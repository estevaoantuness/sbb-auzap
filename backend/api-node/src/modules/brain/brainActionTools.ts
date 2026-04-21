import { prisma } from '../../lib/db'

/**
 * Tools do brain do dashboard — consultas agregadas pro operador Super Bem Barato.
 *
 * Cada tool:
 *   - schema JSON-Schema pra function-calling
 *   - handler que executa query e retorna JSON STRINGIFIED (OpenAI espera string).
 *
 * Todas consultam views prontas no schema `public` (CISS sync) ou `crm.leads`.
 */

type ToolParams = Record<string, unknown>

export interface BrainTool {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
    additionalProperties: false
  }
  handler: (args: ToolParams) => Promise<string>
}

function serializeBigInt<T>(obj: T): T {
  return JSON.parse(
    JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
  )
}

// ─── 1. Faturamento de hoje ──────────────────────────────────────────────────

const queryFaturamentoHoje: BrainTool = {
  name: 'query_faturamento_hoje',
  description: 'Consulta o faturamento bruto e líquido de hoje e compara com ontem.',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  handler: async () => {
    const rows = await prisma.$queryRaw<
      Array<{
        dia: Date | string
        faturamento_bruto: string | number | null
        faturamento_liquido: string | number | null
        total_pedidos: number | null
      }>
    >`
      SELECT dia, faturamento_bruto, faturamento_liquido, total_pedidos
      FROM public.v_faturamento_diario_net
      WHERE dia >= (CURRENT_DATE - 1)
      ORDER BY dia DESC
      LIMIT 2
    `
    const hoje = rows.find((r) => {
      const d = typeof r.dia === 'string' ? r.dia.slice(0, 10) : r.dia.toISOString().slice(0, 10)
      const today = new Date().toISOString().slice(0, 10)
      return d === today
    })
    const ontem = rows.find((r) => r !== hoje)

    return JSON.stringify({
      hoje: hoje
        ? {
            faturamento_bruto: Number(hoje.faturamento_bruto ?? 0),
            faturamento_liquido: Number(hoje.faturamento_liquido ?? 0),
            total_pedidos: Number(hoje.total_pedidos ?? 0),
          }
        : null,
      ontem: ontem
        ? {
            faturamento_bruto: Number(ontem.faturamento_bruto ?? 0),
            faturamento_liquido: Number(ontem.faturamento_liquido ?? 0),
            total_pedidos: Number(ontem.total_pedidos ?? 0),
          }
        : null,
    })
  },
}

// ─── 2. Top produtos ─────────────────────────────────────────────────────────

const queryTopProdutos: BrainTool = {
  name: 'query_top_produtos',
  description:
    'Lista os N produtos mais vendidos nos últimos D dias, ordenados por faturamento líquido.',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
      days: { type: 'integer', minimum: 1, maximum: 365, default: 7 },
    },
    additionalProperties: false,
  },
  handler: async (args) => {
    const limit = Math.min(Math.max(Number(args.limit ?? 10) || 10, 1), 50)
    const days = Math.min(Math.max(Number(args.days ?? 7) || 7, 1), 365)
    const rows = await prisma.$queryRaw<
      Array<{
        erp_id: string
        nome: string
        categoria: string | null
        total_vendido: string | number | null
        faturamento_liquido: string | number | null
      }>
    >`
      SELECT erp_id, nome, categoria, total_vendido, faturamento_liquido
      FROM public.v_top_produtos_net
      WHERE dia >= (CURRENT_DATE - ${days}::integer)
      ORDER BY faturamento_liquido DESC NULLS LAST
      LIMIT ${limit}
    `
    return JSON.stringify({
      days,
      limit,
      products: rows.map((r) => ({
        erp_id: r.erp_id,
        nome: r.nome,
        categoria: r.categoria,
        total_vendido: Number(r.total_vendido ?? 0),
        faturamento_liquido: Number(r.faturamento_liquido ?? 0),
      })),
    })
  },
}

// ─── 3. Leads em risco (churn) ───────────────────────────────────────────────

const queryLeadsEmRisco: BrainTool = {
  name: 'query_leads_em_risco',
  description:
    'Lista leads com segmentação RFM "em_risco" ou "hibernando" — candidatos a campanha de reengajamento.',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      only_opt_in: {
        type: 'boolean',
        default: true,
        description: 'Se true, retorna só quem aceitou marketing (LGPD).',
      },
    },
    additionalProperties: false,
  },
  handler: async (args) => {
    const limit = Math.min(Math.max(Number(args.limit ?? 20) || 20, 1), 100)
    const onlyOptIn = args.only_opt_in !== false

    const rows = await prisma.lead.findMany({
      where: {
        segmentoRfm: { in: ['em_risco', 'hibernando'] },
        ...(onlyOptIn ? { optInMarketing: true } : {}),
      },
      orderBy: { ultimaConversaAt: 'desc' },
      take: limit,
      select: {
        id: true,
        telefone: true,
        nomeReal: true,
        nomeWhatsapp: true,
        bairro: true,
        segmentoRfm: true,
        totalGasto: true,
        ticketMedio: true,
        ultimoPedidoAt: true,
      },
    })

    return JSON.stringify({
      count: rows.length,
      leads: serializeBigInt(rows),
    })
  },
}

// ─── 4. Pedidos pendentes ────────────────────────────────────────────────────

const queryPedidosPendentes: BrainTool = {
  name: 'query_pedidos_pendentes',
  description:
    'Lista pedidos com status "confirmado" ou "em_separacao" — operacional do dia.',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
    },
    additionalProperties: false,
  },
  handler: async (args) => {
    const limit = Math.min(Math.max(Number(args.limit ?? 30) || 30, 1), 100)

    const rows = await prisma.pedido.findMany({
      where: {
        status: { in: ['confirmado', 'em_separacao', 'saiu_entrega'] },
      },
      orderBy: { confirmadoAt: 'asc' },
      take: limit,
      select: {
        id: true,
        numero: true,
        telefone: true,
        status: true,
        total: true,
        tipoEntrega: true,
        bairroEntrega: true,
        confirmadoAt: true,
        lead: { select: { nomeReal: true, nomeWhatsapp: true } },
      },
    })

    return JSON.stringify({
      count: rows.length,
      orders: serializeBigInt(rows),
    })
  },
}

// ─── 5. Agente IA (KPIs) ─────────────────────────────────────────────────────

const queryAgentKpis: BrainTool = {
  name: 'query_agent_kpis',
  description:
    'KPIs da IA Maria nas últimas 24h: volume, latência P95 e custo estimado em BRL.',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  handler: async () => {
    const rows = await prisma.$queryRaw<
      Array<{
        total_runs: bigint | number | null
        p95_ms: number | null
        input_tokens: bigint | number | null
        output_tokens: bigint | number | null
      }>
    >`
      SELECT
        COUNT(*)::bigint                                                  AS total_runs,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)::integer AS p95_ms,
        COALESCE(SUM(input_tokens), 0)::bigint                            AS input_tokens,
        COALESCE(SUM(output_tokens), 0)::bigint                           AS output_tokens
      FROM agent.runs
      WHERE created_at >= NOW() - INTERVAL '24 hours'
    `
    const r = rows[0] ?? { total_runs: 0, p95_ms: 0, input_tokens: 0, output_tokens: 0 }
    return JSON.stringify({
      total_runs_24h: Number(r.total_runs ?? 0),
      latencia_p95_ms: Number(r.p95_ms ?? 0),
      input_tokens: Number(r.input_tokens ?? 0),
      output_tokens: Number(r.output_tokens ?? 0),
    })
  },
}

// ─── Registro global ─────────────────────────────────────────────────────────

export const BRAIN_TOOLS: BrainTool[] = [
  queryFaturamentoHoje,
  queryTopProdutos,
  queryLeadsEmRisco,
  queryPedidosPendentes,
  queryAgentKpis,
]

export const BRAIN_TOOLS_BY_NAME: Record<string, BrainTool> = Object.fromEntries(
  BRAIN_TOOLS.map((t) => [t.name, t])
)
