#!/bin/sh
set -e

# Produção entrypoint — aplica migrations Prisma antes de subir o server.
# Roda idempotente via _prisma_migrations table; no-op se já aplicadas.

if [ -z "$DATABASE_URL" ]; then
  echo "[entrypoint] FATAL: DATABASE_URL não configurado" >&2
  exit 1
fi

echo "[entrypoint] aplicando migrations (prisma migrate deploy)..."
npx --yes prisma migrate deploy --schema=/app/prisma/schema.prisma || {
  echo "[entrypoint] migrate deploy falhou — abortando subida" >&2
  exit 1
}

# Migration 007 (role auditor) é opcional e requer AUDITOR_PWD injetado.
# Se AUDITOR_PWD setado, roda o SQL via psql.
if [ -n "$AUDITOR_PWD" ]; then
  echo "[entrypoint] aplicando role auditor (007)..."
  # psql client precisa estar disponível — checar Dockerfile
  if command -v psql >/dev/null 2>&1; then
    psql "$DATABASE_URL" -v auditor_pwd="'$AUDITOR_PWD'" \
      -f /app/prisma/optional/007_role_auditor.sql \
      || echo "[entrypoint] warn: 007 role auditor falhou (ignorando — já pode existir)"
  else
    echo "[entrypoint] warn: psql não instalado na imagem; skip 007"
  fi
fi

echo "[entrypoint] starting server..."
exec "$@"
