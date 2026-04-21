"""
Tools de cliente — upsert, detalhes e eventos do lead.

Cacheado via `agent.tool_cache` por `lead_id`.
"""

from __future__ import annotations

import json
import logging
from typing import Any

import psycopg2

from db import get_connection
from memory.tool_result_cache import (
    cache_get_customer_details,
    cache_invalidate_customer,
    cache_set_customer_details,
)

logger = logging.getLogger("ai-service.tools.customer")


def upsert_customer(telefone: str, nome: str | None = None) -> dict:
    """Upsert lead via RPC `crm.upsert_customer(telefone, nome)`."""
    if not telefone or not str(telefone).strip():
        return {"success": False, "error": "telefone é obrigatório"}
    try:
        with get_connection() as conn:
            cur = conn.cursor()
            cur.execute("SELECT crm.upsert_customer(%s, %s)", (telefone, nome))
            row = cur.fetchone()
            lead_id = row[0] if row and not isinstance(row, dict) else (
                row.get("upsert_customer") if isinstance(row, dict) else None
            )
    except psycopg2.Error as exc:
        logger.exception("upsert_customer falhou (%s)", exc)
        return {"success": False, "error": str(exc)}
    if lead_id is None:
        return {"success": False, "error": "RPC não retornou lead_id"}
    cache_invalidate_customer(int(lead_id))
    return {"success": True, "lead_id": int(lead_id)}


def fetch_customer_details(lead_id: int) -> dict:
    """Detalhes do cliente + últimos 5 pedidos + preferências. Usa cache TTL 180s."""
    if not lead_id:
        return {"success": False, "error": "lead_id é obrigatório"}

    cached = cache_get_customer_details(int(lead_id))
    if cached is not None:
        logger.info("CACHE HIT fetch_customer_details | lead_id=%s", lead_id)
        return cached

    try:
        with get_connection() as conn:
            cur = conn.cursor()
            cur.execute(
                """
                SELECT id, nome, telefone, email, bairro, segmento_rfm,
                       total_pedidos, top_categorias, criado_em, ultima_interacao_em
                FROM crm.leads WHERE id = %s
                """,
                (lead_id,),
            )
            lead = cur.fetchone()
            if not lead:
                return {"success": False, "error": "cliente não encontrado"}

            cur.execute(
                """
                SELECT id, status, total, tipo_entrega, bairro, created_at
                FROM crm.pedidos
                WHERE lead_id = %s
                ORDER BY created_at DESC
                LIMIT 5
                """,
                (lead_id,),
            )
            orders = [dict(r) for r in cur.fetchall()]

            cur.execute(
                "SELECT * FROM crm.preferencias WHERE lead_id = %s", (lead_id,)
            )
            prefs = [dict(r) for r in cur.fetchall()]
    except psycopg2.Error as exc:
        logger.exception("fetch_customer_details falhou (%s)", exc)
        return {"success": False, "error": str(exc)}

    payload = {
        "success": True,
        "lead": dict(lead),
        "pedidos": orders,
        "preferencias": prefs,
    }
    cache_set_customer_details(int(lead_id), payload)
    return payload


def register_event(
    lead_id: int,
    tipo: str,
    payload: dict | None = None,
    conversa_id: int | None = None,
    idempotency_key: str | None = None,
) -> dict:
    """
    Insere evento em `crm.eventos_lead`. `idempotency_key` impede duplicata
    (unique parcial espera-se em `(lead_id, idempotency_key)` quando a chave estiver presente).
    """
    if not lead_id or not tipo:
        return {"success": False, "error": "lead_id e tipo são obrigatórios"}
    payload = payload or {}
    try:
        with get_connection() as conn:
            cur = conn.cursor()
            cur.execute(
                """
                INSERT INTO crm.eventos_lead
                  (lead_id, conversa_id, tipo, payload, idempotency_key)
                VALUES (%s, %s, %s, %s::jsonb, %s)
                ON CONFLICT DO NOTHING
                RETURNING id
                """,
                (
                    lead_id,
                    conversa_id,
                    tipo,
                    json.dumps(payload, ensure_ascii=False, default=str),
                    idempotency_key,
                ),
            )
            row = cur.fetchone()
    except psycopg2.Error as exc:
        logger.exception("register_event falhou (%s)", exc)
        return {"success": False, "error": str(exc)}
    if not row:
        # Idempotente: chave já existia
        return {"success": True, "event_id": None, "deduped": True}
    event_id = row[0] if not isinstance(row, dict) else row.get("id")
    return {"success": True, "event_id": int(event_id), "deduped": False}


def set_preference(
    lead_id: int,
    chave: str,
    valor: Any,
) -> dict:
    """Grava/atualiza preferência do cliente em `crm.preferencias`."""
    if not lead_id or not chave:
        return {"success": False, "error": "lead_id e chave são obrigatórios"}
    try:
        with get_connection() as conn:
            cur = conn.cursor()
            cur.execute(
                """
                INSERT INTO crm.preferencias (lead_id, chave, valor)
                VALUES (%s, %s, %s::jsonb)
                ON CONFLICT (lead_id, chave) DO UPDATE
                  SET valor = EXCLUDED.valor, updated_at = NOW()
                RETURNING id
                """,
                (
                    lead_id,
                    chave,
                    json.dumps(valor, ensure_ascii=False, default=str),
                ),
            )
            row = cur.fetchone()
    except psycopg2.Error as exc:
        logger.exception("set_preference falhou (%s)", exc)
        return {"success": False, "error": str(exc)}
    cache_invalidate_customer(int(lead_id))
    pref_id = row[0] if row and not isinstance(row, dict) else (row.get("id") if isinstance(row, dict) else None)
    return {"success": True, "preferencia_id": int(pref_id) if pref_id else None}


def build_customer_tools(lead_id: int, conversa_id: int | None = None) -> list:
    """Tools Agno. Assinaturas sem IDs (via closure)."""

    def detalhes_cliente() -> dict:
        """Retorna dados do cliente atual — pedidos recentes e preferências."""
        return fetch_customer_details(lead_id)

    def atualizar_cliente(nome: str | None = None, telefone: str | None = None) -> dict:
        """Atualiza nome/telefone do cliente (upsert por telefone)."""
        phone = telefone or ""
        if not phone:
            # Sem telefone: busca o do lead atual
            try:
                with get_connection() as conn:
                    cur = conn.cursor()
                    cur.execute("SELECT telefone FROM crm.leads WHERE id = %s", (lead_id,))
                    row = cur.fetchone()
                    phone = (row[0] if row and not isinstance(row, dict) else (
                        row.get("telefone") if isinstance(row, dict) else ""
                    )) or ""
            except psycopg2.Error:
                phone = ""
        if not phone:
            return {"success": False, "error": "telefone do cliente não resolvido"}
        return upsert_customer(phone, nome)

    def registrar_preferencia(chave: str, valor: Any) -> dict:
        """Salva preferência (ex.: 'forma_pagamento_padrao', 'lista_compras_recorrente')."""
        return set_preference(lead_id, chave, valor)

    def registrar_evento(tipo: str, payload: dict | None = None, idempotency_key: str | None = None) -> dict:
        """Registra evento no histórico do lead (tipos: recebeu_oferta, perguntou_preco, etc)."""
        return register_event(lead_id, tipo, payload or {}, conversa_id, idempotency_key)

    return [detalhes_cliente, atualizar_cliente, registrar_preferencia, registrar_evento]
