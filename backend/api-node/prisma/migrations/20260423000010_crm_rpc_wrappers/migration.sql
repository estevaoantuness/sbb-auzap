-- =============================================================================
-- 20260423000010_crm_rpc_wrappers.sql
-- api-node (worker, conversationController, clientController) chama RPCs
-- como crm.upsert_customer, crm.pausar_ia, etc. Mas essas RPCs foram
-- criadas pela equipe Superbem no schema public. Resultado: worker trava
-- com 42883 "function does not exist" toda vez que uma mensagem chega.
--
-- Fix cirúrgico: cria wrappers em crm.* que delegam pra public.*. Mantém
-- o contrato que o código assume (schema crm) sem precisar refatorar 5
-- arquivos.
-- =============================================================================

CREATE OR REPLACE FUNCTION crm.upsert_customer(
  p_telefone TEXT,
  p_nome_real TEXT DEFAULT NULL,
  p_nome_whatsapp TEXT DEFAULT NULL,
  p_bairro TEXT DEFAULT NULL,
  p_endereco TEXT DEFAULT NULL
) RETURNS SETOF crm.leads
LANGUAGE sql AS $$
  SELECT * FROM public.upsert_customer(p_telefone, p_nome_real, p_nome_whatsapp, p_bairro, p_endereco);
$$;

CREATE OR REPLACE FUNCTION crm.pausar_ia(p_conversa_id BIGINT) RETURNS VOID
LANGUAGE sql AS $$ SELECT public.pausar_ia(p_conversa_id); $$;

CREATE OR REPLACE FUNCTION crm.retomar_ia(p_conversa_id BIGINT) RETURNS VOID
LANGUAGE sql AS $$ SELECT public.retomar_ia(p_conversa_id); $$;

CREATE OR REPLACE FUNCTION crm.fetch_customer_details(p_lead_id BIGINT) RETURNS JSON
LANGUAGE sql AS $$ SELECT public.fetch_customer_details(p_lead_id); $$;

CREATE OR REPLACE FUNCTION crm.upsert_preference(
  p_lead_id BIGINT,
  p_categoria TEXT,
  p_produtos_favoritos TEXT DEFAULT '',
  p_restricoes TEXT DEFAULT '',
  p_acao_falta TEXT DEFAULT 'cancelar',
  p_notas TEXT DEFAULT ''
) RETURNS SETOF crm.preferencias
LANGUAGE sql AS $$
  SELECT * FROM public.upsert_preference(p_lead_id, p_categoria, p_produtos_favoritos, p_restricoes, p_acao_falta, p_notas);
$$;

CREATE OR REPLACE FUNCTION crm.marcar_mensagens_lidas(p_conversa_id BIGINT) RETURNS INTEGER
LANGUAGE sql AS $$ SELECT public.marcar_mensagens_lidas(p_conversa_id); $$;

-- Grants pros wrappers (sbb_app usa em runtime)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sbb_app') THEN
    GRANT EXECUTE ON FUNCTION crm.upsert_customer(TEXT,TEXT,TEXT,TEXT,TEXT) TO sbb_app;
    GRANT EXECUTE ON FUNCTION crm.pausar_ia(BIGINT) TO sbb_app;
    GRANT EXECUTE ON FUNCTION crm.retomar_ia(BIGINT) TO sbb_app;
    GRANT EXECUTE ON FUNCTION crm.fetch_customer_details(BIGINT) TO sbb_app;
    GRANT EXECUTE ON FUNCTION crm.upsert_preference(BIGINT,TEXT,TEXT,TEXT,TEXT,TEXT) TO sbb_app;
    GRANT EXECUTE ON FUNCTION crm.marcar_mensagens_lidas(BIGINT) TO sbb_app;
  END IF;
END $$;
