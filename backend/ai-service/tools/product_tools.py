"""
Tools de busca de produtos — chamam a RPC `public.buscar_produto(query)` do ERP espelhado.

Uso pelo especialista `product_search_agent`. Cacheado via `agent.tool_cache` (TTL 300s).
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

import psycopg2

from db import get_connection
from memory.tool_result_cache import (
    cache_get_product_result,
    cache_set_product_result,
)

logger = logging.getLogger("ai-service.tools.product")

DEFAULT_LIMIT = 6
MAX_LIMIT = 12


def _freshness_minutes(ts) -> int | None:
    if ts is None:
        return None
    if isinstance(ts, datetime):
        dt = ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)
        delta = datetime.now(timezone.utc) - dt
        return int(delta.total_seconds() // 60)
    return None


def _normalize_row(row: dict) -> dict:
    """Normaliza colunas de `public.buscar_produto` → dict pro LLM.

    Schema real (public.vitrine via RPC buscar_produto):
      erp_id, nome, nome_busca, nome_curto, categoria, subcategoria,
      preco, preco_promo, em_promocao, saldo, tem_estoque, ativo,
      synced_at, preco_synced_at, created_at, updated_at
    """
    preco_varejo = row.get("preco_varejo") or row.get("preco") or 0
    preco_promo = row.get("preco_promo")
    em_promocao_raw = row.get("em_promocao")
    em_promocao = bool(
        em_promocao_raw if em_promocao_raw is not None
        else (preco_promo and float(preco_promo) > 0)
    )
    saldo = row.get("saldo") or row.get("saldo_estoque") or row.get("estoque") or 0
    tem_estoque_raw = row.get("tem_estoque")
    tem_estoque = bool(tem_estoque_raw if tem_estoque_raw is not None else float(saldo or 0) > 0)
    # Freshness: preferir preco_synced_at (atualização de preço), fallback synced_at
    freshness_src = row.get("preco_synced_at") or row.get("synced_at") or row.get("dtalteracao")
    return {
        "nome": row.get("nome") or row.get("descrcomproduto") or "",
        "sku": row.get("sku") or row.get("erp_id") or row.get("codproduto"),
        "categoria": row.get("categoria") or row.get("descrcomgrupo"),
        "subcategoria": row.get("subcategoria"),
        "unidade": row.get("unidade") or row.get("unidade_medida") or "un",
        "preco_varejo": float(preco_varejo or 0),
        "preco_promo": float(preco_promo) if preco_promo not in (None, "") else None,
        "em_promocao": em_promocao,
        "saldo_estoque": float(saldo or 0),
        "tem_estoque": tem_estoque,
        "freshness_min": _freshness_minutes(freshness_src),
    }


def search_products(query: str, limit: int = DEFAULT_LIMIT) -> list[dict]:
    """
    Busca produtos via RPC `public.buscar_produto`. Retorna até `limit` itens (máx 12).
    Usa cache `agent.tool_cache` (TTL 300s) por par (query, limit) normalizados.
    """
    q = (query or "").strip()
    if not q:
        return []
    lim = max(1, min(int(limit or DEFAULT_LIMIT), MAX_LIMIT))

    cached = cache_get_product_result(q, lim)
    if cached is not None and isinstance(cached.get("results"), list):
        logger.info("CACHE HIT search_products | query=%r limit=%s", q, lim)
        return list(cached["results"])

    logger.info("search_products | query=%r limit=%s", q, lim)
    try:
        with get_connection() as conn:
            cur = conn.cursor()
            cur.execute("SELECT * FROM public.buscar_produto(%s) LIMIT %s", (q, lim))
            rows = cur.fetchall()
    except psycopg2.Error as exc:
        logger.exception("search_products: falha na RPC public.buscar_produto (%s)", exc)
        return []

    normalized = [_normalize_row(dict(r)) for r in rows]
    cache_set_product_result(q, lim, {"results": normalized, "count": len(normalized)})
    return normalized


def build_product_tools() -> list:
    """Exposição Agno-friendly: lista de tools sem closures (sem IDs por tenant)."""
    def buscar_produto(query: str, limit: int = DEFAULT_LIMIT) -> dict:
        """
        Consulta preço, promoção e estoque no ERP em tempo real.
        Use SEMPRE que o cliente perguntar preço, marca ou disponibilidade de um produto.
        Parâmetros:
          query: nome livre do produto (ex.: "arroz 5kg", "coca 2l", "frango")
          limit: máximo de resultados (padrão 6, teto 12)
        Retorno: lista de produtos com nome, preço, promoção, estoque e freshness_min.
        """
        results = search_products(query, limit)
        return {"results": results, "count": len(results)}

    return [buscar_produto]
