/**
 * Evolution API provider — integracao com instancia Evolution externa.
 *
 * Evolution roda como serviço separado (container). O provider só fala HTTP.
 * Envio: POST ${EVOLUTION_URL}/message/sendText/${EVOLUTION_INSTANCE}
 * Recebimento: webhook em POST /whatsapp/webhook/evolution (guarded por IP allowlist + apikey)
 *
 * ⚠️ SHADOW_MODE=true → nada é enviado (logs apenas) — safety gate pre-rollout.
 */

import type { MessagingProvider, ProviderStatus, SendOptions } from './types'

interface EvolutionEnv {
  url: string
  apiKey: string
  instance: string
}

function mustEnv(key: string): string {
  const v = process.env[key]
  if (!v) throw new Error(`[evolution] env ${key} missing`)
  return v
}

function loadEnv(): EvolutionEnv {
  return {
    url: mustEnv('EVOLUTION_URL').replace(/\/+$/, ''),
    apiKey: mustEnv('EVOLUTION_API_KEY'),
    instance: process.env.EVOLUTION_INSTANCE || 'SuperBemBarato',
  }
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  attempt = 1,
): Promise<Response> {
  const res = await fetch(url, init)
  if (res.ok) return res

  if (attempt < 3 && [429, 500, 503].includes(res.status)) {
    const delayMs = attempt === 1 ? 1000 : 3000 // 1s, 3s
    console.warn(
      `[evolution] HTTP ${res.status} em tentativa ${attempt}/3 — retry em ${delayMs}ms`,
    )
    await new Promise((r) => setTimeout(r, delayMs))
    return fetchWithRetry(url, init, attempt + 1)
  }

  const body = await res.text().catch(() => '')
  throw new Error(
    `[evolution] ${res.status} após ${attempt} tentativa(s): ${body.slice(0, 500)}`,
  )
}

export const evolutionProvider: MessagingProvider = {
  async start(): Promise<void> {
    // Valida envs em startup — Evolution roda separado (no-op real).
    const env = loadEnv()
    console.log(
      `[evolution] provider iniciado (instance=${env.instance}, url=${env.url})`,
    )
    if (process.env.SHADOW_MODE === 'true') {
      console.warn('[evolution] SHADOW_MODE=true → envios serão logados, não enviados')
    }
  },

  async sendMessage(
    to: string,
    body: string,
    _opts?: SendOptions,
  ): Promise<string> {
    if (process.env.SHADOW_MODE === 'true') {
      const shadowId = `shadow:${Date.now()}`
      console.log('[evolution] [SHADOW] would send', {
        to,
        bodyPreview: body.slice(0, 120),
        shadowId,
      })
      return shadowId
    }

    const env = loadEnv()
    const url = `${env.url}/message/sendText/${env.instance}`
    const payload = { number: to, text: body }

    const res = await fetchWithRetry(url, {
      method: 'POST',
      headers: {
        apikey: env.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })

    const data: any = await res.json().catch(() => ({}))
    const messageId =
      data?.key?.id ||
      data?.messageId ||
      data?.id ||
      data?.data?.key?.id
    if (!messageId) {
      throw new Error(
        `[evolution] sendMessage sem message id no response: ${JSON.stringify(data).slice(0, 500)}`,
      )
    }
    return String(messageId)
  },

  async markAsRead(messageId: string): Promise<void> {
    if (process.env.SHADOW_MODE === 'true') {
      console.log('[evolution] [SHADOW] would mark as read', { messageId })
      return
    }
    const env = loadEnv()
    const url = `${env.url}/chat/markMessageAsRead/${env.instance}`
    await fetchWithRetry(url, {
      method: 'POST',
      headers: {
        apikey: env.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ readMessages: [{ id: messageId }] }),
    }).catch((err) => {
      console.warn('[evolution] markAsRead falhou (non-fatal)', err)
    })
  },

  async getStatus(): Promise<ProviderStatus> {
    const env = loadEnv()
    try {
      const stateRes = await fetch(
        `${env.url}/instance/connectionState/${env.instance}`,
        { headers: { apikey: env.apiKey } },
      )
      if (!stateRes.ok) {
        return { provider: 'evolution', status: 'unknown' }
      }
      const stateData: any = await stateRes.json().catch(() => ({}))
      const rawState: string =
        stateData?.instance?.state ||
        stateData?.state ||
        'unknown'

      let status: ProviderStatus['status']
      switch (rawState) {
        case 'open':
          status = 'connected'
          break
        case 'connecting':
          status = 'qr_pending'
          break
        case 'close':
        case 'closed':
          status = 'disconnected'
          break
        default:
          status = 'unknown'
      }

      let phoneNumber: string | undefined
      try {
        const listRes = await fetch(`${env.url}/instance/fetchInstances`, {
          headers: { apikey: env.apiKey },
        })
        if (listRes.ok) {
          const list: any = await listRes.json().catch(() => [])
          const arr: any[] = Array.isArray(list) ? list : list?.instances || []
          const me = arr.find(
            (i: any) =>
              i?.instance?.instanceName === env.instance ||
              i?.instanceName === env.instance ||
              i?.name === env.instance,
          )
          phoneNumber =
            me?.instance?.owner ||
            me?.owner ||
            me?.instance?.profileName ||
            me?.number ||
            undefined
          if (typeof phoneNumber === 'string') {
            phoneNumber = phoneNumber.replace(/@s\.whatsapp\.net$/, '')
          }
        }
      } catch (err) {
        console.warn('[evolution] fetchInstances falhou', err)
      }

      return {
        provider: 'evolution',
        status,
        phoneNumber,
      }
    } catch (err) {
      console.error('[evolution] getStatus erro', err)
      return { provider: 'evolution', status: 'unknown' }
    }
  },

  async getQR(): Promise<string | null> {
    const env = loadEnv()
    try {
      const res = await fetch(`${env.url}/instance/connect/${env.instance}`, {
        headers: { apikey: env.apiKey },
      })
      if (!res.ok) return null
      const data: any = await res.json().catch(() => ({}))
      const base64: string | undefined =
        data?.base64 || data?.qrcode?.base64 || data?.qr
      if (!base64) return null
      if (base64.startsWith('data:image/')) return base64
      return `data:image/png;base64,${base64}`
    } catch (err) {
      console.warn('[evolution] getQR falhou', err)
      return null
    }
  },

  async disconnect(): Promise<void> {
    const env = loadEnv()
    const res = await fetch(`${env.url}/instance/logout/${env.instance}`, {
      method: 'POST',
      headers: { apikey: env.apiKey },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(
        `[evolution] disconnect falhou ${res.status}: ${body.slice(0, 200)}`,
      )
    }
    console.log(`[evolution] disconnect OK (instance=${env.instance})`)
  },
}
