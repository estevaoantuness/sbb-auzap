import type { Request, Response } from 'express'
import { enqueueInbound, InboundJob } from '../../lib/queue'
import type { WhatsAppWebhookPayload } from './providers/cloudApi'
import { handleStatuses } from './statusHandler'

/**
 * Handler do POST /whatsapp/webhook — já passou por verifyMetaSignature.
 * Responsabilidades:
 *   1. Normalizar payload Cloud API em InboundJob.
 *   2. Enqueue em pg-boss com singletonKey+coalescing.
 *   3. SEMPRE retornar 200 (Meta reentrega infinitamente se 5xx).
 */
export async function handleWebhook(req: Request, res: Response) {
  // Responde 200 imediatamente — processamento é assíncrono (pg-boss)
  res.status(200).json({ ok: true })

  try {
    const payload = req.body as WhatsAppWebhookPayload
    const entries = payload?.entry ?? []

    for (const entry of entries) {
      for (const change of entry.changes) {
        if (change.field !== 'messages') continue
        const messages = change.value.messages ?? []

        for (const msg of messages) {
          if (!msg.from || !msg.id) continue

          const job: InboundJob = {
            waId: msg.from,
            messageId: msg.id,
            userMessage: extractText(msg),
            mediaType: extractMediaType(msg),
            mediaUrl: undefined, // pre-fetch via Media API só no worker (evita gastar aqui)
            receivedAt: new Date().toISOString(),
          }

          try {
            await enqueueInbound(job)
          } catch (err) {
            console.error('[webhook] enqueue falhou', { waId: job.waId, error: err })
            // Não faz retry agressivo aqui — se pg-boss falhou, alerta Telegram no worker
          }
        }

        // Statuses (delivered/read/failed) — wire pro statusHandler (Team D1)
        const statuses = change.value.statuses
        if (statuses && statuses.length > 0) {
          try {
            await handleStatuses(statuses as any)
          } catch (err) {
            console.error('[webhook] handleStatuses falhou', err)
          }
        }
      }
    }
  } catch (err) {
    console.error('[webhook] erro no processamento assíncrono', err)
  }
}

function extractText(msg: any): string {
  if (msg.type === 'text') return msg.text?.body ?? ''
  if (msg.type === 'image') return msg.image?.caption ?? '[imagem]'
  if (msg.type === 'audio') return '[áudio]'
  if (msg.type === 'document') return msg.document?.caption ?? '[documento]'
  if (msg.type === 'location') return '[localização]'
  return '[tipo não suportado]'
}

function extractMediaType(msg: any): 'audio' | 'image' | 'document' | undefined {
  if (msg.type === 'audio') return 'audio'
  if (msg.type === 'image') return 'image'
  if (msg.type === 'document') return 'document'
  return undefined
}
