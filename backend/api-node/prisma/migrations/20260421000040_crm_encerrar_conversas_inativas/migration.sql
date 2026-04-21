-- =============================================================================
-- 004_crm_encerrar_conversas_inativas.sql
-- Substitui workflow N8N sbb-crm-encerrar-conversa (aposentado no cutover)
-- Usa timezone BRT (America/Sao_Paulo), NÃO UTC — previne fechar conversa
-- que ainda está no horário comercial local do cliente
-- =============================================================================

CREATE OR REPLACE FUNCTION crm.encerrar_conversas_inativas(
  timeout_horas INTEGER DEFAULT 4
) RETURNS INTEGER LANGUAGE sql AS $$
  WITH brt_now AS (
    SELECT NOW() AT TIME ZONE 'America/Sao_Paulo' AS ts
  ),
  closed AS (
    UPDATE crm.conversas c
    SET encerrada_at = NOW(),
        encerrada_por = 'timeout'
    FROM brt_now
    WHERE c.encerrada_at IS NULL
      AND (c.iniciada_at AT TIME ZONE 'America/Sao_Paulo') < brt_now.ts - (timeout_horas || ' hours')::INTERVAL
      AND NOT EXISTS (
        SELECT 1 FROM crm.mensagens m
        WHERE m.conversa_id = c.id
          AND (m.created_at AT TIME ZONE 'America/Sao_Paulo') > brt_now.ts - (timeout_horas || ' hours')::INTERVAL
      )
    RETURNING 1
  )
  SELECT COUNT(*)::INTEGER FROM closed;
$$;

COMMENT ON FUNCTION crm.encerrar_conversas_inativas IS 'Fecha conversas sem mensagem há N horas (BRT-aware). Substitui workflow N8N sbb-crm-encerrar-conversa no cutover';
