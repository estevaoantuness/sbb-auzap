/**
 * Types do dashboard — Superbem.
 * Nomes expostos ao front em snake_case (convenção SQL existente).
 */

export interface FaturamentoDiario {
  dia: string                    // 'YYYY-MM-DD'
  faturamento_bruto: number
  faturamento_liquido: number
  total_pedidos: number
  ticket_medio: number | null
}

export interface ProdutoTop {
  erp_id: string
  nome: string
  categoria: string | null
  total_vendido: number
  faturamento_liquido: number
}

export interface ProjecaoDia {
  projecao_faturamento: number
  projecao_pedidos: number
  confianca_percentual: number | null
}

export interface ProjecaoSemana {
  projecao_faturamento: number
  projecao_pedidos: number
  dias_com_dados: number
}

export interface FluxoEstoque {
  dia: string
  categoria: string | null
  entradas: number
  saidas: number
  saldo: number
}

export interface FaturamentoCategoria {
  categoria: string
  faturamento_liquido: number
  total_itens: number
  pct_total: number
}

export interface FaturamentoHora {
  hora: number
  faturamento: number
  pedidos: number
}

export interface AgentKpis {
  total_runs_24h: number
  latencia_p95_ms: number
  custo_estimado_brl: number
  input_tokens_24h: number
  output_tokens_24h: number
}
