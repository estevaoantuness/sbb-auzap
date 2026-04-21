"""
Modelo Agno para agentes: OpenAIChat (chat/completions) ou OpenAIResponses (responses).

gpt-5* + reasoning_effort + function tools não são suportados em /v1/chat/completions
(ex.: gpt-5.4-nano) — nesse caso usamos OpenAIResponses (/v1/responses).

Valores típicos de esforço: none, minimal, low, medium, high, xhigh (depende do modelo).
Configuração: OPENAI_REASONING_EFFORT e OPENAI_REASONING_EFFORT_ADVANCED em config / .env.
"""

from __future__ import annotations

from typing import Any, Optional

from agno.models.base import Model
from agno.models.openai import OpenAIChat, OpenAIResponses

from config import OPENAI_REASONING_EFFORT, OPENAI_REASONING_EFFORT_ADVANCED


def is_openai_gpt5_family(model_id: str) -> bool:
    return (model_id or "").strip().lower().startswith("gpt-5")


def _resolved_reasoning_effort(*, advanced: bool) -> str:
    if advanced:
        if OPENAI_REASONING_EFFORT_ADVANCED:
            return OPENAI_REASONING_EFFORT_ADVANCED
        if OPENAI_REASONING_EFFORT:
            return OPENAI_REASONING_EFFORT
        return "medium"
    if OPENAI_REASONING_EFFORT:
        return OPENAI_REASONING_EFFORT
    return "low"


def _openai_model_gpt5_with_reasoning(
    model_id: str, effort: str, **kwargs: Any
) -> OpenAIResponses:
    """Responses API: necessário para reasoning + tools em modelos como gpt-5.4-nano."""
    return OpenAIResponses(id=model_id, reasoning_effort=effort, **kwargs)


def openai_chat_for_agents(
    model_id: str,
    *,
    advanced: bool = False,
    reasoning_effort: Optional[str] = None,
    **kwargs: Any,
) -> Model:
    """
    Instancia o modelo Agno adequado. Para gpt-5* com reasoning_effort usa OpenAIResponses;
    caso contrário OpenAIChat (chat/completions).
    """
    mid = (model_id or "").strip()
    if not mid:
        return OpenAIChat(**kwargs)

    if reasoning_effort is not None:
        eff = (reasoning_effort or "").strip()
        if eff and is_openai_gpt5_family(mid):
            return _openai_model_gpt5_with_reasoning(mid, eff, **kwargs)
        return OpenAIChat(id=mid, **kwargs)

    if is_openai_gpt5_family(mid):
        return _openai_model_gpt5_with_reasoning(
            mid,
            _resolved_reasoning_effort(advanced=advanced),
            **kwargs,
        )
    return OpenAIChat(id=mid, **kwargs)
