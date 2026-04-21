-- =============================================================================
-- 007_role_auditor.sql — idempotente
-- Cria role `auditor` read-only pra dashboards internos / compliance.
-- Postgres 15 não suporta CREATE POLICY IF NOT EXISTS — usa DO block.
-- =============================================================================

-- Senha via psql variable (injetada pelo entrypoint)
\set auditor_pwd `echo "'$AUDITOR_PWD'"`

-- 1. Cria role idempotente
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auditor') THEN
    EXECUTE format('CREATE ROLE auditor NOINHERIT LOGIN PASSWORD %L', current_setting('auditor_pwd', true));
  END IF;
END $$;

-- 2. Grants (idempotente — regrantar é no-op)
GRANT CONNECT ON DATABASE postgres TO auditor;
GRANT USAGE ON SCHEMA crm, agent TO auditor;
GRANT SELECT ON ALL TABLES IN SCHEMA crm TO auditor;
GRANT SELECT ON ALL TABLES IN SCHEMA agent TO auditor;
ALTER DEFAULT PRIVILEGES IN SCHEMA crm GRANT SELECT ON TABLES TO auditor;
ALTER DEFAULT PRIVILEGES IN SCHEMA agent GRANT SELECT ON TABLES TO auditor;

-- 3. Policies idempotentes — CREATE POLICY IF NOT EXISTS só >= PG16
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='agent' AND tablename='runs' AND policyname='auditor_read') THEN
    EXECUTE 'CREATE POLICY auditor_read ON agent.runs FOR SELECT TO auditor USING (true)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='agent' AND tablename='shadow_runs' AND policyname='auditor_read') THEN
    EXECUTE 'CREATE POLICY auditor_read ON agent.shadow_runs FOR SELECT TO auditor USING (true)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='agent' AND tablename='conversa_sumarios' AND policyname='auditor_read') THEN
    EXECUTE 'CREATE POLICY auditor_read ON agent.conversa_sumarios FOR SELECT TO auditor USING (true)';
  END IF;
END $$;

COMMENT ON ROLE auditor IS 'Read-only role para dashboards internos e compliance LGPD';
