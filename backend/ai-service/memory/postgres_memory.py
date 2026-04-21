"""
Backend Postgres para memória de conversa (substitui Redis).

Mantém a API pública do antigo `redis_memory.py` — assinaturas e comportamento são os
mesmos do ponto de vista dos callers (main.py, history_summary.py, identity_migration_flow.py),
exceto que o estado mora em `crm.mensagens` + `agent.router_state` + `agent.conversa_sumarios`
+ `agent.identity_flow`.

Resolve `conversa_id` via RPC `crm.abrir_conversa(lead_id, telefone)`. Upsert do lead via
`crm.upsert_customer(telefone)` quando ainda não existe.

Pool: asyncpg com `min_size=2, max_size=10` — compartilhado via lazy singleton.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, List, Optional

import asyncpg

logger = logging.getLogger("ai-service.postgres_memory")

# Últimas N mensagens cruas enviadas ao modelo; o restante fica no resumo rolante
MAX_HISTORY_MESSAGES = 6

_pool: Optional[asyncpg.Pool] = None


async def get_pool() -> asyncpg.Pool:
    """Lazy singleton de pool asyncpg."""
    global _pool
    if _pool is None:
        dsn = os.getenv("DATABASE_URL") or os.getenv("DATABASE_URL_AGENT")
        if not dsn:
            raise RuntimeError("DATABASE_URL (ou DATABASE_URL_AGENT) não definido")
        _pool = await asyncpg.create_pool(
            dsn=dsn,
            min_size=2,
            max_size=10,
            command_timeout=30,
        )
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


# ─────────────────────────────────────────────────────────────────────────────
# Lookup / bootstrap de lead + conversa
# ─────────────────────────────────────────────────────────────────────────────


async def _resolve_lead_id(conn: asyncpg.Connection, telefone: str) -> int:
    """
    Retorna `crm.leads.id` pro telefone. Se não existir, cria via RPC
    `crm.upsert_customer(telefone)` — assumimos assinatura `(p_telefone TEXT, p_nome TEXT DEFAULT NULL)
    RETURNS BIGINT`. Fallback: insert direto.
    """
    row = await conn.fetchrow("SELECT id FROM crm.leads WHERE telefone = $1", telefone)
    if row:
        return int(row["id"])

    try:
        lead_id = await conn.fetchval("SELECT crm.upsert_customer($1, NULL)", telefone)
        if lead_id is not None:
            return int(lead_id)
    except asyncpg.PostgresError as exc:
        logger.warning("upsert_customer indisponível (%s) — insert direto em crm.leads", exc)

    lead_id = await conn.fetchval(
        """
        INSERT INTO crm.leads (telefone)
        VALUES ($1)
        ON CONFLICT (telefone) DO UPDATE SET telefone = EXCLUDED.telefone
        RETURNING id
        """,
        telefone,
    )
    return int(lead_id)


async def _resolve_conversa_id(
    conn: asyncpg.Connection, lead_id: int, telefone: str
) -> int:
    """Abre (ou reusa) conversa ativa via RPC com advisory lock session-level."""
    conversa_id = await conn.fetchval(
        "SELECT crm.abrir_conversa($1, $2)", lead_id, telefone
    )
    return int(conversa_id)


async def _resolve_active_conversa_id(
    conn: asyncpg.Connection, lead_id: int
) -> Optional[int]:
    """
    Só lê a conversa ativa (não abre nova). Usado em reads (`get_history`, `get_router_ctx`,
    etc.) pra não criar conversa a cada GET.
    """
    row = await conn.fetchrow(
        """
        SELECT id FROM crm.conversas
        WHERE lead_id = $1 AND encerrada_at IS NULL
        ORDER BY iniciada_at DESC
        LIMIT 1
        """,
        lead_id,
    )
    return int(row["id"]) if row else None


async def _lead_id_if_exists(
    conn: asyncpg.Connection, telefone: str
) -> Optional[int]:
    row = await conn.fetchrow("SELECT id FROM crm.leads WHERE telefone = $1", telefone)
    return int(row["id"]) if row else None


# ─────────────────────────────────────────────────────────────────────────────
# Mensagens / histórico
# ─────────────────────────────────────────────────────────────────────────────


def _direcao_for_role(role: str) -> str:
    return "out" if role == "assistant" else "in"


def _role_for_direcao(direcao: str) -> str:
    return "assistant" if direcao == "out" else "user"


async def save_message(
    company_id: int, client_phone: str, role: str, content: str
) -> None:
    """
    Grava mensagem em `crm.mensagens`. Resolve/abre conversa ativa. `company_id` é mantido
    na API pública por compatibilidade — no schema do SBB a multiempresa é implícita
    (1 instância ai-service por cliente).
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        lead_id = await _resolve_lead_id(conn, client_phone)
        conversa_id = await _resolve_conversa_id(conn, lead_id, client_phone)
        direcao = _direcao_for_role(role)
        await conn.execute(
            """
            INSERT INTO crm.mensagens (conversa_id, lead_id, telefone, direcao, conteudo, tipo)
            VALUES ($1, $2, $3, $4, $5, 'texto')
            """,
            conversa_id,
            lead_id,
            client_phone,
            direcao,
            content or "",
        )


async def get_history(company_id: int, client_phone: str) -> List[dict]:
    """
    Retorna as últimas MAX_HISTORY_MESSAGES da conversa ativa em ordem cronológica
    ascendente (mais antigo → mais recente).
    Formato: [{"role": "user"|"assistant", "content": "..."}]
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        lead_id = await _lead_id_if_exists(conn, client_phone)
        if lead_id is None:
            return []
        conversa_id = await _resolve_active_conversa_id(conn, lead_id)
        if conversa_id is None:
            return []
        rows = await conn.fetch(
            """
            SELECT direcao, conteudo
            FROM crm.mensagens
            WHERE conversa_id = $1
            ORDER BY created_at DESC, id DESC
            LIMIT $2
            """,
            conversa_id,
            MAX_HISTORY_MESSAGES,
        )
    # Retorno cronológico ascendente (mais antigo primeiro) pra caller iterar como no legado
    ordered = list(reversed(rows))
    return [
        {"role": _role_for_direcao(r["direcao"]), "content": r["conteudo"] or ""}
        for r in ordered
    ]


async def history_length(company_id: int, client_phone: str) -> int:
    """Total de mensagens da conversa ativa (para o history_summary decidir quando resumir)."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        lead_id = await _lead_id_if_exists(conn, client_phone)
        if lead_id is None:
            return 0
        conversa_id = await _resolve_active_conversa_id(conn, lead_id)
        if conversa_id is None:
            return 0
        count = await conn.fetchval(
            "SELECT COUNT(*) FROM crm.mensagens WHERE conversa_id = $1", conversa_id
        )
        return int(count or 0)


async def history_slice(
    company_id: int, client_phone: str, start: int, end: int
) -> List[dict]:
    """
    Intervalo `[start, end)` do histórico em ordem cronológica (0 = mais antiga).
    Usado pelo sumarizador rolante.
    """
    if end <= start:
        return []
    pool = await get_pool()
    async with pool.acquire() as conn:
        lead_id = await _lead_id_if_exists(conn, client_phone)
        if lead_id is None:
            return []
        conversa_id = await _resolve_active_conversa_id(conn, lead_id)
        if conversa_id is None:
            return []
        rows = await conn.fetch(
            """
            SELECT direcao, conteudo
            FROM crm.mensagens
            WHERE conversa_id = $1
            ORDER BY created_at ASC, id ASC
            OFFSET $2 LIMIT $3
            """,
            conversa_id,
            start,
            end - start,
        )
    return [
        {"role": _role_for_direcao(r["direcao"]), "content": r["conteudo"] or ""}
        for r in rows
    ]


async def pop_last_messages(company_id: int, client_phone: str, count: int) -> int:
    """
    Remove as últimas N mensagens (para descartar respostas invalidadas por concorrência).
    Retorna quantas foram efetivamente removidas.
    """
    if count <= 0:
        return 0
    pool = await get_pool()
    async with pool.acquire() as conn:
        lead_id = await _lead_id_if_exists(conn, client_phone)
        if lead_id is None:
            return 0
        conversa_id = await _resolve_active_conversa_id(conn, lead_id)
        if conversa_id is None:
            return 0
        rows = await conn.fetch(
            """
            SELECT id FROM crm.mensagens
            WHERE conversa_id = $1
            ORDER BY created_at DESC, id DESC
            LIMIT $2
            """,
            conversa_id,
            count,
        )
        if not rows:
            return 0
        ids = [r["id"] for r in rows]
        await conn.execute(
            "DELETE FROM crm.mensagens WHERE id = ANY($1::bigint[])", ids
        )
        return len(ids)


async def clear_history(company_id: int, client_phone: str) -> None:
    """
    «Reset» da conversa: encerra a conversa ativa (mensagens ficam em histórico),
    apaga estado do router, sumário e fase de identity_flow.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        lead_id = await _lead_id_if_exists(conn, client_phone)
        if lead_id is None:
            return
        conversa_id = await _resolve_active_conversa_id(conn, lead_id)
        if conversa_id is None:
            return
        async with conn.transaction():
            await conn.execute(
                """
                UPDATE crm.conversas
                SET encerrada_at = NOW(), encerrada_por = COALESCE(encerrada_por, 'agent_reset')
                WHERE id = $1 AND encerrada_at IS NULL
                """,
                conversa_id,
            )
            await conn.execute(
                "DELETE FROM agent.router_state WHERE conversa_id = $1", conversa_id
            )
            await conn.execute(
                "DELETE FROM agent.conversa_sumarios WHERE conversa_id = $1", conversa_id
            )
            await conn.execute(
                "DELETE FROM agent.identity_flow WHERE conversa_id = $1", conversa_id
            )


# ─────────────────────────────────────────────────────────────────────────────
# Sumário rolante
# ─────────────────────────────────────────────────────────────────────────────


async def get_summary_state(
    company_id: int, client_phone: str
) -> Optional[dict]:
    pool = await get_pool()
    async with pool.acquire() as conn:
        lead_id = await _lead_id_if_exists(conn, client_phone)
        if lead_id is None:
            return None
        conversa_id = await _resolve_active_conversa_id(conn, lead_id)
        if conversa_id is None:
            return None
        row = await conn.fetchrow(
            "SELECT text, covered FROM agent.conversa_sumarios WHERE conversa_id = $1",
            conversa_id,
        )
        if not row:
            return None
        return {"text": row["text"] or "", "covered": int(row["covered"] or 0)}


async def set_summary_state(
    company_id: int, client_phone: str, text: str, covered: int
) -> None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        lead_id = await _resolve_lead_id(conn, client_phone)
        conversa_id = await _resolve_conversa_id(conn, lead_id, client_phone)
        await conn.execute(
            """
            INSERT INTO agent.conversa_sumarios (conversa_id, text, covered, updated_at)
            VALUES ($1, $2, $3, NOW())
            ON CONFLICT (conversa_id) DO UPDATE
              SET text = EXCLUDED.text,
                  covered = EXCLUDED.covered,
                  updated_at = NOW()
            """,
            conversa_id,
            text or "",
            int(covered or 0),
        )


async def delete_summary_state(company_id: int, client_phone: str) -> None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        lead_id = await _lead_id_if_exists(conn, client_phone)
        if lead_id is None:
            return
        conversa_id = await _resolve_active_conversa_id(conn, lead_id)
        if conversa_id is None:
            return
        await conn.execute(
            "DELETE FROM agent.conversa_sumarios WHERE conversa_id = $1", conversa_id
        )


# ─────────────────────────────────────────────────────────────────────────────
# Router state (agent + stage + required_tools + payload por conversa)
# ─────────────────────────────────────────────────────────────────────────────


async def get_router_ctx(
    company_id: int, client_phone: str
) -> Optional[dict]:
    pool = await get_pool()
    async with pool.acquire() as conn:
        lead_id = await _lead_id_if_exists(conn, client_phone)
        if lead_id is None:
            return None
        conversa_id = await _resolve_active_conversa_id(conn, lead_id)
        if conversa_id is None:
            return None
        row = await conn.fetchrow(
            """
            SELECT agent, stage, required_tools, payload
            FROM agent.router_state
            WHERE conversa_id = $1
            """,
            conversa_id,
        )
        if not row:
            return None

    payload = row["payload"] or {}
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError:
            payload = {}

    out: dict[str, Any] = dict(payload) if isinstance(payload, dict) else {}
    if row["agent"]:
        out["agent"] = row["agent"]
    if row["stage"]:
        out["stage"] = row["stage"]
    if row["required_tools"] is not None:
        out["required_tools"] = list(row["required_tools"])
    return out


async def save_router_ctx(
    company_id: int, client_phone: str, router_ctx: Optional[dict]
) -> None:
    if not router_ctx:
        return
    agent = router_ctx.get("agent")
    stage = router_ctx.get("stage")
    required_tools = router_ctx.get("required_tools")
    # payload = todo o restante (exclui campos promovidos a coluna)
    payload = {
        k: v
        for k, v in router_ctx.items()
        if k not in ("agent", "stage", "required_tools")
    }
    pool = await get_pool()
    async with pool.acquire() as conn:
        lead_id = await _resolve_lead_id(conn, client_phone)
        conversa_id = await _resolve_conversa_id(conn, lead_id, client_phone)
        await conn.execute(
            """
            INSERT INTO agent.router_state
                (conversa_id, agent, stage, required_tools, payload, updated_at)
            VALUES ($1, $2, $3, $4::text[], $5::jsonb, NOW())
            ON CONFLICT (conversa_id) DO UPDATE
              SET agent = EXCLUDED.agent,
                  stage = EXCLUDED.stage,
                  required_tools = EXCLUDED.required_tools,
                  payload = EXCLUDED.payload,
                  updated_at = NOW()
            """,
            conversa_id,
            agent,
            stage,
            list(required_tools) if required_tools is not None else None,
            json.dumps(payload, ensure_ascii=False, default=str),
        )


# ─────────────────────────────────────────────────────────────────────────────
# Identity migration flow (recadastro incremental)
# ─────────────────────────────────────────────────────────────────────────────


async def get_identity_migration_phase(
    company_id: int, client_phone: str
) -> Optional[str]:
    pool = await get_pool()
    async with pool.acquire() as conn:
        lead_id = await _lead_id_if_exists(conn, client_phone)
        if lead_id is None:
            return None
        conversa_id = await _resolve_active_conversa_id(conn, lead_id)
        if conversa_id is None:
            return None
        phase = await conn.fetchval(
            "SELECT phase FROM agent.identity_flow WHERE conversa_id = $1", conversa_id
        )
    return str(phase) if phase else None


async def get_identity_migration_data(
    company_id: int, client_phone: str
) -> dict:
    pool = await get_pool()
    async with pool.acquire() as conn:
        lead_id = await _lead_id_if_exists(conn, client_phone)
        if lead_id is None:
            return {}
        conversa_id = await _resolve_active_conversa_id(conn, lead_id)
        if conversa_id is None:
            return {}
        raw = await conn.fetchval(
            "SELECT partial FROM agent.identity_flow WHERE conversa_id = $1", conversa_id
        )
    if raw is None:
        return {}
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            return {}
    return raw if isinstance(raw, dict) else {}


async def set_identity_migration_phase(
    company_id: int,
    client_phone: str,
    phase: Optional[str],
    partial: Optional[dict] = None,
) -> None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        lead_id = await _resolve_lead_id(conn, client_phone)
        conversa_id = await _resolve_conversa_id(conn, lead_id, client_phone)
        if not phase:
            await conn.execute(
                "DELETE FROM agent.identity_flow WHERE conversa_id = $1", conversa_id
            )
            return
        await conn.execute(
            """
            INSERT INTO agent.identity_flow (conversa_id, phase, partial, updated_at)
            VALUES ($1, $2, $3::jsonb, NOW())
            ON CONFLICT (conversa_id) DO UPDATE
              SET phase = EXCLUDED.phase,
                  partial = EXCLUDED.partial,
                  updated_at = NOW()
            """,
            conversa_id,
            phase,
            json.dumps(partial or {}, ensure_ascii=False, default=str),
        )


async def clear_identity_migration_phase(
    company_id: int, client_phone: str
) -> None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        lead_id = await _lead_id_if_exists(conn, client_phone)
        if lead_id is None:
            return
        conversa_id = await _resolve_active_conversa_id(conn, lead_id)
        if conversa_id is None:
            return
        await conn.execute(
            "DELETE FROM agent.identity_flow WHERE conversa_id = $1", conversa_id
        )
