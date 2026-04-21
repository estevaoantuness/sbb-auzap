#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
# bootstrap-dev.sh — setup idempotente do ambiente de dev local SBB-AuZap
# ════════════════════════════════════════════════════════════════════════════
#
# O que faz (cada passo é idempotente — pode rodar 10x sem problema):
#   1. Cria .env.dev a partir do template .env.dev.example (se ainda não existe)
#   2. Sobe docker-compose.dev.yml (postgres + api-node + ai-service)
#   3. Espera postgres responder healthcheck
#   4. Aplica migrations SQL de /superbem/scripts/migrations/ no postgres local
#   5. Gera Prisma client (npx prisma generate) dentro do container api-node
#
# Uso:
#   ./scripts/bootstrap-dev.sh                # setup completo
#   ./scripts/bootstrap-dev.sh --reset        # destroi volumes e recria do zero
#   ./scripts/bootstrap-dev.sh --migrations-only  # só aplica SQL
#
# Pré-requisitos:
#   - docker + docker compose instalados
#   - /Users/estevaoantunes/superbem/scripts/migrations/ existe (repo superbem)
# ════════════════════════════════════════════════════════════════════════════

set -euo pipefail

# ── Cores ──────────────────────────────────────────────────────────────────
GREEN="\033[0;32m"
YELLOW="\033[0;33m"
RED="\033[0;31m"
BLUE="\033[0;34m"
RESET="\033[0m"

info()  { echo -e "${BLUE}[info]${RESET} $*"; }
ok()    { echo -e "${GREEN}[ ok ]${RESET} $*"; }
warn()  { echo -e "${YELLOW}[warn]${RESET} $*"; }
error() { echo -e "${RED}[err ]${RESET} $*" >&2; }

# ── Paths ──────────────────────────────────────────────────────────────────
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/docker/docker-compose.dev.yml"
ENV_DEV_FILE="$REPO_ROOT/.env.dev"
ENV_DEV_TEMPLATE="$REPO_ROOT/.env.dev.example"
MIGRATIONS_DIR="/Users/estevaoantunes/superbem/scripts/migrations"

# ── Flags ──────────────────────────────────────────────────────────────────
RESET=0
MIGRATIONS_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --reset)            RESET=1 ;;
    --migrations-only)  MIGRATIONS_ONLY=1 ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *) warn "flag desconhecida: $arg" ;;
  esac
done

# ── Pré-checks ─────────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || { error "docker não encontrado no PATH"; exit 1; }
docker compose version >/dev/null 2>&1 || { error "docker compose v2 não encontrado (use docker-compose plugin moderno)"; exit 1; }

[ -f "$COMPOSE_FILE" ] || { error "compose file não existe: $COMPOSE_FILE"; exit 1; }
[ -f "$ENV_DEV_TEMPLATE" ] || { error "template de env não existe: $ENV_DEV_TEMPLATE"; exit 1; }

if [ ! -d "$MIGRATIONS_DIR" ]; then
  warn "diretório de migrations não existe: $MIGRATIONS_DIR"
  warn "bootstrap continua, mas nenhuma migration será aplicada. Clone o repo superbem primeiro."
fi

# ── Passo 0: reset opcional ────────────────────────────────────────────────
if [ "$RESET" -eq 1 ]; then
  info "flag --reset → derrubando volumes (DATA LOSS)"
  docker compose -f "$COMPOSE_FILE" down -v
  ok "volumes removidos"
fi

# ── Passo 1: .env.dev idempotente ──────────────────────────────────────────
if [ "$MIGRATIONS_ONLY" -eq 0 ]; then
  if [ ! -f "$ENV_DEV_FILE" ]; then
    info "criando .env.dev a partir do template"
    cp "$ENV_DEV_TEMPLATE" "$ENV_DEV_FILE"
    ok ".env.dev criado em $ENV_DEV_FILE"
    warn "edite $ENV_DEV_FILE e preencha OPENAI_API_KEY + INTERNAL_API_KEY antes de testar features reais"
  else
    ok ".env.dev já existe, preservando"
  fi
fi

# ── Passo 2: sobe stack ────────────────────────────────────────────────────
if [ "$MIGRATIONS_ONLY" -eq 0 ]; then
  info "subindo docker compose dev (postgres + api-node + ai-service)"
  docker compose -f "$COMPOSE_FILE" up -d
  ok "stack no ar"
fi

# ── Passo 3: espera postgres ───────────────────────────────────────────────
info "aguardando postgres ficar healthy"
ATTEMPT=0
MAX_ATTEMPTS=30
while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
  if docker compose -f "$COMPOSE_FILE" exec -T postgres pg_isready -U postgres -d sbb >/dev/null 2>&1; then
    ok "postgres respondendo"
    break
  fi
  ATTEMPT=$((ATTEMPT + 1))
  sleep 2
done
if [ $ATTEMPT -eq $MAX_ATTEMPTS ]; then
  error "postgres não respondeu após $((MAX_ATTEMPTS * 2))s"
  exit 1
fi

# ── Passo 4: aplica migrations ─────────────────────────────────────────────
if [ -d "$MIGRATIONS_DIR" ]; then
  info "aplicando migrations SQL de $MIGRATIONS_DIR"
  # O compose monta /migrations:ro dentro do container postgres.
  # Aplicamos em ordem alfabética (prefixos 001_, 002_...).
  APPLIED=0
  for sql in $(ls "$MIGRATIONS_DIR"/*.sql 2>/dev/null | sort); do
    fname="$(basename "$sql")"
    info "  → aplicando $fname"
    # -v ON_ERROR_STOP=1 faz falhar ao primeiro erro (idempotência depende de IF NOT EXISTS na DDL).
    docker compose -f "$COMPOSE_FILE" exec -T postgres \
      psql -U postgres -d sbb -v ON_ERROR_STOP=1 -f "/migrations/$fname" >/dev/null \
      || { warn "  ↳ migration $fname falhou (já aplicada? ver logs com 'docker compose -f $COMPOSE_FILE logs postgres')"; continue; }
    APPLIED=$((APPLIED + 1))
  done
  ok "$APPLIED migrations aplicadas (demais já existiam ou falharam — revisar)"
else
  warn "pulando migrations (diretório não existe)"
fi

# ── Passo 5: prisma generate ───────────────────────────────────────────────
if [ "$MIGRATIONS_ONLY" -eq 0 ]; then
  info "rodando prisma generate dentro do api-node"
  if docker compose -f "$COMPOSE_FILE" exec -T api-node npx prisma generate >/dev/null 2>&1; then
    ok "prisma client gerado"
  else
    warn "prisma generate falhou — container api-node pode ainda estar subindo."
    warn "rode manualmente: docker compose -f $COMPOSE_FILE exec api-node npx prisma generate"
  fi
fi

# ── Status final ───────────────────────────────────────────────────────────
echo
ok "═══════════════════════════════════════════════════"
ok " sbb-auzap dev stack pronto"
ok "═══════════════════════════════════════════════════"
echo
echo "  Postgres:    localhost:5432  (user=postgres pwd=devlocal db=sbb)"
echo "  API Node:    http://localhost:3000/health"
echo "  AI Service:  http://localhost:8000/health"
echo
echo "  Logs:        docker compose -f docker/docker-compose.dev.yml logs -f"
echo "  Shell DB:    docker compose -f docker/docker-compose.dev.yml exec postgres psql -U postgres -d sbb"
echo "  Derrubar:    docker compose -f docker/docker-compose.dev.yml down"
echo "  Reset total: ./scripts/bootstrap-dev.sh --reset"
echo
