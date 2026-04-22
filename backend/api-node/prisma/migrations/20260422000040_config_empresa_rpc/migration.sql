-- =============================================================================
-- 20260422000040_config_empresa_rpc.sql
-- RPCs que o dashboard Settings chama: get_config_empresa / upsert_config_empresa.
-- Sem essas, `use-company-settings.ts` cai pra localStorage após 3 falhas com
-- o aviso "Backend indisponível" pro usuário.
--
-- Schema: tabela key/value (key TEXT pk, value JSONB). Uma linha por "key"
-- ('default' no uso atual, mas flexível pra multi-perfil no futuro).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.config_empresa (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION public.get_config_empresa(p_key TEXT)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT value FROM public.config_empresa WHERE key = p_key LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.upsert_config_empresa(p_key TEXT, p_value JSONB)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.config_empresa (key, value, updated_at)
  VALUES (p_key, p_value, NOW())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
$$;

-- Grants pra PostgREST expor pros roles anon/authenticator
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    GRANT EXECUTE ON FUNCTION public.get_config_empresa(TEXT) TO anon;
    GRANT EXECUTE ON FUNCTION public.upsert_config_empresa(TEXT, JSONB) TO anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticator') THEN
    GRANT EXECUTE ON FUNCTION public.get_config_empresa(TEXT) TO authenticator;
    GRANT EXECUTE ON FUNCTION public.upsert_config_empresa(TEXT, JSONB) TO authenticator;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sbb_app') THEN
    GRANT EXECUTE ON FUNCTION public.get_config_empresa(TEXT) TO sbb_app;
    GRANT EXECUTE ON FUNCTION public.upsert_config_empresa(TEXT, JSONB) TO sbb_app;
  END IF;
END $$;

-- Notify PostgREST pra recarregar schema cache — senão as RPCs só aparecem
-- no próximo SIGUSR1 (pode demorar).
NOTIFY pgrst, 'reload schema';
