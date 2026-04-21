# 🧠 Knowledge Base — WhatsApp AI Agent SaaS para Petshops

## Visão Geral

SaaS multi-tenant de agentes de IA para WhatsApp, iniciando pelo nicho de petshops. Cada petshop conecta seu próprio WhatsApp, e um agente de IA responde automaticamente aos clientes.

---

## Stack Tecnológica

| Camada | Tecnologia |
|---|---|
| Frontend | React + Vite + TypeScript |
| Backend API | Node.js + TypeScript (api-node) |
| Agente de IA | Python + FastAPI + Agno (ai-service) |
| WhatsApp | Baileys (biblioteca Node) |
| Banco de dados | Supabase (PostgreSQL) |
| Cache / Memória | Redis |
| Infra | Docker + Docker Compose |
| LLM | OpenAI gpt-4o-mini |

---

## Estrutura de Repositório (Monorepo)

```
agent-whatsapp/
  backend/
    api-node/          ← Node + TypeScript
      src/
        services/
          agentService.ts     ← chama o ai-service via HTTP
          baileysService.ts   ← gerencia sessões WhatsApp por company
        modules/
          whatsapp/           ← controller + routes do WhatsApp
          webhook/
            messageHandler.ts ← processa mensagens recebidas
      prisma/
        schema.prisma
      Dockerfile
    ai-service/        ← Python + FastAPI + Agno
      agents/
        router.py             ← classifica intenção + delega ao especialista
        team/
          onboarding_agent.py
          booking_agent.py
          faq_agent.py
          sales_agent.py
          escalation_agent.py
      context/
        loader.py             ← carrega company + petshop + cliente do banco
      memory/
        redis_memory.py       ← histórico de conversa por company + cliente
      prompts/
        router_prompt.py
        onboarding_prompt.py
        booking_prompt.py
        sales_prompt.py       ← contém também build_faq_prompt e build_escalation_prompt
        faq_prompt.py         ← re-exporta de sales_prompt.py
      tools/
        client_tools.py       ← get_client_pets, create_pet, get_client, get_upcoming_appointments
        booking_tools.py      ← get_services, get_available_times, create_appointment, cancel_appointment
        escalation_tools.py   ← escalate_to_human
        faq_tools.py          ← search_knowledge_base (stub, RAG futuro)
      rag/
        embeddings.py         ← stub para embeddings futuros
        search.py             ← stub para busca vetorial futura
      db.py                   ← connection pool (psycopg2 ThreadedConnectionPool)
      main.py                 ← FastAPI, endpoint POST /run
      Dockerfile
  frontend/            ← React + Vite + TypeScript
  docker/
    docker-compose.yml
```

---

## Arquitetura Geral

```
WhatsApp
    ↓
Baileys (api-node)
    ↓ messageHandler.ts
agentService.ts
    ↓ POST /run
ai-service (FastAPI)
    ↓
context/loader.py   → carrega dados do Supabase
memory/redis        → carrega histórico da conversa
    ↓
router.py           → classifica intenção → retorna JSON com agente + contexto
    ↓
especialista        → executa com tools
    ↓
tools               → acessam Supabase via connection pool
    ↓
reply               → salvo no Redis → enviado via Baileys
```

---

## Banco de Dados

**Conexão:** Supabase PostgreSQL via connection pooler (porta 6543, usuário `postgres.[project-ref]`).
Não usar conexão direta (porta 5432) — o host retorna apenas IPv6, incompatível com Docker bridge.

**Separação multi-tenant:** todas as tabelas têm `company_id` (INT, FK para `saas_companies`).

### Tabelas Core (genéricas)

| Tabela | Descrição |
|---|---|
| `saas_companies` | Tenant principal. 1 empresa = 1 petshop |
| `saas_users` | Usuários do painel (donos, staff) |
| `clients` | Clientes do petshop (identificados pelo telefone) |
| `whatsapp_sessions` | Sessão Baileys por company (unique `company_id`) |
| `agent_conversations` | Conversas do agente por cliente |
| `agent_messages` | Mensagens individuais (role: user/assistant) |

### Tabelas do Nicho Petshop (prefixo `petshop_`)

| Tabela | Descrição |
|---|---|
| `saas_petshops` | Perfil do petshop (1:1 com company) |
| `petshop_services` | Catálogo de serviços. Suporte a `price_by_size` (JSONB) e `duration_multiplier_large` |
| `petshop_pets` | Pets dos clientes. Campos: `name`, `species`, `breed`, `size` (small/medium/large), `weight_kg`, `gender` |
| `petshop_schedules` | Slots de horário por dia da semana com `capacity` |
| `petshop_appointments` | Agendamentos. Status: pending/confirmed/in_progress/completed/cancelled/no_show |

### Campos importantes

**`petshop_services`:**
- `price` → preço fixo (usado se `price_by_size` for null)
- `price_by_size` → JSONB `{"small": x, "medium": y, "large": z}` (preço varia por porte)
- `duration_multiplier_large` → ex: 2.0 = porte grande ocupa o dobro do slot

**`petshop_pets`:**
- `size` → `small | medium | large` (obrigatório para cadastro)

**`saas_petshops`:**
- `business_hours` → JSONB `{"seg": "08:00-18:00", "sab": "09:00-14:00"}`
- `default_capacity_per_hour` → INT, capacidade padrão dos slots
- `custom_capacity_hours` → JSONB, exceções por dia+hora
- `assistant_name` → nome do agente exibido ao cliente

**`clients`:**
- `ai_paused` → BOOLEAN. Se true, o agente não responde (cliente em atendimento humano)
- `ai_paused_at`, `ai_pause_reason` → registro do escalonamento

---

## Prisma Schema

Localização: `backend/api-node/prisma/schema.prisma`

Models principais:
- `SaasCompany`, `SaasUser`, `SaasPetshop`
- `Client` → `@@unique([companyId, phone])`
- `WhatsappSession` → `@unique` em `companyId`
- `AgentConversation`, `AgentMessage`
- `PetshopService`, `PetshopPet`, `PetshopSchedule`, `PetshopAppointment`

binaryTargets: `["native", "debian-openssl-3.0.x"]` (obrigatório para node:20-slim)

---

## ai-service — Fluxo Detalhado

### POST /run

Recebe: `{ company_id, client_phone, message }`

1. `load_context()` → busca company + petshop + serviços + cliente + pets do banco
2. `get_history()` → últimas 20 mensagens do Redis (TTL 24h, chave: `chat:{company_id}:{phone}`)
3. `save_message()` → salva mensagem do usuário no Redis
4. `run_router()` → classifica + executa especialista
5. `save_message()` → salva resposta no Redis
6. Retorna `{ reply, agent_used }`

### Router

O router recebe o histórico formatado e a mensagem atual e retorna um JSON:

```json
{
  "agent": "booking_agent",
  "stage": "SCHEDULING",
  "active_pet": "Rex",
  "service": "Banho",
  "date_mentioned": "quinta",
  "awaiting_confirmation": false
}
```

Estágios possíveis: `WELCOME | PET_REGISTRATION | SERVICE_SELECTION | SCHEDULING | AWAITING_CONFIRMATION | COMPLETED`

Fallback: se o JSON vier inválido ou com agente desconhecido, usa `faq_agent`.

### Especialistas e suas Tools

| Agente | Tools disponíveis |
|---|---|
| onboarding_agent | `get_client_pets`, `create_pet` |
| booking_agent | `get_services`, `get_available_times`, `create_appointment`, `cancel_appointment`, `get_client_pets`, `get_upcoming_appointments` |
| sales_agent | `get_services` |
| faq_agent | `search_knowledge_base` |
| escalation_agent | `escalate_to_human` |

### Filosofia dos Prompts

**Python injeta estado real → LLM decide como falar.**

Nenhum prompt gera mensagens fixas. O Python calcula o estado da conversa (quantos pets, qual porte, se há serviço definido, etc.) e injeta isso no prompt. O LLM usa esses fatos para responder naturalmente.

Exemplos de injeção:
- 0 pets → "O cliente não tem pets cadastrados."
- 1 pet → "O cliente tem 1 pet: Rex (cachorro, golden retriever, porte grande)."
- 2+ pets → "O cliente tem 3 pets: Rex, Luna, Pipoca. Antes de agendar, pergunte para qual deles é o serviço."
- Pet ativo com porte → preço correto calculado pelo Python e injetado no prompt

### Garantias implementadas nas Tools

**`create_pet`:** bloqueia cadastro se faltar qualquer um dos 4 campos obrigatórios (nome, espécie, raça, porte). Normaliza espécie e porte. Verifica duplicata antes de inserir.

**`create_appointment`:** exige `confirmed=True`. Sem esse parâmetro a tool recusa criar, independente do prompt. Verifica disponibilidade de vaga no momento da criação.

**`get_available_times`:** retorna `available_times`, `closed_days`, `full_days`. Só retorna horários com 2h+ de antecedência. Bloqueia datas além de 60 dias.

**`escalate_to_human`:** seta `ai_paused=TRUE` no cliente no banco. O messageHandler do api-node deve checar esse campo antes de chamar o ai-service.

---

## Conexão com Banco (ai-service)

`db.py` usa `psycopg2.pool.ThreadedConnectionPool` (min=1, max=10).
Todos os arquivos que precisam de banco usam o context manager `with get_connection() as conn:` que faz commit automático em caso de sucesso e rollback em caso de erro.

---

## Memória (Redis)

Chave: `chat:{company_id}:{client_phone}`
TTL: 24 horas (renovado a cada mensagem)
Limite: últimas 20 mensagens no contexto do agente
Formato: lista de `{"role": "user"|"assistant", "content": "..."}`

`clear_history()` disponível para limpar conversa após conclusão ou timeout.

---

## WhatsApp (api-node)

Biblioteca: Baileys
Sessões armazenadas em: `./sessions/{company_id}/`
Persistidas via volume Docker: `baileys_sessions`

`baileysService.ts`:
- `startBaileysSession(companyIdStr, onQR?)` → conecta, gera QR, reconecta automaticamente
- `sendTextMessage(companyIdStr, jid, text)` → envia mensagem
- `disconnectSession(companyIdStr)` → logout + limpeza
- `restoreActiveSessions()` → chamado no startup, restaura sessões com status `connected`

`messageHandler.ts`:
- Extrai telefone do JID
- Busca ou cria cliente
- Busca ou cria conversa
- Salva mensagem do usuário
- Checa `ai_paused` antes de chamar o agente
- Chama `agentService.ts` → recebe reply → envia via Baileys

---

## Docker

Containers: `petshop-backend`, `petshop-ai-service`, `petshop-frontend`, `petshop-redis`
Rede: `petshop-network` (bridge)
DNS no ai-service: `8.8.8.8 / 8.8.4.4` (necessário para resolver Supabase)

Volumes montados no ai-service: `../backend/ai-service:/app` (hot reload com `--reload`)

---

## Variáveis de Ambiente

### api-node/.env
```
DATABASE_URL=postgresql://postgres.[ref]:[senha]@aws-0-us-west-2.pooler.supabase.com:6543/postgres
REDIS_HOST=redis
REDIS_PORT=6379
JWT_SECRET=...
FRONTEND_URL=http://localhost:5173
AI_SERVICE_URL=http://ai-service:8000
```

### ai-service/.env
```
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-4o-mini
DATABASE_URL=postgresql://postgres.[ref]:[senha]@aws-0-us-west-2.pooler.supabase.com:6543/postgres
REDIS_HOST=redis
REDIS_PORT=6379
PORT=8000
```

---

## Endpoints

| Serviço | Endpoint | Descrição |
|---|---|---|
| ai-service | GET /health | Health check |
| ai-service | POST /run | Executa agente |
| ai-service | GET /docs | Swagger UI para testes |
| api-node | GET /health | Health check |
| api-node | GET /whatsapp/status/:companyId | Status da sessão |
| api-node | POST /whatsapp/connect/:companyId | Inicia conexão + QR |
| api-node | POST /whatsapp/disconnect/:companyId | Desconecta sessão |

---

## Pendências / Próximos Passos

- [ ] Integrar `messageHandler.ts` com `agentService.ts` (checar `ai_paused` antes)
- [ ] Auth routes no api-node (`/auth/login`, `/auth/me`)
- [ ] Frontend: página de login, QR code, clientes, conversas
- [ ] RAG: implementar `embeddings.py` + `search.py` + tabela `knowledge_base` com pgvector
- [ ] Notificação ao responsável quando `escalate_to_human` for chamado
- [ ] Sincronizador de `business_hours` → `petshop_schedules` (quando dono editar horários no painel)
- [ ] Testes dos agentes end-to-end

---

## Decisões de Arquitetura Registradas

**Por que monorepo?** MVP com time pequeno. Fácil de separar depois movendo `ai-service/` para repo próprio quando precisar escalar independentemente.

**Por que ai-service separado do api-node?** Python tem ecossistema de IA muito superior (Agno, psycopg2, asyncio). Node cuida do WhatsApp e da API REST. Comunicação via HTTP interno.

**Por que pooler do Supabase (porta 6543)?** O host direto do Supabase resolve apenas IPv6, incompatível com Docker bridge network. O pooler resolve IPv4.

**Por que Redis para memória?** TTL automático, estrutura de lista nativa, performance para leitura/escrita frequente. Sem Redis o agente seria stateless entre mensagens.

**Por que `petshop_schedules` como tabela e não só JSONB?** Queries SQL diretas de disponibilidade ("quantas vagas restam às 10h de terça?"). O JSONB `business_hours` serve para configuração visual no painel; a tabela serve para lógica de agendamento.

**Por que `confirmed=True` obrigatório em `create_appointment`?** Garantia em nível de tool — mesmo que o prompt falhe em seguir o fluxo de confirmação, a tool bloqueia o agendamento sem confirmação explícita do cliente.
