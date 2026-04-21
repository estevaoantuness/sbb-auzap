"""
Resumo rolante: mensagens além das últimas MAX_HISTORY_MESSAGES viram texto estruturado.
Backend: `agent.conversa_sumarios` (Postgres) — troca do Redis legado.

Atualização em blocos de 6 mensagens (HISTORY_SUMMARY_CHUNK), modelo gpt-4o-mini (configurável).
"""

from __future__ import annotations

import logging
import os

from openai import AsyncOpenAI

from memory.postgres_memory import (
    MAX_HISTORY_MESSAGES,
    delete_summary_state,
    get_summary_state,
    history_length,
    history_slice,
    set_summary_state,
)

logger = logging.getLogger("ai-service.history_summary")

_SUMMARY_MODEL_DEFAULT = "gpt-4o-mini"
_MAX_MSG_CHARS = 3500


def _summary_enabled() -> bool:
    v = (os.getenv("HISTORY_SUMMARY_ENABLED") or "true").strip().lower()
    return v not in ("0", "false", "no", "off")


def _chunk_size() -> int:
    try:
        return max(1, int(os.getenv("HISTORY_SUMMARY_CHUNK", "6")))
    except ValueError:
        return 6


def _summary_model(company_id: int | None = None) -> str:
    from config import resolve_model_for_company
    base = (os.getenv("OPENAI_MODEL_SUMMARY") or _SUMMARY_MODEL_DEFAULT).strip()
    return resolve_model_for_company(base, company_id)


def _format_messages_block(messages: list[dict]) -> str:
    lines: list[str] = []
    for m in messages:
        role = m.get("role") or "user"
        raw = (m.get("content") or "").strip()
        if len(raw) > _MAX_MSG_CHARS:
            raw = raw[:_MAX_MSG_CHARS] + " […]"
        label = "Cliente" if role == "user" else "Maria"
        lines.append(f"{label}: {raw}")
    return "\n".join(lines)


_STRUCTURE_INSTRUCTIONS = """Use SEMPRE este esqueleto (omita linhas cuja informação não exista):

**Cliente / tom:**
**Itens mencionados / produtos consultados:**
**Pedido em andamento:** (modalidade, endereço, itens confirmados, itens pendentes)
**Forma de pagamento / observações:**
**Estado do fluxo:** (ex.: coletando lista, aguardando confirmação, pedido encaminhado ao humano)
**Observações:**

Regras: frases curtas; português do Brasil; fatos só das mensagens; sem inventar preços ou prazos.
Se houver lista enorme de produtos/preços, resuma em uma linha (ex.: «cliente consultou catálogo de bebidas»)
sem copiar tabela.
"""


async def _llm_merge_summary(
    previous: str, messages: list[dict], company_id: int | None = None
) -> str:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        logger.warning("history_summary | OPENAI_API_KEY ausente — pulando merge")
        return previous

    block = _format_messages_block(messages)
    if not block.strip():
        return previous

    client = AsyncOpenAI(api_key=api_key)
    model = _summary_model(company_id)
    sys_prompt = (
        "Você atualiza o resumo estruturado de um atendimento WhatsApp de supermercado. "
        "Mescle o resumo anterior com as novas mensagens num único texto coerente. "
        + _STRUCTURE_INSTRUCTIONS
    )
    user_prompt = (
        f"RESUMO ANTERIOR:\n{previous.strip() or '(nenhum)'}\n\n"
        f"NOVAS MENSAGENS ({len(messages)} trocas):\n{block}\n\n"
        "Resumo estruturado unificado:"
    )
    try:
        resp = await client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": sys_prompt},
                {"role": "user", "content": user_prompt},
            ],
            max_completion_tokens=700,
            temperature=0.15,
        )
        out = (resp.choices[0].message.content or "").strip()
        return out if out else previous
    except Exception:
        logger.exception("history_summary | falha ao chamar modelo %s", model)
        return previous


async def ensure_rolling_summary(company_id: int, client_phone: str) -> None:
    if not _summary_enabled():
        return

    total = await history_length(company_id, client_phone)
    if total <= MAX_HISTORY_MESSAGES:
        await delete_summary_state(company_id, client_phone)
        return

    start_recent = total - MAX_HISTORY_MESSAGES
    state = await get_summary_state(company_id, client_phone)
    text = (state or {}).get("text") or ""
    covered = int((state or {}).get("covered") or 0)

    if covered > start_recent:
        text, covered = "", 0
        await set_summary_state(company_id, client_phone, text, covered)

    chunk = _chunk_size()
    while covered < start_recent:
        chunk_end = min(covered + chunk, start_recent)
        msgs = await history_slice(company_id, client_phone, covered, chunk_end)
        if not msgs:
            break
        text = await _llm_merge_summary(text, msgs, company_id)
        covered = chunk_end
        await set_summary_state(company_id, client_phone, text, covered)
        logger.info(
            "history_summary | company=%s phone=%s covered=%s/%s model=%s chars=%s",
            company_id,
            client_phone,
            covered,
            start_recent,
            _summary_model(company_id),
            len(text),
        )


async def summary_prefix_for_prompt(company_id: int, client_phone: str) -> str | None:
    if not _summary_enabled():
        return None
    state = await get_summary_state(company_id, client_phone)
    t = (state or {}).get("text") if state else None
    if not t or not str(t).strip():
        return None
    return str(t).strip()
