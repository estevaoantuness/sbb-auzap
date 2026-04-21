-- =============================================================================
-- 005_crm_anonimizar_lead_cascade.sql
-- Estende crm.anonimizar_lead() existente com cascata em agent.*
-- LGPD Art. 18 IV — direito ao esquecimento
--
-- PRÉ-REQUISITO: função crm.anonimizar_lead(lead_id BIGINT) já deve existir em
-- crm_schema.sql (verificar antes de rodar esta migration)
-- =============================================================================

-- Se a função base não existir, criar stub (produção deve ter a versão completa)
CREATE OR REPLACE FUNCTION crm.anonimizar_lead(p_lead_id BIGINT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  -- Parte crm.* (anonimiza lead + mensagens + eventos)
  UPDATE crm.leads
  SET nome_real = '[REMOVIDO-LGPD]',
      nome_whatsapp = '[REMOVIDO-LGPD]',
      apelido = NULL,
      endereco_preferido = NULL,
      telefone = '***' || LPAD((RANDOM() * 99999)::INTEGER::TEXT, 5, '0'),  -- pseudo-anon, mantém lead_id
      opt_out_at = NOW(),
      top_categorias = '{}',
      top_produtos = NULL
  WHERE id = p_lead_id;

  UPDATE crm.mensagens
  SET conteudo = '[REMOVIDO-LGPD]'
  WHERE lead_id = p_lead_id;

  -- Parte agent.* (cascata introduzida round 2)
  UPDATE agent.runs
  SET reply_raw = NULL,
      reply_final = NULL,
      tool_calls = '[]'::jsonb
  WHERE lead_id = p_lead_id;

  UPDATE agent.conversa_sumarios
  SET text = '',
      covered = 0
  WHERE conversa_id IN (SELECT id FROM crm.conversas WHERE lead_id = p_lead_id);

  DELETE FROM agent.router_state
  WHERE conversa_id IN (SELECT id FROM crm.conversas WHERE lead_id = p_lead_id);

  DELETE FROM agent.identity_flow
  WHERE conversa_id IN (SELECT id FROM crm.conversas WHERE lead_id = p_lead_id);

  DELETE FROM agent.shadow_runs
  WHERE conversa_origem_id IN (SELECT id FROM crm.conversas WHERE lead_id = p_lead_id);

  DELETE FROM agent.tool_cache
  WHERE scope_key = p_lead_id::TEXT;

  -- Log de anonimização (auditoria LGPD)
  INSERT INTO crm.eventos_lead (lead_id, tipo, fonte, payload)
  VALUES (p_lead_id, 'lgpd_anonimizado', 'sistema', jsonb_build_object('anonimizado_em', NOW()));
END $$;

COMMENT ON FUNCTION crm.anonimizar_lead IS 'LGPD Art. 18 IV — anonimiza lead em crm.* E cascateia em agent.* (runs, sumarios, router_state, identity_flow, shadow_runs, tool_cache)';
