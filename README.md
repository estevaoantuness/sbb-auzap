# SBB-AuZap — Maria v2 (Super Bem Barato)

![status: MVP em desenvolvimento](https://img.shields.io/badge/status-MVP%20em%20desenvolvimento-yellow)

Backend multi-agente para a secretária WhatsApp do Super Bem Barato.
Forked de AuZap (SaaS petshop) e adaptado para supermercado single-tenant.

## Overview

Maria v2 atende clientes do Super Bem Barato (Luzimangues, Porto Nacional — TO)
via WhatsApp Cloud API da Meta. Mensagens entram num webhook validado por HMAC,
são enfileiradas em `pg-boss` (Postgres), processadas por um worker que chama o
`ai-service` (Python/FastAPI + Agno) e a resposta é enviada de volta via Graph API.

## Stack

- **API Node** — Node 20 + Express + Prisma (`@prisma/client`) + `pg-boss`
- **AI service** — Python 3.11 + FastAPI + Agno + OpenAI
- **Banco** — PostgreSQL 17 (`sbb-postgres` no Coolify)
- **Canal** — WhatsApp Cloud API (Meta) com validação `X-Hub-Signature-256`
- **Fallback de rollback** — N8N (repontar webhook Meta se a stack nova falhar)

## Estrutura

```
sbb-auzap/
  backend/
    api-node/                 # Node + Express (webhook, workers, REST)
      src/
        app.ts                # rotas + middlewares globais
        server.ts             # bootstrap (pg-boss, workers, listen, SIGTERM)
        lib/                  # queue, db, prisma, telegramAlert
        middleware/           # metaSignature.ts (HMAC)
        modules/
          whatsapp/           # webhookController, worker, retrySender, providers/cloudApi
          conversations/      # inbox (dashboard)
          clients/            # CRM do dashboard
          campaigns/          # disparos
          dashboard/          # métricas
          brain/              # agente "brain" admin
          internal/           # webhooks internos (N8N, alertas)
          settings/           # agenda / config
          chat/               # chat interno dashboard
          dev-tools/          # utilitários dev
      prisma/
      Dockerfile | Dockerfile.prod
    ai-service/               # FastAPI + Agno
      main.py                 # POST /run, /history/pop, /reactivate
      agents/                 # router + team (vendas, faq, escalation, onboarding)
      memory/                 # postgres_memory, history_summary, tool_result_cache
      context/
      tools/
      Dockerfile | Dockerfile.prod
  docker/
    docker-compose.dev.yml
    docker-compose.prod.yml
    nginx/
  scripts/                    # bootstrap-dev.sh etc. (Team Infra)
  .env.example
  .env.dev.example            # (Team Infra)
```

## Pré-requisitos (dev local)

- Docker + Docker Compose
- Node 20
- Python 3.11

## Quick start

```bash
cp .env.dev.example .env.dev
./scripts/bootstrap-dev.sh
docker compose -f docker/docker-compose.dev.yml up
```

Health checks:

- `GET http://localhost:3000/health` → `{ status: "ok", service: "sbb-auzap-api", version }`
- `GET http://localhost:8000/health` → `{ status: "ok" }`

## Plano master

O plano de migração AuZap → Maria v2 (com divisão de teams e gates de validação)
está em `/Users/estevaoantunes/.claude/plans/valide-ambas-stacks-antes-groovy-mitten.md`.

## Deploy produção (Coolify)

Ambiente: `coolify.pangeia.cloud`. Apps relevantes:

- `sbb-auzap-api` (Node)
- `sbb-auzap-ai-service` (Python)
- `sbb-postgres` (Postgres 17 — shared com `pg-boss` schema `pgboss.*`)

Disparo de deploy via API REST (exemplo):

```bash
curl -X POST "https://coolify.pangeia.cloud/api/v1/deploy?uuid=<app-uuid>" \
  -H "Authorization: Bearer $COOLIFY_TOKEN"
```

Referência completa em `coolify/api-rest-reference.md`.

## Rollback

Se a Maria v2 falhar em produção, o caminho de rollback é **repontar o webhook
Meta para o N8N** (stack antiga):

1. Meta Business → App da Maria → WhatsApp → Configuration → Webhook
2. Callback URL: `https://n8n.pangeia.cloud/webhook/maria-v1` (stack N8N legada)
3. Verify token: `$N8N_MARIA_VERIFY_TOKEN`
4. Re-subscrever `messages`, `message_template_status_update`, `messaging_postbacks`.

Enquanto o webhook aponta para o N8N, a stack nova (`sbb-auzap-api`) pode ficar
em pé sem receber mensagens — os workers `pg-boss` simplesmente ficam idle.

## Licença

Privado — Super Bem Barato.
