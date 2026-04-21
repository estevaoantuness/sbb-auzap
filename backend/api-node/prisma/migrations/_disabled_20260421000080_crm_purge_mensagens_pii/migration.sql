-- =============================================================================
-- 008_crm_purge_mensagens_pii.sql
-- Retenção uniforme: mascarar crm.mensagens.conteudo após 30 dias
-- (alinhado com agent.purge_pii_older_than pra evitar inconsistência LGPD)
--
-- NOTA: Ativar APÓS decisão jurídica no Sprint 0 sobre retenção de histórico
-- fiscal vs purge estrito. Se SBB precisar guardar histórico pra auditoria
-- fiscal (lei comercial), NÃO rodar esta função — só agent.purge_pii.
-- =============================================================================

CREATE OR REPLACE FUNCTION crm.purge_mensagens_pii(days INTEGER DEFAULT 30) RETURNS INTEGER LANGUAGE sql AS $$
  WITH purged AS (
    UPDATE crm.mensagens
    SET conteudo = '[REDACTED-LGPD]'
    WHERE created_at < NOW() - (days || ' days')::INTERVAL
      AND conteudo != '[REDACTED-LGPD]'
      AND conteudo != '[REMOVIDO-LGPD]'
    RETURNING 1
  )
  SELECT COUNT(*)::INTEGER FROM purged;
$$;

COMMENT ON FUNCTION crm.purge_mensagens_pii IS 'Mascara conteúdo de crm.mensagens >30d. DESATIVADO por default — ativar só após parecer jurídico confirmar que não viola retenção fiscal obrigatória';
