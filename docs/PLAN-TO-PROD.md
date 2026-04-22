# PLAN-TO-PROD — Maria v2 go-live hardening

> Sequência executável única pra sair de "LIVE aguardando QR" → "produção estável com 1-3 clientes internos" → "tráfego real".
> Dependências entre fases são estritas. Ordem = ordem de execução.

---

## ⚠️ Revisão 2026-04-22 — Red team feedback aplicado

**Mudança de direção:** migrar de Baileys próprio → Evolution API **shared** (`evolution.pangeia.cloud`, instância `SuperBemBarato`) reutilizando infra existente. Red team apontou 7 pontos que reordenam o plano:

### Princípios (inegociáveis pré-cutover)

1. **Cloudflare Access obrigatório ANTES de canal novo** — `VITE_INTERNAL_API_KEY` no bundle continua o bloqueador #3 do auditor 21/04. Abrir canal Evolution sem auth real = ban de chip + spam atribuível ao backend.
2. **Evolution-Baileys ≠ imunidade a ban** — ganho real é estabilidade de conexão (heartbeat, state em Postgres, reconnect). Ban risk persiste. Registro de risco explícito.
3. **WABA Cloud API é a saída real** — abrir processo Meta Business **em paralelo** à migração Evolution. Não bloqueia cutover de hoje; 2-3 semanas pra estar pronto.
4. **Instância dedicada ≤30 dias** — Evolution shared com Leuzzi/Operate/Oxy = noisy neighbor + LGPD frágil (PII de SBB mistura com outros projetos). Aceitar pro MVP, migrar antes do 2º cliente.
5. **Separar frentes A e B** — Evolution primeiro, estabilizar 24h, depois Dock global. Rollback de canal com 2 commits no ar = cascata de incidentes.

### Fase 0.5 (NOVA) — Pré-Evolution checks (30min, hoje)

Antes de escrever qualquer linha do provider Evolution:

#### 0.5.1 — Inspecionar instância `SuperBemBarato` (residuais da equipe SBB antiga)
```bash
EVO_URL="https://evolution.pangeia.cloud"
EVO_KEY="QSLLMr6irOKF45qtyE3rcmWycZXYeNfI07Hofc00"

# Webhook residual (provável apontando pra Chatwoot legacy)
curl -s -H "apikey: $EVO_KEY" "$EVO_URL/webhook/find/SuperBemBarato" | jq

# Chatwoot binding
curl -s -H "apikey: $EVO_KEY" "$EVO_URL/chatwoot/find/SuperBemBarato" | jq

# Estado completo
curl -s -H "apikey: $EVO_KEY" "$EVO_URL/instance/fetchInstances?instanceName=SuperBemBarato" | jq
```
**Decisão:** se webhook existe apontando pra algo ativo → `DELETE /webhook/SuperBemBarato` antes de setar o novo. Se Chatwoot binding existe → `POST /chatwoot/set` com `enabled=false` primeiro.

#### 0.5.2 — Chip: uso humano ou novo?
Red team: chip novo tem heurística anti-fraude agressiva. Prática: warm-up 7-14 dias (conversas humanas, grupos, recebimentos) **antes** de plugar em bot.

**Pergunta ao user:** chip tem histórico? Se não, duas opções:
- (a) Usar chip pessoal temporariamente pra testes internos + adquirir chip novo pra prod com warm-up
- (b) Assumir risco documentado de ban nas primeiras 2 semanas

#### 0.5.3 — Idempotência em `crm.mensagens`
```sql
-- Migration: crm.mensagens UNIQUE em message_id_waba pra dedup Evolution retries
ALTER TABLE crm.mensagens
  ADD CONSTRAINT uq_mensagens_wa_message_id UNIQUE (message_id_waba)
  WHERE message_id_waba IS NOT NULL;
```
Sem isso, retry do webhook Evolution (3× default) vira 3 turns Maria + 3× custo OpenAI.

#### 0.5.4 — Test bug Evolution 2.3.7 #2390 (buttons/lists)
```bash
# Depois de conectar QR, testar sendList (Maria hoje só manda texto, mas vale validar pra roadmap de catálogo visual)
curl -sX POST -H "apikey: $EVO_KEY" -H "Content-Type: application/json" \
  "$EVO_URL/message/sendList/SuperBemBarato" \
  -d '{"number":"<SEU_TEL>","title":"t","description":"t","buttonText":"ver","sections":[{"title":"s","rows":[{"title":"a"}]}]}'
# Se 500 "isZero": bug confirmado → downgrade pra 2.3.6 via Coolify env
# Se 200/OK: seguir com 2.3.7
```

#### 0.5.5 — Validar `data.key.fromMe` no payload
Evolution emite `SEND_MESSAGE` como `event: "messages.upsert"` (lowercase com dot), IGUAL ao inbound. Sem filter `fromMe=true`, provider processa ecos da própria Maria como mensagens novas = loop de resposta = ban imediato.

**Obrigatório no `providers/evolution.ts`:**
```ts
if (event === 'messages.upsert' && data?.key?.fromMe === true) return  // ignora ecos
if (data?.instance !== 'SuperBemBarato') return                        // valida target
```

---

### Fase 0.7 (NOVA) — Cloudflare Access (2h, bloqueador anterior à Evolution)

Não é mais Fase 1.1 — sobe pra pré-canal. Motivo: abrir novo provider com dashboard ainda público e key no bundle = alguém pode disparar `/internal/debug/simulate-message` e queimar custo OpenAI ou trigger de spam atribuível à Maria.

Roteiro:
1. Cloudflare Zero Trust → Access → Applications → Add Self-hosted
2. Domains: `auzap-api.pangeia.cloud` + `superbembarato.pangeia.cloud`
3. Policy: email `@superbembarato.com.br` OR `estevao.antunes.rocha@gmail.com` (OTP via email)
4. **Bypass apenas em `/whatsapp/webhook/evolution`** com policy "Bypass" + IP allowlist do container Evolution (rede coolify interna)
5. Teste em browser privado → deve exigir OTP antes de carregar dashboard

**Alternativa ao bypass por URL** (red team sugere mais seguro): IP allowlist no middleware Express antes do webhook:
```ts
const EVOLUTION_IPS = (process.env.EVOLUTION_ALLOWED_IPS || '').split(',')
router.use('/whatsapp/webhook/evolution', (req, res, next) => {
  if (!EVOLUTION_IPS.includes(req.ip)) return res.status(403).send('ip not allowed')
  next()
})
```

---

### Fase 2 REVISADA — Migração Evolution (5-6h, depois de 0.5 + 0.7)

Adições ao plano Frente A original:

#### A0 — Baseline Maria-N8N (30min)
Antes de migrar: rodar `psql -f ~/superbem/scripts/baseline-maria.sql` pra capturar latência/erro/custo atuais. Sem baseline, não temos como declarar sucesso.

#### A3.5 — SHADOW_MODE=true por 30min pós-cutover
```ts
// providers/evolution.ts
async sendMessage(to, body) {
  if (process.env.SHADOW_MODE === 'true') {
    logger.info('[SHADOW] would send', { to, body: body.slice(0, 80) })
    return `shadow:${Date.now()}`
  }
  // ... envio real
}
```
Deploy Evolution com `SHADOW_MODE=true` primeiro. Receber 30min de webhooks reais, processar com ai-service, gravar tudo em `agent.runs` — mas **não enviar nada**. Validar qualidade antes de ligar envio real.

#### A3.6 — Alerta Telegram em CONNECTION_UPDATE=close
```ts
if (event === 'connection.update' && data?.state === 'close') {
  await sendAlert(`⚠️ Baileys (Evolution/SuperBemBarato) desconectado — state=close`, 'error')
}
```
Sem isso, desconexão silenciosa = cliente descobre antes da gente.

#### A8 REVISADO — Scan QR via Evolution Manager (não api-node)
```
https://evolution.pangeia.cloud/manager
→ login com EVO_KEY (apikey)
→ instância SuperBemBarato → Connect → QR visible
→ scanear com chip
```
Depois, `/whatsapp/qr` do nosso api-node vira redirect/proxy pro Evolution Manager OU renderiza QR inline via `GET /instance/connect/SuperBemBarato`.

#### A9 REVISADO — Rollback plan explícito
Se cutover quebra:
```bash
# 1. Desativar webhook Evolution → api-node (volta pro Chatwoot legacy se existir)
curl -X DELETE -H "apikey: $EVO_KEY" $EVO_URL/webhook/SuperBemBarato

# 2. Coolify env WHATSAPP_PROVIDER=baileys (session Baileys ainda existe no volume?)
curl -X PATCH "https://coolify.pangeia.cloud/api/v1/applications/f88swo04ogw0wo8w00okcw8c/envs" \
  -H "Authorization: Bearer $COOLIFY_API_KEY" -d '{"key":"WHATSAPP_PROVIDER","value":"baileys"}'

# 3. Se session Baileys foi apagada: reativar workflow N8N 01.Secretaria
curl -X PATCH "https://n8nsuperbembarato.pangeia.cloud/api/v1/workflows/g0ESSfSDxkFqkuxl" \
  -H "X-N8N-API-KEY: $N8N_API_KEY" -d '{"active":true}'
```

---

### Fase 2.5 (NOVA) — Rate limit por waId (obrigatório antes de primeiro cliente real)

Movido pra antes do Dock. Sem rate limit, cliente louco mandando 200 msgs/min = custo OpenAI + trigger ban. Código em `PLAN-TO-PROD.md` Fase 1.2 original permanece válido.

**Burst test antes de considerar seguro:**
```bash
# Disparar 5 webhooks em 3s com waIds diferentes
for i in 1 2 3 4 5; do
  curl -X POST https://auzap-api.pangeia.cloud/whatsapp/webhook/evolution \
    -H "apikey: $EVO_KEY" \
    -d "{\"event\":\"messages.upsert\",\"instance\":\"SuperBemBarato\",\"data\":{\"key\":{\"id\":\"wamid.test$i\",\"remoteJid\":\"556399999999$i@s.whatsapp.net\",\"fromMe\":false},\"message\":{\"conversation\":\"teste $i\"}}}" &
done
wait
# Conferir que todas 5 viraram turns
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM crm.mensagens WHERE created_at > NOW() - INTERVAL '30 seconds'"
```

**Burst mesmo waId (coalescing singletonKey):**
```bash
# 5 msgs do MESMO telefone em 3s
for i in 1 2 3 4 5; do
  curl -X POST ... -d "{\"event\":\"messages.upsert\",\"data\":{\"key\":{\"id\":\"wamid.burst$i\",\"remoteJid\":\"5563912345678@s.whatsapp.net\",\"fromMe\":false},\"message\":{\"conversation\":\"msg $i\"}}}" &
done
wait
# Pode virar 1 turn coalescido (correto) OU 5 turns sequenciais — validar comportamento real
```

---

### Fase 3 (Dock global) — Adiado para +48h pós-Evolution estável

Não executar junto com Evolution. Motivo: rollback de canal com Dock no ar = 2 commits pra bisect. Fazer depois com sistema estável.

Implementação com feature flag: mergeia `AppLayout` com `DOCK_EVERYWHERE=false` default. Vira true após inspeção visual em staging.

---

### Fase 4 ADICIONAL — WABA Cloud API paralelo (processo começa hoje)

Em paralelo a tudo (não bloqueia nada):
1. User abre `business.facebook.com` → WhatsApp Accounts → Create
2. Business verification SBB (CNPJ + docs) — 1-3 dias Meta review
3. Número novo dedicado (pode ser mesmo chip do Evolution ou outro)
4. System User permanent token
5. Template de saudação aprovado
6. Quando pronto: envs `WABA_*` já existem no Coolify (seto via API). Switch `WHATSAPP_PROVIDER=cloud_api` = saída definitiva do Baileys.

---

### Risk register atualizado (honesto)

| Risco | Status | Mitigação atual | Escape permanente |
|---|---|---|---|
| Ban Baileys (dentro da Evolution) | ATIVO — aceito | warm-up chip, rate limit, shadow mode, alerta CONNECTION_UPDATE | WABA Cloud API em 2-3 semanas |
| VITE_INTERNAL_API_KEY bundle | RESOLVIDO em Fase 0.7 (Cloudflare Access) | — | — |
| SPOF host Coolify único | ATIVO | backup diário + monitoring | Managed Postgres (Neon) + Cloudflare Tunnel em ≤60d |
| Evolution shared LGPD | ATIVO | documentar RIPD | Evolution dedicada em ≤30d |
| Bug Evolution 2.3.7 #2390 | PENDENTE teste A0 | downgrade 2.3.6 se confirmado | — |
| Chip novo banável rápido | PENDENTE decisão user (0.5.2) | warm-up 7-14d OU aceitar | — |

---

### Ordem final de execução (hoje + próximas 72h)

**Dia 0 (hoje, 4-5h):**
1. 0.5 Pré-Evolution checks (30min)
2. 0.7 Cloudflare Access (2h)
3. A0 Baseline Maria-N8N (30min, pode paralelizar com 0.7)
4. 2.5 Rate limit middleware + burst tests em staging (1h)
5. 2 Provider Evolution com filter fromMe + instance check + CONNECTION_UPDATE alert (2h)
6. Deploy com SHADOW_MODE=true → scan QR → 30min observação
7. Se shadow OK: `SHADOW_MODE=false` → primeiras mensagens reais em círculo interno

**Dia +1 (24h observação Evolution):**
- Monitorar agent.runs, custo OpenAI, reconexões
- Se estável: começar Fase 3 (Dock global)

**Dia +3 (72h+):**
- Revisar métricas vs baseline Maria-N8N
- Decidir se libera pra clientes reais

**Semana +1-2:**
- Abrir processo WABA Cloud API (Fase 4)
- Iniciar Evolution dedicada planning (Fase 3.1 revisada)

---



## Resumo (16 itens)

| # | Fase | Item | Automação | Tempo |
|---|---|---|---|---|
| 0.1 | BLOQ pré-QR | Baileys persistent storage Coolify | manual UI | 15m |
| 0.2 | BLOQ pré-QR | sbb-postgres healthcheck audit | script | 15m |
| 0.3 | BLOQ pré-QR | Restore drill (pg_restore em test DB) | script | 30m |
| 0.4 | BLOQ pré-QR | Pin versions (Agno, Baileys, pg-boss) | script | 15m |
| 1.1 | Seg | Cloudflare Access em *.pangeia.cloud | manual + API | 2h |
| 1.2 | Seg | Rate limit por waId em worker | código + deploy | 2h |
| 1.3 | Seg | Audit RLS PostgREST schemas public+crm | psql read-only | 30m |
| 2.1 | Robustez | Auditar 13 workflows N8N nominais | N8N API | 1h |
| 2.2 | Robustez | Desativar N8N workflows duplicados | PATCH N8N | 30m |
| 2.3 | Robustez | Staging app sbb-auzap-{api,ai}-staging | Coolify API | 1h |
| 2.4 | Robustez | Golden dataset 30 conversas + CI | código | 4h |
| 3.1 | Operação | WABA Cloud paralelo (número reserva) | user + Meta | 1-3d |
| 3.2 | Operação | Observabilidade Grafana/Metabase | Docker compose | 4h |
| 3.3 | Operação | pg_cron pra DDL jobs | SQL + scheduler | 1h |
| 4.1 | Otimização | Benchmark gpt-5 vs gpt-5.4-mini | golden dataset | 1d |
| 4.2 | Otimização | Managed Postgres (Neon/Supabase) | migração | 2d |

---

## Fase 0 — BLOQUEADORES PRÉ-QR (30min total, ANTES de scanear QR)

**Motivo:** scan QR agora sem persistence = QR perdido no próximo redeploy = reconexão = trigger de ban Baileys.

### 0.1 — Baileys persistent storage no Coolify

**Via UI Coolify** (API não expõe persistent storage):
1. `https://coolify.pangeia.cloud` → Projects → sbb-auzap → sbb-auzap-api
2. Persistent Storage → Add
3. Nome: `baileys_sessions`
4. Mount Path: `/app/sessions`
5. Save → Redeploy

**Verificação:**
```bash
curl -s "https://coolify.pangeia.cloud/api/v1/applications/f88swo04ogw0wo8w00okcw8c" \
  -H "Authorization: Bearer $COOLIFY_API_KEY" | jq '.persistent_storages // .storages // .volumes'
# Deve listar baileys_sessions → /app/sessions
```

### 0.2 — Sbb-postgres healthcheck audit

```bash
COOLIFY_API_KEY=$(grep -E "^COOLIFY_API_KEY=" ~/superbem/.env | cut -d= -f2-)
# Get sub-services status
curl -s "https://coolify.pangeia.cloud/api/v1/applications/rk4o8gc08k88ogo8kcg40sow/logs?lines=200" \
  -H "Authorization: Bearer $COOLIFY_API_KEY" | jq -r '.logs' | grep -iE "healthcheck|unhealthy|pg_isready|backup" | tail -30

# Test backup container alive
curl -s "https://coolify.pangeia.cloud/api/v1/applications/rk4o8gc08k88ogo8kcg40sow" \
  -H "Authorization: Bearer $COOLIFY_API_KEY" | jq '.docker_compose_raw' | grep -A2 "postgres-backup"
```

**Decisão:** se backup sub-service está `unhealthy`, parar tudo e investigar; se é PostgREST ou pgAdmin, não bloqueia.

### 0.3 — Restore drill do backup mais recente

Via Coolify UI terminal no container sbb-postgres:
```bash
# Lista backups disponíveis
docker exec sbb-postgres-backup ls -lh /backups | tail -5

# Copia backup recente, cria DB de teste, restaura
LATEST=$(docker exec sbb-postgres-backup ls -t /backups | head -1)
docker exec sbb-postgres psql -U postgres -c "CREATE DATABASE restore_test"
docker exec sbb-postgres-backup sh -c "gunzip -c /backups/$LATEST | docker exec -i sbb-postgres psql -U postgres -d restore_test"
docker exec sbb-postgres psql -U postgres -d restore_test -c "SELECT COUNT(*) FROM crm.mensagens"
docker exec sbb-postgres psql -U postgres -c "DROP DATABASE restore_test"
```

**Acceptance:** SELECT retorna count > 0 (backup tem dados reais). Se <100 rows, backup pode estar vazio.

### 0.4 — Pin versions (evita breaking silencioso)

```bash
cd /Users/estevaoantunes/sbb-auzap/backend/ai-service
# Pin Agno, OpenAI SDK
sed -i.bak 's/^agno$/agno==2.5.17/' requirements.txt
sed -i.bak 's/^openai$/openai==2.32.0/' requirements.txt
sed -i.bak 's/^fastapi$/fastapi==0.136.0/' requirements.txt

cd /Users/estevaoantunes/sbb-auzap
git add -A && git commit -m "chore: pin Agno/OpenAI/FastAPI versions pra evitar breaking upstream"
git push origin main
```

---

## Fase 1 — Segurança (2-3h, antes de qualquer cliente real)

### 1.1 — Cloudflare Access em *.pangeia.cloud

**Setup manual no Cloudflare Zero Trust:**

1. Dashboard Cloudflare → Zero Trust → Access → Applications → Add
2. Self-hosted application
3. Application domain: `auzap-api.pangeia.cloud` + `superbembarato.pangeia.cloud`
4. Session duration: 24h
5. Policies:
   - Allow: Email ending in `@superbembarato.com.br` OU email igual a `estevao.antunes.rocha@gmail.com`
   - OTP (magic link) via email
6. Save
7. Teste: abrir URL em browser privado → redireciona pra login CF

**Bypass pro webhook Meta** (se migrar Cloud API): criar segunda application `auzap-api.pangeia.cloud/whatsapp/webhook` com policy "Bypass" → permite POST público com HMAC guard.

### 1.2 — Rate limit por waId

Escrevo middleware em `backend/api-node/src/middleware/rateLimit.ts`:

```ts
import type { Request, Response, NextFunction } from 'express'
import { getBoss } from '../lib/queue'

const WINDOW_MS = 60_000  // 1 min
const MAX_PER_WINDOW = 20 // 20 msgs/min por waId

const buckets = new Map<string, { count: number; resetAt: number }>()

export function rateLimitByWaId(waId: string): { allowed: boolean; resetIn: number } {
  const now = Date.now()
  const bucket = buckets.get(waId)
  if (!bucket || bucket.resetAt < now) {
    buckets.set(waId, { count: 1, resetAt: now + WINDOW_MS })
    return { allowed: true, resetIn: WINDOW_MS }
  }
  if (bucket.count >= MAX_PER_WINDOW) {
    return { allowed: false, resetIn: bucket.resetAt - now }
  }
  bucket.count++
  return { allowed: true, resetIn: bucket.resetAt - now }
}

// Cleanup periódico
setInterval(() => {
  const now = Date.now()
  for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k)
}, 60_000)
```

Wire no worker `worker.ts`:
```ts
import { rateLimitByWaId } from '../../middleware/rateLimit'

// dentro do handler:
const { allowed, resetIn } = rateLimitByWaId(job.waId)
if (!allowed) {
  console.warn('[worker] rate limited', { waId: job.waId, resetIn })
  await provider.sendMessage(job.waId, 'Muitas mensagens em pouco tempo. Aguarde um momento.')
  return
}
```

### 1.3 — Audit RLS PostgREST

```bash
# Via psql dentro do container sbb-postgres
docker exec sbb-postgres psql -U postgres -d postgres <<'SQL'
-- Lista policies em crm + public
SELECT schemaname, tablename, policyname, roles, cmd
FROM pg_policies WHERE schemaname IN ('crm','public')
ORDER BY schemaname, tablename, policyname;

-- Tabelas com RLS HABILITADA mas SEM policy pra anon = efetivamente bloqueadas
SELECT schemaname, tablename, rowsecurity,
  EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname=c.schemaname AND p.tablename=c.tablename AND 'anon' = ANY(p.roles)) AS has_anon_policy
FROM pg_tables c
WHERE schemaname IN ('crm','public') AND rowsecurity=true
ORDER BY 1,2;

-- Tabelas expostas via PostgREST (schemas public,crm) SEM RLS = leak
SELECT schemaname, tablename
FROM pg_tables
WHERE schemaname IN ('public','crm') AND rowsecurity=false;
SQL
```

**Decisão:** qualquer tabela `rowsecurity=false` em schemas expostos = gap. Habilitar RLS + policy anon read-only OU remover schema do PGRST_DB_SCHEMAS.

---

## Fase 2 — Robustez (4-6h)

### 2.1 — Auditar 13 workflows N8N ativos

```bash
N8N_API_KEY=$(grep -E "^N8N_API_KEY=" ~/superbem/.env | cut -d= -f2-)
curl -s "https://n8nsuperbembarato.pangeia.cloud/api/v1/workflows?active=true" \
  -H "X-N8N-API-KEY: $N8N_API_KEY" | jq -r '.data[] | "\(.id) | \(.name) | nodes=\(.nodes | length)"' \
  > /tmp/n8n-active-workflows.txt

# Pra cada workflow, extrair nodes que escrevem em crm.* (postgres nodes com INSERT/UPDATE em crm)
for id in $(jq -r '.data[].id' /tmp/n8n-active-workflows.txt); do
  curl -s "https://n8nsuperbembarato.pangeia.cloud/api/v1/workflows/$id" \
    -H "X-N8N-API-KEY: $N8N_API_KEY" \
    | jq -r --arg id "$id" '.nodes[] | select(.type | test("postgres|supabase")) | select((.parameters.query // .parameters.operation) | tostring | test("crm\\.|INSERT|UPDATE"; "i")) | "\($id) | \(.name) | query=\(.parameters.query // .parameters.operation | .[0:60])"'
done | tee /tmp/n8n-crm-writers.txt
```

**Classificação por workflow:**
- `01.Secretaria v3` (`g0ESSfSDxkFqkuxl`) — **APOSENTAR** (Maria v1 LLM; AuZap substitui)
- `sbb-buscar-produto` (`VjKyByI4UHi0bleY`) — **APOSENTAR** (AuZap tem product_tools)
- `07. Quebrar e enviar msg` — **APOSENTAR**
- `SBB Sender` — **APOSENTAR**
- `05. Escalar Humano` — **MANTER** (recebe evento escalation do AuZap; notifica operador)
- `sbb-receiver` — **APOSENTAR ou reusar** (depende se AuZap recebe webhook Chatwoot OU direto Baileys)
- `sbb-crm-pool` (RFM diário) — **MANTER**
- `sbb-crm-sync-rfm` — **MANTER**
- `sbb-crm-encerrar-conversa` — **APOSENTAR** (substituído por `crm.encerrar_conversas_inativas` job pg-boss)
- `sbb-monitor-sync` — **MANTER**
- `sbb-sync-error-handler` — **MANTER**
- `sbb-dashboard-ai-chat` — **APOSENTAR** (substituído por `/brain/chat` endpoint api-node)

### 2.2 — Desativar workflows duplicados

```bash
DISABLE_IDS=(
  "g0ESSfSDxkFqkuxl"  # 01.Secretaria v3
  "VjKyByI4UHi0bleY"  # sbb-buscar-produto (legacy)
  # adicionar IDs reais da auditoria 2.1
)
for id in "${DISABLE_IDS[@]}"; do
  curl -s -X PATCH "https://n8nsuperbembarato.pangeia.cloud/api/v1/workflows/$id" \
    -H "X-N8N-API-KEY: $N8N_API_KEY" -H "Content-Type: application/json" \
    -d '{"active":false}' | jq -r '.name + " → " + (.active | tostring)'
done

# Export backup antes de deletar
for id in "${DISABLE_IDS[@]}"; do
  curl -s "https://n8nsuperbembarato.pangeia.cloud/api/v1/workflows/$id" \
    -H "X-N8N-API-KEY: $N8N_API_KEY" > ~/superbem/workflows/archived/$id.json
done
```

### 2.3 — Staging app no Coolify

```bash
# Branch staging no repo
cd /Users/estevaoantunes/sbb-auzap
git checkout -b staging && git push origin staging

# Cria apps staging via API
for pair in "sbb-auzap-api-staging:/backend/api-node:3000" "sbb-auzap-ai-staging:/backend/ai-service:8000"; do
  name=$(echo $pair | cut -d: -f1)
  dir=$(echo $pair | cut -d: -f2)
  port=$(echo $pair | cut -d: -f3)
  curl -s -X POST "https://coolify.pangeia.cloud/api/v1/applications/public" \
    -H "Authorization: Bearer $COOLIFY_API_KEY" -H "Content-Type: application/json" \
    -d "{\"project_uuid\":\"qwkw04k4ocgwwk4s4k8w0ogg\",\"environment_name\":\"production\",\"server_uuid\":\"voo8kswgwkkokggwogoko4os\",\"git_repository\":\"https://github.com/estevaoantuness/sbb-auzap\",\"git_branch\":\"staging\",\"build_pack\":\"dockerfile\",\"dockerfile_location\":\"/Dockerfile.prod\",\"base_directory\":\"$dir\",\"ports_exposes\":\"$port\",\"name\":\"$name\"}" \
    | jq -r '.uuid + " " + .domains'
done

# Clona envs prod → staging (mesmo DATABASE mas DB separado: "sbb_staging")
# Criar sbb_staging DB via psql + aplicar migrations via deploy
```

### 2.4 — Golden dataset + CI

`backend/api-node/test/golden/conversations.json` — 30 conversas reais (anonimizadas) da Maria-N8N.

`backend/api-node/test/e2e.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import fixtures from './golden/conversations.json'

describe('E2E golden dataset', () => {
  for (const conv of fixtures) {
    it(`handles: ${conv.name}`, async () => {
      for (const turn of conv.turns) {
        const res = await fetch(`${STAGING_API}/internal/debug/simulate-message`, {
          method: 'POST',
          headers: { 'x-internal-key': KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone: conv.phone, message: turn.user_msg })
        })
        const data = await res.json()
        expect(data.reply).toBeTruthy()
        if (turn.expected_agent) expect(data.agent_used).toBe(turn.expected_agent)
        if (turn.forbidden_phrases) {
          for (const phrase of turn.forbidden_phrases) {
            expect(data.reply.toLowerCase()).not.toContain(phrase.toLowerCase())
          }
        }
      }
    })
  }
})
```

GitHub Actions `.github/workflows/e2e.yml` executa contra staging em push→main.

---

## Fase 3 — Operação estável (1-2 semanas)

### 3.1 — WABA Cloud API paralelo (reserva anti-ban Baileys)

**User action (Meta Business Manager, 1-3d):**
1. `https://business.facebook.com` → WhatsApp Accounts → Create new
2. Verificar Business (CNPJ + documentos SBB)
3. Adicionar número secundário dedicado (pode ser o mesmo chip comprado, ou outro)
4. Criar System User permanent → Access Token permanente
5. Aprovar template de saudação (ex: "Oi! A Maria da Super Bem Barato está de volta. Como posso ajudar?")

**Setup no Coolify (quando token estiver pronto):**
```bash
COOLIFY_API_KEY=$(grep -E "^COOLIFY_API_KEY=" ~/superbem/.env | cut -d= -f2-)
API_UUID="f88swo04ogw0wo8w00okcw8c"
# Setar WABA envs (sem trocar WHATSAPP_PROVIDER ainda — fica em standby)
for kv in "WABA_PHONE_NUMBER_ID=..." "WABA_BUSINESS_ACCOUNT_ID=..." "WABA_ACCESS_TOKEN=..." "WABA_APP_SECRET=..." "WABA_VERIFY_TOKEN=$(openssl rand -hex 16)"; do
  key=${kv%%=*}; val=${kv#*=}
  curl -s -X POST "https://coolify.pangeia.cloud/api/v1/applications/$API_UUID/envs" \
    -H "Authorization: Bearer $COOLIFY_API_KEY" -H "Content-Type: application/json" \
    -d "$(jq -n --arg k "$key" --arg v "$val" '{key:$k,value:$v}')"
done
```

**Emergency switch Baileys→Cloud API (se banir):**
```bash
# 1 min
curl -s -X PATCH "https://coolify.pangeia.cloud/api/v1/applications/$API_UUID/envs" \
  -H "Authorization: Bearer $COOLIFY_API_KEY" -H "Content-Type: application/json" \
  -d '{"key":"WHATSAPP_PROVIDER","value":"cloud_api"}'
coolify app restart $API_UUID
# Webhook Meta apontando pra /whatsapp/webhook já está configurado em Meta (feito no setup)
```

### 3.2 — Observabilidade `agent.runs` (Grafana)

Subir container Grafana no mesmo Coolify, datasource = sbb-postgres (role `auditor` read-only):

```bash
# Coolify app Grafana
curl -s -X POST "https://coolify.pangeia.cloud/api/v1/applications/dockerimage" \
  -H "Authorization: Bearer $COOLIFY_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "project_uuid":"qwkw04k4ocgwwk4s4k8w0ogg",
    "environment_name":"production",
    "server_uuid":"voo8kswgwkkokggwogoko4os",
    "name":"sbb-grafana",
    "docker_registry_image_name":"grafana/grafana:latest",
    "ports_exposes":"3000",
    "domains":"https://obs.pangeia.cloud"
  }'
```

Dashboards (import JSON):
1. **LLM Cost Tracker** — `SUM(input_tokens + output_tokens) × preço_por_modelo GROUP BY DATE_TRUNC('day', created_at), model`
2. **Agent performance** — `agent_used, AVG(latency_ms), COUNT(*), COUNT(*) FILTER (WHERE guardrails_fired != '{}')`
3. **Reprocess rate** — taxa de runs que acionaram guardrail `verificar_reprocess`
4. **Tool cache hit** — `tool_cache` vs `agent.runs.tool_calls` (indiretamente via timing)

Cloudflare Access protege `obs.pangeia.cloud`.

### 3.3 — pg_cron pra DDL jobs

Se extensão disponível:
```sql
-- psql como postgres superuser
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Migra schedules de pg-boss pra pg_cron (mais robusto pra DDL)
SELECT cron.schedule('rotate_runs', '0 3 * * *', 'SELECT agent.rotate_runs_partitions()');
SELECT cron.schedule('purge_pii', '15 3 * * *', 'SELECT agent.purge_pii_older_than(30)');
SELECT cron.schedule('cleanup_tool_cache', '0 * * * *', 'SELECT agent.cleanup_expired_tool_cache()');
SELECT cron.schedule('close_inactive', '*/15 * * * *', 'SELECT crm.encerrar_conversas_inativas(4)');

-- Verificar
SELECT * FROM cron.job;
```

Depois remover essas schedules do pg-boss `scheduleMaintenanceJobs()` em `queue.ts` (deixar só `auzap:msg_inbound` e `auzap:retry_send`).

---

## Fase 4 — Otimizações (não urgente)

### 4.1 — Benchmark gpt-5 vs gpt-5.4-mini (quando houver amostra)

Script `backend/ai-service/scripts/bench_models.py`:
```python
# Roda 50 turnos do golden dataset contra gpt-5 E gpt-5.4-mini
# Mede: tokens in/out, latency, score juiz LLM (correção/tom/escopo/completude)
# Reporta regressão por agent
```

Decisão: se regressão <5% em correção factual, migrar `faq_agent` e `product_search_agent` pra mini. Manter `order_agent` em gpt-5 full (decisões multi-turno mais complexas).

### 4.2 — Managed Postgres externo

Migrar `crm.*` + `agent.*` pra Neon/Supabase (elimina SPOF host VPS):
```bash
# 1. Criar Neon project
# 2. pg_dump do sbb-postgres, restore no Neon
# 3. Atualizar DATABASE_URL em sbb-auzap-api, sbb-auzap-ai, n8n (postgres credential)
# 4. Manter public.vitrine local OR migrar também (depende se sync CISS consegue alcançar Neon)
# 5. Parar sbb-postgres local (manter volume 30d pra rollback)
```

Custo: ~$20-40/mês. Benefício: HA managed + backups automáticos + disponibilidade sem depender do VPS.

### 4.3 — Consolidar asyncpg (drop psycopg2)

`tool_result_cache.py` hoje usa psycopg2 sync (pq tools Agno rodam em thread). Migrar pra asyncpg com `run_in_executor`:
```python
from asyncio import get_event_loop
from functools import partial

def cache_get_product_result(query: str) -> dict | None:
    loop = get_event_loop()
    return loop.run_until_complete(_cache_get_product_result_async(query))
```

Remove `psycopg2-binary` do requirements.txt.

---

## Scripts auxiliares

### `scripts/harden.sh` — Fases 0.2, 0.3, 0.4 + 1.3 automáticas

```bash
#!/bin/bash
set -e
source ~/.sbb-auzap-secrets.local
COOLIFY_API_KEY=$(grep -E "^COOLIFY_API_KEY=" ~/superbem/.env | cut -d= -f2-)

echo "=== 0.2 Postgres health audit ==="
curl -s "https://coolify.pangeia.cloud/api/v1/applications/rk4o8gc08k88ogo8kcg40sow/logs?lines=100" \
  -H "Authorization: Bearer $COOLIFY_API_KEY" | jq -r '.logs' | grep -iE "healthcheck|unhealthy" | tail -20

echo "=== 0.4 Pin versions ==="
cd ~/sbb-auzap/backend/ai-service
grep -q "^agno==" requirements.txt || sed -i.bak 's/^agno$/agno==2.5.17/' requirements.txt
grep -q "^openai==" requirements.txt || sed -i.bak 's/^openai$/openai==2.32.0/' requirements.txt
grep -q "^fastapi==" requirements.txt || sed -i.bak 's/^fastapi$/fastapi==0.136.0/' requirements.txt
rm -f requirements.txt.bak

echo "=== 1.3 RLS audit ==="
# Requires psql access via Coolify terminal (manual)
echo "Run manually in Coolify UI terminal on sbb-postgres:"
echo "  SELECT schemaname,tablename,rowsecurity FROM pg_tables WHERE schemaname IN ('public','crm') AND rowsecurity=false;"

cd ~/sbb-auzap
if ! git diff --quiet; then
  git add -A
  git commit -m "chore: hardening fase 0 (pin versions)"
  git push origin main
fi

echo "=== done ==="
```

---

## Gates de GO/NO-GO

**Gate 1 — scan QR:** Fase 0 completa (baileys persistent OK, sbb-postgres healthy, backup testado). Sem isso, QR é desperdício.

**Gate 2 — primeiro cliente interno:** Fase 1 completa (auth dashboard, rate limit, RLS audit). Sem isso, vaza key ou abusa custo.

**Gate 3 — 10 clientes internos:** Fase 2 completa (N8N duplicatas desligadas, staging rodando, golden dataset verde). Sem isso, regressão silenciosa.

**Gate 4 — tráfego real:** Fase 3.1 ativa (WABA paralelo) + 3.2 (observabilidade). Sem isso, primeiro ban = horas de downtime sem visibilidade.

**Gate 5 — escala:** Fase 4 (managed DB, modelos otimizados, drivers consolidados). Otimização pós-produto-market-fit.

---

## Sequência em 1 dia (ideal)

Se tiver 1 dia focado (8h):

- **09:00-09:30** Fase 0 (30min): 0.1 UI Coolify + 0.2-0.4 via harden.sh
- **09:30-10:00** Scan QR + smoke test inbound/outbound
- **10:00-12:00** Fase 1.1 Cloudflare Access (2h, inclui teste múltiplos devices)
- **12:00-14:00** Fase 1.2 Rate limit (código + deploy + teste burst)
- **14:00-14:30** Fase 1.3 RLS audit
- **14:30-15:30** Fase 2.1 Audit N8N workflows
- **15:30-16:00** Fase 2.2 Desativar duplicatas
- **16:00-17:00** Fase 2.3 Staging app (build + envs)

Fases 2.4 (golden dataset), 3.x, 4.x em dias seguintes.

---

**Última revisão:** 2026-04-21 21:30Z
**Owner execução:** Estevão (scan QR, UI Coolify) + Claude (automação scripts)




