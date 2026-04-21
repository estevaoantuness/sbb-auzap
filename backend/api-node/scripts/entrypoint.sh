#!/bin/sh
set -e

# Entrypoint produção: aplica migrations SQL idempotentes via psql antes de subir server.
# Motivo: sbb-postgres já tem tabelas crm.* e public.* criadas pela equipe Superbem,
# então prisma migrate deploy abortaria com P3005. Nossas migrations usam
# CREATE TABLE IF NOT EXISTS e CREATE OR REPLACE FUNCTION — seguras pra re-aplicar.

if [ -z "$DATABASE_URL" ]; then
  echo "[entrypoint] FATAL: DATABASE_URL não configurado" >&2
  exit 1
fi

# libpq/psql não aceita ?schema= nem ?connection_limit= (que Prisma usa).
# Limpa pra chamadas psql.
PSQL_URL=$(echo "$DATABASE_URL" | sed -E 's/[?&](schema|connection_limit|pgbouncer)=[^&]+//g; s/\?$//')

MIGRATIONS_DIR=/app/prisma/migrations

if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "[entrypoint] warn: $MIGRATIONS_DIR não existe; skip migrations"
else
  echo "[entrypoint] aplicando migrations SQL via psql (ordem alfabética)..."
  for mig in $(ls -d "$MIGRATIONS_DIR"/*/ 2>/dev/null | sort); do
    name=$(basename "$mig")
    sql="$mig/migration.sql"
    if [ -f "$sql" ]; then
      echo "  → $name"
      if ! psql "$PSQL_URL" -v ON_ERROR_STOP=1 -f "$sql" 2>&1 | tail -5; then
        echo "[entrypoint] ERROR: migration $name falhou — abortando" >&2
        exit 1
      fi
    fi
  done
  echo "[entrypoint] migrations aplicadas ✓"
fi

# Migration 007 opcional — role auditor (requer AUDITOR_PWD)
if [ -n "$AUDITOR_PWD" ] && [ -f /app/prisma/optional/007_role_auditor.sql ]; then
  echo "[entrypoint] aplicando role auditor (007)..."
  psql "$PSQL_URL" -v auditor_pwd="'$AUDITOR_PWD'" \
    -f /app/prisma/optional/007_role_auditor.sql 2>&1 | tail -3 \
    || echo "[entrypoint] warn: 007 falhou (ignorando — role pode já existir)"
fi

# Prisma client generate confirma schema/DB contract. Não aplica migration.
echo "[entrypoint] prisma generate (ensures client up-to-date)..."
npx --yes prisma generate --schema=/app/prisma/schema.prisma 2>&1 | tail -3 || true

echo "[entrypoint] starting server..."
exec "$@"
