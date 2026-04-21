-- =============================================================================
-- 007_role_auditor.sql
-- Cria role `auditor` read-only pra dashboards internos / compliance
--
-- EXECUÇÃO MANUAL (não automatizar — senha é gerada localmente):
--   RAND=$(openssl rand -hex 16) && echo "auditor password: $RAND" > ~/.sbb-auzap-secrets.local
--   psql -U postgres -d sbb -v auditor_pwd="'$RAND'" -f 007_role_auditor.sql
-- =============================================================================

-- Senha via psql variable (preferred sobre hardcode)
\set auditor_pwd `echo "'$AUDITOR_PWD'"`

-- Cria role se não existir (idempotente)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auditor') THEN
    EXECUTE format('CREATE ROLE auditor NOINHERIT LOGIN PASSWORD %L', current_setting('auditor_pwd', true));
  END IF;
END $$;

-- Grants
GRANT CONNECT ON DATABASE sbb TO auditor;
GRANT USAGE ON SCHEMA crm, agent TO auditor;

GRANT SELECT ON ALL TABLES IN SCHEMA crm TO auditor;
GRANT SELECT ON ALL TABLES IN SCHEMA agent TO auditor;

-- Default privileges (tabelas futuras)
ALTER DEFAULT PRIVILEGES IN SCHEMA crm GRANT SELECT ON TABLES TO auditor;
ALTER DEFAULT PRIVILEGES IN SCHEMA agent GRANT SELECT ON TABLES TO auditor;

-- RLS — policies de leitura
CREATE POLICY IF NOT EXISTS auditor_read ON agent.runs                FOR SELECT TO auditor USING (true);
CREATE POLICY IF NOT EXISTS auditor_read ON agent.shadow_runs         FOR SELECT TO auditor USING (true);
CREATE POLICY IF NOT EXISTS auditor_read ON agent.conversa_sumarios   FOR SELECT TO auditor USING (true);

COMMENT ON ROLE auditor IS 'Read-only role para dashboards internos e compliance LGPD. Senha em ~/.sbb-auzap-secrets.local (gitignored)';
