#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
# deploy-prod.sh — REFERÊNCIA de deploy Coolify (não executa automaticamente)
# ════════════════════════════════════════════════════════════════════════════
#
# Este script IMPRIME os curls que criam o projeto + apps + envs no Coolify.
# NÃO executa por padrão. Pra rodar, exporte COOLIFY_EXECUTE=1 (com ciência).
#
# Baseado no §Team A do plano:
#   /Users/estevaoantunes/.claude/plans/valide-ambas-stacks-antes-groovy-mitten.md
#
# Regra do CLAUDE.md: CLI > API > UI. CLI v1.6.0 NÃO expõe project/app create
# nem env set — por isso API REST é o único caminho.
#
# Uso:
#   ./scripts/deploy-prod.sh                    # imprime comandos (dry-run)
#   COOLIFY_EXECUTE=1 ./scripts/deploy-prod.sh  # executa de verdade
#   ./scripts/deploy-prod.sh --step=create      # só um bloco (create|envs|deploy)
# ════════════════════════════════════════════════════════════════════════════

set -euo pipefail

# ── Cores ──────────────────────────────────────────────────────────────────
GREEN="\033[0;32m"; YELLOW="\033[0;33m"; RED="\033[0;31m"; BLUE="\033[0;34m"; RESET="\033[0m"
info()  { echo -e "${BLUE}[info]${RESET} $*"; }
ok()    { echo -e "${GREEN}[ ok ]${RESET} $*"; }
warn()  { echo -e "${YELLOW}[warn]${RESET} $*"; }
error() { echo -e "${RED}[err ]${RESET} $*" >&2; }
cmd()   { echo -e "${YELLOW}\$${RESET} $*"; }

# ── Constantes ─────────────────────────────────────────────────────────────
COOLIFY_URL="${COOLIFY_URL:-https://coolify.pangeia.cloud}"
SERVER_UUID="${COOLIFY_SERVER_UUID:-voo8kswgwkkokggwogoko4os}"
DESTINATION_UUID="${COOLIFY_DESTINATION_UUID:-<destination_uuid_placeholder>}"
GIT_REPO="${GIT_REPO:-https://github.com/estevaoantuness/sbb-auzap}"
GIT_BRANCH="${GIT_BRANCH:-main}"
PROJECT_NAME="${PROJECT_NAME:-sbb-auzap}"
AI_APP_NAME="${AI_APP_NAME:-sbb-auzap-ai}"
API_APP_NAME="${API_APP_NAME:-sbb-auzap-api}"

# ── Flags / modo ───────────────────────────────────────────────────────────
EXECUTE="${COOLIFY_EXECUTE:-0}"
STEP="all"
for arg in "$@"; do
  case "$arg" in
    --step=*)  STEP="${arg#*=}" ;;
    --execute) EXECUTE=1 ;;
    -h|--help)
      sed -n '2,25p' "$0"
      exit 0
      ;;
  esac
done

# ── Função utilitária — imprime ou executa ─────────────────────────────────
run_or_print() {
  local desc="$1"; shift
  info "$desc"
  cmd "$@"
  if [ "$EXECUTE" -eq 1 ]; then
    eval "$@"
    echo
  fi
}

# ── Guardrails de execução ─────────────────────────────────────────────────
if [ "$EXECUTE" -eq 1 ]; then
  warn "MODO EXECUTE ATIVO — os curls rodarão de verdade em $COOLIFY_URL"
  if [ -z "${COOLIFY_TOKEN:-}" ]; then
    error "COOLIFY_TOKEN não definido. Exporte antes: export COOLIFY_TOKEN=..."
    exit 1
  fi
  read -p "Confirma deploy em $COOLIFY_URL (digite 'sim'): " CONFIRM
  [ "$CONFIRM" = "sim" ] || { info "abortado"; exit 0; }
else
  warn "DRY-RUN — só imprimindo comandos. Exporte COOLIFY_EXECUTE=1 pra rodar."
fi

# ── Bloco 1: criar projeto ─────────────────────────────────────────────────
if [ "$STEP" = "all" ] || [ "$STEP" = "create" ]; then
  echo "═══════════════════════════════════════════════════════════════"
  echo " Bloco 1 — criar projeto Coolify"
  echo "═══════════════════════════════════════════════════════════════"

  run_or_print "criando projeto $PROJECT_NAME" \
    "curl -sS -X POST $COOLIFY_URL/api/v1/projects \\
      -H 'Authorization: Bearer \$COOLIFY_TOKEN' \\
      -H 'Content-Type: application/json' \\
      -d '{\"name\":\"$PROJECT_NAME\",\"description\":\"AuZap brain for Maria v2 — Super Bem Barato\"}'"

  warn "→ guarde o project_uuid da resposta em \$PROJECT_UUID"

  # ── App AI service ───────────────────────────────────────────────────────
  run_or_print "criando app $AI_APP_NAME (ai-service, porta 8000, interno)" \
    "curl -sS -X POST $COOLIFY_URL/api/v1/applications \\
      -H 'Authorization: Bearer \$COOLIFY_TOKEN' \\
      -H 'Content-Type: application/json' \\
      -d '{
        \"project_uuid\":\"\$PROJECT_UUID\",
        \"server_uuid\":\"$SERVER_UUID\",
        \"destination_uuid\":\"$DESTINATION_UUID\",
        \"name\":\"$AI_APP_NAME\",
        \"git_repository\":\"$GIT_REPO\",
        \"git_branch\":\"$GIT_BRANCH\",
        \"build_pack\":\"dockerfile\",
        \"dockerfile_location\":\"backend/ai-service/Dockerfile.prod\",
        \"ports_exposes\":\"8000\"
      }'"

  warn "→ guarde app_uuid da resposta em \$AI_UUID"

  # ── App API node ─────────────────────────────────────────────────────────
  run_or_print "criando app $API_APP_NAME (api-node, porta 3000, público)" \
    "curl -sS -X POST $COOLIFY_URL/api/v1/applications \\
      -H 'Authorization: Bearer \$COOLIFY_TOKEN' \\
      -H 'Content-Type: application/json' \\
      -d '{
        \"project_uuid\":\"\$PROJECT_UUID\",
        \"server_uuid\":\"$SERVER_UUID\",
        \"destination_uuid\":\"$DESTINATION_UUID\",
        \"name\":\"$API_APP_NAME\",
        \"git_repository\":\"$GIT_REPO\",
        \"git_branch\":\"$GIT_BRANCH\",
        \"build_pack\":\"dockerfile\",
        \"dockerfile_location\":\"backend/api-node/Dockerfile.prod\",
        \"ports_exposes\":\"3000\",
        \"fqdn\":\"https://auzap-api.pangeia.cloud\"
      }'"

  warn "→ guarde app_uuid da resposta em \$API_UUID"
fi

# ── Bloco 2: envs ──────────────────────────────────────────────────────────
if [ "$STEP" = "all" ] || [ "$STEP" = "envs" ]; then
  echo
  echo "═══════════════════════════════════════════════════════════════"
  echo " Bloco 2 — setar envs (repetir POST por cada par key/value)"
  echo "═══════════════════════════════════════════════════════════════"

  warn "envs da lista completa em /Users/estevaoantunes/sbb-auzap/.env.example"
  warn "pra cada variável, rodar:"

  cmd "curl -sS -X POST $COOLIFY_URL/api/v1/applications/\$API_UUID/envs \\
      -H 'Authorization: Bearer \$COOLIFY_TOKEN' \\
      -H 'Content-Type: application/json' \\
      -d '{
        \"key\":\"DATABASE_URL\",
        \"value\":\"postgresql://sbb_app:\$SBB_APP_PWD@postgres-sbb:6432/sbb?schema=public&connection_limit=10\",
        \"is_buildtime\":false
      }'"

  echo
  warn "envs críticas pro AI service (\$AI_UUID):"
  echo "  - DATABASE_URL"
  echo "  - OPENAI_API_KEY"
  echo "  - OPENAI_MODEL, OPENAI_MODEL_SUMMARY, OPENAI_MODEL_JUDGE"
  echo "  - OPENAI_DAILY_BUDGET_USD"
  echo "  - HISTORY_SUMMARY_ENABLED"
  echo "  - SUPERBEM_COMPANY_ID=1"
  echo "  - STORE_NAME, STORE_PHONE, STORE_ADDRESS, STORE_HOURS"
  echo "  - INTERNAL_API_KEY"
  echo "  - TELEGRAM_ALERT_BOT_TOKEN, TELEGRAM_ALERT_CHAT_ID"
  echo "  - GROQ_API_KEY (opcional)"
  echo

  warn "envs críticas pro API node (\$API_UUID):"
  echo "  - DATABASE_URL"
  echo "  - AI_SERVICE_URL=http://$AI_APP_NAME:8000  (hostname docker interno)"
  echo "  - WHATSAPP_PROVIDER=cloud_api"
  echo "  - WABA_PHONE_NUMBER_ID, WABA_BUSINESS_ACCOUNT_ID"
  echo "  - WABA_ACCESS_TOKEN, WABA_APP_SECRET, WABA_VERIFY_TOKEN"
  echo "  - INTERNAL_API_KEY  (MESMO valor do ai-service)"
  echo "  - TELEGRAM_ALERT_BOT_TOKEN, TELEGRAM_ALERT_CHAT_ID"
  echo "  - PGBOSS_POOL_MAX=5, INBOUND_CONCURRENCY=10, COALESCING_WINDOW_MS=8000"
  echo "  - NODE_ENV=production, PORT=3000"
fi

# ── Bloco 3: rede sbb-db ────────────────────────────────────────────────────
if [ "$STEP" = "all" ] || [ "$STEP" = "network" ]; then
  echo
  echo "═══════════════════════════════════════════════════════════════"
  echo " Bloco 3 — anexar apps à rede externa sbb-db"
  echo "═══════════════════════════════════════════════════════════════"

  warn "Coolify API REST não tem endpoint público pra connect network. Duas opções:"
  echo "  (a) Coolify UI: app → Network → Connect Networks → sbb-db"
  echo "  (b) SSH + docker network connect:"
  cmd "ssh coolify@pangeia.cloud 'docker network connect sbb-db $AI_APP_NAME && docker network connect sbb-db $API_APP_NAME'"
fi

# ── Bloco 4: deploy ─────────────────────────────────────────────────────────
if [ "$STEP" = "all" ] || [ "$STEP" = "deploy" ]; then
  echo
  echo "═══════════════════════════════════════════════════════════════"
  echo " Bloco 4 — deploy (CLI funciona aqui)"
  echo "═══════════════════════════════════════════════════════════════"

  cmd "coolify deploy uuid \$AI_UUID --force"
  cmd "coolify deploy uuid \$API_UUID --force"

  echo
  warn "Regra CLAUDE.md: 1 redeploy por vez, 15min de observação entre eles."
  warn "Monitorar logs:"
  cmd "coolify app logs \$AI_UUID -f"
  cmd "coolify app logs \$API_UUID -f"
fi

# ── Bloco 5: smoke pós-deploy ──────────────────────────────────────────────
if [ "$STEP" = "all" ] || [ "$STEP" = "smoke" ]; then
  echo
  echo "═══════════════════════════════════════════════════════════════"
  echo " Bloco 5 — smoke pós-deploy"
  echo "═══════════════════════════════════════════════════════════════"

  cmd "./scripts/smoke-test.sh --env=prod"
fi

echo
ok "referência impressa. Veja também: coolify/api-rest-reference.md"
