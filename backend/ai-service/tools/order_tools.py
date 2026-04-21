"""
Tools de pedido — chamam RPCs `crm.criar_pedido`, `crm.adicionar_item_pedido`,
`crm.remover_item_pedido`. Também expõem confirm/summary via SQL direto.

Todas as funções são síncronas (Agno chama tools em thread sync).
"""

from __future__ import annotations

import logging
from typing import Any

import psycopg2

from db import get_connection

logger = logging.getLogger("ai-service.tools.order")


def create_order(
    lead_id: int,
    conversa_id: int,
    endereco: str | None = None,
    bairro: str | None = None,
    tipo_entrega: str = "delivery",
) -> dict:
    """Cria pedido em status draft. Retorna {pedido_id} ou {error}."""
    if not lead_id or not conversa_id:
        return {"success": False, "error": "lead_id e conversa_id são obrigatórios"}
    try:
        with get_connection() as conn:
            cur = conn.cursor()
            cur.execute(
                "SELECT crm.criar_pedido(%s, %s, %s, %s, %s)",
                (lead_id, conversa_id, endereco, bairro, tipo_entrega),
            )
            row = cur.fetchone()
            pedido_id = row[0] if row and not isinstance(row, dict) else (
                row.get("criar_pedido") if isinstance(row, dict) else None
            )
    except psycopg2.Error as exc:
        logger.exception("create_order falhou (%s)", exc)
        return {"success": False, "error": str(exc)}
    return {"success": True, "pedido_id": int(pedido_id)} if pedido_id else {
        "success": False,
        "error": "RPC não retornou pedido_id",
    }


def add_item(
    pedido_id: int,
    sku: str,
    nome_produto: str,
    categoria: str | None,
    quantidade: float,
    unidade: str,
    preco_unitario: float,
) -> dict:
    """Adiciona item ao pedido via RPC `crm.adicionar_item_pedido`."""
    if not pedido_id or not sku:
        return {"success": False, "error": "pedido_id e sku são obrigatórios"}
    try:
        with get_connection() as conn:
            cur = conn.cursor()
            cur.execute(
                """
                SELECT crm.adicionar_item_pedido(%s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    pedido_id,
                    sku,
                    nome_produto,
                    categoria,
                    float(quantidade),
                    unidade,
                    float(preco_unitario),
                ),
            )
            row = cur.fetchone()
            item_id = row[0] if row and not isinstance(row, dict) else (
                row.get("adicionar_item_pedido") if isinstance(row, dict) else None
            )
    except psycopg2.Error as exc:
        logger.exception("add_item falhou (%s)", exc)
        return {"success": False, "error": str(exc)}
    return {
        "success": True,
        "item_id": int(item_id) if item_id else None,
        "pedido_id": pedido_id,
    }


def remove_item(pedido_id: int, sku: str) -> dict:
    if not pedido_id or not sku:
        return {"success": False, "error": "pedido_id e sku são obrigatórios"}
    try:
        with get_connection() as conn:
            cur = conn.cursor()
            cur.execute("SELECT crm.remover_item_pedido(%s, %s)", (pedido_id, sku))
    except psycopg2.Error as exc:
        logger.exception("remove_item falhou (%s)", exc)
        return {"success": False, "error": str(exc)}
    return {"success": True, "pedido_id": pedido_id, "removed_sku": sku}


def confirm_order(pedido_id: int) -> dict:
    """Move status para `confirmado`. Fluxo bloqueia IA via status + encaminha time humano."""
    if not pedido_id:
        return {"success": False, "error": "pedido_id é obrigatório"}
    try:
        with get_connection() as conn:
            cur = conn.cursor()
            cur.execute(
                """
                UPDATE crm.pedidos
                SET status = 'confirmado', confirmado_at = NOW()
                WHERE id = %s
                RETURNING id, status, total
                """,
                (pedido_id,),
            )
            updated = cur.fetchone()
    except psycopg2.Error as exc:
        logger.exception("confirm_order falhou (%s)", exc)
        return {"success": False, "error": str(exc)}
    if not updated:
        return {"success": False, "error": "pedido não encontrado"}
    return {
        "success": True,
        "pedido_id": int(updated["id"]) if isinstance(updated, dict) else pedido_id,
        "status": updated["status"] if isinstance(updated, dict) else "confirmado",
        "total": float(updated["total"]) if isinstance(updated, dict) and updated.get("total") else None,
    }


def get_order_summary(pedido_id: int) -> dict:
    if not pedido_id:
        return {"success": False, "error": "pedido_id é obrigatório"}
    try:
        with get_connection() as conn:
            cur = conn.cursor()
            cur.execute(
                """
                SELECT id, status, total, tipo_entrega, endereco, bairro, created_at,
                       confirmado_at
                FROM crm.pedidos WHERE id = %s
                """,
                (pedido_id,),
            )
            pedido = cur.fetchone()
            if not pedido:
                return {"success": False, "error": "pedido não encontrado"}
            cur.execute(
                """
                SELECT id, sku, nome_produto, categoria, quantidade, unidade, preco_unitario,
                       subtotal
                FROM crm.pedido_itens
                WHERE pedido_id = %s
                ORDER BY id ASC
                """,
                (pedido_id,),
            )
            items = [dict(r) for r in cur.fetchall()]
    except psycopg2.Error as exc:
        logger.exception("get_order_summary falhou (%s)", exc)
        return {"success": False, "error": str(exc)}
    return {
        "success": True,
        "pedido": dict(pedido),
        "items": items,
        "item_count": len(items),
    }


def build_order_tools(lead_id: int, conversa_id: int) -> list:
    """Tools Agno com IDs de tenant via closure."""

    def criar_pedido(
        endereco: str | None = None,
        bairro: str | None = None,
        tipo_entrega: str = "delivery",
    ) -> dict:
        """
        Abre um pedido novo (status draft) pro cliente. Use apenas UMA vez por fluxo de pedido —
        depois adicione itens com `adicionar_item`.
        """
        return create_order(lead_id, conversa_id, endereco, bairro, tipo_entrega)

    def adicionar_item(
        pedido_id: int,
        sku: str,
        nome_produto: str,
        categoria: str | None,
        quantidade: float,
        unidade: str,
        preco_unitario: float,
    ) -> dict:
        """
        Adiciona um item ao pedido. Use APÓS `buscar_produto` — SKU e preço_unitario vêm do
        retorno da busca. Quantidade em unidade compatível (kg, un, L).
        """
        return add_item(
            pedido_id, sku, nome_produto, categoria, quantidade, unidade, preco_unitario
        )

    def remover_item(pedido_id: int, sku: str) -> dict:
        """Remove um item do pedido por SKU."""
        return remove_item(pedido_id, sku)

    def confirmar_pedido(pedido_id: int) -> dict:
        """
        Marca o pedido como confirmado. Só chame após o cliente revisar e confirmar a lista.
        Encaminhe ao humano via `escalate_to_human` em seguida.
        """
        return confirm_order(pedido_id)

    def resumo_pedido(pedido_id: int) -> dict:
        """Retorna pedido + itens atuais — útil pra mostrar ao cliente antes do confirm."""
        return get_order_summary(pedido_id)

    return [criar_pedido, adicionar_item, remover_item, confirmar_pedido, resumo_pedido]
