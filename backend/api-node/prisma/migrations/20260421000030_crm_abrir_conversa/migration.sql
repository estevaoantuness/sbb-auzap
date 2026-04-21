-- =============================================================================
-- 003_crm_abrir_conversa.sql
-- RPC com advisory lock SESSION-level (não xact_lock) — suporta pg-boss handlers
-- que mantêm conexão viva durante chamada OpenAI (20s+)
-- =============================================================================

CREATE OR REPLACE FUNCTION crm.abrir_conversa(
  p_lead_id   BIGINT,
  p_telefone  TEXT
) RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE
  v_conversa_id BIGINT;
  v_lock_key    BIGINT;
BEGIN
  -- hashtext retorna INT4; cast seguro pra BIGINT via subtract
  v_lock_key := hashtext('conversa_open:' || p_lead_id::TEXT)::BIGINT;

  -- Tenta adquirir lock session-level com retry curto
  IF NOT pg_try_advisory_lock(v_lock_key) THEN
    PERFORM pg_sleep(0.1);
    IF NOT pg_try_advisory_lock(v_lock_key) THEN
      PERFORM pg_sleep(0.2);
      IF NOT pg_try_advisory_lock(v_lock_key) THEN
        RAISE EXCEPTION 'abrir_conversa: lock timeout for lead_id=% after 300ms', p_lead_id;
      END IF;
    END IF;
  END IF;

  -- Secção crítica: abre ou reusa conversa ativa
  BEGIN
    SELECT id INTO v_conversa_id
    FROM crm.conversas
    WHERE lead_id = p_lead_id AND encerrada_at IS NULL
    ORDER BY iniciada_at DESC
    LIMIT 1;

    IF v_conversa_id IS NULL THEN
      INSERT INTO crm.conversas (lead_id, telefone)
      VALUES (p_lead_id, p_telefone)
      RETURNING id INTO v_conversa_id;
    END IF;

    PERFORM pg_advisory_unlock(v_lock_key);
    RETURN v_conversa_id;

  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_advisory_unlock(v_lock_key);
    RAISE;
  END;
END $$;

COMMENT ON FUNCTION crm.abrir_conversa IS 'Abre (ou reusa) conversa ativa pra lead. Session-level lock com unlock explícito — NÃO xact_lock (pg-boss em session mode mantém TX durante IA)';
