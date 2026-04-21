import { Request, Response } from 'express'
import { prisma } from '../../lib/db'

/**
 * Helper: JSON-safe Prisma BigInt.
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

function parseOffset(raw: unknown): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.floor(n)
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
 * GET /clients?search=...&limit=50&offset=0
 * Lista de crm.leads com filtro de texto em nome_real/nome_whatsapp/telefone.
 */
export async function listClients(req: Request, res: Response) {
  try {
    const search = (req.query.search as string | undefined)?.trim()
    const limit = parseLimit(req.query.limit)
    const offset = parseOffset(req.query.offset)

    const where = search
      ? {
          OR: [
            { nomeReal: { contains: search, mode: 'insensitive' as const } },
            { nomeWhatsapp: { contains: search, mode: 'insensitive' as const } },
            { telefone: { contains: search } },
          ],
        }
      : {}

    const [leads, total] = await Promise.all([
      prisma.lead.findMany({
        where,
        skip: offset,
        take: limit,
        orderBy: { ultimaConversaAt: 'desc' },
      }),
      prisma.lead.count({ where }),
    ])

    res.json({
      leads: serializeBigInt(leads),
      total,
      limit,
      offset,
    })
  } catch (error) {
    console.error('[clients] listClients error:', error)
    res.status(500).json({ error: 'Failed to list clients' })
  }
}

/**
 * GET /clients/:id
 * RPC crm.fetch_customer_details(lead_id) → JSON completo (lead + preferencias + pedidos + conversas).
 */
export async function getClientDetails(req: Request, res: Response) {
  try {
    const leadId = parseBigIntParam(req.params.id)
    if (!leadId) {
      return res.status(400).json({ error: 'invalid lead id' })
    }

    const rows = await prisma.$queryRaw<Array<{ details: unknown }>>`
      SELECT crm.fetch_customer_details(${leadId}::bigint) AS details
    `

    const details = rows[0]?.details ?? null
    if (!details) {
      return res.status(404).json({ error: 'Client not found' })
    }

    res.json(details)
  } catch (error) {
    console.error('[clients] getClientDetails error:', error)
    res.status(500).json({ error: 'Failed to get client details' })
  }
}

/**
 * PATCH /clients/:id
 * Update apenas de campos "safe" — campos derivados (totalGasto, segmentoRfm...) NÃO são aceitos.
 */
export async function updateClient(req: Request, res: Response) {
  try {
    const leadId = parseBigIntParam(req.params.id)
    if (!leadId) {
      return res.status(400).json({ error: 'invalid lead id' })
    }

    const body = (req.body ?? {}) as Record<string, unknown>
    const patch: Record<string, unknown> = {}

    // Whitelist de campos editáveis
    if ('nomeReal' in body || 'nome_real' in body) {
      const v = body.nomeReal ?? body.nome_real
      patch.nomeReal = v == null ? null : String(v).trim() || null
    }
    if ('apelido' in body) {
      patch.apelido = body.apelido == null ? null : String(body.apelido).trim() || null
    }
    if ('bairro' in body) {
      patch.bairro = body.bairro == null ? null : String(body.bairro).trim() || null
    }
    if ('cidade' in body) {
      patch.cidade = body.cidade == null ? null : String(body.cidade).trim() || null
    }
    if ('estado' in body) {
      patch.estado = body.estado == null ? null : String(body.estado).trim() || null
    }
    if ('enderecoPreferido' in body || 'endereco_preferido' in body) {
      const v = body.enderecoPreferido ?? body.endereco_preferido
      patch.enderecoPreferido = v == null ? null : String(v).trim() || null
    }
    if ('optInMarketing' in body || 'opt_in_marketing' in body) {
      const v = body.optInMarketing ?? body.opt_in_marketing
      patch.optInMarketing = Boolean(v)
      // Registra timestamp do opt-in/out
      if (patch.optInMarketing === true) {
        patch.optInAt = new Date()
        patch.optOutAt = null
      } else {
        patch.optOutAt = new Date()
      }
    }
    if ('tipoEntregaPreferida' in body || 'tipo_entrega_preferida' in body) {
      const v = body.tipoEntregaPreferida ?? body.tipo_entrega_preferida
      patch.tipoEntregaPreferida = v == null ? null : String(v).trim() || null
    }

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'no valid fields to update' })
    }

    patch.updatedAt = new Date()

    try {
      const updated = await prisma.lead.update({
        where: { id: leadId },
        data: patch,
      })
      res.json(serializeBigInt(updated))
    } catch (err: any) {
      if (err?.code === 'P2025') {
        return res.status(404).json({ error: 'Client not found' })
      }
      throw err
    }
  } catch (error) {
    console.error('[clients] updateClient error:', error)
    res.status(500).json({ error: 'Failed to update client' })
  }
}

/**
 * POST /clients/:id/preferences
 * RPC crm.upsert_preference(lead_id, tipo, valor, peso).
 */
export async function upsertPreference(req: Request, res: Response) {
  try {
    const leadId = parseBigIntParam(req.params.id)
    if (!leadId) {
      return res.status(400).json({ error: 'invalid lead id' })
    }

    const tipo = typeof req.body?.tipo === 'string' ? req.body.tipo.trim() : ''
    const valor = typeof req.body?.valor === 'string' ? req.body.valor.trim() : ''
    const peso =
      req.body?.peso != null && Number.isFinite(Number(req.body.peso))
        ? Number(req.body.peso)
        : 1

    if (!tipo || !valor) {
      return res.status(400).json({ error: 'tipo and valor are required' })
    }

    const rows = await prisma.$queryRaw<Array<{ preference: unknown }>>`
      SELECT crm.upsert_preference(
        ${leadId}::bigint,
        ${tipo}::text,
        ${valor}::text,
        ${peso}::numeric
      ) AS preference
    `

    res.json({ success: true, preference: rows[0]?.preference ?? null })
  } catch (error) {
    console.error('[clients] upsertPreference error:', error)
    res.status(500).json({ error: 'Failed to upsert preference' })
  }
}
