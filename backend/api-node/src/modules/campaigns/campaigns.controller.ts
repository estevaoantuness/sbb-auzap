import { Request, Response } from 'express'
import {
  listCampaigns,
  getCampaign,
  createCampaign,
  updateCampaign,
  dispatchCampaign,
  type CreateCampaignInput,
  type UpdateCampaignInput,
} from './campaigns.service'

function serializeBigInt<T>(obj: T): T {
  return JSON.parse(
    JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
  )
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
 * GET /campaigns
 */
export async function list(_req: Request, res: Response) {
  try {
    const rows = await listCampaigns()
    res.json({ campaigns: serializeBigInt(rows) })
  } catch (err) {
    console.error('[campaigns] list error:', err)
    res.status(500).json({ error: 'Failed to list campaigns' })
  }
}

/**
 * GET /campaigns/:id
 */
export async function get(req: Request, res: Response) {
  try {
    const id = parseBigIntParam(req.params.id)
    if (!id) return res.status(400).json({ error: 'invalid campaign id' })

    const row = await getCampaign(id)
    if (!row) return res.status(404).json({ error: 'Campaign not found' })
    res.json(serializeBigInt(row))
  } catch (err) {
    console.error('[campaigns] get error:', err)
    res.status(500).json({ error: 'Failed to get campaign' })
  }
}

/**
 * POST /campaigns
 * Cria campanha em status=rascunho.
 */
export async function create(req: Request, res: Response) {
  try {
    const body = (req.body ?? {}) as Partial<CreateCampaignInput>
    const nome = typeof body.nome === 'string' ? body.nome.trim() : ''
    const template = typeof body.template_mensagem === 'string' ? body.template_mensagem.trim() : ''
    if (!nome || !template) {
      return res.status(400).json({ error: 'nome and template_mensagem are required' })
    }

    const tipo = ['marketing', 'reengajamento', 'recompra', 'boas_vindas'].includes(String(body.tipo))
      ? (body.tipo as CreateCampaignInput['tipo'])
      : 'marketing'

    const input: CreateCampaignInput = {
      nome,
      tipo,
      template_mensagem: template,
      target_criteria: (body.target_criteria && typeof body.target_criteria === 'object')
        ? body.target_criteria
        : undefined,
      produto_destaque_sku: body.produto_destaque_sku ?? null,
      agendada_at: body.agendada_at ? new Date(body.agendada_at as any) : null,
    }

    const row = await createCampaign(input)
    res.status(201).json(serializeBigInt(row))
  } catch (err) {
    console.error('[campaigns] create error:', err)
    res.status(500).json({ error: 'Failed to create campaign' })
  }
}

/**
 * PATCH /campaigns/:id — só aceita edição se status=rascunho.
 */
export async function update(req: Request, res: Response) {
  try {
    const id = parseBigIntParam(req.params.id)
    if (!id) return res.status(400).json({ error: 'invalid campaign id' })

    const body = (req.body ?? {}) as Partial<UpdateCampaignInput>
    const input: UpdateCampaignInput = {
      ...(typeof body.nome === 'string' ? { nome: body.nome.trim() } : {}),
      ...(typeof body.template_mensagem === 'string'
        ? { template_mensagem: body.template_mensagem.trim() }
        : {}),
      ...(body.target_criteria ? { target_criteria: body.target_criteria } : {}),
      ...('produto_destaque_sku' in body ? { produto_destaque_sku: body.produto_destaque_sku ?? null } : {}),
      ...('agendada_at' in body ? { agendada_at: body.agendada_at ? new Date(body.agendada_at as any) : null } : {}),
    }

    try {
      const row = await updateCampaign(id, input)
      if (!row) return res.status(404).json({ error: 'Campaign not found' })
      res.json(serializeBigInt(row))
    } catch (err: any) {
      if (err?.message?.includes('rascunho')) {
        return res.status(409).json({ error: err.message })
      }
      throw err
    }
  } catch (err) {
    console.error('[campaigns] update error:', err)
    res.status(500).json({ error: 'Failed to update campaign' })
  }
}

/**
 * POST /campaigns/:id/dispatch
 * Atenção: cada mensagem outbound Meta custa ~R$ 0,20. Dispatch só após revisão humana.
 */
export async function dispatch(req: Request, res: Response) {
  try {
    const id = parseBigIntParam(req.params.id)
    if (!id) return res.status(400).json({ error: 'invalid campaign id' })

    try {
      const result = await dispatchCampaign(id)
      res.json({ campaign_id: id.toString(), ...result })
    } catch (err: any) {
      const msg = err?.message ?? String(err)
      if (msg.includes('não pode') || msg.includes('não encontrada')) {
        return res.status(409).json({ error: msg })
      }
      throw err
    }
  } catch (err) {
    console.error('[campaigns] dispatch error:', err)
    res.status(500).json({ error: 'Failed to dispatch campaign' })
  }
}
