"""
Tools de escalonamento humano — pausa IA na conversa e dispara webhook Telegram.

Substitui a implementação legada (AuZap petshop). Alvo: `crm.conversas` + `crm.eventos_lead`
+ RPC `crm.pausar_ia`. Notificação: bot Telegram configurado via env
(`TELEGRAM_ALERT_BOT_TOKEN`, `TELEGRAM_ALERT_CHAT_ID`).
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

import psycopg2
import urllib.request
import urllib.parse

from db import get_connection
from tools.customer_tools import register_event

logger = logging.getLogger("ai-service.tools.escalation")


def _notify_telegram(text: str) -> None:
    token = os.getenv("TELEGRAM_ALERT_BOT_TOKEN", "").strip()
    chat_id = os.getenv("TELEGRAM_ALERT_CHAT_ID", "").strip()
    if not token or not chat_id:
        return
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = urllib.parse.urlencode(
        {
            "chat_id": chat_id,
            "text": text[:3500],
            "parse_mode": "HTML",
            "disable_web_page_preview": "true",
        }
    ).encode("utf-8")
    req = urllib.request.Request(url, data=payload)
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            if resp.status >= 400:
                logger.warning("telegram alert: status=%s", resp.status)
    except Exception as exc:  # noqa: BLE001 — best-effort
        logger.warning("telegram alert falhou: %s", exc)


def _pause_ia(conversa_id: int, motivo: str) -> bool:
    """Tenta RPC `crm.pausar_ia`; fallback: UPDATE direto."""
    try:
        with get_connection() as conn:
            cur = conn.cursor()
            try:
                cur.execute("SELECT crm.pausar_ia(%s, %s)", (conversa_id, motivo))
                return True
            except psycopg2.Error:
                conn.rollback()
                cur.execute(
                    """
                    UPDATE crm.conversas
                    SET ia_pausada = TRUE,
                        ia_pausada_at = NOW(),
                        ia_pausa_motivo = %s
                    WHERE id = %s
                    """,
                    (motivo, conversa_id),
                )
                return True
    except psycopg2.Error as exc:
        logger.exception("pausar_ia falhou (%s)", exc)
        return False


def escalate_to_human(
    conversa_id: int,
    reason: str,
    lead_id: int | None = None,
    summary: str | None = None,
    last_message: str | None = None,
) -> dict:
    """
    Pausa IA na conversa, registra evento `escalou_operador` e dispara alerta Telegram.
    Idempotente via `idempotency_key = f"escalate:{conversa_id}"`.
    """
    motivo = (reason or "").strip() or "escalation sem motivo"
    if not conversa_id:
        return {"success": False, "error": "conversa_id obrigatório"}

    paused = _pause_ia(conversa_id, motivo)

    payload = {
        "motivo": motivo,
        "summary": (summary or "").strip() or None,
        "last_message": (last_message or "").strip() or None,
    }
    event_result = {"success": True, "deduped": False}
    if lead_id:
        event_result = register_event(
            lead_id=lead_id,
            tipo="escalou_operador",
            payload=payload,
            conversa_id=conversa_id,
            idempotency_key=f"escalate:{conversa_id}",
        )

    header = "<b>Escalonamento IA</b>"
    lines = [
        header,
        f"conversa_id: <code>{conversa_id}</code>",
    ]
    if lead_id:
        lines.append(f"lead_id: <code>{lead_id}</code>")
    lines.append(f"motivo: {motivo}")
    if summary:
        lines.append(f"resumo: {summary}")
    if last_message:
        lines.append(f"última msg: {last_message[:400]}")
    _notify_telegram("\n".join(lines))

    return {
        "success": paused,
        "paused": paused,
        "event": event_result,
    }


def build_escalation_tools(lead_id: int, conversa_id: int) -> list:
    """Tools Agno com IDs via closure."""

    def escalar_humano(
        motivo: str,
        resumo: str | None = None,
        ultima_mensagem: str | None = None,
    ) -> dict:
        """
        Encaminha o atendimento para um humano. Use quando: cliente pede atendente; assunto
        fora do escopo (negociação, reclamação complexa); pedido confirmado a ser separado;
        dúvida de entrega/taxa/área.
        Sempre inclua `resumo` (1–3 frases objetivas) e `ultima_mensagem` (cópia da última fala
        do cliente).
        """
        if not (motivo or "").strip():
            return {"success": False, "error": "motivo obrigatório"}
        return escalate_to_human(
            conversa_id=conversa_id,
            reason=motivo,
            lead_id=lead_id,
            summary=resumo,
            last_message=ultima_mensagem,
        )

    return [escalar_humano]
