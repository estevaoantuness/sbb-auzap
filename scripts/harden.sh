#!/bin/bash
# harden.sh — executor automático das etapas não-interativas do PLAN-TO-PROD.md
# Uso: bash ~/sbb-auzap/scripts/harden.sh

set -e

COOLIFY_API_KEY=$(grep -E "^COOLIFY_API_KEY=" ~/superbem/.env | cut -d= -f2-)
if [ -z "$COOLIFY_API_KEY" ]; then
  echo "✗ COOLIFY_API_KEY não encontrada em ~/superbem/.env"
  exit 1
fi

echo "══════════════════════════════════════════════════"
echo "  SBB-AuZap Hardening — Fases 0.2, 0.4, 1.3"
echo "══════════════════════════════════════════════════"

# ── 0.2 Postgres health audit ──────────────────────
echo ""
echo "▸ 0.2 sbb-postgres healthcheck audit"
curl -s "https://coolify.pangeia.cloud/api/v1/applications/rk4o8gc08k88ogo8kcg40sow" \
  -H "Authorization: Bearer $COOLIFY_API_KEY" \
  | jq -r '"   status: \(.status)\n   updated: \(.updated_at)"'

LOG_FILE=$(mktemp)
curl -s "https://coolify.pangeia.cloud/api/v1/applications/rk4o8gc08k88ogo8kcg40sow/logs?lines=200" \
  -H "Authorization: Bearer $COOLIFY_API_KEY" \
  | jq -r '.logs // empty' > "$LOG_FILE" 2>/dev/null || true

if [ -s "$LOG_FILE" ]; then
  echo "   healthcheck signals (últimas 15):"
  grep -iE "healthcheck|unhealthy|pg_isready|backup" "$LOG_FILE" | tail -15 | sed 's/^/     /'
else
  echo "   ⚠ log API vazio — checar via UI Coolify manualmente"
fi
rm -f "$LOG_FILE"

# ── 0.4 Pin versions ──────────────────────────────
echo ""
echo "▸ 0.4 Pin versions (ai-service requirements)"
cd ~/sbb-auzap/backend/ai-service
NEED_COMMIT=0
for pin in "agno:agno==2.5.17" "openai:openai==2.32.0" "fastapi:fastapi==0.136.0"; do
  bare=${pin%%:*}
  pinned=${pin##*:}
  if grep -q "^${bare}$" requirements.txt; then
    sed -i.bak "s/^${bare}\$/${pinned}/" requirements.txt
    echo "   ✓ pinned ${bare} → ${pinned}"
    NEED_COMMIT=1
  else
    echo "   — ${bare} já pinado ou não presente"
  fi
done
rm -f requirements.txt.bak

# ── 1.3 RLS audit (imprime comandos) ──────────────
echo ""
echo "▸ 1.3 RLS audit — rodar via Coolify UI terminal no container sbb-postgres:"
cat <<'SQL'
  docker exec sbb-postgres psql -U postgres -d postgres -c "
    SELECT schemaname, tablename, rowsecurity,
      EXISTS(SELECT 1 FROM pg_policies p WHERE p.schemaname=c.schemaname AND p.tablename=c.tablename) AS has_policy
    FROM pg_tables c WHERE schemaname IN ('public','crm')
    ORDER BY rowsecurity, schemaname, tablename;
  "
SQL

# ── Checklist UI Coolify ──────────────────────────
echo ""
echo "══════════════════════════════════════════════════"
echo "  Restantes que exigem UI Coolify (manual):"
echo "══════════════════════════════════════════════════"
echo ""
echo "▸ 0.1 Baileys persistent storage"
echo "  UI → sbb-auzap-api → Persistent Storage → Add:"
echo "    name: baileys_sessions"
echo "    mount: /app/sessions"
echo "  Depois: redeploy"
echo ""
echo "▸ 0.3 Restore drill (Coolify UI terminal em sbb-postgres):"
cat <<'SH'
  LATEST=$(docker exec sbb-postgres-backup ls -t /backups | head -1)
  echo "Backup alvo: $LATEST"
  docker exec sbb-postgres psql -U postgres -c "CREATE DATABASE restore_test"
  docker exec sbb-postgres-backup sh -c "gunzip -c /backups/$LATEST" | docker exec -i sbb-postgres psql -U postgres -d restore_test
  docker exec sbb-postgres psql -U postgres -d restore_test -c "SELECT COUNT(*) FROM crm.mensagens"
  docker exec sbb-postgres psql -U postgres -c "DROP DATABASE restore_test"
SH
echo ""
echo "▸ 1.1 Cloudflare Access (Zero Trust dashboard):"
echo "  - Application: auzap-api.pangeia.cloud + superbembarato.pangeia.cloud"
echo "  - Policy: email ending @superbembarato.com.br OR estevao.antunes.rocha@gmail.com"
echo "  - Duration: 24h"
echo "  - Test: abrir em browser privado → deve exigir OTP"

# ── Commit se houve mudança ───────────────────────
cd ~/sbb-auzap
if [ $NEED_COMMIT -eq 1 ] || ! git diff --quiet; then
  echo ""
  echo "▸ Commit + push mudanças:"
  git add -A
  git commit -m "chore: hardening fase 0 (pin versions, pre-prod checklist)" || echo "   nothing to commit"
  git push origin main 2>&1 | tail -1
fi

echo ""
echo "══════════════════════════════════════════════════"
echo "  ✓ harden.sh concluído"
echo "  Próximo: executar itens manuais acima + scan QR"
echo "══════════════════════════════════════════════════"
