import { Request, Response } from 'express'
import { prisma } from '../../lib/db'
import { sendMessage as sendCloudApiMessage } from '../whatsapp/providers/cloudApi'

/**
 * Helper — converte `BigInt` em `string` pra serializar JSON (Prisma BigInt não é JSON-safe).
 */
function serializeBigInt<T>(obj: T): T {
  return JSON.parse(
    JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
  )
}

function parseLimit(raw: unknown, def = 50, max = 200): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return def
  return Math.min(Math.floor(n), max)
}

function parseBigIntParam(raw: unknown): bigint | null {
  if (raw == null) return null
  const s = String(raw).trim()
  if (!s) return null
  try {
    return BigInt(s)
  } catch {
    return null
  }
}

/**
 * GET /conversations?status=ativa&limit=50&search=...&before_id=...
 * Lista conversas com JOIN em lead (nome/telefone) + LEFT JOIN na última mensagem.
 * Paginação keyset descendente por id.
 */
export async function listConversations(req: Request, res: Response) {
  try {
    const status = (req.query.status as string | undefined)?.trim()
    const limit = parseLimit(req.query.limit)
    const beforeId = parseBigIntParam(req.query.before_id)
    const search = (req.query.search as string | undefined)?.trim()

    // Query raw pra trazer última mensagem num único round-trip (evita N+1).
    // Schema: crm.conversas ⨝ crm.leads ⨝ LATERAL (última mensagem)
    const rows = await prisma.$queryRaw<
      Array<{
        id: bigint
        lead_id: bigint
        telefone: string
        iniciada_at: Date
        encerrada_at: Date | null
        total_mensagens: number
        teve_pedido: boolean
        intencao_detectada: string | null
        nome_real: string | null
        nome_whatsapp: string | null
        bairro: string | null
        opt_in_marketing: boolean
        last_message_content: string | null
        last_message_at: Date | null
        last_message_direcao: string | null
      }>
    >`
      SELECT
        c.id,
        c.lead_id,
        c.telefone,
        c.iniciada_at,
        c.encerrada_at,
        c.total_mensagens,
        c.teve_pedido,
        c.intencao_detectada,
        l.nome_real,
        l.nome_whatsapp,
        l.bairro,
        l.opt_in_marketing,
        m.conteudo            AS last_message_content,
        m.created_at          AS last_message_at,
        m.direcao             AS last_message_direcao
      FROM crm.conversas c
      JOIN crm.leads l ON l.id = c.lead_id
      LEFT JOIN LATERAL (
        SELECT conteudo, created_at, direcao
        FROM crm.mensagens
        WHERE conversa_id = c.id
        ORDER BY id DESC
        LIMIT 1
      ) m ON TRUE
      WHERE
        (${status}::text IS NULL OR
         (${status}::text = 'ativa'     AND c.encerrada_at IS NULL) OR
         (${status}::text = 'encerrada' AND c.encerrada_at IS NOT NULL))
        AND (${beforeId ? beforeId.toString() : null}::bigint IS NULL OR c.id < ${beforeId ? beforeId.toString() : null}::bigint)
        AND (${search ?? null}::text IS NULL OR (
          l.nome_real     ILIKE '%' || ${search ?? null}::text || '%' OR
          l.nome_whatsapp ILIKE '%' || ${search ?? null}::text || '%' OR
          c.telefone      ILIKE '%' || ${search ?? null}::text || '%'
        ))
      ORDER BY c.id DESC
      LIMIT ${limit}
    `

    const shaped = rows.map((r) => ({
      id: r.id.toString(),
      lead_id: r.lead_id.toString(),
      telefone: r.telefone,
      iniciada_at: r.iniciada_at,
      encerrada_at: r.encerrada_at,
      total_mensagens: r.total_mensagens,
      teve_pedido: r.teve_pedido,
      intencao_detectada: r.intencao_detectada,
      lead: {
        id: r.lead_id.toString(),
        nome_real: r.nome_real,
        nome_whatsapp: r.nome_whatsapp,
        bairro: r.bairro,
        opt_in_marketing: r.opt_in_marketing,
      },
      last_message: r.last_message_content
        ? {
            conteudo: r.last_message_content,
            direcao: r.last_message_direcao,
            created_at: r.last_message_at,
          }
        : null,
    }))

    const next_before_id = rows.length === limit ? rows[rows.length - 1]!.id.toString() : null

    res.json({ conversations: shaped, next_before_id })
  } catch (error) {
    console.error('[conversations] listConversations error:', error)
    res.status(500).json({ error: 'Failed to list conversations' })
  }
}

/**
 * GET /conversations/:id/messages?before=<msg_id>&limit=50
 * Paginação reversa (keyset descendente).
 */
export async function listMessages(req: Request, res: Response) {
  try {
    const conversaId = parseBigIntParam(req.params.id)
    if (!conversaId) {
      return res.status(400).json({ error: 'invalid conversation id' })
    }

    const limit = parseLimit(req.query.limit)
    const before = parseBigIntParam(req.query.before)

    const messages = await prisma.mensagem.findMany({
      where: {
        conversaId,
        ...(before ? { id: { lt: before } } : {}),
      },
      orderBy: { id: 'desc' },
      take: limit,
    })

    // Inverte pra ordem cronológica (front-end espera assim).
    const chronological = [...messages].reverse()

    const next_before = messages.length === limit ? messages[messages.length - 1]!.id.toString() : null

    res.json({
      messages: serializeBigInt(chronological),
      next_before,
    })
  } catch (error) {
    console.error('[conversations] listMessages error:', error)
    res.status(500).json({ error: 'Failed to list messages' })
  }
}

/**
 * POST /conversations/:id/messages
 * Envio manual pelo operador. Body: { content: string }
 * - Insere `crm.mensagens` (direcao=out, tipo=texto, status=pendente)
 * - Chama Cloud API sendMessage
 * - Updata status='enviada' + message_id_waba
 * - Pausa IA na conversa via RPC crm.pausar_ia
 */
export async function sendManualMessage(req: Request, res: Response) {
  try {
    const conversaId = parseBigIntParam(req.params.id)
    if (!conversaId) {
      return res.status(400).json({ error: 'invalid conversation id' })
    }

    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : ''
    if (!content) {
      return res.status(400).json({ error: 'content is required' })
    }

    const conversa = await prisma.conversa.findUnique({
      where: { id: conversaId },
      select: { id: true, leadId: true, telefone: true },
    })
    if (!conversa) {
      return res.status(404).json({ error: 'Conversation not found' })
    }

    const inserted = await prisma.mensagem.create({
      data: {
        conversaId,
        leadId: conversa.leadId,
        telefone: conversa.telefone,
        direcao: 'out',
        tipo: 'texto',
        conteudo: content,
        status: 'pendente',
      },
    })

    // Pausa a IA — operador assumiu o atendimento
    try {
      await prisma.$executeRaw`SELECT crm.pausar_ia(${conversaId}::bigint)`
    } catch (err) {
      console.warn('[conversations] pausar_ia RPC falhou (continuando envio):', err)
    }

    // Envia via Cloud API (não awaita retornar sucesso pra responder 200 rápido NÃO —
    // aqui queremos saber status. Se retry interno do cloudApi falhar, updata status=falha_envio).
    try {
      const wamid = await sendCloudApiMessage(conversa.telefone, content)
      await prisma.mensagem.update({
        where: { id: inserted.id },
        data: { status: 'enviada', messageIdWaba: wamid },
      })
      return res.status(201).json({
        success: true,
        message: serializeBigInt({ ...inserted, status: 'enviada', messageIdWaba: wamid }),
      })
    } catch (sendErr) {
      console.error('[conversations] cloudApi.sendMessage falhou:', sendErr)
      await prisma.mensagem.update({
        where: { id: inserted.id },
        data: { status: 'falha_envio' },
      })
      return res.status(502).json({
        error: 'Falha ao enviar mensagem via WhatsApp',
        detail: String((sendErr as Error).message ?? sendErr),
      })
    }
  } catch (error) {
    console.error('[conversations] sendManualMessage error:', error)
    res.status(500).json({ error: 'Failed to send message' })
  }
}

/**
 * POST /conversations/:id/pause-ai
 * RPC crm.pausar_ia(conversa_id).
 */
export async function pauseAi(req: Request, res: Response) {
  try {
    const conversaId = parseBigIntParam(req.params.id)
    if (!conversaId) {
      return res.status(400).json({ error: 'invalid conversation id' })
    }

    await prisma.$executeRaw`SELECT crm.pausar_ia(${conversaId}::bigint)`

    res.json({ success: true, conversation_id: conversaId.toString(), ai_paused: true })
  } catch (error) {
    console.error('[conversations] pauseAi error:', error)
    res.status(500).json({ error: 'Failed to pause AI' })
  }
}

/**
 * POST /conversations/:id/resume-ai
 * RPC crm.retomar_ia(conversa_id).
 */
export async function resumeAi(req: Request, res: Response) {
  try {
    const conversaId = parseBigIntParam(req.params.id)
    if (!conversaId) {
      return res.status(400).json({ error: 'invalid conversation id' })
    }

    await prisma.$executeRaw`SELECT crm.retomar_ia(${conversaId}::bigint)`

    res.json({ success: true, conversation_id: conversaId.toString(), ai_paused: false })
  } catch (error) {
    console.error('[conversations] resumeAi error:', error)
    res.status(500).json({ error: 'Failed to resume AI' })
  }
}
