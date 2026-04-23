-- =============================================================================
-- 20260423000020_sbb_app_bypass_rls.sql
-- Concede BYPASSRLS ao role sbb_app.
--
-- Contexto: crm.conversas, crm.leads, crm.mensagens (e outras) têm RLS
-- habilitada com policies apenas pra 'anon' (usado pelo PostgREST público).
-- O worker do api-node roda como sbb_app e bate contra RLS no primeiro
-- INSERT ("new row violates row-level security policy for table conversas").
--
-- sbb_app é role de aplicação interna/trusted (só usado pelo backend, nunca
-- exposto a clientes). Padrão Postgres pra esse caso é BYPASSRLS. Evita ter
-- que replicar 6+ policies por tabela e manter em sync.
--
-- Idempotente.
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sbb_app') THEN
    ALTER ROLE sbb_app BYPASSRLS;
    RAISE NOTICE 'sbb_app agora bypassa RLS';
  ELSE
    RAISE NOTICE 'Role sbb_app não existe — skip';
  END IF;
END $$;
