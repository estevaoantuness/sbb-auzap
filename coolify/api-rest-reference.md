# Coolify API REST — Referência SBB-AuZap

Referência dos endpoints REST para provisionar `sbb-auzap` no Coolify `pangeia.cloud`,
extraída do `§Team A` do plano (`/Users/estevaoantunes/.claude/plans/valide-ambas-stacks-antes-groovy-mitten.md`).

> **Por que API REST e não CLI?**
> Coolify CLI v1.6.0 expõe apenas `deploy`, `logs`, `app list`. Não tem `project create`,
> `app create`, nem `env set`. Pra criação e configuração, API REST é o único caminho.
> CLI fica pra leitura (list, logs, status) e deploy.

## Pré-requisitos

```bash
export COOLIFY_URL="https://coolify.pangeia.cloud"
export COOLIFY_TOKEN="..."                                   # token pessoal
export COOLIFY_SERVER_UUID="voo8kswgwkkokggwogoko4os"        # server "superbem"
export COOLIFY_DESTINATION_UUID="<uuid_docker_destination>"  # olhar via GET /destinations
export GIT_REPO="https://github.com/estevaoantuness/sbb-auzap"
```

Obter `destination_uuid`:

```bash
curl -sS "$COOLIFY_URL/api/v1/servers/$COOLIFY_SERVER_UUID/destinations" \
  -H "Authorization: Bearer $COOLIFY_TOKEN" | jq '.[] | {uuid, name}'
```

---

## 1 — Criar projeto

```bash
PROJECT_RESP=$(curl -sS -X POST "$COOLIFY_URL/api/v1/projects" \
  -H "Authorization: Bearer $COOLIFY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "sbb-auzap",
    "description": "AuZap brain for Maria v2 — Super Bem Barato"
  }')

export PROJECT_UUID=$(echo "$PROJECT_RESP" | jq -r .uuid)
echo "PROJECT_UUID=$PROJECT_UUID"
```

---

## 2 — Criar aplicações

### 2.1 — `sbb-auzap-ai` (FastAPI, interno)

```bash
AI_RESP=$(curl -sS -X POST "$COOLIFY_URL/api/v1/applications" \
  -H "Authorization: Bearer $COOLIFY_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"project_uuid\": \"$PROJECT_UUID\",
    \"server_uuid\": \"$COOLIFY_SERVER_UUID\",
    \"destination_uuid\": \"$COOLIFY_DESTINATION_UUID\",
    \"name\": \"sbb-auzap-ai\",
    \"git_repository\": \"$GIT_REPO\",
    \"git_branch\": \"main\",
    \"build_pack\": \"dockerfile\",
    \"dockerfile_location\": \"backend/ai-service/Dockerfile.prod\",
    \"ports_exposes\": \"8000\"
  }")

export AI_UUID=$(echo "$AI_RESP" | jq -r .uuid)
echo "AI_UUID=$AI_UUID"
```

### 2.2 — `sbb-auzap-api` (Express, público)

```bash
API_RESP=$(curl -sS -X POST "$COOLIFY_URL/api/v1/applications" \
  -H "Authorization: Bearer $COOLIFY_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"project_uuid\": \"$PROJECT_UUID\",
    \"server_uuid\": \"$COOLIFY_SERVER_UUID\",
    \"destination_uuid\": \"$COOLIFY_DESTINATION_UUID\",
    \"name\": \"sbb-auzap-api\",
    \"git_repository\": \"$GIT_REPO\",
    \"git_branch\": \"main\",
    \"build_pack\": \"dockerfile\",
    \"dockerfile_location\": \"backend/api-node/Dockerfile.prod\",
    \"ports_exposes\": \"3000\",
    \"fqdn\": \"https://auzap-api.pangeia.cloud\"
  }")

export API_UUID=$(echo "$API_RESP" | jq -r .uuid)
echo "API_UUID=$API_UUID"
```

---

## 3 — Setar envs

Endpoint: `POST /api/v1/applications/{uuid}/envs` — um par `key/value` por requisição.

### 3.1 — Função helper

```bash
set_env() {
  local app_uuid="$1" key="$2" value="$3" buildtime="${4:-false}"
  curl -sS -X POST "$COOLIFY_URL/api/v1/applications/$app_uuid/envs" \
    -H "Authorization: Bearer $COOLIFY_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"key\":\"$key\",\"value\":\"$value\",\"is_buildtime\":$buildtime}"
  echo
}
```

### 3.2 — Envs do `sbb-auzap-ai`

```bash
set_env $AI_UUID DATABASE_URL "postgresql://sbb_app:$SBB_APP_PWD@postgres-sbb:6432/sbb?schema=public&connection_limit=10"
set_env $AI_UUID OPENAI_API_KEY "$OPENAI_API_KEY"
set_env $AI_UUID OPENAI_MODEL "gpt-5.4-mini"
set_env $AI_UUID OPENAI_MODEL_SUMMARY "gpt-5.4-mini"
set_env $AI_UUID OPENAI_MODEL_JUDGE "gpt-5.4"
set_env $AI_UUID OPENAI_DAILY_BUDGET_USD "10"
set_env $AI_UUID HISTORY_SUMMARY_ENABLED "true"
set_env $AI_UUID SUPERBEM_COMPANY_ID "1"
set_env $AI_UUID STORE_NAME "Super Bem Barato"
set_env $AI_UUID STORE_PHONE "(63) 4141-9318"
set_env $AI_UUID STORE_ADDRESS "Luzimangues, Porto Nacional - TO"
set_env $AI_UUID STORE_HOURS "Seg-Sáb 07:00-22:00, Dom 08:00-20:00"
set_env $AI_UUID INTERNAL_API_KEY "$INTERNAL_API_KEY"
set_env $AI_UUID TELEGRAM_ALERT_BOT_TOKEN "$TELEGRAM_ALERT_BOT_TOKEN"
set_env $AI_UUID TELEGRAM_ALERT_CHAT_ID "$TELEGRAM_ALERT_CHAT_ID"
set_env $AI_UUID GROQ_API_KEY "$GROQ_API_KEY"
set_env $AI_UUID MAX_AUDIO_SECONDS "120"
set_env $AI_UUID SHADOW_MODE_ENABLED "false"
set_env $AI_UUID SHADOW_SAMPLE_SIZE "100"
```

### 3.3 — Envs do `sbb-auzap-api`

```bash
set_env $API_UUID DATABASE_URL "postgresql://sbb_app:$SBB_APP_PWD@postgres-sbb:6432/sbb?schema=public&connection_limit=10"
set_env $API_UUID AI_SERVICE_URL "http://sbb-auzap-ai:8000"
set_env $API_UUID WHATSAPP_PROVIDER "cloud_api"
set_env $API_UUID WABA_PHONE_NUMBER_ID "$WABA_PHONE_NUMBER_ID"
set_env $API_UUID WABA_BUSINESS_ACCOUNT_ID "$WABA_BUSINESS_ACCOUNT_ID"
set_env $API_UUID WABA_ACCESS_TOKEN "$WABA_ACCESS_TOKEN"
set_env $API_UUID WABA_APP_SECRET "$WABA_APP_SECRET"
set_env $API_UUID WABA_VERIFY_TOKEN "$WABA_VERIFY_TOKEN"
set_env $API_UUID INTERNAL_API_KEY "$INTERNAL_API_KEY"   # MESMO valor que o ai-service
set_env $API_UUID PGBOSS_POOL_MAX "5"
set_env $API_UUID INBOUND_CONCURRENCY "10"
set_env $API_UUID COALESCING_WINDOW_MS "8000"
set_env $API_UUID TELEGRAM_ALERT_BOT_TOKEN "$TELEGRAM_ALERT_BOT_TOKEN"
set_env $API_UUID TELEGRAM_ALERT_CHAT_ID "$TELEGRAM_ALERT_CHAT_ID"
set_env $API_UUID SUPERBEM_COMPANY_ID "1"
set_env $API_UUID STORE_NAME "Super Bem Barato"
set_env $API_UUID STORE_PHONE "(63) 4141-9318"
set_env $API_UUID STORE_ADDRESS "Luzimangues, Porto Nacional - TO"
set_env $API_UUID STORE_HOURS "Seg-Sáb 07:00-22:00, Dom 08:00-20:00"
set_env $API_UUID NODE_ENV "production"
set_env $API_UUID PORT "3000"
```

---

## 4 — Anexar rede `sbb-db`

A API Coolify não tem endpoint canônico pra connect network. Duas opções:

**Opção A — Coolify UI**
App → `Network` → `Connect Networks` → selecionar `sbb-db`.

**Opção B — SSH + docker network connect**

```bash
ssh coolify@pangeia.cloud \
  "docker network connect sbb-db sbb-auzap-ai && \
   docker network connect sbb-db sbb-auzap-api"
```

Valida (C3):

```bash
ssh coolify@pangeia.cloud "docker network inspect sbb-db" | jq '.[0].Containers'
```

---

## 5 — Deploy (CLI funciona aqui)

```bash
coolify deploy uuid $AI_UUID --force
# aguardar 15min de observação (regra CLAUDE.md / docs/STACK.md) antes do próximo
coolify deploy uuid $API_UUID --force
```

Logs (streaming):

```bash
coolify app logs $AI_UUID -f
coolify app logs $API_UUID -f
```

---

## 6 — Validação pós-deploy

```bash
# Health checks
curl -fsS https://auzap-api.pangeia.cloud/health                         # {"status":"ok"}
curl -fsS -H "x-internal-key: $INTERNAL_API_KEY" \
  https://auzap-api.pangeia.cloud/internal/ai-service/health

# C13 — webhook rejeita POSTs sem assinatura
curl -sS -o /dev/null -w "%{http_code}\n" \
  -X POST https://auzap-api.pangeia.cloud/whatsapp/webhook \
  -H "Content-Type: application/json" \
  -d '{}'                                                                # 401/403

# C11 — PostgREST NÃO expõe agent.*
curl -sS -o /dev/null -w "%{http_code}\n" \
  -I https://postgrest-sbb.pangeia.cloud/agent.runs                      # 404/401

# Suite completa
./scripts/smoke-test.sh --env=prod
```

---

## 7 — Rollback de emergência (T+0 a T+30min)

```bash
# 1. Apontar webhook Meta de volta pro N8N
curl -X POST "https://graph.facebook.com/v17.0/$WABA_APP_ID/subscriptions" \
  -H "Authorization: Bearer $WABA_ACCESS_TOKEN" \
  -d '{"object":"whatsapp_business_account","callback_url":"https://n8nsuperbembarato.pangeia.cloud/webhook/sbb-receiver","fields":"messages"}'

# 2. Reativar workflow
curl -X PATCH "https://n8nsuperbembarato.pangeia.cloud/api/v1/workflows/g0ESSfSDxkFqkuxl" \
  -H "X-N8N-API-KEY: $N8N_API_KEY" \
  -d '{"active":true}'

# 3. Parar AuZap
coolify app stop $API_UUID
coolify app stop $AI_UUID
```

Tempo total: ~5min. Mensagens entre T+0 e rollback ficam em `agent.runs` pra revisão.

---

## UUIDs de referência

| Item                         | UUID                                 |
| ---------------------------- | ------------------------------------ |
| Coolify server               | `voo8kswgwkkokggwogoko4os`           |
| sbb-postgres app             | `rk4o8gc08k88ogo8kcg40sow`           |
| Projeto sbb-auzap            | (criar em §1; guardar em memória)    |
| App sbb-auzap-ai             | (criar em §2.1; guardar em memória)  |
| App sbb-auzap-api            | (criar em §2.2; guardar em memória)  |

---

## Troubleshooting

**Resposta 401 no POST /applications:**
Token sem permissão ou expirado. Recriar no Coolify UI `→ Keys & Tokens`.

**`destination_uuid` inválido:**
Rodar `GET /servers/$COOLIFY_SERVER_UUID/destinations` pra listar.

**App faz deploy mas não alcança postgres-sbb:6432:**
Rede `sbb-db` não foi conectada. Ver §4.

**`prisma generate` falha no build:**
Aumentar `build_timeout` no Coolify (default pode ser curto pro primeiro build). Ou pre-build imagem localmente e push pro Coolify registry.
