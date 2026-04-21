import { prisma } from '../../lib/db'
import type {
  FaturamentoDiario,
  ProdutoTop,
  ProjecaoDia,
  ProjecaoSemana,
  FluxoEstoque,
  FaturamentoCategoria,
  FaturamentoHora,
  AgentKpis,
} from './dashboard.types'

/**
 * DashboardService — consome views existentes em `public.v_*` + agent.runs.
 *
 * Views de negócio (criadas pela pipeline CISS sync, NÃO owned por este backend):
 *   - v_faturamento_diario_net
 *   - v_top_produtos_net
 *   - v_projecao_dia
 *   - v_projecao_semana
 *   - v_fluxo_estoque_diario
 *   - v_faturamento_categoria_net
 *   - v_faturamento_hora
 *
 * Agente IA (sbb-auzap):
 *   - agent.runs (partições diárias) — latência P95, custo, volume
 */

// Preços default OpenAI (pt-BR / GPT-4o-mini) em BRL por 1M tokens.
// Override via env: AGENT_PRICE_INPUT_PER_MTOK_BRL, AGENT_PRICE_OUTPUT_PER_MTOK_BRL
const AGENT_PRICE_INPUT_DEFAULT = 0.75   // ~$0.15 USD * 5 (BRL)
const AGENT_PRICE_OUTPUT_DEFAULT = 3.0   // ~$0.60 USD * 5 (BRL)

function priceInputPerMTok(): number {
  const raw = process.env.AGENT_PRICE_INPUT_PER_MTOK_BRL
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? n : AGENT_PRICE_INPUT_DEFAULT
}
function priceOutputPerMTok(): number {
  const raw = process.env.AGENT_PRICE_OUTPUT_PER_MTOK_BRL
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? n : AGENT_PRICE_OUTPUT_DEFAULT
}

export class DashboardService {
  async getFaturamentoDiario(daysBack = 30): Promise<FaturamentoDiario[]> {
    const rows = await prisma.$queryRaw<
      Array<{
        dia: Date | string
        faturamento_bruto: string | number | null
        faturamento_liquido: string | number | null
        total_pedidos: number | null
        ticket_medio: string | number | null
      }>
    >`
      SELECT
        dia,
        faturamento_bruto,
        faturamento_liquido,
        total_pedidos,
        ticket_medio
      FROM public.v_faturamento_diario_net
      WHERE dia >= (CURRENT_DATE - ${daysBack}::integer)
      ORDER BY dia ASC
    `
    return rows.map((r) => ({
      dia: typeof r.dia === 'string' ? r.dia.slice(0, 10) : r.dia.toISOString().slice(0, 10),
      faturamento_bruto: Number(r.faturamento_bruto ?? 0),
      faturamento_liquido: Number(r.faturamento_liquido ?? 0),
      total_pedidos: Number(r.total_pedidos ?? 0),
      ticket_medio: r.ticket_medio != null ? Number(r.ticket_medio) : null,
    }))
  }

  async getTopProdutos(limit = 20, daysBack = 30): Promise<ProdutoTop[]> {
    const rows = await prisma.$queryRaw<
      Array<{
        erp_id: string
        nome: string
        categoria: string | null
        total_vendido: string | number | null
        faturamento_liquido: string | number | null
      }>
    >`
      SELECT
        erp_id,
        nome,
        categoria,
        total_vendido,
        faturamento_liquido
      FROM public.v_top_produtos_net
      WHERE dia >= (CURRENT_DATE - ${daysBack}::integer)
      ORDER BY faturamento_liquido DESC NULLS LAST
      LIMIT ${limit}
    `
    return rows.map((r) => ({
      erp_id: r.erp_id,
      nome: r.nome,
      categoria: r.categoria,
      total_vendido: Number(r.total_vendido ?? 0),
      faturamento_liquido: Number(r.faturamento_liquido ?? 0),
    }))
  }

  async getProjecaoDia(): Promise<ProjecaoDia | null> {
    const rows = await prisma.$queryRaw<
      Array<{
        projecao_faturamento: string | number | null
        projecao_pedidos: number | null
        confianca_percentual: string | number | null
      }>
    >`
      SELECT
        projecao_faturamento,
        projecao_pedidos,
        confianca_percentual
      FROM public.v_projecao_dia
      LIMIT 1
    `
    const r = rows[0]
    if (!r) return null
    return {
      projecao_faturamento: Number(r.projecao_faturamento ?? 0),
      projecao_pedidos: Number(r.projecao_pedidos ?? 0),
      confianca_percentual: r.confianca_percentual != null ? Number(r.confianca_percentual) : null,
    }
  }

  async getProjecaoSemana(): Promise<ProjecaoSemana | null> {
    const rows = await prisma.$queryRaw<
      Array<{
        projecao_faturamento: string | number | null
        projecao_pedidos: number | null
        dias_com_dados: number | null
      }>
    >`
      SELECT
        projecao_faturamento,
        projecao_pedidos,
        dias_com_dados
      FROM public.v_projecao_semana
      LIMIT 1
    `
    const r = rows[0]
    if (!r) return null
    return {
      projecao_faturamento: Number(r.projecao_faturamento ?? 0),
      projecao_pedidos: Number(r.projecao_pedidos ?? 0),
      dias_com_dados: Number(r.dias_com_dados ?? 0),
    }
  }

  async getFluxoEstoque(daysBack = 30): Promise<FluxoEstoque[]> {
    const rows = await prisma.$queryRaw<
      Array<{
        dia: Date | string
        categoria: string | null
        entradas: string | number | null
        saidas: string | number | null
        saldo: string | number | null
      }>
    >`
      SELECT dia, categoria, entradas, saidas, saldo
      FROM public.v_fluxo_estoque_diario
      WHERE dia >= (CURRENT_DATE - ${daysBack}::integer)
      ORDER BY dia ASC
    `
    return rows.map((r) => ({
      dia: typeof r.dia === 'string' ? r.dia.slice(0, 10) : r.dia.toISOString().slice(0, 10),
      categoria: r.categoria,
      entradas: Number(r.entradas ?? 0),
      saidas: Number(r.saidas ?? 0),
      saldo: Number(r.saldo ?? 0),
    }))
  }

  async getFaturamentoCategoria(daysBack = 30): Promise<FaturamentoCategoria[]> {
    const rows = await prisma.$queryRaw<
      Array<{
        categoria: string
        faturamento_liquido: string | number | null
        total_itens: number | null
        pct_total: string | number | null
      }>
    >`
      SELECT categoria, faturamento_liquido, total_itens, pct_total
      FROM public.v_faturamento_categoria_net
      WHERE dia_ref >= (CURRENT_DATE - ${daysBack}::integer)
      ORDER BY faturamento_liquido DESC NULLS LAST
    `
    return rows.map((r) => ({
      categoria: r.categoria,
      faturamento_liquido: Number(r.faturamento_liquido ?? 0),
      total_itens: Number(r.total_itens ?? 0),
      pct_total: Number(r.pct_total ?? 0),
    }))
  }

  async getFaturamentoHora(): Promise<FaturamentoHora[]> {
    const rows = await prisma.$queryRaw<
      Array<{
        hora: number | string
        faturamento: string | number | null
        pedidos: number | null
      }>
    >`
      SELECT hora, faturamento, pedidos
      FROM public.v_faturamento_hora
      ORDER BY hora ASC
    `
    return rows.map((r) => ({
      hora: Number(r.hora),
      faturamento: Number(r.faturamento ?? 0),
      pedidos: Number(r.pedidos ?? 0),
    }))
  }

  /**
   * KPIs do agente IA (schema agent.*):
   *   - total runs nas últimas 24h
   *   - latência P95 (percentile_cont em latency_ms)
   *   - custo estimado em BRL
   */
  async getAgentKpis(): Promise<AgentKpis> {
    const rows = await prisma.$queryRaw<
      Array<{
        total_runs: bigint | number | null
        p95_ms: number | null
        input_tokens: bigint | number | null
        output_tokens: bigint | number | null
      }>
    >`
      SELECT
        COUNT(*)::bigint                                                   AS total_runs,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)::integer  AS p95_ms,
        COALESCE(SUM(input_tokens), 0)::bigint                             AS input_tokens,
        COALESCE(SUM(output_tokens), 0)::bigint                            AS output_tokens
      FROM agent.runs
      WHERE created_at >= NOW() - INTERVAL '24 hours'
    `
    const r = rows[0] ?? { total_runs: 0, p95_ms: 0, input_tokens: 0, output_tokens: 0 }

    const inputTok = Number(r.input_tokens ?? 0)
    const outputTok = Number(r.output_tokens ?? 0)
    const custo =
      (inputTok / 1_000_000) * priceInputPerMTok() +
      (outputTok / 1_000_000) * priceOutputPerMTok()

    return {
      total_runs_24h: Number(r.total_runs ?? 0),
      latencia_p95_ms: Number(r.p95_ms ?? 0),
      custo_estimado_brl: Number(custo.toFixed(2)),
      input_tokens_24h: inputTok,
      output_tokens_24h: outputTok,
    }
  }
}
