-- =============================================================================
-- 002_agent_shadow_runs.sql
-- Shadow mode: replay offline controlado, ZERO poluição em crm.*
-- =============================================================================

CREATE TABLE IF NOT EXISTS agent.shadow_runs (
  id                  BIGSERIAL PRIMARY KEY,
  conversa_origem_id  BIGINT NOT NULL REFERENCES crm.conversas(id) ON DELETE CASCADE,
  turno               INTEGER NOT NULL,
  user_msg_raw        TEXT NOT NULL,                          -- mensagem original do cliente
  user_msg_anon       TEXT,                                    -- versão anonimizada (CPF/tel mascarados) enviada ao juiz
  maria_reply         TEXT NOT NULL,                           -- veio de crm.mensagens (original do N8N)
  auzap_reply         TEXT NOT NULL,                           -- gerada em memória no replay, sem tocar crm.*
  auzap_latency_ms    INTEGER,
  auzap_agent_used    TEXT,
  auzap_tool_calls    JSONB NOT NULL DEFAULT '[]'::jsonb,
  judge_model         TEXT,                                    -- gpt-5.4 etc
  judge_verdict       JSONB,                                   -- {correcao_maria:0-5, correcao_auzap:0-5, escopo_*:0-5, tom_*:0-5, completude_*:0-5, observacoes:text}
  calibration_sample  BOOLEAN NOT NULL DEFAULT false,          -- true se for amostra de calibração com anotação humana
  human_verdict       JSONB,                                   -- preenchido em calibration_sample
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (conversa_origem_id, turno)                           -- replay idempotente (ON CONFLICT DO NOTHING)
);

CREATE INDEX IF NOT EXISTS idx_shadow_conversa ON agent.shadow_runs (conversa_origem_id, turno);
CREATE INDEX IF NOT EXISTS idx_shadow_calibration ON agent.shadow_runs (calibration_sample) WHERE calibration_sample = true;

ALTER TABLE agent.shadow_runs ENABLE ROW LEVEL SECURITY;
DO $policy$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='agent' AND tablename='shadow_runs' AND policyname='sbb_app_all') THEN
    EXECUTE 'CREATE POLICY sbb_app_all ON agent.shadow_runs FOR ALL TO sbb_app USING (true) WITH CHECK (true)';
  END IF;
END $policy$;
GRANT ALL ON agent.shadow_runs TO sbb_app;

COMMENT ON TABLE agent.shadow_runs IS 'Shadow mode read-only replay: NUNCA escreve em crm.*, apenas captura saídas pra avaliação de qualidade pré-cutover';
