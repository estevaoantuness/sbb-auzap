/**
 * WhatsApp Cloud API — status callbacks (delivered/read/failed).
 *
 * O webhook entrega um array `statuses` junto com `messages`. Esses eventos
 * referenciam mensagens que a Maria ENVIOU (direcao='out'), via wamid.
 *
 * Mapping status Meta → crm.mensagens.status:
 *   sent       → enviada      (já deveria estar enviada; idempotente)
 *   delivered  → entregue
 *   read       → lida         (+ read_at = timestamp)
 *   failed     → falha_envio  + enqueueRetry (se ainda estiver na janela)
 *
 * Integrador: Team D2 deve chamar `handleStatuses(change.value.statuses)` em
 * `webhookController.ts` quando `change.field === 'messages'` e
 * `change.value.statuses` estiver presente.
 */

import { prisma } from '../../lib/db'
import { enqueueRetry } from './retrySender'
import { sendAlert } from '../../lib/telegramAlert'

export interface WhatsAppStatus {
  id: string                   // wamid da msg enviada pela Maria
  status: 'sent' | 'delivered' | 'read' | 'failed'
  timestamp: string            // unix seconds (string)
  recipient_id: string
  errors?: Array<{
    code?: number
    title?: string
    message?: string
    error_data?: { details?: string }
  }>
}

export async function handleStatuses(statuses: WhatsAppStatus[] | undefined): Promise<void> {
  if (!statuses || statuses.length === 0) return

  for (const status of statuses) {
    try {
      await processStatus(status)
    } catch (err) {
      // Não deixa 1 status ruim derrubar o batch inteiro
      console.error('[statusHandler] erro processando status', {
        wamid: status.id,
        status: status.status,
        error: err instanceof Error ? err.message : err,
      })
    }
  }
}

async function processStatus(status: WhatsAppStatus): Promise<void> {
  const tsMs = Number.parseInt(status.timestamp, 10) * 1000
  const eventAt = Number.isFinite(tsMs) ? new Date(tsMs) : new Date()

  // Localiza msg pelo wamid (messageIdWaba) — único pra outbound
  const msg = await prisma.mensagem.findFirst({
    where: { messageIdWaba: status.id },
    select: {
      id: true,
      status: true,
      direcao: true,
      leadId: true,
      conversaId: true,
      telefone: true,
      createdAt: true,
    },
  })

  if (!msg) {
    // Pode acontecer em race (status chega antes do UPDATE do worker inserir wamid)
    // ou em msgs enviadas antes do cutover. Log só, sem alerta.
    console.warn('[statusHandler] mensagem não encontrada pelo wamid', {
      wamid: status.id,
      status: status.status,
    })
    return
  }

  switch (status.status) {
    case 'sent': {
      // 'sent' é o ACK do Meta logo após receber nosso POST. Status 'enviada' já deve estar.
      // Só atualiza se ainda estiver 'pendente' (race defensivo).
      if (msg.status === 'pendente') {
        await prisma.mensagem.update({
          where: { id: msg.id },
          data: { status: 'enviada' },
        })
      }
      return
    }

    case 'delivered': {
      // Só avança estado — não retrocede (ex: não vira entregue se já lida).
      if (msg.status === 'pendente' || msg.status === 'enviada') {
        await prisma.mensagem.update({
          where: { id: msg.id },
          data: { status: 'entregue' },
        })
      }
      return
    }

    case 'read': {
      await prisma.mensagem.update({
        where: { id: msg.id },
        data: { status: 'lida', readAt: eventAt },
      })
      return
    }

    case 'failed': {
      const errorDetails = extractErrorDetails(status)

      await prisma.mensagem.update({
        where: { id: msg.id },
        data: { status: 'falha_envio' },
      })

      // Evento auditável (best effort)
      try {
        const idempotencyKey = `${msg.id.toString()}:status_failed`
        await prisma.$executeRaw`
          INSERT INTO crm.eventos_lead
            (lead_id, conversa_id, telefone, tipo, fonte, payload, idempotency_key)
          VALUES
            (${msg.leadId}, ${msg.conversaId}, ${msg.telefone}, 'envio_falhou',
             'meta_status',
             ${JSON.stringify({
               mensagem_id: msg.id.toString(),
               wamid: status.id,
               error: errorDetails,
             })}::jsonb,
             ${idempotencyKey})
          ON CONFLICT (idempotency_key) DO NOTHING
        `
      } catch (err) {
        console.error('[statusHandler] falha ao inserir evento envio_falhou', err)
      }

      // Tenta retry se msg ainda está na janela de 1h. `enqueueRetry` é idempotente
      // via singletonKey — não duplica se já houver retry pendente.
      const ageMs = Date.now() - msg.createdAt.getTime()
      const RETRY_MAX_AGE_MS = 60 * 60 * 1000
      if (ageMs <= RETRY_MAX_AGE_MS) {
        await enqueueRetry(msg.id, 1)
      } else {
        // Fora da janela — marca permanente + alerta
        await prisma.mensagem.update({
          where: { id: msg.id },
          data: { status: 'falha_permanente' },
        })
        await sendAlert(
          `Falha de envio fora da janela de retry\n` +
            `mensagem_id: ${msg.id.toString()}\n` +
            `telefone: ${msg.telefone}\n` +
            `wamid: ${status.id}\n` +
            `error: ${JSON.stringify(errorDetails).slice(0, 300)}`,
          'error'
        )
      }
      return
    }

    default: {
      console.warn('[statusHandler] status desconhecido', {
        wamid: status.id,
        status: (status as any).status,
      })
    }
  }
}

function extractErrorDetails(status: WhatsAppStatus): Record<string, unknown> {
  const err = status.errors?.[0]
  if (!err) return {}
  return {
    code: err.code,
    title: err.title,
    message: err.message,
    details: err.error_data?.details,
  }
}
