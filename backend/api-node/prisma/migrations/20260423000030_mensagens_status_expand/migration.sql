-- =============================================================================
-- 20260423000030_mensagens_status_expand.sql
-- Check constraint mensagens_status_check só aceita 'pendente','enviada',
-- 'entregue','lida','falha'. Worker/retrySender usam 'falha_envio' e
-- 'falha_permanente' pra diferenciar retry-possível vs deu-ruim-de-vez.
-- Expande a lista.
-- =============================================================================

ALTER TABLE crm.mensagens DROP CONSTRAINT IF EXISTS mensagens_status_check;
ALTER TABLE crm.mensagens ADD CONSTRAINT mensagens_status_check
  CHECK (status = ANY (ARRAY[
    'pendente'::text,
    'enviada'::text,
    'entregue'::text,
    'lida'::text,
    'falha'::text,
    'falha_envio'::text,
    'falha_permanente'::text
  ]));
