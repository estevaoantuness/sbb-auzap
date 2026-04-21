/**
 * Lead (cliente) types — Superbem.
 * Campos "safe" que podem ser editados pelo painel. Campos derivados (totalGasto,
 * segmentoRfm etc.) são calculados por triggers/jobs e NÃO devem ser aceitos no PATCH.
 */

export interface UpdateLeadDTO {
  nomeReal?: string | null
  apelido?: string | null
  bairro?: string | null
  cidade?: string | null
  estado?: string | null
  enderecoPreferido?: string | null
  optInMarketing?: boolean
  tipoEntregaPreferida?: string | null
}

export interface UpsertPreferenceDTO {
  // Exemplo: { tipo: 'categoria_favorita', valor: 'carnes' } — schema exato vem da RPC.
  tipo: string
  valor: string
  peso?: number
}

export interface LeadListQuery {
  search?: string
  limit?: string
  offset?: string
}
