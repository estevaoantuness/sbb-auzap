"""
Loader de contexto por turno (Super Bem Barato).

Carrega: lead CRM, últimos pedidos, preferências e metadados da loja (vindos de env).
Upsert do lead via RPC `crm.upsert_customer(telefone)` — garantido existir antes do especialista.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Optional

import asyncpg

from config import OPENAI_MODEL_COMPANY_OVERRIDE
from memory.postgres_memory import get_pool

logger = logging.getLogger("ai-service.context.loader")


def _get_model_override(company_id: int) -> Optional[str]:
    return OPENAI_MODEL_COMPANY_OVERRIDE.get(company_id)


def _store_settings() -> dict[str, str]:
    return {
        "store_name": os.getenv("STORE_NAME", "Super Bem Barato"),
        "store_phone": os.getenv("STORE_PHONE", "(63) 4141-9318"),
        "store_address": os.getenv(
            "STORE_ADDRESS", "Luzimangues, Porto Nacional - TO"
        ),
        "business_hours": os.getenv(
            "STORE_HOURS", "Seg-Sáb 07-22h, Dom 08-20h"
        ),
    }


async def _upsert_lead(conn: asyncpg.Connection, telefone: str) -> int:
    """Upsert lead via RPC (fallback: insert idempotente)."""
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


async def _load_lead(conn: asyncpg.Connection, lead_id: int) -> dict[str, Any]:
    row = await conn.fetchrow(
        """
        SELECT id, nome, telefone, email, bairro, segmento_rfm, total_pedidos,
               top_categorias, criado_em, ultima_interacao_em
        FROM crm.leads
        WHERE id = $1
        """,
        lead_id,
    )
    if not row:
        return {}
    return dict(row)


async def _load_last_orders(
    conn: asyncpg.Connection, lead_id: int, limit: int = 3
) -> list[dict]:
    try:
        rows = await conn.fetch(
            """
            SELECT id, status, total, tipo_entrega, endereco, bairro, created_at
            FROM crm.pedidos
            WHERE lead_id = $1
            ORDER BY created_at DESC
            LIMIT $2
            """,
            lead_id,
            limit,
        )
    except asyncpg.PostgresError as exc:
        logger.warning("crm.pedidos indisponível (%s) — contexto seguirá sem histórico", exc)
        return []
    return [dict(r) for r in rows]


async def _load_preferences(
    conn: asyncpg.Connection, lead_id: int
) -> list[dict]:
    try:
        rows = await conn.fetch(
            "SELECT * FROM crm.preferencias WHERE lead_id = $1", lead_id
        )
    except asyncpg.PostgresError as exc:
        logger.warning("crm.preferencias indisponível (%s) — contexto seguirá sem prefs", exc)
        return []
    return [dict(r) for r in rows]


async def _ai_paused(conn: asyncpg.Connection, lead_id: int) -> bool:
    """Checa se tem conversa ativa com IA pausada."""
    try:
        row = await conn.fetchrow(
            """
            SELECT ia_pausada
            FROM crm.conversas
            WHERE lead_id = $1 AND encerrada_at IS NULL
            ORDER BY iniciada_at DESC
            LIMIT 1
            """,
            lead_id,
        )
    except asyncpg.PostgresError:
        return False
    return bool(row and row["ia_pausada"])


async def load_context(company_id: int, telefone: str) -> dict:
    """
    Carrega tudo que os especialistas precisam pra responder neste turno.

    company_id: mantido por compatibilidade com assinatura AuZap (aqui equivale ao tenant 1 do SBB).
    telefone: telefone do cliente (E.164 ou nacional).
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        lead_id = await _upsert_lead(conn, telefone)
        lead = await _load_lead(conn, lead_id)
        orders = await _load_last_orders(conn, lead_id)
        prefs = await _load_preferences(conn, lead_id)
        paused = await _ai_paused(conn, lead_id)

    store = _store_settings()
    customer_name = (lead.get("nome") or "").strip() or None
    top_categorias = lead.get("top_categorias") or []
    if isinstance(top_categorias, str):
        # text[] já vem como lista do asyncpg; se algum deploy antigo tiver JSON em TEXT, segura
        top_categorias = [c.strip() for c in top_categorias.split(",") if c.strip()]

    ultimo_pedido = orders[0] if orders else None

    return {
        "company_id": company_id,
        "lead_id": lead_id,
        "telefone": telefone,
        "customer_name": customer_name,
        "assistant_name": os.getenv("ASSISTANT_NAME", "Maria"),
        "company_name": store["store_name"],
        "store_name": store["store_name"],
        "store_phone": store["store_phone"],
        "store_address": store["store_address"],
        "business_hours": store["business_hours"],
        "bairro": lead.get("bairro"),
        "segmento": lead.get("segmento_rfm"),
        "total_pedidos": lead.get("total_pedidos") or 0,
        "top_categorias": top_categorias,
        "ultimo_pedido": ultimo_pedido,
        "pedidos_recentes": orders,
        "preferencias": prefs,
        "ai_paused": paused,
        # Campos mantidos por compat com o prompt do router legado / shared_blocks
        "client": {
            "id": lead_id,
            "name": customer_name,
            "phone": telefone,
            "conversation_stage": lead.get("segmento_rfm") or "desconhecido",
            "ai_paused": paused,
        },
        "features": {},
        "services": [],
        "pets": [],
        "specialties": [],
        "lodging_config": {},
        "lodging_room_types": [],
        "identity_flow_required": False,
        "model_override": _get_model_override(company_id),
    }
