-- =============================================================================
-- 006_agent_runs_partitions.sql
-- Particionamento mensal + rotação 90d + fallback caminho B (sem pg_cron)
-- Cria 2 meses em avanço (não 1) — previne gap no virar do mês entre cron 03:00 BRT
-- e primeiro INSERT 00:00 do novo mês
-- =============================================================================

-- Partições iniciais (ajustar datas conforme mês do deploy)
CREATE TABLE IF NOT EXISTS agent.runs_2026_04 PARTITION OF agent.runs FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE IF NOT EXISTS agent.runs_2026_05 PARTITION OF agent.runs FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE IF NOT EXISTS agent.runs_2026_06 PARTITION OF agent.runs FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

-- -----------------------------------------------------------------------------
-- agent.rotate_runs_partitions()
-- Cria partições NEXT e NEXT+1 (2 meses em avanço) + drop de >90 dias
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION agent.rotate_runs_partitions() RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  m1_start    DATE := DATE_TRUNC('month', NOW() + INTERVAL '1 month')::DATE;
  m1_end      DATE := m1_start + INTERVAL '1 month';
  m1_name     TEXT := 'runs_' || TO_CHAR(m1_start, 'YYYY_MM');

  m2_start    DATE := DATE_TRUNC('month', NOW() + INTERVAL '2 months')::DATE;
  m2_end      DATE := m2_start + INTERVAL '1 month';
  m2_name     TEXT := 'runs_' || TO_CHAR(m2_start, 'YYYY_MM');

  drop_before DATE := DATE_TRUNC('month', NOW() - INTERVAL '3 months')::DATE;
  r           RECORD;
BEGIN
  -- Cria partição próximo mês
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS agent.%I PARTITION OF agent.runs FOR VALUES FROM (%L) TO (%L)',
    m1_name, m1_start, m1_end
  );

  -- Cria partição mês+1 (buffer contra gap de 3min entre job e virar do mês)
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS agent.%I PARTITION OF agent.runs FOR VALUES FROM (%L) TO (%L)',
    m2_name, m2_start, m2_end
  );

  -- Drop partições > 90 dias (retenção)
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'agent'
      AND c.relname LIKE 'runs_%'
      AND c.relkind = 'r'
      AND TO_DATE(SUBSTRING(c.relname FROM 6), 'YYYY_MM') < drop_before
  LOOP
    EXECUTE format('DROP TABLE agent.%I', r.relname);
    RAISE NOTICE 'Dropped partition agent.% (older than 90 days)', r.relname;
  END LOOP;
END $$;

COMMENT ON FUNCTION agent.rotate_runs_partitions IS 'Cria partição NEXT + NEXT+1 do agent.runs; dropa >90d. Rodar 03:00 BRT via pg_cron OU pg-boss sendCron OU node-cron (decisão em Sprint 0)';

-- -----------------------------------------------------------------------------
-- Setup pg_cron (tenta; se falhar, Team A usa node-cron ou pg-boss sendCron)
-- -----------------------------------------------------------------------------

-- Comentado por default: descomentar após confirmar pg_cron disponível (checklist C4)
-- CREATE EXTENSION IF NOT EXISTS pg_cron;
-- SELECT cron.schedule('rotate_runs',    '0 3 * * *',       'SELECT agent.rotate_runs_partitions()');
-- SELECT cron.schedule('purge_pii',      '15 3 * * *',      'SELECT agent.purge_pii_older_than(30)');
-- SELECT cron.schedule('cleanup_cache',  '0 * * * *',       'SELECT agent.cleanup_expired_tool_cache()');
-- SELECT cron.schedule('close_inactive', '*/15 * * * *',    'SELECT crm.encerrar_conversas_inativas(4)');
