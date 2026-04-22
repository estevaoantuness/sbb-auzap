/**
 * Evolution API webhook handler.
 *
 * SEMPRE retorna 200 — Evolution retenta em 5xx (3× loop catastrófico em falha).
 *
 * Guards (ordem obrigatória):
 *   1. instance !== EVOLUTION_INSTANCE → 200 silencioso (proteção cross-tenant)
 *   2. messages.upsert com fromMe=true → ignora eco (bug Evolution #1340)
 *   3. connection.update com state=close → alerta Telegram
 *   4. data.key.id ausente → skip
 *   5. messageTimestamp > 60s atrás → skip (replay offline na reconexão)
 */

import type { Request, Response } from 'express'
import { enqueueInbound, InboundJob } from '../../lib/queue'
import { sendAlert } from '../../lib/telegramAlert'
import * as qrCache from './providers/evolutionQrCache'

// Payload Evolution é bruto — any aqui é deliberado (único ponto de `any` permitido)
interface EvolutionPayload {
  event?: string
  instance?: string
  data?: any
}

function extractText(data: any): string {
  const m = data?.message || {}
  if (m.conversation) return m.conversation
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text
  if (m.imageMessage?.caption) return m.imageMessage.caption
  if (m.audioMessage) return '[áudio]'
  if (m.imageMessage) return '[imagem]'
  return '[tipo não suportado]'
}

function extractMediaType(
  data: any,
): 'audio' | 'image' | 'document' | undefined {
  const m = data?.message || {}
  if (m.audioMessage) return 'audio'
  if (m.imageMessage) return 'image'
  if (m.documentMessage) return 'document'
  return undefined
}

function normalizeWaId(remoteJid: string): string {
  return remoteJid
    .replace(/@s\.whatsapp\.net$/, '')
    .replace(/@c\.us$/, '')
    .replace(/@g\.us$/, '')
}

function toEpochMs(timestamp: unknown): number | null {
  if (typeof timestamp === 'number') {
    // Evolution às vezes manda em segundos, às vezes em ms
    return timestamp > 1e12 ? timestamp : timestamp * 1000
  }
  if (typeof timestamp === 'string') {
    const n = Number(timestamp)
    if (!Number.isNaN(n)) return n > 1e12 ? n : n * 1000
    const parsed = Date.parse(timestamp)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

export async function handleEvolutionWebhook(
  req: Request,
  res: Response,
): Promise<void> {
  // SEMPRE 200 antes de qualquer processamento — Evolution é impiedoso com 5xx.
  res.status(200).json({ ok: true })

  try {
    const payload = (req.body || {}) as EvolutionPayload
    const event = payload.event || ''
    const instance = payload.instance || ''
    const data = payload.data

    const expectedInstance = process.env.EVOLUTION_INSTANCE || 'SuperBemBarato'

    // TEMP DEBUG: log every webhook event (remove once pairing is stable)
    console.log('[evolution:debug] webhook IN', {
      event,
      instance,
      expectedInstance,
      dataKeys: data ? Object.keys(data) : null,
      state: data?.state,
      fromMe: data?.key?.fromMe,
      remoteJid: data?.key?.remoteJid,
    })

    // Guard 1: cross-tenant protection
    if (instance !== expectedInstance) {
      console.warn('[evolution] webhook de instance inesperada — ignorado', {
        received: instance,
        expected: expectedInstance,
        event,
      })
      return
    }

    // connection.update — log all states (close triggers Telegram alert)
    if (event === 'connection.update') {
      console.log('[evolution] connection.update', {
        instance,
        state: data?.state,
      })
      // Ao abrir (pareou!) ou fechar: invalida QR cache — não serve mais
      if (data?.state === 'open' || data?.state === 'close') {
        qrCache.clearQR(instance)
      }
      if (data?.state === 'close') {
        await sendAlert(
          `⚠️ Evolution/${instance} desconectado (connection.update state=close)`,
          'error',
        ).catch((err) =>
          console.error('[evolution] sendAlert falhou', err),
        )
      }
      return
    }

    // qrcode.updated — Evolution empurra QR fresco a cada rotação (~30s).
    // Cacheamos pra servir na próxima chamada de /whatsapp/qr (mais fresco
    // que pedir via /instance/connect toda hora).
    if (event === 'qrcode.updated') {
      const base64: string | undefined =
        data?.qrcode?.base64 || data?.base64 || data?.qr
      if (base64) {
        qrCache.setQR(instance, base64)
        console.log('[evolution] qrcode.updated → cache atualizado', {
          instance,
          qrLen: base64.length,
        })
      } else {
        console.warn('[evolution] qrcode.updated sem base64 — ignorado', {
          instance,
          dataKeys: data ? Object.keys(data) : null,
        })
      }
      return
    }

    // Daqui em diante só trata mensagens inbound
    if (event !== 'messages.upsert') {
      return
    }

    // Guard 2: ignora ecos (fromMe) — Evolution #1340
    if (data?.key?.fromMe === true) {
      return
    }

    // Guard 4: message id obrigatório
    const messageId: string | undefined = data?.key?.id
    if (!messageId) {
      console.warn('[evolution] messages.upsert sem key.id — skip', { event })
      return
    }

    // Guard 5: timestamp > 60s atrás → replay offline, descartar
    const epochMs = toEpochMs(data?.messageTimestamp)
    if (epochMs !== null) {
      const ageMs = Date.now() - epochMs
      if (ageMs > 60_000) {
        console.warn('[evolution] mensagem stale — skip (replay offline)', {
          messageId,
          ageMs,
        })
        return
      }
    }

    const remoteJid: string | undefined = data?.key?.remoteJid
    if (!remoteJid) {
      console.warn('[evolution] sem remoteJid — skip', { messageId })
      return
    }

    // Descarta grupos (remoteJid com @g.us)
    if (remoteJid.endsWith('@g.us')) {
      return
    }

    const waId = normalizeWaId(remoteJid)
    const userMessage = extractText(data)
    const mediaType = extractMediaType(data)

    const job: InboundJob = {
      waId,
      messageId,
      userMessage,
      mediaType,
      mediaUrl: undefined,
      receivedAt: new Date().toISOString(),
    }

    try {
      await enqueueInbound(job)
    } catch (err) {
      console.error('[evolution] enqueueInbound falhou', {
        waId,
        messageId,
        error: err,
      })
    }
  } catch (err) {
    console.error('[evolution] erro no processamento assíncrono', err)
    // Swallowed — já respondemos 200.
  }
}
