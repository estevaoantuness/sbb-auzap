#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
# smoke-test.sh — implementa C1-C14 do pre-execution checklist
# ════════════════════════════════════════════════════════════════════════════
#
# Cada checagem é um curl ou psql. Output: JSON streaming (uma linha por check).
# Formato: {"check_id":"C1","status":"pass"|"fail"|"skip","detail":"..."}
#
# Uso:
#   ./scripts/smoke-test.sh                     # roda todos (prod)
#   ./scripts/smoke-test.sh --env=dev           # alvo dev local
#   ./scripts/smoke-test.sh --only=C2,C4,C11    # subset
#   ./scripts/smoke-test.sh --json              # stream JSON puro (sem cabeçalhos)
#
# Envs esperadas (opcional — fallbacks razoáveis):
#   COOLIFY_URL       default https://coolify.pangeia.cloud
#   COOLIFY_TOKEN     (pra C2)
#   COOLIFY_SERVER_UUID default voo8kswgwkkokggwogoko4os
#   DATABASE_URL      (pra C4, C5, C6, C12)
#   OPENAI_API_KEY    (pra C7)
#   WABA_PHONE_NUMBER_ID + WABA_ACCESS_TOKEN (pra C8)
#   N8N_API_KEY       (pra C9)
#   POSTGREST_URL     default https://postgrest-sbb.pangeia.cloud (C11)
#   API_URL           default https://auzap-api.pangeia.cloud (C13)
#
# Exit code:
#   0 — todos os checks rodados passaram
#   1 — algum check falhou
#   2 — erro de invocação / dependência missing
# ════════════════════════════════════════════════════════════════════════════

set -uo pipefail

# ── Flags ──────────────────────────────────────────────────────────────────
ENV_TARGET="prod"
ONLY=""
JSON_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --env=*)   ENV_TARGET="${arg#*=}" ;;
    --only=*)  ONLY="${arg#*=}" ;;
    --json)    JSON_ONLY=1 ;;
    -h|--help)
      sed -n '2,28p' "$0"
      exit 0
      ;;
  esac
done

# ── Defaults ───────────────────────────────────────────────────────────────
COOLIFY_URL="${COOLIFY_URL:-https://coolify.pangeia.cloud}"
COOLIFY_SERVER_UUID="${COOLIFY_SERVER_UUID:-voo8kswgwkkokggwogoko4os}"
POSTGREST_URL="${POSTGREST_URL:-https://postgrest-sbb.pangeia.cloud}"
API_URL="${API_URL:-https://auzap-api.pangeia.cloud}"
N8N_URL="${N8N_URL:-https://n8nsuperbembarato.pangeia.cloud}"
N8N_WORKFLOW_ID="${N8N_WORKFLOW_ID:-g0ESSfSDxkFqkuxl}"

# Em dev, vários endpoints mudam.
if [ "$ENV_TARGET" = "dev" ]; then
  API_URL="${API_URL_DEV:-http://localhost:3000}"
  DATABASE_URL="${DATABASE_URL:-postgresql://postgres:devlocal@localhost:5432/sbb}"
fi

# ── Helpers ────────────────────────────────────────────────────────────────
TOTAL=0; PASS=0; FAIL=0; SKIP=0
RESULTS=()

emit() {
  # emit check_id status detail
  local id="$1" status="$2" detail="${3:-}"
  # Escape detail para JSON válido (backslash + aspas).
  local detail_escaped
  detail_escaped=$(printf '%s' "$detail" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\n' | head -c 300)
  RESULTS+=("{\"check_id\":\"$id\",\"status\":\"$status\",\"detail\":\"$detail_escaped\"}")
  echo "{\"check_id\":\"$id\",\"status\":\"$status\",\"detail\":\"$detail_escaped\"}"
  TOTAL=$((TOTAL + 1))
  case "$status" in
    pass) PASS=$((PASS + 1)) ;;
    fail) FAIL=$((FAIL + 1)) ;;
    skip) SKIP=$((SKIP + 1)) ;;
  esac
}

should_run() {
  local id="$1"
  [ -z "$ONLY" ] && return 0
  echo ",$ONLY," | grep -q ",$id,"
}

require_env() {
  local varname="$1"
  if [ -z "${!varname:-}" ]; then
    return 1
  fi
  return 0
}

# ── Banner ─────────────────────────────────────────────────────────────────
if [ "$JSON_ONLY" -eq 0 ]; then
  echo "═══════════════════════════════════════════════════════════════"
  echo " SBB-AuZap smoke test  (env=$ENV_TARGET)"
  echo "═══════════════════════════════════════════════════════════════"
fi

# ── C1: D0 respondido (manual) ─────────────────────────────────────────────
if should_run C1; then
  if [ -f ~/.sbb-auzap-d0-resolved ]; then
    emit "C1" "pass" "gate D0 marcado como resolvido (~/.sbb-auzap-d0-resolved)"
  else
    emit "C1" "skip" "verificação manual — criar ~/.sbb-auzap-d0-resolved após Q1+Q2 do número"
  fi
fi

# ── C2: RAM do Coolify server ──────────────────────────────────────────────
if should_run C2; then
  if require_env COOLIFY_TOKEN; then
    MEM=$(curl -sS -m 10 "$COOLIFY_URL/api/v1/servers/$COOLIFY_SERVER_UUID" \
      -H "Authorization: Bearer $COOLIFY_TOKEN" 2>/dev/null \
      | grep -oE '"mem_total":[0-9]+' | head -1 | cut -d: -f2)
    if [ -n "${MEM:-}" ] && [ "$MEM" -gt 0 ]; then
      MEM_GB=$((MEM / 1024 / 1024 / 1024))
      if [ "$MEM_GB" -ge 8 ]; then
        emit "C2" "pass" "mem_total=${MEM_GB}GB"
      else
        emit "C2" "fail" "mem_total=${MEM_GB}GB (<8GB, abaixo do mínimo)"
      fi
    else
      emit "C2" "fail" "não conseguiu ler mem_total da resposta API"
    fi
  else
    emit "C2" "skip" "COOLIFY_TOKEN não definido"
  fi
fi

# ── C3: docker network sbb-db existe ───────────────────────────────────────
if should_run C3; then
  if [ "$ENV_TARGET" = "dev" ]; then
    emit "C3" "skip" "check irrelevante em dev (dev usa rede sbb-auzap-dev)"
  else
    if command -v ssh >/dev/null 2>&1 && [ -n "${COOLIFY_SSH_HOST:-}" ]; then
      if ssh -o ConnectTimeout=5 -o BatchMode=yes "$COOLIFY_SSH_HOST" "docker network inspect sbb-db" >/dev/null 2>&1; then
        emit "C3" "pass" "rede sbb-db existe no host Coolify"
      else
        emit "C3" "fail" "docker network inspect sbb-db falhou"
      fi
    else
      emit "C3" "skip" "COOLIFY_SSH_HOST não definido (check requer SSH ao host)"
    fi
  fi
fi

# ── C4: pg_cron disponível ─────────────────────────────────────────────────
if should_run C4; then
  if require_env DATABASE_URL && command -v psql >/dev/null 2>&1; then
    OUT=$(psql "$DATABASE_URL" -t -A -c "SELECT name FROM pg_available_extensions WHERE name='pg_cron';" 2>&1 || true)
    if echo "$OUT" | grep -q pg_cron; then
      emit "C4" "pass" "pg_cron disponível → caminho A (DDL cron.schedule)"
    else
      emit "C4" "skip" "pg_cron NÃO disponível → caminho C (pg-boss sendCron)"
    fi
  else
    emit "C4" "skip" "DATABASE_URL ou psql ausente"
  fi
fi

# ── C5: PgBouncer pool_mode session ────────────────────────────────────────
if should_run C5; then
  if [ "$ENV_TARGET" = "dev" ]; then
    emit "C5" "skip" "dev não usa PgBouncer (postgres direto)"
  elif require_env DATABASE_URL && command -v psql >/dev/null 2>&1; then
    # Extrai host:porta do DATABASE_URL e testa pgbouncer admin db.
    PGHOST=$(echo "$DATABASE_URL" | sed -E 's|.*@([^:/]+).*|\1|')
    POOL=$(psql "postgresql://pgbouncer@${PGHOST}:6432/pgbouncer" -t -A -c "SHOW pool_mode;" 2>&1 || true)
    if echo "$POOL" | grep -q session; then
      emit "C5" "pass" "pool_mode=session"
    else
      emit "C5" "fail" "pool_mode=$POOL (esperado 'session'; Prisma multi-schema quebra em transaction)"
    fi
  else
    emit "C5" "skip" "DATABASE_URL ou psql ausente"
  fi
fi

# ── C6: max_connections ≥ 100 ─────────────────────────────────────────────
if should_run C6; then
  if require_env DATABASE_URL && command -v psql >/dev/null 2>&1; then
    MAXCONN=$(psql "$DATABASE_URL" -t -A -c "SHOW max_connections;" 2>&1 || true)
    if [ -n "$MAXCONN" ] && [ "$MAXCONN" -ge 100 ] 2>/dev/null; then
      emit "C6" "pass" "max_connections=$MAXCONN"
    elif [ -n "$MAXCONN" ]; then
      emit "C6" "fail" "max_connections=$MAXCONN (<100, pode estourar sob pico)"
    else
      emit "C6" "fail" "não conseguiu ler SHOW max_connections"
    fi
  else
    emit "C6" "skip" "DATABASE_URL ou psql ausente"
  fi
fi

# ── C7: gpt-5.4-mini disponível ────────────────────────────────────────────
if should_run C7; then
  if require_env OPENAI_API_KEY; then
    MODEL_CHECK=$(curl -sS -m 10 https://api.openai.com/v1/models \
      -H "Authorization: Bearer $OPENAI_API_KEY" 2>/dev/null \
      | grep -oE '"id":"[^"]*5\.4[^"]*"' | head -3 | tr '\n' ',')
    if [ -n "$MODEL_CHECK" ]; then
      emit "C7" "pass" "modelos 5.4 encontrados: $MODEL_CHECK"
    else
      emit "C7" "fail" "nenhum modelo 5.4 listado pela API"
    fi
  else
    emit "C7" "skip" "OPENAI_API_KEY não definido"
  fi
fi

# ── C8: tier WABA ──────────────────────────────────────────────────────────
if should_run C8; then
  if require_env WABA_PHONE_NUMBER_ID && require_env WABA_ACCESS_TOKEN; then
    TIER=$(curl -sS -m 10 \
      "https://graph.facebook.com/v17.0/$WABA_PHONE_NUMBER_ID?fields=messaging_limit_tier" \
      -H "Authorization: Bearer $WABA_ACCESS_TOKEN" 2>/dev/null \
      | grep -oE '"messaging_limit_tier":"[^"]*"' | cut -d\" -f4)
    if [ -n "$TIER" ]; then
      emit "C8" "pass" "tier=$TIER"
    else
      emit "C8" "fail" "não conseguiu ler messaging_limit_tier (token ou phone_number_id inválidos)"
    fi
  else
    emit "C8" "skip" "WABA_PHONE_NUMBER_ID/WABA_ACCESS_TOKEN não definido"
  fi
fi

# ── C9: N8N workflow reativável ────────────────────────────────────────────
if should_run C9; then
  if require_env N8N_API_KEY; then
    HTTP=$(curl -sS -m 10 -o /dev/null -w "%{http_code}" \
      -X GET "$N8N_URL/api/v1/workflows/$N8N_WORKFLOW_ID" \
      -H "X-N8N-API-KEY: $N8N_API_KEY" 2>/dev/null)
    if [ "$HTTP" = "200" ]; then
      emit "C9" "pass" "workflow $N8N_WORKFLOW_ID acessível (HTTP 200)"
    else
      emit "C9" "fail" "GET workflow retornou HTTP=$HTTP"
    fi
  else
    emit "C9" "skip" "N8N_API_KEY não definido"
  fi
fi

# ── C10: backup pg_dump executado ──────────────────────────────────────────
if should_run C10; then
  # Considera pass se existe arquivo recente em /tmp/sbb-pre-cutover-*.sql com >1MB.
  if ls /tmp/sbb-pre-cutover-*.sql >/dev/null 2>&1; then
    LATEST=$(ls -t /tmp/sbb-pre-cutover-*.sql | head -1)
    SIZE=$(stat -f%z "$LATEST" 2>/dev/null || stat -c%s "$LATEST" 2>/dev/null || echo 0)
    if [ "$SIZE" -gt 1048576 ]; then
      emit "C10" "pass" "backup $LATEST tem ${SIZE} bytes"
    else
      emit "C10" "fail" "backup $LATEST é pequeno (<1MB), provável falha de dump"
    fi
  else
    emit "C10" "skip" "nenhum /tmp/sbb-pre-cutover-*.sql encontrado — rode pg_dump antes do cutover"
  fi
fi

# ── C11: PostgREST NÃO expõe agent.* ───────────────────────────────────────
if should_run C11; then
  if [ "$ENV_TARGET" = "dev" ]; then
    emit "C11" "skip" "dev não tem PostgREST exposto"
  else
    HTTP=$(curl -sS -m 10 -o /dev/null -w "%{http_code}" -I "$POSTGREST_URL/agent.runs" 2>/dev/null)
    case "$HTTP" in
      404|401) emit "C11" "pass" "HTTP=$HTTP (agent.* corretamente não exposto)" ;;
      200)     emit "C11" "fail" "HTTP=200 — agent.* EXPOSTO via PostgREST (VAZAMENTO DE PII!)" ;;
      *)       emit "C11" "fail" "HTTP=$HTTP (inesperado)" ;;
    esac
  fi
fi

# ── C12: crm.eventos_lead.idempotency_key UNIQUE ───────────────────────────
if should_run C12; then
  if require_env DATABASE_URL && command -v psql >/dev/null 2>&1; then
    # Verifica se há índice UNIQUE na coluna idempotency_key.
    UQ=$(psql "$DATABASE_URL" -t -A -c "
      SELECT indexdef FROM pg_indexes
      WHERE schemaname='crm' AND tablename='eventos_lead'
      AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%idempotency_key%';
    " 2>&1 || true)
    if [ -n "$UQ" ]; then
      emit "C12" "pass" "índice UNIQUE em idempotency_key encontrado"
    else
      emit "C12" "fail" "sem UNIQUE em crm.eventos_lead.idempotency_key (idempotência quebrada)"
    fi
  else
    emit "C12" "skip" "DATABASE_URL ou psql ausente"
  fi
fi

# ── C13: webhook rejeita POST sem signature ────────────────────────────────
if should_run C13; then
  HTTP=$(curl -sS -m 10 -o /dev/null -w "%{http_code}" \
    -X POST "$API_URL/whatsapp/webhook" \
    -H "Content-Type: application/json" \
    -d '{}' 2>/dev/null)
  case "$HTTP" in
    401|403) emit "C13" "pass" "HTTP=$HTTP (webhook rejeita POSTs sem X-Hub-Signature-256)" ;;
    000)     emit "C13" "skip" "endpoint inacessível ($API_URL)" ;;
    *)       emit "C13" "fail" "HTTP=$HTTP (esperado 401/403 pra payloads sem assinatura)" ;;
  esac
fi

# ── C14: shadow mode não polui crm.* ───────────────────────────────────────
if should_run C14; then
  if require_env DATABASE_URL && command -v psql >/dev/null 2>&1; then
    # Conta linhas em crm.mensagens com criado_por='shadow' (se a coluna/constraint existir).
    OUT=$(psql "$DATABASE_URL" -t -A -c "
      SELECT COUNT(*) FROM crm.mensagens WHERE criado_por='shadow';
    " 2>&1 || true)
    if [ "$OUT" = "0" ]; then
      emit "C14" "pass" "zero mensagens shadow em crm.mensagens"
    elif [ -n "$OUT" ] && [ "$OUT" -gt 0 ] 2>/dev/null; then
      emit "C14" "fail" "$OUT linhas shadow em crm.mensagens (shadow vazando)"
    else
      emit "C14" "skip" "coluna crm.mensagens.criado_por não existe ainda (migration pendente)"
    fi
  else
    emit "C14" "skip" "DATABASE_URL ou psql ausente"
  fi
fi

# ── Resumo ─────────────────────────────────────────────────────────────────
if [ "$JSON_ONLY" -eq 0 ]; then
  echo
  echo "═══════════════════════════════════════════════════════════════"
  echo " Resumo: $PASS passed, $FAIL failed, $SKIP skipped ($TOTAL total)"
  echo "═══════════════════════════════════════════════════════════════"
fi

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
