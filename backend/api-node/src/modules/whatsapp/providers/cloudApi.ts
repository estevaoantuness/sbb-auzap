/**
 * WhatsApp Cloud API (Meta Graph API) — provider principal do MVP.
 *
 * Envio: POST https://graph.facebook.com/v17.0/{WABA_PHONE_NUMBER_ID}/messages
 * Recebimento: webhook em POST /whatsapp/webhook (signature validada em middleware)
 *
 * Baileys NÃO é implementado no MVP — rollback = reativar N8N (ver runbook).
 */

const GRAPH_API_VERSION = 'v17.0'

export interface WhatsAppMessage {
  id: string                 // wamid
  from: string               // E.164 sem +
  timestamp: string          // unix seconds
  type: 'text' | 'audio' | 'image' | 'document' | 'location' | 'unknown'
  text?: { body: string }
  audio?: { id: string; mime_type: string }
  image?: { id: string; mime_type: string; caption?: string }
  document?: { id: string; mime_type: string; filename?: string; caption?: string }
}

export interface WhatsAppWebhookPayload {
  entry: Array<{
    id: string
    changes: Array<{
      field: 'messages'
      value: {
        messaging_product: 'whatsapp'
        metadata: { display_phone_number: string; phone_number_id: string }
        contacts?: Array<{ profile: { name: string }; wa_id: string }>
        messages?: WhatsAppMessage[]
        statuses?: Array<{ id: string; status: 'sent' | 'delivered' | 'read' | 'failed'; timestamp: string; recipient_id: string }>
      }
    }>
  }>
}

export async function sendMessage(to: string, body: string, opts?: { previewUrl?: boolean }): Promise<string> {
  const phoneNumberId = mustEnv('WABA_PHONE_NUMBER_ID')
  const accessToken = mustEnv('WABA_ACCESS_TOKEN')

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { body, preview_url: opts?.previewUrl ?? false },
  }

  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  const data = await res.json()
  const wamid = data?.messages?.[0]?.id
  if (!wamid) {
    throw new Error(`[cloudApi] sendMessage resposta sem wamid: ${JSON.stringify(data)}`)
  }
  return wamid as string
}

export async function markAsRead(messageId: string): Promise<void> {
  const phoneNumberId = mustEnv('WABA_PHONE_NUMBER_ID')
  const accessToken = mustEnv('WABA_ACCESS_TOKEN')

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`
  await fetchWithRetry(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: messageId }),
  })
}

export async function getTier(): Promise<string | null> {
  const phoneNumberId = mustEnv('WABA_PHONE_NUMBER_ID')
  const accessToken = mustEnv('WABA_ACCESS_TOKEN')

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}?fields=messaging_limit_tier`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) return null
  const data = await res.json()
  return data?.messaging_limit_tier ?? null
}

/**
 * Retry exponencial 3× pra Graph API (429/500/503).
 * Após 3 falhas, throw → caller marca crm.mensagens.status='falha_envio'.
 */
async function fetchWithRetry(url: string, init: RequestInit, attempt = 1): Promise<Response> {
  const res = await fetch(url, init)
  if (res.ok) return res

  if (attempt < 3 && [429, 500, 502, 503, 504].includes(res.status)) {
    const delayMs = 1000 * Math.pow(3, attempt - 1) // 1s, 3s, 9s
    await new Promise((r) => setTimeout(r, delayMs))
    return fetchWithRetry(url, init, attempt + 1)
  }

  const body = await res.text().catch(() => '')
  throw new Error(`[cloudApi] ${res.status} após ${attempt} tentativa(s): ${body}`)
}

function mustEnv(key: string): string {
  const v = process.env[key]
  if (!v) throw new Error(`env ${key} missing`)
  return v
}
