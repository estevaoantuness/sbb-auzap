"""
Cache curto para resultados de tools em Postgres (`agent.tool_cache`) — substitui o cache Redis
legado. Compartilhado por todos os workers da ai-service.

API pública mantida no formato `cache_get_*` / `cache_set_*`:
  - cache_get_product_result / cache_set_product_result — busca ERP
  - cache_get_customer_details / cache_set_customer_details — dados do lead

Todas as funções são síncronas (chamadas de dentro de tools Agno); usam `psycopg2` pra evitar
criar event loop novo pra cada call em código que já está rodando em thread sync do Agno.
"""

from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

import psycopg2
import psycopg2.extras

from db import get_connection

logger = logging.getLogger("ai-service.tool_result_cache")

# TTLs curtos (produto muda rápido no ERP, cliente muda lento)
PRODUCT_TTL_SEC = 300
CUSTOMER_TTL_SEC = 180
GLOBAL_SCOPE = "global"


def _json_dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, default=str)


def _hash_args(payload: dict) -> str:
    """Hash estável de args (sha1, 20 chars) pra deduplicar cache por entrada."""
    canonical = json.dumps(payload or {}, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha1(canonical.encode("utf-8")).hexdigest()[:20]


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _cache_get(tool_name: str, args_hash: str, scope_key: str) -> dict | None:
    try:
        with get_connection() as conn:
            cur = conn.cursor()
            cur.execute(
                """
                SELECT result FROM agent.tool_cache
                WHERE tool_name = %s AND args_hash = %s AND scope_key = %s
                  AND expires_at > NOW()
                LIMIT 1
                """,
                (tool_name, args_hash, scope_key),
            )
            row = cur.fetchone()
    except psycopg2.Error as exc:
        logger.warning("tool_cache get falhou (%s) — ignorando cache", exc)
        return None
    if not row:
        return None
    result = row["result"] if isinstance(row, dict) else row[0]
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except json.JSONDecodeError:
            return None
    return result if isinstance(result, dict) else None


def _cache_set(
    tool_name: str,
    args_hash: str,
    scope_key: str,
    payload: dict,
    ttl_sec: int,
) -> None:
    expires_at = _now_utc() + timedelta(seconds=ttl_sec)
    try:
        with get_connection() as conn:
            cur = conn.cursor()
            cur.execute(
                """
                INSERT INTO agent.tool_cache
                  (tool_name, args_hash, scope_key, result, expires_at)
                VALUES (%s, %s, %s, %s::jsonb, %s)
                ON CONFLICT (tool_name, args_hash, scope_key) DO UPDATE
                  SET result = EXCLUDED.result,
                      expires_at = EXCLUDED.expires_at,
                      created_at = NOW()
                """,
                (
                    tool_name,
                    args_hash,
                    scope_key,
                    _json_dumps(payload),
                    expires_at,
                ),
            )
    except psycopg2.Error as exc:
        logger.warning("tool_cache set falhou (%s)", exc)


def _cache_invalidate(tool_name: str, scope_key: str) -> None:
    try:
        with get_connection() as conn:
            cur = conn.cursor()
            cur.execute(
                "DELETE FROM agent.tool_cache WHERE tool_name = %s AND scope_key = %s",
                (tool_name, scope_key),
            )
    except psycopg2.Error as exc:
        logger.warning("tool_cache invalidate falhou (%s)", exc)


# ─────────────────────────────────────────────────────────────────────────────
# Produto (busca ERP)
# ─────────────────────────────────────────────────────────────────────────────


def cache_get_product_result(query: str, limit: int = 6) -> dict | None:
    q = (query or "").strip().lower()
    if not q:
        return None
    args_hash = _hash_args({"query": q, "limit": int(limit)})
    return _cache_get("search_products", args_hash, GLOBAL_SCOPE)


def cache_set_product_result(query: str, limit: int, payload: dict) -> None:
    q = (query or "").strip().lower()
    if not q:
        return
    args_hash = _hash_args({"query": q, "limit": int(limit)})
    _cache_set("search_products", args_hash, GLOBAL_SCOPE, payload, PRODUCT_TTL_SEC)


def cache_invalidate_products() -> None:
    _cache_invalidate("search_products", GLOBAL_SCOPE)


# ─────────────────────────────────────────────────────────────────────────────
# Customer details
# ─────────────────────────────────────────────────────────────────────────────


def cache_get_customer_details(lead_id: int) -> dict | None:
    if not lead_id:
        return None
    args_hash = _hash_args({"lead_id": int(lead_id)})
    return _cache_get("fetch_customer_details", args_hash, f"lead:{lead_id}")


def cache_set_customer_details(lead_id: int, payload: dict) -> None:
    if not lead_id:
        return
    args_hash = _hash_args({"lead_id": int(lead_id)})
    _cache_set(
        "fetch_customer_details",
        args_hash,
        f"lead:{lead_id}",
        payload,
        CUSTOMER_TTL_SEC,
    )


def cache_invalidate_customer(lead_id: int) -> None:
    if not lead_id:
        return
    _cache_invalidate("fetch_customer_details", f"lead:{lead_id}")
