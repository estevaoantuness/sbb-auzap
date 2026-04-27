-- =============================================================================
-- 20260427000010_agent_readonly.sql
-- Revoga writes em agent.* pra sbb_app (rollback Maria-AuZap → Maria-N8N).
--
-- Contexto: o stack Python sbb-auzap-api/ai foi parado. Tabelas agent.runs,
-- agent.shadow_runs, agent.conversa_sumarios, agent.router_state,
-- agent.tool_cache, agent.identity_flow ficam congeladas pra histórico/auditoria.
-- sbb_app continua tendo SELECT (em caso de uso futuro de leitura: relatório,
-- LGPD anonimizar_lead etc.) mas não pode mais inserir/atualizar/deletar.
--
-- Idempotente. Reverter via segunda migration que re-conceda os privilégios.
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sbb_app') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA agent FROM sbb_app;

    -- Default privileges pra futuras tabelas em agent.* (caso alguém crie sem refletir)
    ALTER DEFAULT PRIVILEGES IN SCHEMA agent
      REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLES FROM sbb_app;

    -- SELECT preservado (LGPD/auditoria/relatórios)
    GRANT SELECT ON ALL TABLES IN SCHEMA agent TO sbb_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA agent GRANT SELECT ON TABLES TO sbb_app;

    -- Sequencias: revoga UPDATE (impede nextval). USAGE só faz sentido em SELECT path.
    REVOKE UPDATE ON ALL SEQUENCES IN SCHEMA agent FROM sbb_app;

    RAISE NOTICE 'sbb_app agora é read-only em agent.*';
  ELSE
    RAISE NOTICE 'Role sbb_app não existe — skip';
  END IF;
END $$;
