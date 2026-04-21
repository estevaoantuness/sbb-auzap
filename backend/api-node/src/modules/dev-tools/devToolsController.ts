import { Request, Response } from 'express'
import { prisma } from '../../lib/db'
import { sendMessage as sendCloudApi } from '../whatsapp/providers/cloudApi'

/**
 * Dev-tools Superbem — APENAS pra operação/troubleshooting. Protegido por
 * `x-dev-tools-key` (verifyDevToolsKey). Default: bloqueia em prod sem key.
 */

function serializeBigInt<T>(obj: T): T {
  return JSON.parse(
    JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
  )
}

// ─── GET /dev-tools/db-info ──────────────────────────────────────────────────
/**
 * Snapshot do banco: contagens principais, última conversa, agent runs últimas 24h.
 */
export async function getDbInfo(_req: Request, res: Response) {
  try {
    const [leadsCount, conversasCount, mensagensCount, pedidosCount, vitrineCount] = await Promise.all([
      prisma.lead.count(),
      prisma.conversa.count(),
      prisma.mensagem.count(),
      prisma.pedido.count(),
      prisma.vitrine.count({ where: { temEstoque: true } }),
    ])

    const lastConversa = await prisma.conversa.findFirst({
      orderBy: { iniciadaAt: 'desc' },
      select: { id: true, leadId: true, telefone: true, iniciadaAt: true, encerradaAt: true },
    })

    const agentRuns24h = await prisma.$queryRaw<Array<{ c: bigint }>>`
      SELECT COUNT(*)::bigint AS c FROM agent.runs WHERE created_at >= NOW() - INTERVAL '24 hours'
    `

    res.json(
      serializeBigInt({
        counts: {
          leads: leadsCount,
          conversas: conversasCount,
          mensagens: mensagensCount,
          pedidos: pedidosCount,
          vitrine_em_estoque: vitrineCount,
          agent_runs_24h: Number(agentRuns24h[0]?.c ?? 0),
        },
        last_conversa: lastConversa,
        db_url_host: maskDatabaseUrl(process.env.DATABASE_URL),
        node_env: process.env.NODE_ENV ?? 'development',
      })
    )
  } catch (err) {
    console.error('[dev-tools] db-info:', err)
    res.status(500).json({ error: 'Failed to fetch db info' })
  }
}

// ─── POST /dev-tools/send-message ────────────────────────────────────────────
/**
 * Envia mensagem Cloud API direto — contorna a fila.
 * Body: { phone, message }
 */
export async function sendMessageDirect(req: Request, res: Response) {
  try {
    const phone = String(req.body?.phone ?? '').replace(/\D/g, '')
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : ''
    if (!phone || !message) {
      return res.status(400).json({ error: 'phone e message são obrigatórios' })
    }

    const wamid = await sendCloudApi(phone, message)
    res.json({ success: true, to: phone, wamid })
  } catch (err) {
    console.error('[dev-tools] send-message:', err)
    res.status(500).json({ error: 'Failed to send message', detail: (err as Error).message })
  }
}

// ─── POST /dev-tools/lead ────────────────────────────────────────────────────
/**
 * Cria lead fake para QA/E2E. Body: { telefone, nome_real?, bairro? }
 */
export async function createLead(req: Request, res: Response) {
  try {
    const telefone = String(req.body?.telefone ?? '').replace(/\D/g, '')
    if (!telefone) {
      return res.status(400).json({ error: 'telefone obrigatório' })
    }

    const nomeReal = req.body?.nome_real ? String(req.body.nome_real).trim() : null
    const bairro = req.body?.bairro ? String(req.body.bairro).trim() : null

    const lead = await prisma.lead.upsert({
      where: { telefone },
      create: {
        telefone,
        nomeReal,
        bairro,
      },
      update: {
        nomeReal: nomeReal ?? undefined,
        bairro: bairro ?? undefined,
      },
    })

    res.status(201).json(serializeBigInt(lead))
  } catch (err) {
    console.error('[dev-tools] createLead:', err)
    res.status(500).json({ error: 'Failed to create lead' })
  }
}

// ─── DELETE /dev-tools/lead/:telefone ────────────────────────────────────────
/**
 * Limpa lead (e deps) — usar com carinho, irreversível.
 */
export async function deleteLead(req: Request, res: Response) {
  try {
    const telefone = String(req.params.telefone ?? '').replace(/\D/g, '')
    if (!telefone) {
      return res.status(400).json({ error: 'telefone obrigatório' })
    }

    const lead = await prisma.lead.findUnique({ where: { telefone } })
    if (!lead) {
      return res.status(404).json({ error: 'lead não encontrado' })
    }

    // Usa a função de anonimização (mantém dados estatísticos mas apaga PII)
    try {
      await prisma.$executeRaw`SELECT crm.anonimizar_lead(${lead.id}::bigint)`
      return res.json({ success: true, action: 'anonymized', lead_id: lead.id.toString() })
    } catch (err) {
      console.warn('[dev-tools] anonimizar_lead RPC falhou, tentando delete direto:', err)
    }

    // Fallback: delete cascade manual (só rola se não tiver FKs bloqueantes)
    await prisma.$transaction([
      prisma.mensagem.deleteMany({ where: { leadId: lead.id } }),
      prisma.eventoLead.deleteMany({ where: { leadId: lead.id } }),
      prisma.pedido.deleteMany({ where: { leadId: lead.id } }),
      prisma.conversa.deleteMany({ where: { leadId: lead.id } }),
      prisma.lead.delete({ where: { id: lead.id } }),
    ])

    res.json({ success: true, action: 'deleted', lead_id: lead.id.toString() })
  } catch (err) {
    console.error('[dev-tools] deleteLead:', err)
    res.status(500).json({ error: 'Failed to delete lead' })
  }
}

function maskDatabaseUrl(url: string | undefined): string {
  if (!url) return ''
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.hostname}:${u.port}${u.pathname}`
  } catch {
    return '***'
  }
}
