import { Request, Response } from 'express'
import { DashboardService } from './dashboard.service'

const svc = new DashboardService()

function parseDaysBack(raw: unknown, def = 30, max = 365): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return def
  return Math.min(Math.floor(n), max)
}

function parseLimit(raw: unknown, def = 20, max = 200): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return def
  return Math.min(Math.floor(n), max)
}

// ─── Faturamento ─────────────────────────────────────────────────────────────

export async function getFaturamentoDiario(req: Request, res: Response) {
  try {
    const days = parseDaysBack(req.query.days)
    const data = await svc.getFaturamentoDiario(days)
    res.json({ days, series: data })
  } catch (err) {
    console.error('[dashboard] getFaturamentoDiario:', err)
    res.status(500).json({ error: 'Failed to fetch faturamento diario' })
  }
}

export async function getTopProdutos(req: Request, res: Response) {
  try {
    const limit = parseLimit(req.query.limit)
    const days = parseDaysBack(req.query.days)
    const data = await svc.getTopProdutos(limit, days)
    res.json({ limit, days, products: data })
  } catch (err) {
    console.error('[dashboard] getTopProdutos:', err)
    res.status(500).json({ error: 'Failed to fetch top produtos' })
  }
}

export async function getProjecaoDia(_req: Request, res: Response) {
  try {
    const data = await svc.getProjecaoDia()
    res.json(data ?? { projecao_faturamento: 0, projecao_pedidos: 0, confianca_percentual: null })
  } catch (err) {
    console.error('[dashboard] getProjecaoDia:', err)
    res.status(500).json({ error: 'Failed to fetch projecao dia' })
  }
}

export async function getProjecaoSemana(_req: Request, res: Response) {
  try {
    const data = await svc.getProjecaoSemana()
    res.json(data ?? { projecao_faturamento: 0, projecao_pedidos: 0, dias_com_dados: 0 })
  } catch (err) {
    console.error('[dashboard] getProjecaoSemana:', err)
    res.status(500).json({ error: 'Failed to fetch projecao semana' })
  }
}

export async function getFluxoEstoque(req: Request, res: Response) {
  try {
    const days = parseDaysBack(req.query.days)
    const data = await svc.getFluxoEstoque(days)
    res.json({ days, series: data })
  } catch (err) {
    console.error('[dashboard] getFluxoEstoque:', err)
    res.status(500).json({ error: 'Failed to fetch fluxo estoque' })
  }
}

export async function getFaturamentoCategoria(req: Request, res: Response) {
  try {
    const days = parseDaysBack(req.query.days)
    const data = await svc.getFaturamentoCategoria(days)
    res.json({ days, categories: data })
  } catch (err) {
    console.error('[dashboard] getFaturamentoCategoria:', err)
    res.status(500).json({ error: 'Failed to fetch faturamento por categoria' })
  }
}

export async function getFaturamentoHora(_req: Request, res: Response) {
  try {
    const data = await svc.getFaturamentoHora()
    res.json({ hours: data })
  } catch (err) {
    console.error('[dashboard] getFaturamentoHora:', err)
    res.status(500).json({ error: 'Failed to fetch faturamento por hora' })
  }
}

// ─── Agente IA ───────────────────────────────────────────────────────────────

export async function getAgentKpis(_req: Request, res: Response) {
  try {
    const data = await svc.getAgentKpis()
    res.json(data)
  } catch (err) {
    console.error('[dashboard] getAgentKpis:', err)
    res.status(500).json({ error: 'Failed to fetch agent kpis' })
  }
}

// ─── KPI summary ─────────────────────────────────────────────────────────────

/**
 * GET /dashboard/kpis — snapshot pro home da dashboard.
 * Agrega as consultas principais em paralelo.
 */
export async function getKpisSummary(_req: Request, res: Response) {
  try {
    const [hoje, projecaoDia, projecaoSemana, topProdutos, agent] = await Promise.all([
      svc.getFaturamentoDiario(1),
      svc.getProjecaoDia(),
      svc.getProjecaoSemana(),
      svc.getTopProdutos(5, 7),
      svc.getAgentKpis(),
    ])
    const today = hoje[hoje.length - 1] ?? null

    res.json({
      faturamento_hoje: today,
      projecao_dia: projecaoDia,
      projecao_semana: projecaoSemana,
      top_produtos_7d: topProdutos,
      agent,
    })
  } catch (err) {
    console.error('[dashboard] getKpisSummary:', err)
    res.status(500).json({ error: 'Failed to fetch kpis' })
  }
}
