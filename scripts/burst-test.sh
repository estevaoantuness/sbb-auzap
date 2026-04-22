#!/bin/bash
# Burst test pós-Evolution cutover — valida rate limit + singletonKey coalescing
set -e

API_URL="${API_URL:-https://auzap-api.pangeia.cloud}"
EVO_KEY="${EVOLUTION_API_KEY:-QSLLMr6irOKF45qtyE3rcmWycZXYeNfI07Hofc00}"
TEL_BASE="${TEL_BASE:-5563912345600}"

echo "=== Burst test 1: 5 waIds DISTINTOS em 3s (rate limit por bucket) ==="
for i in 1 2 3 4 5; do
  curl -sX POST -H "apikey: $EVO_KEY" -H "Content-Type: application/json" \
    "$API_URL/whatsapp/webhook/evolution" \
    -d "{\"event\":\"messages.upsert\",\"instance\":\"SuperBemBarato\",\"data\":{\"key\":{\"id\":\"wamid.burst_distinct_$i_$(date +%s%N)\",\"remoteJid\":\"${TEL_BASE}${i}@s.whatsapp.net\",\"fromMe\":false},\"message\":{\"conversation\":\"teste distinct $i\"},\"messageTimestamp\":$(date +%s)}}" &
done
wait
echo "  → esperar 2s pro worker consumir"
sleep 2

echo ""
echo "=== Burst test 2: 5 msgs MESMO waId em 3s (singletonKey + coalescing) ==="
for i in 1 2 3 4 5; do
  curl -sX POST -H "apikey: $EVO_KEY" -H "Content-Type: application/json" \
    "$API_URL/whatsapp/webhook/evolution" \
    -d "{\"event\":\"messages.upsert\",\"instance\":\"SuperBemBarato\",\"data\":{\"key\":{\"id\":\"wamid.burst_same_$i_$(date +%s%N)\",\"remoteJid\":\"5563999999991@s.whatsapp.net\",\"fromMe\":false},\"message\":{\"conversation\":\"burst msg $i\"},\"messageTimestamp\":$(date +%s)}}" &
done
wait
echo "  → esperar 15s (coalescing window 8s + worker)"
sleep 15

echo ""
echo "=== Burst test 3: 25 msgs MESMO waId (trigger rate limit) ==="
for i in $(seq 1 25); do
  curl -sX POST -H "apikey: $EVO_KEY" -H "Content-Type: application/json" \
    "$API_URL/whatsapp/webhook/evolution" \
    -d "{\"event\":\"messages.upsert\",\"instance\":\"SuperBemBarato\",\"data\":{\"key\":{\"id\":\"wamid.rate_$i_$(date +%s%N)\",\"remoteJid\":\"5563999999992@s.whatsapp.net\",\"fromMe\":false},\"message\":{\"conversation\":\"rate $i\"},\"messageTimestamp\":$(date +%s)}}" >/dev/null &
done
wait
sleep 5

echo ""
echo "=== RESULTADOS ==="
echo "Rodar no psql (via Coolify UI terminal sbb-postgres):"
cat <<'SQL'
SELECT
  split_part(telefone, '@', 1) AS waId,
  COUNT(*) FILTER (WHERE direcao='in')  AS msgs_in,
  COUNT(*) FILTER (WHERE direcao='out') AS msgs_out,
  COUNT(DISTINCT message_id_waba) AS unique_wamids
FROM crm.mensagens
WHERE created_at > NOW() - INTERVAL '2 minutes'
  AND telefone LIKE '556399999999%'
GROUP BY 1 ORDER BY 1;

-- Conferir agent.runs (turns processados)
SELECT conversa_id, agent_used, latency_ms, created_at
FROM agent.runs
WHERE created_at > NOW() - INTERVAL '2 minutes'
ORDER BY created_at DESC LIMIT 30;
SQL

echo ""
echo "✓ burst-test completo"
