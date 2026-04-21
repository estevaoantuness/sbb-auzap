/**
 * Retry sender — worker de `QUEUE_RETRY_SEND` (pg-boss).
 *
 * Enfileirado pelo worker principal quando `sendMessage` falha após as 3 tentativas
 * internas do `fetchWithRetry` (providers/cloudApi.ts). Faz 3 retries adicionais
 * com backoff exponencial: 30s, 2min, 10min.
 *
 * Após 3 falhas: marca `status='falha_permanente'`, insere evento `envio_falhou`
 * e dispara alerta Telegram.
 *
 * Idempotência: worker carrega `crm.mensagens` pelo id passado e reentra só se
 * `status='falha_envio'` (evita reprocessar msgs que já subiram via outra via).
 */

import { getBoss } from '../../lib/queue'
import { prisma } from '../../lib/db'
import { sendMessage as providerSend } from './providers/cloudApi'
import { sendAlert } from '../../lib/telegramAlert'

export const QUEUE_RETRY_SEND = 'auzap:retry_send'

/** Janela de tempo pra considerar uma msg elegível pra retry (anti-stale). */
const RETRY_MAX_AGE_MS = 60 * 60 * 1000 // 1h

/** Backoff em segundos por tentativa adicional. */
const RETRY_BACKOFF_SECONDS = [30, 120, 600]

export interface RetrySendJob {
  mensagemId: string // bigint serializado (pg-boss faz JSON)
  attempt: number    // 1..3
}

/**
 * Enqueue pra retry. Chamado pelo worker principal se `providerSend` falhou.
 */
export async function enqueueRetry(mensagemId: bigint, attempt = 1): Promise<string | null> {
  if (attempt > RETRY_BACKOFF_SECONDS.length) {
    // Nunca deve cair aqui — caller (workerHandler) já checa — mas defense-in-depth.
    console.warn('[retrySender] enqueueRetry ignorado: attempt fora do range', { attempt })
    return null
  }

  const boss = await getBoss()
  const backoffIdx = Math.max(0, attempt - 1)
  const startAfter = RETRY_BACKOFF_SECONDS[backoffIdx] ?? RETRY_BACKOFF_SECONDS[RETRY_BACKOFF_SECONDS.length - 1]!

  const job: RetrySendJob = {
    mensagemId: mensagemId.toString(),
    attempt,
  }

  return boss.send(QUEUE_RETRY_SEND, job, {
    singletonKey: `retry:${mensagemId.toString()}`, // serializa tentativas por msg
    startAfter,
    expireInSeconds: 300,
    retryLimit: 0, // controle de retry é nosso (via `attempt` no job)
  })
}

/**
 * Registrar worker de retry. Chamado no startup junto do worker inbound.
 */
export async function registerRetryWorker(): Promise<void> {
  const boss = await getBoss()
  const concurrency = Number(process.env.RETRY_CONCURRENCY ?? '5')

  await boss.work<RetrySendJob>(
    QUEUE_RETRY_SEND,
    { batchSize: concurrency },
    async (jobs) => {
      for (const j of jobs) {
        const payload = j.data
        try {
          await processRetry(payload)
        } catch (err) {
          console.error('[retrySender] erro processando retry', {
            mensagemId: payload.mensagemId,
            attempt: payload.attempt,
            error: err instanceof Error ? err.message : err,
          })
          // Não propaga — evita re-retry automático do pg-boss (controle é nosso).
        }
      }
    }
  )
}

async function processRetry(job: RetrySendJob): Promise<void> {
  const mensagemId = BigInt(job.mensagemId)

  // Carrega msg + valida elegibilidade
  const msg = await prisma.mensagem.findUnique({
    where: { id: mensagemId },
    select: {
      id: true,
      telefone: true,
      conteudo: true,
      status: true,
      direcao: true,
      leadId: true,
      conversaId: true,
      createdAt: true,
    },
  })

  if (!msg) {
    console.warn('[retrySender] mensagem não encontrada', { mensagemId: job.mensagemId })
    return
  }

  // Só re-tenta saídas em falha_envio
  if (msg.direcao !== 'out' || msg.status !== 'falha_envio') {
    console.log('[retrySender] msg não elegível (status mudou)', {
      mensagemId: job.mensagemId,
      status: msg.status,
      direcao: msg.direcao,
    })
    return
  }

  // Anti-stale: se msg é muito antiga, não insiste
  const ageMs = Date.now() - msg.createdAt.getTime()
  if (ageMs > RETRY_MAX_AGE_MS) {
    await markPermanentFailure(msg.id, msg.leadId, msg.conversaId, msg.telefone, 'stale')
    return
  }

  // Tenta reenviar
  try {
    const wamid = await providerSend(msg.telefone, msg.conteudo)
    await prisma.mensagem.update({
      where: { id: msg.id },
      data: { status: 'enviada', messageIdWaba: wamid },
    })
    console.log('[retrySender] retry sucesso', {
      mensagemId: msg.id.toString(),
      attempt: job.attempt,
      wamid,
    })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    console.warn('[retrySender] tentativa falhou', {
      mensagemId: msg.id.toString(),
      attempt: job.attempt,
      error: errMsg,
    })

    // Próxima tentativa? (1→2, 2→3)
    if (job.attempt < RETRY_BACKOFF_SECONDS.length) {
      await enqueueRetry(msg.id, job.attempt + 1)
      return
    }

    // Esgotou — marca falha permanente
    await markPermanentFailure(msg.id, msg.leadId, msg.conversaId, msg.telefone, errMsg)
  }
}

async function markPermanentFailure(
  mensagemId: bigint,
  leadId: bigint,
  conversaId: bigint,
  telefone: string,
  reason: string
): Promise<void> {
  try {
    await prisma.mensagem.update({
      where: { id: mensagemId },
      data: { status: 'falha_permanente' },
    })

    // Evento auditável com idempotency_key pra não duplicar em race
    const idempotencyKey = `${mensagemId.toString()}:envio_falhou`
    await prisma.$executeRaw`
      INSERT INTO crm.eventos_lead
        (lead_id, conversa_id, telefone, tipo, fonte, payload, idempotency_key)
      VALUES
        (${leadId}, ${conversaId}, ${telefone}, 'envio_falhou', 'sistema',
         ${JSON.stringify({ mensagem_id: mensagemId.toString(), motivo: reason.slice(0, 500) })}::jsonb,
         ${idempotencyKey})
      ON CONFLICT (idempotency_key) DO NOTHING
    `

    await sendAlert(
      `Envio WhatsApp falhou permanentemente\n` +
        `mensagem_id: ${mensagemId.toString()}\n` +
        `telefone: ${telefone}\n` +
        `motivo: ${reason.slice(0, 300)}`,
      'error'
    )
  } catch (err) {
    console.error('[retrySender] falha ao marcar falha_permanente', {
      mensagemId: mensagemId.toString(),
      error: err,
    })
  }
}
