-- =============================================================================
-- 20260422000010_mensagens_unique_waba.sql
-- Dedup idempotente em crm.mensagens(message_id_waba).
-- Evolution API retenta webhooks (default 3x) -- sem UNIQUE, cada retry vira
-- um turno duplicado no CRM. Este índice parcial garante 1 mensagem por
-- message_id_waba quando presente, mantendo tolerância a NULLs (mensagens
-- outbound antes de persistir waba id, e testes).
--
-- CONCURRENTLY para não travar produção. NÃO rodar em transação (Prisma
-- trata CREATE INDEX CONCURRENTLY automaticamente fora de transação quando
-- migration tem apenas esse statement).
-- =============================================================================

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_mensagens_message_id_waba
  ON crm.mensagens (message_id_waba)
  WHERE message_id_waba IS NOT NULL;
