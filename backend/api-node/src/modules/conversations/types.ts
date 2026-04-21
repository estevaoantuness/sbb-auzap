/**
 * Conversation types — Superbem single-tenant.
 */

export interface SendMessageDTO {
  content: string
}

export interface ConversationListQuery {
  status?: 'ativa' | 'encerrada'
  limit?: string
  before_id?: string
  search?: string
}

export interface MessagesListQuery {
  before?: string
  limit?: string
}
