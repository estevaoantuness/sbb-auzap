/**
 * Baileys provider — MVP WhatsApp via celular virtual (QR code scan).
 *
 * Single-tenant: sessão única em BAILEYS_SESSIONS_PATH/default.
 * Ao receber msg: enqueue InboundJob em pg-boss (mesma fila que o Cloud API webhook usa).
 *
 * ⚠️ Risco: banimento Meta (issue WhiskeySockets/Baileys#1869). Número dedicado NOVO obrigatório.
 */

import makeWASocket from '@whiskeysockets/baileys'
import { DisconnectReason } from '@whiskeysockets/baileys/lib/Types/index.js'
import {
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys/lib/Utils/index.js'
import { Boom } from '@hapi/boom'
import path from 'path'
import fs from 'fs'
import qrcode from 'qrcode'
import type { MessagingProvider, ProviderStatus, SendOptions } from './types'
import { enqueueInbound, InboundJob } from '../../../lib/queue'
import { sendAlert } from '../../../lib/telegramAlert'

const SESSION_DIR = path.join(
  process.env.BAILEYS_SESSIONS_PATH || './sessions',
  'default',
)

let socket: ReturnType<typeof makeWASocket> | null = null
let currentStatus: ProviderStatus = {
  provider: 'baileys',
  status: 'disconnected',
}
let lastQrDataUrl: string | null = null
let reconnectTimer: NodeJS.Timeout | null = null

function setStatus(next: Partial<ProviderStatus>) {
  currentStatus = { ...currentStatus, ...next }
}

async function cleanupSocket() {
  if (socket) {
    try {
      socket.ev.removeAllListeners('connection.update')
      socket.ev.removeAllListeners('creds.update')
      socket.ev.removeAllListeners('messages.upsert')
      socket.end(undefined)
    } catch {
      /* noop */
    }
    socket = null
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

async function bootSocket(): Promise<void> {
  await cleanupSocket()

  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true })
  }

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR)
  const { version } = await fetchLatestBaileysVersion()

  socket = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, undefined as any),
    },
    printQRInTerminal: false,
    shouldIgnoreJid: (jid?: string) =>
      !jid || jid.includes('@broadcast') || jid === 'status@broadcast',
  })

  setStatus({ status: 'connecting' })

  socket.ev.on('connection.update', async (update: any) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      lastQrDataUrl = await qrcode.toDataURL(qr)
      setStatus({ status: 'qr_pending', qrCodeDataUrl: lastQrDataUrl ?? undefined })
      console.log('[baileys] QR code gerado — esperando scan')
    }

    if (connection === 'open') {
      const jid = socket?.user?.id || ''
      const phone = jid.split(':')[0] || ''
      lastQrDataUrl = null
      setStatus({
        status: 'connected',
        phoneNumber: phone,
        qrCodeDataUrl: undefined,
        connectedAt: new Date().toISOString(),
      })
      console.log(`[baileys] conectado como ${phone}`)
      void sendAlert(`Baileys conectado como ${phone}`, 'info')
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
      const loggedOut = statusCode === DisconnectReason.loggedOut
      const restartRequired =
        statusCode === 515 || statusCode === DisconnectReason.restartRequired

      if (loggedOut) {
        setStatus({ status: 'disconnected', phoneNumber: undefined })
        fs.rmSync(SESSION_DIR, { recursive: true, force: true })
        void sendAlert('Baileys logout — sessão limpa, reconexão manual via QR', 'error')
        await cleanupSocket()
        return
      }

      // Reconexão automática com backoff
      setStatus({ status: 'connecting' })
      const delay = restartRequired ? 1_000 : 5_000
      console.log(`[baileys] desconectado (code=${statusCode}), reconectando em ${delay}ms`)
      await cleanupSocket()
      reconnectTimer = setTimeout(() => {
        void bootSocket()
      }, delay)
    }
  })

  socket.ev.on('creds.update', saveCreds)

  socket.ev.on('messages.upsert', async ({ messages, type }: any) => {
    if (type !== 'notify') return
    const now = Math.floor(Date.now() / 1000)

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue

      const ts =
        typeof msg.messageTimestamp === 'number'
          ? msg.messageTimestamp
          : Number(msg.messageTimestamp?.low ?? msg.messageTimestamp ?? 0)
      // Ignora msgs antigas (história offline reaproveitada em reconnect)
      if (ts > 0 && now - ts > 60) continue

      const waId = (msg.key.remoteJid || '').replace(/@s\.whatsapp\.net$/, '')
      const messageId = msg.key.id || ''
      if (!waId || !messageId) continue

      const body = extractBody(msg)
      const mediaType = extractMediaType(msg)

      const job: InboundJob = {
        waId,
        messageId,
        userMessage: body,
        mediaType,
        mediaUrl: undefined, // worker baixa mídia se precisar
        receivedAt: new Date().toISOString(),
      }

      try {
        await enqueueInbound(job)
      } catch (err) {
        console.error('[baileys] enqueue falhou', { waId, err })
      }
    }
  })
}

function extractBody(msg: any): string {
  const m = msg.message || {}
  if (m.conversation) return m.conversation
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text
  if (m.imageMessage?.caption) return m.imageMessage.caption
  if (m.videoMessage?.caption) return m.videoMessage.caption
  if (m.documentMessage?.caption) return m.documentMessage.caption
  if (m.audioMessage) return '[áudio]'
  if (m.imageMessage) return '[imagem]'
  if (m.documentMessage) return '[documento]'
  if (m.locationMessage) return '[localização]'
  return '[tipo não suportado]'
}

function extractMediaType(msg: any): 'audio' | 'image' | 'document' | undefined {
  const m = msg.message || {}
  if (m.audioMessage) return 'audio'
  if (m.imageMessage) return 'image'
  if (m.documentMessage) return 'document'
  return undefined
}

// ──────────────────────────────────────────────────
// MessagingProvider implementation
// ──────────────────────────────────────────────────

export const baileysProvider: MessagingProvider = {
  async start(): Promise<void> {
    if (socket) return // já iniciado
    await bootSocket()
  },

  async sendMessage(to: string, body: string, _opts?: SendOptions): Promise<string> {
    if (!socket) throw new Error('[baileys] socket não iniciado')
    if (currentStatus.status !== 'connected') {
      throw new Error(`[baileys] não conectado (status=${currentStatus.status})`)
    }
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`

    let lastErr: unknown
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const sent = await socket.sendMessage(jid, { text: body })
        const id = sent?.key?.id || `baileys:${Date.now()}`
        return id
      } catch (err: any) {
        lastErr = err
        const timeout = err?.output?.statusCode === 408 || err?.message === 'Timed Out'
        if (timeout && attempt < 2) {
          await new Promise((r) => setTimeout(r, 3_000))
          continue
        }
        throw err
      }
    }
    throw lastErr
  },

  async markAsRead(messageId: string): Promise<void> {
    if (!socket) return
    try {
      await socket.readMessages([{ id: messageId, remoteJid: '', participant: undefined } as any])
    } catch {
      /* best-effort */
    }
  },

  async getStatus(): Promise<ProviderStatus> {
    return currentStatus
  },

  async getQR(): Promise<string | null> {
    return lastQrDataUrl
  },

  async disconnect(): Promise<void> {
    await cleanupSocket()
    fs.rmSync(SESSION_DIR, { recursive: true, force: true })
    setStatus({ status: 'disconnected', phoneNumber: undefined, qrCodeDataUrl: undefined })
    lastQrDataUrl = null
  },
}
