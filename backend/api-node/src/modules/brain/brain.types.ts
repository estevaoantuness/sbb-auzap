/**
 * Types do brain do dashboard — Superbem single-tenant.
 * Chat operador → tools de consulta (faturamento, produtos, leads, pedidos).
 */

export interface BrainMessage {
  role: 'user' | 'assistant' | 'tool'
  content: string
  // Quando role='tool', identifica qual chamada gerou este conteúdo.
  tool_call_id?: string
  name?: string
}

export interface BrainToolCallSummary {
  name: string
  args_summary?: string
  ok: boolean
}

export interface BrainResponse {
  reply: string
  tool_calls: BrainToolCallSummary[]
  model_used?: string
}
