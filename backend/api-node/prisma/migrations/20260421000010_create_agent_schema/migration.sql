-- =============================================================================
-- 001_create_agent_schema.sql
-- Cria schema agent.* para AuZap brain (Maria v2)
-- Prisma é APENAS consumer (db pull + generate client); nunca migrate dev em agent.*
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS agent;

-- -----------------------------------------------------------------------------
-- agent.runs — trace por turno do LLM (particionada por mês, retenção 90d)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS agent.runs (
  id                  BIGSERIAL,
  conversa_id         BIGINT NOT NULL REFERENCES crm.conversas(id) ON DELETE CASCADE,
  lead_id             BIGINT NOT NULL REFERENCES crm.leads(id) ON DELETE CASCADE,
  user_message_id     BIGINT REFERENCES crm.mensagens(id),
  agent_used          TEXT NOT NULL,                        -- router | order | product_search | faq | sales | escalation | onboarding | identity_migration | system
  stage               TEXT,
  input_tokens        INTEGER,
  output_tokens       INTEGER,
  latency_ms          INTEGER,
  reply_raw           TEXT,                                  -- purgado após 30d (LGPD)
  reply_final         TEXT,                                  -- purgado após 30d
  tool_calls          JSONB NOT NULL DEFAULT '[]'::jsonb,   -- purgado após 30d
  guardrails_fired    TEXT[] NOT NULL DEFAULT '{}',
  model               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, created_at),
  -- Idempotência em retry pós-failover. UNIQUE em tabela particionada deve incluir created_at.
  CONSTRAINT uq_agent_run_per_user_message UNIQUE (conversa_id, user_message_id, agent_used, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX IF NOT EXISTS idx_agent_runs_conversa ON agent.runs (conversa_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_agent ON agent.runs (agent_used, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_lead ON agent.runs (lead_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- agent.conversa_sumarios — sumário rolante por conversa (substitui chat_summary do Redis)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS agent.conversa_sumarios (
  conversa_id     BIGINT PRIMARY KEY REFERENCES crm.conversas(id) ON DELETE CASCADE,
  text            TEXT NOT NULL DEFAULT '',
  covered         INTEGER NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- agent.router_state — estado do router entre turnos (substitui chat_router_ctx do Redis)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS agent.router_state (
  conversa_id     BIGINT PRIMARY KEY REFERENCES crm.conversas(id) ON DELETE CASCADE,
  agent           TEXT,
  stage           TEXT,
  required_tools  TEXT[],
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- agent.tool_cache — cache de resultados de tools (substitui auzap:tc:* do Redis)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS agent.tool_cache (
  id              BIGSERIAL PRIMARY KEY,
  tool_name       TEXT NOT NULL,
  args_hash       TEXT NOT NULL,
  scope_key       TEXT,                                       -- ex: lead_id, conversa_id, ou 'global'
  result          JSONB NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tool_name, args_hash, scope_key)
);
CREATE INDEX IF NOT EXISTS idx_tool_cache_expiry ON agent.tool_cache (expires_at);

-- -----------------------------------------------------------------------------
-- agent.identity_flow — fluxo de migração/onboarding incremental
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS agent.identity_flow (
  conversa_id     BIGINT PRIMARY KEY REFERENCES crm.conversas(id) ON DELETE CASCADE,
  phase           TEXT,                                       -- awaiting_consent | awaiting_details | completed
  partial         JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------

ALTER TABLE agent.runs                ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.conversa_sumarios   ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.router_state        ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.tool_cache          ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.identity_flow       ENABLE ROW LEVEL SECURITY;

-- Policies idempotentes (PG não tem CREATE POLICY IF NOT EXISTS antes do 16)
DO $policies$
DECLARE tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY['runs','conversa_sumarios','router_state','tool_cache','identity_flow']) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='agent' AND tablename=tbl AND policyname='sbb_app_all') THEN
      EXECUTE format('CREATE POLICY sbb_app_all ON agent.%I FOR ALL TO sbb_app USING (true) WITH CHECK (true)', tbl);
    END IF;
  END LOOP;
END $policies$;

-- GRANTs essenciais: sbb_app precisa USAGE + ALL (owner é postgres porque migration rodou como superuser)
GRANT USAGE, CREATE ON SCHEMA agent TO sbb_app;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA agent TO sbb_app;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA agent TO sbb_app;
GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA agent TO sbb_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA agent GRANT ALL ON TABLES TO sbb_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA agent GRANT ALL ON SEQUENCES TO sbb_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA agent GRANT EXECUTE ON FUNCTIONS TO sbb_app;

-- -----------------------------------------------------------------------------
-- Funções utilitárias
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION agent.cleanup_expired_tool_cache() RETURNS INTEGER LANGUAGE sql AS $$
  WITH d AS (DELETE FROM agent.tool_cache WHERE expires_at < NOW() RETURNING 1)
  SELECT COUNT(*)::INTEGER FROM d;
$$;

CREATE OR REPLACE FUNCTION agent.purge_pii_older_than(days INTEGER DEFAULT 30) RETURNS INTEGER LANGUAGE sql AS $$
  WITH purged AS (
    UPDATE agent.runs
    SET reply_raw = NULL, reply_final = NULL, tool_calls = '[]'::jsonb
    WHERE created_at < NOW() - (days || ' days')::INTERVAL
      AND (reply_raw IS NOT NULL OR reply_final IS NOT NULL OR tool_calls != '[]'::jsonb)
    RETURNING 1
  )
  SELECT COUNT(*)::INTEGER FROM purged;
$$;

COMMENT ON SCHEMA agent IS 'AuZap brain state — owned by SQL migrations in scripts/migrations/, NOT by prisma migrate';
