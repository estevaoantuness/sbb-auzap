-- =============================================================================
-- 20260422000030_crm_grants_to_sbb_app.sql
-- Concede SELECT/INSERT/UPDATE/DELETE em crm.* pro role sbb_app (runtime
-- do api-node). Sem isso todas as rotas /conversations /clients /campaigns
-- voltam 500 "permission denied for table ...".
--
-- sbb_app já tem full access em agent.* e public.*; crm.* foi criado pela
-- equipe Superbem e nunca teve GRANT. Idempotente.
-- =============================================================================

DO $$
BEGIN
  -- Role sbb_app pode não existir em dev local — skip se for o caso.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sbb_app') THEN
    RAISE NOTICE 'Role sbb_app não existe — skip';
    RETURN;
  END IF;

  GRANT USAGE ON SCHEMA crm TO sbb_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA crm TO sbb_app;
  GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA crm TO sbb_app;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA crm TO sbb_app;

  -- Default privileges pra objetos futuros criados por postgres/superuser
  ALTER DEFAULT PRIVILEGES IN SCHEMA crm GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sbb_app;
  ALTER DEFAULT PRIVILEGES IN SCHEMA crm GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO sbb_app;
  ALTER DEFAULT PRIVILEGES IN SCHEMA crm GRANT EXECUTE ON FUNCTIONS TO sbb_app;
END $$;
