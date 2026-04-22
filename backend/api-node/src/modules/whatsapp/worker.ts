/**
 * Inbound worker — consumidor de QUEUE_INBOUND (pg-boss).
 *
 * Por turno, executa 3 transações distintas:
 *   TX1 (~5-10ms): upsert lead → abrir_conversa (advisory lock) → INSERT mensagem in
 *                  → INSERT eventos_lead mensagem_recebida (idempotency_key).
 *   Fora-TX:       chamada ai-service POST /run (2-20s). Pre-guardrail prompt injection
 *                  antes de chamar — se match, escala direto e não passa pro LLM.
 *   TX2 (~5-10ms): INSERT mensagem out → providerSend → UPDATE status → INSERT agent.runs.
 *
 * Idempotência: evento `mensagem_recebida` com idempotency_key=`${wamid}:mensagem_recebida`
 * bloqueia reprocessamento. Worker não reimplementa orphan detection — trigger no DB.
 *
 * Concorrência: pg-boss serializa por `conversa_id` via singletonKey no enqueue.
 * Entrega batches coalescidos — processamos 1 por vez (mas mesmo waId já vem serializado).
 */

import {
  QUEUE_INBOUND,
  registerInboundWorker,
  InboundJob,
} from '../../lib/queue'
import { prisma } from '../../lib/db'
import { sendMessage as providerSend } from './providers/cloudApi'
import { enqueueRetry } from './retrySender'
import { sendAlert } from '../../lib/telegramAlert'
import {
  downloadMedia,
  MediaTooLargeError,
  AudioTooLongError,
} from './mediaDownloader'
import { rateLimitByWaId, RATE_LIMIT_MAX_PER_WINDOW } from '../../middleware/rateLimit'

// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────

const SUPERBEM_COMPANY_ID = Number(process.env.SUPERBEM_COMPANY_ID ?? '1')
const AI_SERVICE_URL = process.env.AI_SERVICE_URL ?? 'http://sbb-auzap-ai:8000'
const AI_SERVICE_TIMEOUT_MS = Number(process.env.AI_SERVICE_TIMEOUT_MS ?? '45000')

// ─────────────────────────────────────────────────────────────
// Pre-guardrail: prompt injection detection
// ─────────────────────────────────────────────────────────────

const INJECTION_PATTERNS: Array<{ pattern: RegExp; tag: string }> = [
  { pattern: /ignore\s+(all|previous|above)\b.*?\binstructions?\b/i, tag: 'ignore_instructions' },
  { pattern: /\b(bypass|override|disable)\b.*?(guardrails?|rules?|filters?|instructions?)/i, tag: 'bypass_override' },
  { pattern: /\b(system|developer|internal|admin)\s*(prompt|instructions?|credentials?)\b/i, tag: 'reveal_system' },
  { pattern: /\b(dump|show|print|reveal)\s+(system|prompt|api[-_]?key|credentials?|secrets?)\b/i, tag: 'leak_secrets' },
]

interface InjectionMatch {
  matched: boolean
  tags: string[]
  matchedText?: string
}

function detectPromptInjection(text: string): InjectionMatch {
  const tags: string[] = []
  let matchedText: string | undefined
  for (const { pattern, tag } of INJECTION_PATTERNS) {
    const m = text.match(pattern)
    if (m) {
      tags.push(tag)
      if (!matchedText) matchedText = m[0]
    }
  }
  return { matched: tags.length > 0, tags, matchedText }
}

// ─────────────────────────────────────────────────────────────
// AI service client
// ─────────────────────────────────────────────────────────────

interface AiServiceRequest {
  company_id: number
  client_phone: string
  message: string
  image_base64?: string
}

interface AiServiceResponse {
  reply: string
  agent_used?: string
  stage?: string
  input_tokens?: number
  output_tokens?: number
  latency_ms?: number
  guardrails_fired?: string[]
  model?: string
  reply_raw?: string
  tool_calls?: unknown[]
}

async function callAiService(req: AiServiceRequest): Promise<AiServiceResponse> {
  const url = `${AI_SERVICE_URL.replace(/\/$/, '')}/run`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), AI_SERVICE_TIMEOUT_MS)

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
      signal: controller.signal,
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`[ai-service] ${res.status}: ${body.slice(0, 300)}`)
    }

    return (await res.json()) as AiServiceResponse
  } finally {
    clearTimeout(timer)
  }
}

// ─────────────────────────────────────────────────────────────
// TX1: resolve lead + conversa + salva msg inbound
// ─────────────────────────────────────────────────────────────

interface InboundContext {
  leadId: bigint
  conversaId: bigint
  mensagemInId: bigint
  firstTimeProcessed: boolean // false se evento já existia (idempotency hit)
}

async function persistInbound(job: InboundJob): Promise<InboundContext> {
  // 1. Upsert lead via RPC — retorna setof leads
  const upsertRows = await prisma.$queryRaw<Array<{ id: bigint }>>`
    SELECT id FROM crm.upsert_customer(${job.waId}::text, NULL, NULL, NULL, NULL)
  `
  const leadRow = upsertRows[0]
  if (!leadRow) {
    throw new Error(`[worker] crm.upsert_customer não retornou lead pra ${job.waId}`)
  }
  const leadId = BigInt(leadRow.id)

  // 2. Resolve conversa via RPC (advisory lock session-level)
  const conversaRows = await prisma.$queryRaw<Array<{ abrir_conversa: bigint }>>`
    SELECT crm.abrir_conversa(${leadId}::bigint, ${job.waId}::text) AS abrir_conversa
  `
  const conversaRow = conversaRows[0]
  if (!conversaRow) {
    throw new Error(`[worker] crm.abrir_conversa não retornou conversa_id pra lead ${leadId}`)
  }
  const conversaId = BigInt(conversaRow.abrir_conversa)

  // 3. INSERT msg in
  const tipo = mapMediaTypeToMensagemTipo(job.mediaType)
  const mensagemIn = await prisma.mensagem.create({
    data: {
      conversaId,
      leadId,
      telefone: job.waId,
      direcao: 'in',
      tipo,
      conteudo: job.userMessage,
      status: 'entregue',
      messageIdWaba: job.messageId,
    },
    select: { id: true },
  })

  // 4. Evento idempotente — ON CONFLICT DO NOTHING
  const idempotencyKey = `${job.messageId}:mensagem_recebida`
  const inserted = await prisma.$executeRaw`
    INSERT INTO crm.eventos_lead
      (lead_id, conversa_id, telefone, tipo, fonte, payload, idempotency_key)
    VALUES
      (${leadId}, ${conversaId}, ${job.waId}, 'mensagem_recebida', 'sistema',
       ${JSON.stringify({
         wamid: job.messageId,
         mensagem_id: mensagemIn.id.toString(),
         media_type: job.mediaType ?? null,
       })}::jsonb,
       ${idempotencyKey})
    ON CONFLICT (idempotency_key) DO NOTHING
  `

  return {
    leadId,
    conversaId,
    mensagemInId: mensagemIn.id,
    firstTimeProcessed: inserted > 0,
  }
}

function mapMediaTypeToMensagemTipo(mediaType: InboundJob['mediaType']): string {
  switch (mediaType) {
    case 'audio':
      return 'audio'
    case 'image':
      return 'imagem'
    case 'document':
      return 'documento'
    default:
      return 'texto'
  }
}

// ─────────────────────────────────────────────────────────────
// Escalation (prompt injection ou erro não recuperável)
// ─────────────────────────────────────────────────────────────

async function escalateToHuman(
  ctx: InboundContext,
  telefone: string,
  motivo: string,
  extraPayload: Record<string, unknown> = {}
): Promise<void> {
  // Pausa IA via RPC
  try {
    await prisma.$executeRaw`SELECT crm.pausar_ia(${ctx.conversaId}::bigint)`
  } catch (err) {
    console.error('[worker] crm.pausar_ia falhou', {
      conversaId: ctx.conversaId.toString(),
      error: err,
    })
  }

  // Evento auditável
  try {
    const idempotencyKey = `${ctx.mensagemInId.toString()}:escalou_operador`
    await prisma.$executeRaw`
      INSERT INTO crm.eventos_lead
        (lead_id, conversa_id, telefone, tipo, fonte, payload, idempotency_key)
      VALUES
        (${ctx.leadId}, ${ctx.conversaId}, ${telefone}, 'escalou_operador', 'sistema',
         ${JSON.stringify({ motivo, ...extraPayload })}::jsonb,
         ${idempotencyKey})
      ON CONFLICT (idempotency_key) DO NOTHING
    `
  } catch (err) {
    console.error('[worker] INSERT escalou_operador falhou', err)
  }

  // Alerta Telegram
  await sendAlert(
    `Conversa escalada pra humano\n` +
      `telefone: ${telefone}\n` +
      `conversa_id: ${ctx.conversaId.toString()}\n` +
      `motivo: ${motivo}\n` +
      (extraPayload && Object.keys(extraPayload).length > 0
        ? `detalhes: ${JSON.stringify(extraPayload).slice(0, 300)}`
        : ''),
    'warn'
  )
}

// ─────────────────────────────────────────────────────────────
// TX2: envia reply + insere agent.runs
// ─────────────────────────────────────────────────────────────

async function persistAndSendReply(
  ctx: InboundContext,
  telefone: string,
  aiResponse: AiServiceResponse
): Promise<void> {
  // INSERT msg out (status=pendente até providerSend confirmar)
  const mensagemOut = await prisma.mensagem.create({
    data: {
      conversaId: ctx.conversaId,
      leadId: ctx.leadId,
      telefone,
      direcao: 'out',
      tipo: 'texto',
      conteudo: aiResponse.reply,
      status: 'pendente',
    },
    select: { id: true },
  })

  // Provider send
  let sendOk = false
  try {
    const wamid = await providerSend(telefone, aiResponse.reply)
    await prisma.mensagem.update({
      where: { id: mensagemOut.id },
      data: { status: 'enviada', messageIdWaba: wamid },
    })
    sendOk = true
  } catch (err) {
    console.error('[worker] providerSend falhou', {
      mensagemId: mensagemOut.id.toString(),
      error: err instanceof Error ? err.message : err,
    })
    await prisma.mensagem.update({
      where: { id: mensagemOut.id },
      data: { status: 'falha_envio' },
    })
    // Enfileira retry exponencial (30s, 2min, 10min)
    try {
      await enqueueRetry(mensagemOut.id, 1)
    } catch (enqueueErr) {
      console.error('[worker] enqueueRetry falhou', enqueueErr)
      await sendAlert(
        `enqueueRetry falhou — msg sem retry\n` +
          `mensagem_id: ${mensagemOut.id.toString()}\n` +
          `telefone: ${telefone}`,
        'error'
      )
    }
  }

  // Insere agent.runs (trace). Idempotente via UQ (conversa_id, user_message_id, agent_used).
  try {
    const toolCallsJson = JSON.stringify(aiResponse.tool_calls ?? [])
    const guardrailsArr = aiResponse.guardrails_fired ?? []
    await prisma.$executeRaw`
      INSERT INTO agent.runs
        (conversa_id, lead_id, user_message_id, agent_used, stage,
         input_tokens, output_tokens, latency_ms,
         reply_raw, reply_final, tool_calls, guardrails_fired, model)
      VALUES
        (${ctx.conversaId}, ${ctx.leadId}, ${ctx.mensagemInId},
         ${aiResponse.agent_used ?? 'unknown'}, ${aiResponse.stage ?? null},
         ${aiResponse.input_tokens ?? null}, ${aiResponse.output_tokens ?? null},
         ${aiResponse.latency_ms ?? null},
         ${aiResponse.reply_raw ?? aiResponse.reply}, ${aiResponse.reply},
         ${toolCallsJson}::jsonb, ${guardrailsArr}::text[], ${aiResponse.model ?? null})
      ON CONFLICT ON CONSTRAINT uq_agent_run_per_user_message DO NOTHING
    `
  } catch (err) {
    console.error('[worker] INSERT agent.runs falhou', {
      conversaId: ctx.conversaId.toString(),
      error: err instanceof Error ? err.message : err,
    })
    // Não escala — trace failure não bloqueia atendimento.
  }

  if (!sendOk) {
    // Log só — worker já enfileirou retry. Não escala pra humano aqui
    // (retrySender vai escalar se esgotar as 3 tentativas).
    console.warn('[worker] reply enfileirada pra retry', {
      mensagemId: mensagemOut.id.toString(),
      conversaId: ctx.conversaId.toString(),
    })
  }
}

// ─────────────────────────────────────────────────────────────
// Handler principal — 1 job por vez
// ─────────────────────────────────────────────────────────────

async function processJob(job: InboundJob): Promise<void> {
  const startedAt = Date.now()

  // TX1: persiste inbound (lead, conversa, mensagem, evento)
  let ctx: InboundContext
  try {
    ctx = await persistInbound(job)
  } catch (err) {
    console.error('[worker] persistInbound falhou — reenfileirando', {
      waId: job.waId,
      wamid: job.messageId,
      error: err instanceof Error ? err.message : err,
    })
    await sendAlert(
      `Worker persistInbound falhou\n` +
        `waId: ${job.waId}\n` +
        `wamid: ${job.messageId}\n` +
        `error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500),
      'error'
    )
    throw err // deixa pg-boss fazer retry (retryLimit=3 no enqueue)
  }

  // Idempotency hit — evento já existia, não reprocessa
  if (!ctx.firstTimeProcessed) {
    console.log('[worker] idempotency hit (evento já processado)', {
      wamid: job.messageId,
      conversaId: ctx.conversaId.toString(),
    })
    return
  }

  // ───────── Pre-guardrail: prompt injection ─────────
  const injection = detectPromptInjection(job.userMessage)
  if (injection.matched) {
    console.warn('[worker] prompt injection detectado — escalando', {
      waId: job.waId,
      conversaId: ctx.conversaId.toString(),
      tags: injection.tags,
    })
    await escalateToHuman(ctx, job.waId, 'prompt_injection_suspected', {
      tags: injection.tags,
      matched_text: injection.matchedText?.slice(0, 200),
    })
    return // NÃO chama ai-service
  }

  // ───────── Media download (áudio/imagem) ─────────
  let imageBase64: string | undefined
  let messageForAi = job.userMessage

  if (job.mediaType && (job.mediaType === 'image' || job.mediaType === 'audio') && job.mediaUrl) {
    try {
      const media = await downloadMedia(job.mediaUrl, {
        isAudio: job.mediaType === 'audio',
      })
      if (job.mediaType === 'image') {
        imageBase64 = media.base64
      }
      // Áudio: por ora, descrição textual. Integração Whisper vem do Team C.
      // O ai-service recebe `messageForAi` como texto — se Whisper for invocado upstream,
      // o worker pode passar o transcript aqui. Enquanto isso, mantém o placeholder "[áudio]".
    } catch (err) {
      if (err instanceof MediaTooLargeError) {
        console.warn('[worker] mídia muito grande — ignorada', {
          wamid: job.messageId,
          size: err.sizeBytes,
          limit: err.limitBytes,
        })
        messageForAi = `${job.userMessage} [mídia acima do limite de tamanho]`
      } else if (err instanceof AudioTooLongError) {
        console.warn('[worker] áudio longo demais — ignorado', {
          wamid: job.messageId,
          duration: err.durationSeconds,
          limit: err.limitSeconds,
        })
        messageForAi = `${job.userMessage} [áudio mais longo que ${err.limitSeconds}s — pedir ao cliente pra resumir em texto]`
      } else {
        console.error('[worker] downloadMedia falhou', {
          wamid: job.messageId,
          mediaUrl: job.mediaUrl,
          error: err instanceof Error ? err.message : err,
        })
        messageForAi = `${job.userMessage} [falha ao baixar mídia]`
      }
    }
  }

  // ───────── Chama ai-service ─────────
  let aiResponse: AiServiceResponse
  try {
    aiResponse = await callAiService({
      company_id: SUPERBEM_COMPANY_ID,
      client_phone: job.waId,
      message: messageForAi,
      image_base64: imageBase64,
    })
  } catch (err) {
    console.error('[worker] ai-service falhou — escalando', {
      waId: job.waId,
      conversaId: ctx.conversaId.toString(),
      error: err instanceof Error ? err.message : err,
    })
    await escalateToHuman(ctx, job.waId, 'ai_service_failure', {
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    })
    return
  }

  // Resposta vazia do ai-service → escala
  if (!aiResponse.reply || aiResponse.reply.trim().length === 0) {
    console.warn('[worker] ai-service retornou reply vazia — escalando', {
      waId: job.waId,
      conversaId: ctx.conversaId.toString(),
    })
    await escalateToHuman(ctx, job.waId, 'empty_reply', {
      agent_used: aiResponse.agent_used,
      stage: aiResponse.stage,
    })
    return
  }

  // ───────── TX2: envia reply + registra trace ─────────
  try {
    await persistAndSendReply(ctx, job.waId, aiResponse)
  } catch (err) {
    console.error('[worker] persistAndSendReply falhou', {
      conversaId: ctx.conversaId.toString(),
      error: err instanceof Error ? err.message : err,
    })
    await sendAlert(
      `Worker persistAndSendReply falhou\n` +
        `conversa_id: ${ctx.conversaId.toString()}\n` +
        `telefone: ${job.waId}\n` +
        `error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500),
      'error'
    )
  }

  const totalMs = Date.now() - startedAt
  console.log('[worker] job processado', {
    waId: job.waId,
    conversaId: ctx.conversaId.toString(),
    agent: aiResponse.agent_used,
    totalMs,
  })
}

// ─────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────

/**
 * Registra o worker inbound em pg-boss. Chamar 1× no startup do api-node.
 */
export async function startInboundWorker(): Promise<void> {
  console.log('[worker] registrando consumer de', QUEUE_INBOUND)

  await registerInboundWorker(async (jobs: InboundJob[]) => {
    for (const job of jobs) {
      const { allowed, count, resetIn } = rateLimitByWaId(job.waId)
      if (!allowed) {
        console.warn('[worker] rate limited', { waId: job.waId, count, resetIn })
        // Informa o cliente UMA ÚNICA VEZ (quando cruzar o limite)
        if (count === RATE_LIMIT_MAX_PER_WINDOW + 1) {
          await providerSend(
            job.waId,
            'Oi! Muitas mensagens em pouco tempo. Vou responder em instantes, aguarde 🙏'
          ).catch(() => {})
        }
        continue
      }
      try {
        await processJob(job)
      } catch (err) {
        // Propaga pro pg-boss — respeita retryLimit do enqueue
        console.error('[worker] processJob falhou (propagando pra pg-boss)', {
          waId: job.waId,
          wamid: job.messageId,
          error: err instanceof Error ? err.message : err,
        })
        throw err
      }
    }
  })

  console.log('[worker] consumer ativo')
}
