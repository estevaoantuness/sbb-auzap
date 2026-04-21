# STACK — Maria v2 (Super Bem Barato)

> **Status:** 🟢 LIVE desde 2026-04-21 21:10Z
> **Deploy final:** `sbb-auzap-api` + `sbb-auzap-ai` running:healthy em Coolify `pangeia.cloud`
> **Aguardando:** scan QR code Baileys em número novo dedicado pra primeiro atendimento

---

## Overview

Maria v2 é o brain de WhatsApp da Super Bem Barato — migração do AuZap (SaaS petshop, 859 arquivos) adaptado pra supermercado single-tenant, com arquitetura multi-agente (router → 6 especialistas), context guardrails, memória Postgres (sem Redis), Baileys MVP como provider WhatsApp (Cloud API switchable via env), e dashboard integrado no repo existente `superbem-dashboard`.

**3 serviços + DB compartilhado:**

```
┌─ Cliente WhatsApp ──────────────────────────────────────────┐
│                                                             │
│   ┌──────────────────────────────────────────────────────┐  │
│   │ Baileys (celular virtual, QR scan)                   │  │
│   └─────────────────┬────────────────────────────────────┘  │
│                     │                                       │
│   ┌─────────────────▼────────────────────────────────────┐  │
│   │ sbb-auzap-api (Node/Express/Prisma/pg-boss)          │  │
│   │  - webhook / provider Baileys                        │  │
│   │  - enfileira msg em pg-boss (schema=agent)           │  │
│   │  - worker consome + chama ai-service                 │  │
│   │  - envia resposta via Baileys                        │  │
│   └─────────────────┬────────────────────────────────────┘  │
│                     │ HTTP POST /run                        │
│   ┌─────────────────▼────────────────────────────────────┐  │
│   │ sbb-auzap-ai (Python/FastAPI/Agno/OpenAI)            │  │
│   │  - router decide agent+stage                         │  │
│   │  - specialist roda com tools (product/order/...)     │  │
│   │  - pre/post context guards                           │  │
│   │  - memória rolante (sumário a cada 6 turnos)         │  │
│   └─────────────────┬────────────────────────────────────┘  │
│                     │                                       │
│   ┌─────────────────▼────────────────────────────────────┐  │
│   │ sbb-postgres (PG17 shared)                           │  │
│   │  - crm.*   (leads/conversas/mensagens/pedidos)       │  │
│   │  - agent.* (runs/sumarios/router_state/tool_cache)   │  │
│   │  - public.vitrine (13k produtos, sync CISS)          │  │
│   └──────────────────────────────────────────────────────┘  │
│                                                             │
│   ┌──────────────────────────────────────────────────────┐  │
│   │ dashboard-superbem (React 18 + Vite + shadcn)        │  │
│   │  - rotas /inbox /clients /campaigns /whatsapp        │  │
│   │  - consome api-node via VITE_API_NODE_URL            │  │
│   │  - legacy /prompt /orders /settings em PostgREST     │  │
│   └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## Endpoints LIVE

| Serviço | URL | Status |
|---|---|---|
| api-node | `https://auzap-api.pangeia.cloud` | ✅ running:healthy |
| dashboard | `https://superbembarato.pangeia.cloud` | ✅ running |
| ai-service | interno `http://sbb-auzap-ai:8000` | ✅ running:healthy |
| PostgREST | `https://postgrest-sbb.pangeia.cloud` (schemas public,crm) | ✅ (existente) |
| N8N | `https://n8nsuperbembarato.pangeia.cloud` (13 workflows — legacy coexiste) | ✅ (existente) |

---

## Índice

1. [Infra Coolify](#infra)
2. [api-node](#api-node)
3. [ai-service](#ai-service)
4. [Database](#db)
5. [Dashboard](#dashboard)
6. [Fluxo end-to-end](#fluxo)
7. [Pendências go-live](#pendencias)
8. [Runbooks](#runbooks)

---

<a id="infra"></a>
## 1. Infra — Coolify `pangeia.cloud`

Server uuid `voo8kswgwkkokggwogoko4os` (single-host, Traefik 3.6.7). Projeto `sbb-auzap` uuid `qwkw04k4ocgwwk4s4k8w0ogg`.

### Apps do projeto sbb-auzap (novos)
| App | UUID | Status | FQDN | Build | Port |
|---|---|---|---|---|---|
| sbb-auzap-api | `f88swo04ogw0wo8w00okcw8c` | running:healthy | `auzap-api.pangeia.cloud` | dockerfile `/backend/api-node/Dockerfile.prod` | 3000 |
| sbb-auzap-ai | `lk8sccg0k840g8w4w8gskcok` | running:healthy | interno | dockerfile `/backend/ai-service/Dockerfile.prod` | 8000 |

Repo: `github.com/estevaoantuness/sbb-auzap` (público) → Coolify auto-deploy em push `main`.

### Apps reusados (existentes Superbem)
| App | UUID | Status | FQDN | Uso |
|---|---|---|---|---|
| dashboard-superbem | `g0o8oowg0g8sww04ow00cg8w` | running | `superbembarato.pangeia.cloud` | repo `estevaoantuness/superbem-dashboard` |
| sbb-postgres (stack) | `rk4o8gc08k88ogo8kcg40sow` | running:unhealthy⚠ | interno `sbb-postgres-db:5432` | compose: postgres+postgrest+backup+pgadmin+uptime-kuma |
| n8n-superbembarato | `yk8swc80www4kw4c48swk80o` | running | `n8nsuperbembarato.pangeia.cloud` | legacy 13 workflows Maria v1 |

⚠ `sbb-postgres` aparece `running:unhealthy` mas funcional — healthcheck de um dos sub-services falha (backup/postgrest disable). Postgres core está OK (deploys funcionaram, migrations aplicadas).

### Envs configuradas

#### sbb-auzap-api (20 keys)
`DATABASE_URL`, `AI_SERVICE_URL`, `INTERNAL_API_KEY`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `WHATSAPP_PROVIDER`, `BAILEYS_SESSIONS_PATH`, `MAX_AUDIO_SECONDS`, `PGBOSS_POOL_MAX`, `INBOUND_CONCURRENCY`, `COALESCING_WINDOW_MS`, `NODE_ENV`, `SUPERBEM_COMPANY_ID`, `STORE_NAME`, `STORE_PHONE`, `STORE_ADDRESS`, `STORE_HOURS`, `TELEGRAM_ALERT_BOT_TOKEN`, `AUDITOR_PWD`, `POSTGRES_PASSWORD` (pra rodar migrations como superuser).

#### sbb-auzap-ai (12 keys)
`DATABASE_URL`, `INTERNAL_API_KEY`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_MODEL_SUMMARY`, `OPENAI_DAILY_BUDGET_USD`, `HISTORY_SUMMARY_ENABLED`, `SUPERBEM_COMPANY_ID`, `STORE_NAME`, `STORE_PHONE`, `STORE_ADDRESS`, `STORE_HOURS`.

#### dashboard-superbem (8 keys)
`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (legacy PostgREST), `VITE_MARKET_NAME`, `VITE_N8N_WEBHOOK_URL`, `VITE_N8N_WEBHOOK_TOKEN`, `VITE_API_NODE_URL` (novo), `VITE_INTERNAL_API_KEY` (novo — build-time, ⚠ exposto no bundle, segurança real vem da rede privada).

### Deploys bem-sucedidos (2026-04-21)
- api-node: commit `bdeb7f4` em `e8404c8ok8cgok88ssso088g` (21:02Z)
- ai-service: commit `2a1f7fb` em `i8oc84kcwwoocggook4kosg8` (21:10Z)
- dashboard: commit `7f339a8` em `lkow4wco8owc8g800w0gskgk` (20:05Z)

Total histórico: 16 deploys api, 9 ai, 7 dashboard, 81 sbb-postgres (desde criação).

### Redes Docker
- `sbb-db` (bridge interna — acesso ao Postgres)
- `coolify` (externa — Traefik proxy + alias `sbb-postgres-db:5432`)

### Volumes persistentes
- `sbb-postgres-data-v8` (dados PG)
- `sbb-postgres-backups` (backups diários 06:00 BRT, retenção 7d/4w/6m)
- `sbb-pgadmin-data`, `sbb-uptime-kuma-data`
- `baileys_sessions` (declarado em docker-compose.prod.yml; em Coolify single-app precisa ser configurado via UI persistent storage se quiser sobrevivência a redeploys)

---

<a id="api-node"></a>
## 2. api-node — `sbb-auzap-api`

**Stack:** Node 20 Alpine + Express 4.19 + TypeScript 5.5 + Prisma 5.14 (multi-schema) + pg-boss 10.1.5 + Baileys 6.7.9 + qrcode.

**Path:** `/backend/api-node/` no repo.

### Rotas REST

| Module | Base Path | Endpoints |
|---|---|---|
| whatsapp | `/whatsapp` | `GET /status`, `GET /qr`, `POST /disconnect`, `GET /webhook` (Cloud API verify), `POST /webhook` (Cloud API signed) |
| conversations | `/conversations` | `GET /`, `GET /:id/messages`, `POST /:id/messages`, `POST /:id/pause-ai`, `POST /:id/resume-ai` |
| clients | `/clients` | `GET /` (search+segmento), `GET /:id`, `PATCH /:id`, `POST /:id/preferences` |
| campaigns | `/campaigns` | `GET /`, `GET /:id`, `POST /`, `PATCH /:id`, `POST /:id/dispatch` |
| dashboard | `/dashboard` | `GET /kpis`, `/faturamento/*`, `/produtos/top`, `/projecao/*`, `/estoque/*`, `/agent` |
| brain | `/brain` | `POST /chat` (operator IA no dashboard) |
| chat | `/chat` | `POST /business` (legacy alias → brain) |
| settings | `/settings` | `GET/PATCH /empresa`, `GET/PATCH /horario` |
| internal | `/internal` | `POST /notify-escalation`, `GET /ai-service/health`, `POST /debug/simulate-message` (x-internal-key) |
| dev-tools | `/dev-tools` | `GET /db-info`, `POST /send-message`, `POST /lead`, `DELETE /lead/:telefone` (dev only) |

### Providers WhatsApp (`src/modules/whatsapp/providers/`)

Interface `MessagingProvider` (types.ts): `start`, `sendMessage`, `markAsRead`, `getStatus`, `getQR?`, `disconnect?`.

- **baileys.ts** (default MVP): QR via celular virtual, sessão persistida em `/app/sessions/default`, reconexão automática com backoff, eventos `messages.upsert` → enqueue `InboundJob` em pg-boss, typing indicator.
- **cloudApi.ts** (v2 switchable): Meta Graph API v17, HMAC X-Hub-Signature-256, tier messaging_limit.
- **index.ts**: selector via env `WHATSAPP_PROVIDER=baileys|cloud_api`.

### Fila pg-boss (schema=`agent`)

| Queue | Propósito | Schedule | Concurrency |
|---|---|---|---|
| `auzap:msg_inbound` | Mensagens entrada (singletonKey=conv, coalescing window 8s) | on-demand | 10 workers |
| `auzap:retry_send` | Retry envios falhos (backoff expon.) | on-demand | — |
| `rotate-partitions` | agent.rotate_runs_partitions() | `0 3 * * *` | — |
| `purge-pii` | agent.purge_pii_older_than(30) | `15 3 * * *` | — |
| `cleanup-tool-cache` | agent.cleanup_expired_tool_cache() | `0 * * * *` | — |
| `close-inactive-conversations` | crm.encerrar_conversas_inativas(4) | `*/15 * * * *` | — |

### Middlewares

- `metaSignature.ts` — HMAC X-Hub-Signature-256 + verify challenge (Cloud API)
- `internalApiKeyMiddleware.ts` — x-internal-key guard (rotas `/internal/*`)
- `devToolsMiddleware.ts` — dev-only token guard

### Lib

- `queue.ts` — pg-boss singleton + enqueueInbound + registerInboundWorker + scheduleMaintenanceJobs
- `db.ts` — Prisma client singleton
- `telegramAlert.ts` — fire-and-forget alerts (escalação, falhas)
- `cpf.ts`, `uuidValidation.ts` — helpers

### Prisma schema (multi-schema `["crm","agent","public"]`)

Models por schema:
- **crm.*:** Lead, Conversa, Mensagem, EventoLead, Pedido
- **agent.*:** AgentRun, ConversaSumario, RouterState, ToolCache, IdentityFlow, ShadowRun
- **public.*:** Vitrine

### Migrations (`prisma/migrations/`)

1. `20260421000010_create_agent_schema` — schema agent + 5 tabelas + RLS + GRANTs + ALTER OWNER
2. `20260421000020_agent_shadow_runs` — shadow mode table
3. `20260421000030_crm_abrir_conversa` — RPC session-level advisory lock
4. `20260421000040_crm_encerrar_conversas_inativas` — timeout 4h BRT-aware
5. `20260421000050_crm_anonimizar_lead_cascade` — LGPD cascata crm→agent
6. `20260421000060_agent_runs_partitions` — partições mensais + rotate function

`prisma/optional/007_role_auditor.sql` — role read-only (aplicada via entrypoint se `AUDITOR_PWD` setado).

### Startup (`src/server.ts`)

1. pg-boss start (connectionString, schema=agent)
2. `startInboundWorker()` — consumer pra `auzap:msg_inbound`
3. `registerRetryWorker()` — consumer pra `auzap:retry_send`
4. `scheduleMaintenanceJobs()` — createQueue + schedule de 4 jobs
5. `startProvider()` — Baileys ou Cloud API (init socket, load session)
6. `app.listen(PORT)`
7. SIGTERM/SIGINT graceful shutdown (server.close + boss.stop)

### Entrypoint Docker (`scripts/entrypoint.sh`)

1. Valida `DATABASE_URL`
2. Strip query params Prisma (schema, connection_limit) pra PSQL_URL
3. Se `POSTGRES_PASSWORD` disponível → usa superuser pra migrations (contorna CREATE ON DATABASE)
4. Aplica `*.sql` em `prisma/migrations/*/` via `psql -v ON_ERROR_STOP=1` (ordem alfabética)
5. Aplica `007_role_auditor.sql` se `AUDITOR_PWD` setado
6. `prisma generate` (no-op se cliente já gerado)
7. `exec "$@"` (node dist/server.js via tini)

### Dockerfile.prod

Multi-stage Alpine:
- **Builder:** deps (openssl, python3, make, g++, git) + `npm install --include=dev` + `prisma generate` + `tsc` + `npm prune --omit=dev`
- **Runner:** só runtime (openssl, curl, tini, postgresql-client) + user `app` non-root + `VOLUME /app/sessions` + healthcheck `curl /health`

### Dependencies

**Prod:** express, cors, dotenv, jsonwebtoken, uuid, @prisma/client, pg-boss, qrcode, @whiskeysockets/baileys, @hapi/boom, pino, pino-pretty
**Dev:** typescript, ts-node-dev, prisma, @types/*

---

<a id="ai-service"></a>
## 3. ai-service — `sbb-auzap-ai`

**Stack:** Python 3.11 slim + FastAPI + uvicorn (2 workers) + Agno (agent framework) + OpenAI SDK 2.x + asyncpg + psycopg2-binary.

**Path:** `/backend/ai-service/` no repo.

### Endpoints FastAPI (`main.py`)

| Method | Path | Payload | Response |
|---|---|---|---|
| POST | `/run` | `{company_id?, client_phone, message, image_base64?}` | `{reply, agent_used, stage?}` |
| POST | `/history/pop` | `{company_id?, client_phone, count=1}` | `{success, removed}` |
| POST | `/reactivate` | `{company_id?, client_phone}` | `{success, phone}` |
| GET | `/health` | — | `{status, tenant}` |

### Fluxo `/run`

1. `load_context(company_id, client_phone)` — lead + pedidos recentes + preferências + config loja
2. Se imagem → visão gpt-5 (descrição em PT)
3. `save_message(user)` → Postgres
4. `ensure_rolling_summary()` — sumário a cada 6 turnos (gpt-4o-mini)
5. `try_handle_identity_migration()` — stub (sempre None em SBB)
6. `run_router()` — classifica → specialist
7. `apply_guardrails()` (pre) — transição entre agents, trim se >12k chars
8. Specialist roda com tools; reprocess até 3× se "vou verificar" vazar
9. `check_post_guardrails()` — sanitize JSON, verificar_reprocess, CJK noise
10. `save_message(assistant)` + `save_router_ctx()`
11. Retorna reply

### Router multi-agent (`agents/router.py`)

**VALID_AGENTS:** order, product_search, faq, sales, escalation, onboarding
**VALID_STAGES:** WELCOME, SEARCH, ORDER_COLLECTION, ORDER_CONFIRMATION, FAQ, ESCALATION, COMPLETED

Router roda com `OPENAI_MODEL_ROUTER` (default gpt-4o-mini — classificação leve), specialists com `OPENAI_MODEL` (gpt-5). Output JSON: `{agent, stage, intent, pedido_id, required_tools}`. Fallback: onboarding/WELCOME.

### Especialistas (`agents/team/`)

| Agent | Model | Tools | Tool Limit |
|---|---|---|---|
| order_agent | OPENAI_MODEL_ADVANCED | product + order + escalation | 8 |
| product_search_agent | OPENAI_MODEL | product + escalation | 4 |
| faq_agent | OPENAI_MODEL | product + escalation | 2 |
| sales_agent | OPENAI_MODEL_ADVANCED | product + customer + escalation | 3 |
| escalation_agent | OPENAI_MODEL | escalation | 2 |
| onboarding_agent | OPENAI_MODEL | customer + escalation | 2 |

### Context guards (`agents/context_guard.py`)

**Pre-specialist (`apply_guardrails`):**
- `_guardrail_agent_transition` — informa nova transição de agent (últimas msg user/assistant)
- `trim_specialist_input` — enxuga pra 12k chars se contexto explode

**Post-specialist (`check_post_guardrails`):**
- `_sanitize_specialist_reply` — remove JSON blobs inline (tool_json_leak)
- `_reply_triggers_verificar_reprocess` — detecta "vou verificar"/"retorno em breve"/"alinhar com equipe" fora de escalation → reprocess até 3× com suffix instrutivo
- Sanitização extra: `to=functions.*` leaks, ruído CJK (4+ chars)

### Tools (`tools/`)

- **product_tools.py** — `search_products(query)` via RPC `public.buscar_produto` + cache `agent.tool_cache` TTL 300s
- **order_tools.py** — `create_order`, `add_item`, `remove_item`, `confirm_order`, `order_summary` (RPCs crm.*)
- **customer_tools.py** — `upsert_customer`, `fetch_customer_details` (TTL 180s), `register_event`, `set_preference`
- **escalation_tools.py** — `escalate_to_human` (RPC pausar_ia + INSERT evento + webhook Telegram)

### Memory (`memory/`)

- **postgres_memory.py** (asyncpg, pool min=2 max=10) — `save_message`, `get_history(limit=6)`, `get/save_router_ctx`, `pop_last_messages`, `clear_history`
- **history_summary.py** — sumário rolante a cada 6 turnos via gpt-4o-mini; backend `agent.conversa_sumarios`
- **tool_result_cache.py** (psycopg2 sync) — `agent.tool_cache` (TTL por key)
- **message_sanitize.py** — strip tool JSON leaks antes de save

### Prompts (`prompts/`)

- **shared/supermarket_shared.py** — tom Maria, política, config loja injetada via env STORE_*
- **shared/shared_blocks.py** — `GLOBAL_AGENT_MAX_RULES` (proibido inventar preço/promo/taxa/prazo, proibido alerta/lembrete automático)
- **specialists/{order,product_search,faq,sales,escalation}.py** — `build_*_prompt(context, router_ctx)`
- **router/build.py** — monta prompt router com histórico + contexto

### Config (`config.py`)

Envs lidas:
- `OPENAI_API_KEY`, `OPENAI_MODEL` (gpt-5), `OPENAI_MODEL_ADVANCED` (gpt-5), `OPENAI_MODEL_ROUTER` (gpt-4o-mini), `OPENAI_MODEL_COMPANY_11` (optional override), `OPENAI_REASONING_EFFORT` (low)
- `DATABASE_URL` (fallback `DATABASE_URL_AGENT` legacy)
- `INTERNAL_API_KEY`, `API_NODE_URL`
- `SUPERBEM_COMPANY_ID=1`, `STORE_NAME`, `STORE_PHONE`, `STORE_ADDRESS`, `STORE_HOURS`
- `HISTORY_SUMMARY_ENABLED=true`, `OPENAI_MODEL_SUMMARY=gpt-4o-mini`, `HISTORY_SUMMARY_CHUNK=6`
- `TELEGRAM_ALERT_BOT_TOKEN`, `TELEGRAM_ALERT_CHAT_ID`

### Dockerfile.prod

Multi-stage slim: builder com gcc+libpq-dev instala deps em `/install`; runner apenas `libpq5+curl+tini`, user `app` (uid 1001) non-root, healthcheck `curl /health`, CMD `uvicorn main:app --workers 2`.

### requirements.txt

`agno`, `openai`, `fastapi`, `uvicorn`, `watchfiles>=0.21`, `asyncpg>=0.29`, `psycopg2-binary`, `python-dotenv`, `pydantic`, `structlog`, `tzdata>=2024.1`

---

<a id="db"></a>
## 4. Database — `sbb-postgres` (shared)

PostgreSQL 17 (pgvector image). 3 schemas: `public`, `crm`, `agent`. Exposto publicamente via PostgREST (`postgrest-sbb.pangeia.cloud`, schemas `public,crm` apenas). Acesso interno via rede docker `coolify` + alias `sbb-postgres-db:5432`.

**Roles:** `postgres` (super), `authenticator` (PostgREST), `anon`, `sbb_app` (runtime), `auditor` (read-only opcional).

### Schema `public.*` — ERP Sync (read-only)

**vitrine** — PK `erp_id`, colunas: nome, nome_busca, categoria, preco_varejo, preco_promo, em_promocao, saldo_estoque, tem_estoque, dtalteracao. GIN index em fts. Atualizada via sync Python CISS (15min incremental + FULL 03:05 BRT). **13k produtos**.

**RPC `public.buscar_produto(termo, limit)`** — 4-layer FTS fallback: (1) FTS rank+synonym, (2) ILIKE direto, (3) ILIKE+AND, (4) Trigram. Max 8 resultados com estoque ativo.

### Schema `crm.*` — CRM Central (existente)

| Tabela | PK | Refs | Notas |
|---|---|---|---|
| leads | id BIGSERIAL | — | 1 row/telefone WABA; RFM, opt-in LGPD, denormalizados |
| conversas | id | lead_id | Sessão 4h timeout; intencao, sentimento, resumo_ia |
| mensagens | id | conversa_id, lead_id | Append-only; status in/out, message_id_waba |
| eventos_lead | id | lead_id, conversa_id | Event sourcing append-only (38 tipos); idempotency_key UNIQUE |
| pedidos | id | lead_id, conversa_id | Numero `P20260312-0001` via trigger; status lifecycle |
| pedido_itens | id | pedido_id CASCADE | UNIQUE (pedido_id, sku) |
| produtos_consultados | id | lead_id, conversa_id | Log buscar_produto calls |
| campanhas | id | — | Marketing/reengajamento; segmentação RFM |
| campanha_envios | id | campanha_id, lead_id | 1/lead/campanha; message_id_waba tracking |

**Views:** `v_conversas_ativas`, `v_pedidos_kanban`, `v_buscas_sem_resultado`, `v_buscas_sem_estoque`, `mv_leads_rfm` (materialized, refresh diário 03:30 BRT).

**RPCs existentes (reaproveitadas):** `upsert_customer`, `fetch_customer_details`, `criar_pedido`, `adicionar_item_pedido`, `remover_item_pedido`, `atualizar_status_pedido`, `pausar_ia`, `retomar_ia`, `auto_retomar_ia_timeout`, `marcar_mensagens_lidas`, `upsert_preference`.

**RPCs novas (migrations AuZap):**
| Função | Propósito |
|---|---|
| `crm.abrir_conversa(lead_id, telefone)` | Session-level `pg_try_advisory_lock` retry 3×, retorna conversa ativa ou cria. **Suporta pg-boss com TX aberta 20s+** (xact_lock quebraria) |
| `crm.encerrar_conversas_inativas(horas=4)` | Fecha conversas sem msg há N horas BRT-aware (`America/Sao_Paulo`, não UTC). Substitui workflow N8N `sbb-crm-encerrar-conversa` |
| `crm.anonimizar_lead(lead_id)` | LGPD Art.18 IV: UPDATE PII em crm.* + cascata em agent.runs/sumarios/router_state/identity_flow/shadow_runs/tool_cache |

### Schema `agent.*` — AuZap Brain v2 (novo)

| Tabela | PK | Refs | Partição | Notas |
|---|---|---|---|---|
| **runs** | (id, created_at) | conversa_id, lead_id, user_message_id | **RANGE (created_at) mensal** | Trace LLM por turno. UNIQUE(conversa, user_msg, agent, created_at) pra idempotência retry. reply_raw/final/tool_calls purgados após 30d |
| **conversa_sumarios** | conversa_id | conversa_id CASCADE | — | Sumário rolante cada 6 turnos (substitui Redis `chat_summary:*`) |
| **router_state** | conversa_id | conversa_id CASCADE | — | Estado router entre turnos (substitui Redis `chat_router_ctx:*`) |
| **tool_cache** | id | — | — | UNIQUE (tool_name, args_hash, scope_key); TTL via expires_at (substitui Redis `auzap:tc:*`) |
| **identity_flow** | conversa_id | conversa_id CASCADE | — | Fluxo migração/onboarding (phase, partial JSONB) |
| **shadow_runs** | id | conversa_origem_id CASCADE | — | Shadow mode D8: replay offline ZERO poluição em crm.*. UNIQUE (conversa, turno) |

**Partições `agent.runs`:** `runs_2026_04`, `runs_2026_05`, `runs_2026_06` criadas. Rotate function cria NEXT+NEXT+1 (buffer virada de mês) + dropa >90d.

**Functions agent.*:**
- `rotate_runs_partitions()` — diário 03:00 BRT
- `purge_pii_older_than(days=30)` — diário 03:15 BRT (NULL reply_raw/final/tool_calls)
- `cleanup_expired_tool_cache()` — hora em hora

### RLS & GRANTs

**RLS ativo** em todas tabelas `agent.*`:
- Policy `sbb_app_all` (role sbb_app): FOR ALL USING(true) WITH CHECK(true)
- Policy `auditor_read` (role auditor, opcional): FOR SELECT USING(true)

**GRANTs essenciais sbb_app** (aplicados em migration 001 rodada como superuser):
- `GRANT CREATE ON DATABASE postgres` — pg-boss bootstrap precisa
- `GRANT USAGE, CREATE ON SCHEMA agent` + ALL em tabelas/sequences/functions
- `ALTER SCHEMA agent OWNER TO sbb_app` + `ALTER TABLE agent.* OWNER TO sbb_app` — permite pg-boss criar tabelas próprias via DDL
- `ALTER DEFAULT PRIVILEGES IN SCHEMA agent` pra futuras tabelas

### Decisões de design

| Aspecto | Escolha | Motivo |
|---|---|---|
| runs particionamento | RANGE (created_at) mensal | Retenção 90d automática, drop partitions O(1) |
| abrir_conversa lock | SESSION-level advisory | Suporta pg-boss com TX aberta 20s+ |
| anonimizar_lead | UPDATE (não DELETE) | Preserva integridade FK + métricas RFM |
| tool_cache TTL | expires_at TIMESTAMPTZ | Determinístico (vs Redis expiry aleatório) |
| shadow_runs idempotência | UNIQUE (conversa, turno) | Replay seguro com ON CONFLICT DO NOTHING |
| Timezone conversas | BRT | Evita fechar conversa no horário comercial do cliente |

---

<a id="dashboard"></a>
## 5. Dashboard — `superbembarato.pangeia.cloud`

**Repo:** `github.com/estevaoantuness/superbem-dashboard` (Coolify auto-deploy em push main)

**Stack:** React 18.3 + Vite 5.4 + TypeScript 5.8 + Tailwind 3.4 + @radix-ui (shadcn/ui) + @base-ui/react + react-router-dom 6.30 + @tanstack/react-query 5.83 + recharts 2.15 + lucide-react + sonner + vaul + react-hook-form + Zod + framer-motion + date-fns.

### Rotas (`src/App.tsx`)

| Path | Page | Origem |
|---|---|---|
| `/` | Index → redirect `/prompt` | legacy |
| `/prompt` | PromptDemo (faturamento/estoque/gráficos) | legacy |
| **`/inbox`** | **InboxPage** | **novo AuZap** |
| `/conversations` | ConversationsPostgrest | legacy (em deprecação) |
| **`/clients`** | **ClientsPage** | **novo AuZap** |
| `/crm` | CRM | legacy |
| `/orders` | Orders (Kanban) | legacy |
| **`/campaigns`** | **CampaignsPage** | **novo AuZap** |
| **`/whatsapp`** | **WhatsAppPage** (QR + status) | **novo AuZap** |
| `/settings` | Settings (Sync, Analytics) | legacy |

### Componentes novos (Team E, 20 arquivos)

- **`src/components/inbox/`** — InboxPage, ConversationsList, ConversationPanel, MessageBubble, CustomerDrawer, inbox-utils
- **`src/components/clients/`** — ClientsPage
- **`src/components/campaigns/`** — CampaignsPage, CampaignEditor
- **`src/components/whatsapp/`** — WhatsAppPage
- **`src/components/shared/`** — DashboardShell, ErrorBoundary, LoadingSpinner, EmptyState, StatusBadge, status-helpers

### Hooks (`src/hooks/`)

- **use-inbox.ts** — useInboxConversations (poll 10s), useInboxMessages (poll 6s), useSendMessage, useToggleConversationAi
- **use-clients.ts** — useClients, useClient, useUpdateClient, useUpsertPreference
- **use-campaigns.ts** — useCampaigns, useCampaign, useCreateCampaign, useUpdateCampaign, useDispatchCampaign
- **use-whatsapp.ts** — useWhatsAppStatus (adaptive polling 5/10/30s), useWhatsAppQr, useDisconnectWhatsApp
- **use-interval.ts** — polling genérico com cleanup

### API client (`src/lib/apiNode.ts`)

```ts
apiGet<T>(path), apiPost<T>(path, body), apiPatch<T>(path, body), apiDelete<T>(path)
qs(params) // query-string builder
// Header automático: x-internal-key: $VITE_INTERNAL_API_KEY
// Base: $VITE_API_NODE_URL = https://auzap-api.pangeia.cloud
// Erros: ApiNodeError(status, message, payload)
```

### Tipos (`src/lib/apiNodeTypes.ts`)

`InboxConversation`, `InboxMessage`, `ClientSummary`, `ClientDetail`, `ClientPatch`, `PreferencePayload`, `CampaignSummary`, `CampaignInput`, `WhatsAppStatus`, `WhatsAppState`, `WhatsAppQrResponse`.

### CONTRACT.md

Lista 20+ endpoints api-node por hook consumidor. Regra: toda mudança de endpoint no api-node → atualizar CONTRACT.md no mesmo PR. Schema `agent.*` NUNCA é acessado via PostgREST direto — apenas via api-node.

### Envs (build-time)

`VITE_SUPABASE_URL` (legacy PostgREST), `VITE_SUPABASE_ANON_KEY`, `VITE_API_NODE_URL` (novo), `VITE_INTERNAL_API_KEY` (novo — ⚠ público no bundle, segurança vem da rede privada Coolify), `VITE_N8N_WEBHOOK_URL`, `VITE_MARKET_NAME`.

### Deploy

- Coolify app `g0o8oowg0g8sww04ow00cg8w`
- Webhook Git push `main` → rebuild automático
- Bundle Vite: ~1.5 MB (339 KB gzip), build ~2-3 min
- Páginas legacy (PromptDemo/CRM/Orders) continuam lendo PostgREST direto — migration gradual

---

<a id="fluxo"></a>
## 6. Fluxo end-to-end

### Mensagem entrando (cliente → Maria v2)

```
1. Cliente WhatsApp envia msg pro número dedicado
   ↓
2. Baileys socket (celular virtual) recebe em sbb-auzap-api
   providers/baileys.ts → messages.upsert event
   ↓
3. Filtra msg: skip fromMe, skip type != notify, skip ts > 60s (replay offline)
   Extrai: waId, messageId (baileys key.id), body, mediaType
   ↓
4. enqueueInbound(job) → pg-boss queue auzap:msg_inbound
   singletonKey=`conv:${waId}` (serializa por conversa)
   startAfter=8s (coalescing window — agrupa msgs burst)
   expireInSeconds=900 (15min DLQ)
   ↓
5. Worker (concurrency=10) pega job
   5.1 Pre-guardrail regex: injection patterns → escala direto
   5.2 RPC crm.upsert_customer(telefone) → lead_id
   5.3 RPC crm.abrir_conversa(lead_id, telefone) → conversa_id (advisory lock)
   5.4 INSERT crm.mensagens direcao=in
   5.5 INSERT crm.eventos_lead mensagem_recebida (idempotency_key=wamid:tipo, ON CONFLICT DO NOTHING)
   ↓
6. HTTP POST http://sbb-auzap-ai:8000/run
   {company_id:1, client_phone:waId, message, image_base64?}
   ↓
7. ai-service:
   7.1 load_context → lead + pedidos + prefs + config loja
   7.2 save_message(user) → crm.mensagens (via asyncpg postgres_memory)
   7.3 ensure_rolling_summary (se > 6 msgs desde último sumário)
   7.4 router_agent classifica → {agent, stage, intent, required_tools}
   7.5 apply_guardrails (pre — transição, trim)
   7.6 specialist.run(input) com tools (até 8 tool_calls)
   7.7 check_post_guardrails:
       - Sanitize JSON leaks
       - Se "vou verificar" sem escalation → reprocess (max 3×)
   7.8 save_message(assistant), save_router_ctx
   7.9 INSERT agent.runs (trace: agent_used, tokens, latency_ms, guardrails_fired)
   ↓ retorna {reply, agent_used, stage}
8. api-node worker:
   8.1 INSERT crm.mensagens direcao=out status=pendente
   8.2 provider.sendMessage(waId, reply) → Baileys envia
   8.3 UPDATE crm.mensagens status=enviada + messageIdWaba
   8.4 Se falhou → enqueueRetry (backoff 30s/2min/10min, 3× extras)
```

### Operador vendo no dashboard

```
Dashboard → /inbox (ConversationsList)
  ↓ useInboxConversations (poll 10s)
  GET https://auzap-api.pangeia.cloud/conversations?status=ativa
  + x-internal-key header
  ↓
api-node: Prisma query crm.conversas JOIN crm.leads LEFT JOIN last crm.mensagens
  ↓
UI renderiza lista com unread badges + sentimento emoji
```

### Operador pausando IA

```
POST /conversations/:id/pause-ai
  ↓ RPC crm.pausar_ia(conversa_id) via Prisma.$executeRaw
  ↓ UPDATE crm.leads SET ai_paused=true
  ↓ Próxima msg do cliente chega → worker check ai_paused → skip ai-service call
```

### Jobs agendados (pg-boss em sbb-auzap-api)

- **03:00 BRT:** `rotate-partitions` → `agent.rotate_runs_partitions()` (cria próximos 2 meses, dropa >90d)
- **03:15 BRT:** `purge-pii` → `agent.purge_pii_older_than(30)` (NULL reply_raw/final/tool_calls)
- **Hora em hora:** `cleanup-tool-cache` → DELETE expired
- **Cada 15min:** `close-inactive-conversations` → `crm.encerrar_conversas_inativas(4)` BRT-aware

---

<a id="pendencias"></a>
## 7. Pendências go-live

### 🔴 Bloqueador (só user resolve)

**Chip WhatsApp novo dedicado:**
1. Comprar chip (ex: Vivo) + ativar no celular
2. Abrir `https://superbembarato.pangeia.cloud/whatsapp`
3. Scan QR code com app WhatsApp desse chip
4. Status muda `qr_pending → connected`
5. Bot passa a receber e responder

### 🟡 Opcionais recomendados

- **Shadow mode (D8 plano):** rodar `scripts/shadow/replay_runner.py` por 48h antes de cutover real pra ter GO/NO-GO numérico
- **Baseline Maria-N8N:** `psql -f ~/superbem/scripts/baseline-maria.sql` pra medir escalação/latência/custo atuais
- **pg_cron extension:** checar disponibilidade (`SELECT * FROM pg_available_extensions WHERE name='pg_cron'`) e migrar schedules do pg-boss pra pg_cron (mais robusto pra DDL)
- **VITE_INTERNAL_API_KEY reviewsec:** atualmente no bundle JS público; segurança atual vem da rede privada + Cloudflare Access. Se quiser camada extra, mover proxy api-node pra rota autenticada no dashboard.
- **Volume `baileys_sessions` persistente:** declarado em docker-compose mas Coolify single-app pode não ter bind automático — configurar via UI Persistent Storage pra sobreviver redeploys (senão perde sessão a cada build)
- **tier WABA se migrar pra Cloud API:** começar em 1k conv únicas/24h; planejar escalada Meta antes de qualquer pico

### 🟢 Não bloqueante

- Deprecar rotas legacy no dashboard: `/conversations` → redirect `/inbox`, `/crm` → `/clients`
- Atualizar `docs/STACK.md` do repo Superbem com novos UUIDs Coolify sbb-auzap
- Decomissionar workflows N8N aposentados: `01.Secretaria v3`, `sbb-buscar-produto`, `07.Quebrar+enviar`, `SBB Sender`, `05.Escalar Humano`, `sbb-receiver`, `sbb-crm-encerrar-conversa` (manter arquivados 90d pra contingência)

---

<a id="runbooks"></a>
## 8. Runbooks

### Deploy manual

```bash
# api-node
curl -X POST "https://coolify.pangeia.cloud/api/v1/deploy?uuid=f88swo04ogw0wo8w00okcw8c&force=true" \
  -H "Authorization: Bearer $COOLIFY_API_KEY"

# ai-service
curl -X POST "https://coolify.pangeia.cloud/api/v1/deploy?uuid=lk8sccg0k840g8w4w8gskcok&force=true" \
  -H "Authorization: Bearer $COOLIFY_API_KEY"

# dashboard (ou git push origin main)
curl -X POST "https://coolify.pangeia.cloud/api/v1/deploy?uuid=g0o8oowg0g8sww04ow00cg8w&force=true" \
  -H "Authorization: Bearer $COOLIFY_API_KEY"
```

### Logs

```bash
# Via Coolify CLI (preferido)
coolify app logs f88swo04ogw0wo8w00okcw8c -f  # api-node
coolify app logs lk8sccg0k840g8w4w8gskcok -f  # ai-service

# Via API (deployment específico)
curl -s "https://coolify.pangeia.cloud/api/v1/deployments/<DEPLOY_UUID>" \
  -H "Authorization: Bearer $COOLIFY_API_KEY" | jq -r '.logs | fromjson | .[-30:] | map(.output) | .[]'
```

### Smoke tests

```bash
curl https://auzap-api.pangeia.cloud/health
# → {"status":"ok","service":"sbb-auzap-api","version":"1.0.0"}

curl https://auzap-api.pangeia.cloud/whatsapp/status
# → {"ok":true,"provider":"baileys","status":"qr_pending"|"connected"}

curl https://auzap-api.pangeia.cloud/whatsapp/qr
# → {"ok":true,"qrCodeDataUrl":"data:image/png;base64,..."}
```

### Rollback de emergência (cutover falhou)

```bash
# 1. Parar containers AuZap
coolify app stop f88swo04ogw0wo8w00okcw8c
coolify app stop lk8sccg0k840g8w4w8gskcok

# 2. Reativar Maria-N8N
curl -X PATCH "https://n8nsuperbembarato.pangeia.cloud/api/v1/workflows/g0ESSfSDxkFqkuxl" \
  -H "X-N8N-API-KEY: $N8N_API_KEY" \
  -d '{"active":true}'

# 3. Repontar webhook WhatsApp pro N8N (se Cloud API) ou reconectar QR Baileys em número antigo
# (Com Baileys, número novo AuZap não interfere no (63) 4141-9318 original)
```

### Conectar WhatsApp (primeira vez)

```
1. Abrir dashboard /whatsapp (https://superbembarato.pangeia.cloud/whatsapp)
2. Com chip novo ativo no celular, abrir WhatsApp → Configurações → Aparelhos conectados
3. "Conectar aparelho" → scan QR no dashboard
4. Status muda qr_pending → connecting → connected em ~5-10s
5. Enviar msg de teste do seu celular pessoal pro número dedicado
6. Verificar em SQL:
   SELECT * FROM crm.mensagens WHERE telefone='SEU_TEL' ORDER BY id DESC LIMIT 2;
   SELECT * FROM agent.runs ORDER BY id DESC LIMIT 1;
```

### Baileys sessão perdida (redeploy sem volume persistente)

Se sessão Baileys for limpa (volume não persistiu):
1. `/whatsapp/status` retorna `disconnected`
2. `/whatsapp/qr` pode demorar ~5s pra aparecer novo QR
3. Scan novamente — reconecta ao mesmo número (Baileys mantém creds no WhatsApp server se auth recentemente)
4. Alternativamente configurar volume Coolify: UI → app → Persistent Storage → `/app/sessions`

---

## Histórico

- **2026-04-16:** zip AuZap (petshop SaaS) analisado, 859 arquivos
- **2026-04-18:** número novo dedicado definido (X2), evitar impacto no (63) 4141-9318 existente
- **2026-04-20:** plano v6 aprovado após 3 auditorias + 7 validadores. 5 agent teams paralelos entregam backend+infra+dashboard
- **2026-04-21:** decisão Baileys MVP (Cloud API switchable via env) → deploy live; correções iterativas (Dockerfile git, npm install, dockerignore migrations, UNIQUE partitioned, CREATE ON DATABASE, ALTER OWNER, Baileys sessions mkdir, pg-boss createQueue, DATABASE_URL_AGENT → DATABASE_URL)

**Repositórios:**
- Backend: `github.com/estevaoantuness/sbb-auzap` (público)
- Frontend: `github.com/estevaoantuness/superbem-dashboard` (existente)
- Plano master: `~/.claude/plans/valide-ambas-stacks-antes-groovy-mitten.md`

**Última revisão:** 2026-04-21 21:10Z


