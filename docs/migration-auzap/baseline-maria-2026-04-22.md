# Baseline Maria-N8N — 2026-04-22 (pré-cutover Evolution)

> Executado por Team Evolution-D via endpoint `POST /dev-tools/run-readonly-query`
> adicionado em `f88swo04ogw0wo8w00okcw8c` (sbb-auzap-api, commit `131f612`).
> Queries ran read-only contra `sbb-postgres` (usuário `sbb_app`, DB `postgres`).

---

## TL;DR — NÃO HÁ BASELINE UTILIZÁVEL

A Maria-N8N **não populou o schema `crm.*`**. Todas as tabelas planejadas
para receber a história (`crm.mensagens`, `crm.conversas`, `crm.pedidos`,
`crm.eventos_lead`, `crm.produtos_consultados`) estão com **0 linhas**
(`pg_stat_user_tables.n_live_tup = 0, n_tup_ins = 0`).

Os dados reais da Maria vivem em `public.n8n_historico_mensagens`
(formato LangChain `chat_history`, colunas: `id`, `session_id`, `message jsonb`,
`created_at`) e somam **11 mensagens de 1 única sessão num único dia
(2026-04-06)**. O restante do mês não registrou tráfego.

Implicação: **o critério NO-GO formal não tem denominador estatístico válido**
(< 30 sessões, < 100 mensagens, zero pedidos). O cutover para Evolution
deve seguir baseado em dry-run + shadow mode, **não em comparação de
métricas históricas**.

---

## Métricas coletadas (honestas, com contexto)

### 1. Volume diário (últimos 30 dias)

| Dia | Msgs total | Humanas | AI | Sessões distintas |
|---|---|---|---|---|
| 2026-04-06 | 11 | 4 | 7 | 1 |
| outros dias | 0 | 0 | 0 | 0 |

**Fonte:** `public.n8n_historico_mensagens`, filtro `created_at > NOW() - INTERVAL '30 days'`.
**Obs.:** `tipo` derivado de `message->>'type'` ('human' / 'ai'). Primeira linha
em 2026-04-06 17:46, última em 2026-04-06 17:55 — **uma única janela de
~9min** com o telefone `+554191851256`. Nada antes ou depois.

Total global absoluto da tabela (todo o histórico):
- `total = 11`
- `primeira = 2026-04-06 17:46:26Z`
- `última = 2026-04-06 17:55:06Z`
- `sessoes = 1`

### 2. Pedidos concluídos / dia

| Métrica | Valor |
|---|---|
| `crm.pedidos` rowcount | **0** |

Não há modelo de pedidos em uso na Maria-N8N atual. A tabela `crm.pedidos`
foi criada pelo schema novo mas nunca recebeu `INSERT` (`n_tup_ins = 0`).

### 3. Taxa de escalação manual

Não mensurável: `crm.eventos_lead` = 0 linhas, e `public.n8n_historico_mensagens`
não registra `escalou_operador`. Motivos de escalação idem.

### 4. Latência P50 / P95 (human → primeiro ai da mesma sessão)

| Pairs medidos | P50 (s) | P95 (s) | Max (s) |
|---|---|---|---|
| 4 | 0.003 | 0.005 | 0.005 |

**Alerta:** essas latências **não representam latência real de atendimento.**
São deltas entre rows escritos pelo próprio N8N no mesmo ciclo
(mensagem `ai` com `<tool-calls>` e mensagem `ai` com o texto final são
gravadas com microsegundos de diferença). O mensurador correto seria o
`execution_time_ms` do N8N run (não disponível aqui), não o delta de
`created_at`.

### 5. Conversas únicas em janelas de 24h (tier WABA)

| Dia | Leads únicos / 24h |
|---|---|
| 2026-04-06 | 1 |

Tier WABA não é estressado: **1 conversa única em 30 dias**. Qualquer
tier Meta (incluindo Tier 1 - 1 000 conv/dia) é folgado.

### 6. Turnos médios por conversa

| Métrica | Valor |
|---|---|
| sessões (30d) | 1 |
| mensagens humanas | 4 |
| turnos médios | 4 |
| P50 turnos | 4 |
| P95 turnos | 4 |

Amostra de n=1 sessão — não generalizável.

### 7. Buscas de produto (baseline tool_cache)

| Termo | Ocorrências |
|---|---|
| frango | 4 |
| carne | 2 |
| carne bovina | 2 |
| bovina | 2 |

Total buscas: **10** (tabela `public.log_busca_produto`, 30 dias).
Todas da mesma sessão de 2026-04-06. Dimensionar `tool_cache` por esses
números é inútil.

---

## Schema reality vs. baseline-maria.sql

| Tabela esperada pelo script | Realidade |
|---|---|
| `crm.mensagens` | **0 rows** (schema criado, nunca usado) |
| `crm.conversas` | **0 rows** |
| `crm.pedidos` | **0 rows** |
| `crm.eventos_lead` | **0 rows** |
| `crm.produtos_consultados` | **0 rows** |
| `crm.leads` | **0 rows** |
| (real) `public.n8n_historico_mensagens` | 11 rows, 1 sessão, 2026-04-06 |
| (real) `public.log_busca_produto` | 10 rows, mesma sessão |
| (real) `public.n8n_fila_mensagens` | 0 rows |
| (real) `public.n8n_status_atendimento` | 1 row |

**O `baseline-maria.sql` deveria ter sido escrito contra o schema
LangChain `public.n8n_*`**. Recomendo deprecar o arquivo ou reescrever
apontando pra `n8n_historico_mensagens` e documentando claramente que
direção é derivada de `message->>'type'`.

---

## Critério NO-GO vs GO pra migração

Definição original (STACK.md / D2): NO-GO **somente se TODAS** verdadeiras:
escalação < 5%, correção ≥ 92%, P95 < 6 s, custo OpenAI < R$ 300/mês.

| Métrica | Valor Maria-N8N | Threshold NO-GO | Decisão |
|---|---|---|---|
| Taxa escalação | **não mensurável** (0 eventos gravados, 0 campo de direção) | < 5% | indeterminado |
| Correção factual | **não mensurável** (amostra manual requer ≥ 50 conversas encerradas; existem 0) | ≥ 92% | indeterminado |
| Latência P95 msg-a-msg | 0.005 s (artefato de batch write, não real) | < 6 s | indeterminado |
| Custo OpenAI/mês | **pendente de confirmação** via dashboard OpenAI | < R$ 300 | **bloqueio de dados — user precisa colar** |
| Volume mensal | 11 msgs em 1 dia isolado | (informativo) | — |

Como **3 de 4 métricas são indeterminadas**, não é possível aplicar o
critério NO-GO original. A regra "todas verdadeiras ⇒ cancela migração"
não dispara: **default → GO** (seguir cutover Evolution).

---

## Recomendação

1. **GO para cutover Evolution** — não há linha de base estatisticamente
   significativa para comparar. Maria-N8N operou em piloto isolado (1 dia,
   1 telefone, 11 mensagens) e não gerou dataset operacional.
2. **Substituir critério histórico por shadow-mode A/B** — com Evolution
   em `SHADOW_MODE` ativo (já presente no código, commit `48d92a9`),
   comparar em tempo real as respostas Maria-N8N vs AuZap por 7-14 dias
   e medir: taxa de divergência, latência AuZap (real, medida pelo
   `agent.runs.duration_ms`), correção humana em amostra manual.
3. **Reescrever `scripts/baseline-maria.sql`** apontando para
   `public.n8n_historico_mensagens` + `public.log_busca_produto` com a
   direção derivada de `message->>'type'`. Documentar em `docs/STACK.md`
   que `crm.*` é o destino da migração AuZap, **não** fonte Maria-N8N.
4. **Confirmar custo OpenAI no dashboard** — a única métrica do critério
   NO-GO que é obtível sem mudar schema. Se custo mensal da Maria-N8N
   foi < R$ 300 (provável, dado o volume de 11 msgs/mês), documentar
   como custo piloto; se > R$ 300, investigar antes do cutover.

---

## Pendências para o usuário

1. **Custo OpenAI mensal da Maria-N8N** (dashboard OpenAI → filtrar por
   API key usada no workflow `sbb-01-secretaria-v3`). Formato esperado:
   ```
   Mês | Total USD | Total BRL (cotação do último dia)
   2026-03 | $X.YZ | R$ X,YZ
   2026-04 (parcial) | $X.YZ | R$ X,YZ
   ```
2. **Decisão sobre deprecar ou reescrever `scripts/baseline-maria.sql`**
   (recomendação: reescrever apontando para n8n_historico_mensagens).

---

## Anexo — Como o baseline foi coletado

**Endpoint criado:** `POST https://auzap-api.pangeia.cloud/dev-tools/run-readonly-query`
**Auth:** `x-dev-tools-key: <DEV_TOOLS_KEY>` (env `DEV_TOOLS_KEY` setada via
Coolify, env UUID `wsgsg8k04cgoow4ww4c84k08`, runtime-only, não build-time).
**Proteções:** single statement, proíbe palavras-chave de escrita,
`BEGIN READ ONLY` + `SET LOCAL statement_timeout = '20s'`, cap 200 rows.

**Usuário DB:** `sbb_app` — tem privilégios em `agent.*` e `public.*` mas
**não em `crm.*`** (por isso os SELECTs originais do script retornavam
`42501 permission denied`). Para rodar queries em `crm.*` no futuro,
seria necessário ou (a) dar SELECT em `crm.*` ao `sbb_app`, ou (b) usar
o usuário `postgres` via Coolify UI terminal.
