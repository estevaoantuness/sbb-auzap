-- =============================================================================
-- 20260422000020_mensagens_add_conteudo_telefone.sql
-- Aligns crm.mensagens with Prisma model (which expects `conteudo` and
-- `telefone`). The base superbem schema only has `texto`. This is additive:
-- old readers that select `texto` keep working; new inserts via Prisma write
-- to `conteudo` + `telefone`.
-- Backfill on existing rows so views that already migrated remain consistent.
-- =============================================================================

ALTER TABLE crm.mensagens
  ADD COLUMN IF NOT EXISTS conteudo TEXT,
  ADD COLUMN IF NOT EXISTS telefone TEXT;

-- Backfill conteudo from texto when present
UPDATE crm.mensagens SET conteudo = texto WHERE conteudo IS NULL AND texto IS NOT NULL;

-- Backfill telefone from leads
UPDATE crm.mensagens m
   SET telefone = l.telefone
  FROM crm.leads l
 WHERE m.lead_id = l.id AND m.telefone IS NULL;

-- Keep `texto` mirrored from `conteudo` for legacy readers (PostgREST views)
CREATE OR REPLACE FUNCTION crm._mensagens_sync_texto_conteudo() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.conteudo IS NOT NULL AND NEW.texto IS NULL THEN
    NEW.texto := NEW.conteudo;
  ELSIF NEW.texto IS NOT NULL AND NEW.conteudo IS NULL THEN
    NEW.conteudo := NEW.texto;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS mensagens_sync_texto_conteudo ON crm.mensagens;
CREATE TRIGGER mensagens_sync_texto_conteudo
  BEFORE INSERT OR UPDATE ON crm.mensagens
  FOR EACH ROW EXECUTE FUNCTION crm._mensagens_sync_texto_conteudo();
