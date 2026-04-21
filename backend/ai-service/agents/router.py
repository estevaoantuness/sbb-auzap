"""
Router (Maria v2) — classifica intenção e invoca um dos especialistas do Super Bem Barato.

Categorias: order | product_search | faq | sales | escalation | onboarding.

Removido: booking/lodging/health (agenda petshop). O fluxo agora é: saudação → consulta/pedido
→ pedido confirmado → humano.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Optional

from agno.agent import Agent

from agents.router_tool_plan import (
    build_router_tools_instruction_block,
    format_required_tools_for_log,
    normalize_required_tools,
)
from config import OPENAI_MODEL_ROUTER, resolve_model
from prompts.shared_blocks import append_global_agent_max_rules
from utils.openai_chat import openai_chat_for_agents

from agents.team.escalation_agent import build_escalation_agent
from agents.team.faq_agent import build_faq_agent
from agents.team.onboarding_agent import build_onboarding_agent
from agents.team.order_agent import build_order_agent
from agents.team.product_search_agent import build_product_search_agent
from agents.team.sales_agent import build_sales_agent
from agents.context_guard import (
    apply_guardrails,
    check_post_guardrails,
    trim_specialist_input,
)

logger = logging.getLogger("ai-service.router")
ROUTER_HISTORY_MESSAGES = 10

VALID_AGENTS = {
    "order_agent",
    "product_search_agent",
    "faq_agent",
    "sales_agent",
    "escalation_agent",
    "onboarding_agent",
}

VALID_STAGES = {
    "WELCOME",
    "SEARCH",
    "ORDER_COLLECTION",
    "ORDER_CONFIRMATION",
    "FAQ",
    "ESCALATION",
    "COMPLETED",
}

DEFAULT_ROUTER_CTX = {
    "agent": "onboarding_agent",
    "stage": "WELCOME",
    "intent": None,
    "pedido_id": None,
    "required_tools": ["none"],
}

DEFAULT_REQUIRED_TOOLS_BY_AGENT_STAGE: dict[tuple[str, str], list[str]] = {
    ("onboarding_agent", "WELCOME"): ["none"],
    ("onboarding_agent", "COMPLETED"): ["none"],
    ("product_search_agent", "SEARCH"): ["products"],
    ("product_search_agent", "FAQ"): ["none"],
    ("order_agent", "ORDER_COLLECTION"): ["products", "orders"],
    ("order_agent", "ORDER_CONFIRMATION"): ["orders"],
    ("order_agent", "COMPLETED"): ["none"],
    ("sales_agent", "SEARCH"): ["products"],
    ("faq_agent", "FAQ"): ["none"],
    ("faq_agent", "WELCOME"): ["none"],
    ("escalation_agent", "ESCALATION"): ["none"],
}


def _default_required_tools(agent: str, stage: str) -> list[str]:
    return DEFAULT_REQUIRED_TOOLS_BY_AGENT_STAGE.get((agent, stage), ["none"])


ROUTER_PROMPT_TEMPLATE = """Você é um classificador de intenções para a Maria, atendente do Super Bem Barato (supermercado no WhatsApp).
Analise o HISTÓRICO + mensagem atual e retorne SOMENTE JSON válido com este schema:

{{
  "agent": "order_agent" | "product_search_agent" | "faq_agent" | "sales_agent" | "escalation_agent" | "onboarding_agent",
  "stage": "WELCOME" | "SEARCH" | "ORDER_COLLECTION" | "ORDER_CONFIRMATION" | "FAQ" | "ESCALATION" | "COMPLETED",
  "intent": "string curta descrevendo o que o cliente quer agora (ou null)",
  "pedido_id": null ou id do pedido em andamento (int),
  "required_tools": ["products" | "orders" | "customer" | "none"]
}}

━━━ CATEGORIAS ━━━
• `order_agent`: cliente quer FAZER um pedido/lista (citou itens + intenção de comprar, pediu "quero pedir", "anota aí", "lista", confirmou lista em andamento).
• `product_search_agent`: cliente pergunta preço, disponibilidade, marca, promoção — SEM ter iniciado lista de compras.
• `faq_agent`: horário, endereço, telefone, formas de pagamento, como pedir, link do tabloide.
• `sales_agent`: cliente demonstra interesse em oferta/desconto/combo — pode migrar para order_agent depois.
• `escalation_agent`: pedido explícito de humano; taxa/área/prazo de entrega; reclamação complexa; fora do escopo.
• `onboarding_agent`: APENAS primeira mensagem / saudação isolada sem demanda clara.

━━━ REGRAS ━━━
• Uma vez que o cliente começa a montar pedido, MANTENHA `order_agent` nos próximos turnos até confirmação ou cancelamento.
• Se houver `pedido_id` em aberto no estado anterior, siga `order_agent` salvo mudança explícita.
• Cliente pede atendente / humano / pessoa → `escalation_agent`.
• Pergunta sobre taxa/área/prazo de entrega → `escalation_agent`.
• "Oi" / "bom dia" SEM demanda → `onboarding_agent` (stage=WELCOME).
• "Obrigado" isolado após atendimento concluído → stage=COMPLETED (mantém último agent).

━━━ required_tools ━━━
• `products`: vai chamar `buscar_produto` neste turno.
• `orders`: vai chamar `criar_pedido` / `adicionar_item` / `remover_item` / `confirmar_pedido`.
• `customer`: vai consultar / atualizar dados do cliente.
• `none`: turno só de conversa (sem tools de dados).

━━━ CONTEXTO DO CLIENTE ━━━
{client_ctx}

━━━ ESTADO ANTERIOR DO ROTEADOR ━━━
{prev_state}

━━━ HISTÓRICO (últimas mensagens) ━━━
{history}

━━━ MENSAGEM ATUAL ━━━
{message}

Retorne APENAS o JSON (sem cercas markdown, sem texto antes/depois).
"""


def _fmt_client_ctx(context: dict) -> str:
    parts = []
    name = (context.get("customer_name") or "").strip()
    if name:
        parts.append(f"nome={name}")
    if context.get("segmento"):
        parts.append(f"segmento={context['segmento']}")
    if context.get("total_pedidos"):
        parts.append(f"total_pedidos={context['total_pedidos']}")
    if context.get("top_categorias"):
        parts.append(f"top_categorias={','.join(context['top_categorias'][:5])}")
    if context.get("bairro"):
        parts.append(f"bairro={context['bairro']}")
    if context.get("ai_paused"):
        parts.append("ia_pausada=true")
    return " | ".join(parts) if parts else "(novo contato)"


def _format_history(history: list) -> str:
    if not history:
        return "(sem histórico)"
    lines = []
    for msg in history:
        role = msg.get("role") or "user"
        if role == "system":
            lines.append(f"[resumo] {msg.get('content', '')[:300]}")
            continue
        label = "Cliente" if role == "user" else "Maria"
        lines.append(f"{label}: {msg.get('content', '')}")
    return "\n".join(lines)


def _format_prev_state(router_ctx: Optional[dict]) -> str:
    if not router_ctx:
        return "(primeiro turno)"
    parts = [
        f"agent={router_ctx.get('agent') or '?'}",
        f"stage={router_ctx.get('stage') or '?'}",
    ]
    for key in ("intent", "pedido_id"):
        v = router_ctx.get(key)
        if v:
            parts.append(f"{key}={v}")
    rt = router_ctx.get("required_tools")
    if rt:
        parts.append(f"required_tools={rt}")
    return " | ".join(parts)


def build_router_prompt(context: dict, history: list, prev_ctx: Optional[dict], message: str) -> str:
    return ROUTER_PROMPT_TEMPLATE.format(
        client_ctx=_fmt_client_ctx(context),
        prev_state=_format_prev_state(prev_ctx),
        history=_format_history(history),
        message=message,
    )


def _parse_router_response(content: str) -> dict:
    """Parseia JSON do router com fallback seguro."""
    if not content:
        return DEFAULT_ROUTER_CTX.copy()
    clean = content.strip()
    # Aceita cercas ```json ... ``` ou ``` ... ```
    clean = re.sub(r"^```(?:json)?\s*", "", clean)
    clean = re.sub(r"\s*```$", "", clean)
    try:
        parsed = json.loads(clean)
    except json.JSONDecodeError:
        logger.warning("Router retornou JSON inválido — default. content=%.300r", content)
        return DEFAULT_ROUTER_CTX.copy()

    if not isinstance(parsed, dict):
        return DEFAULT_ROUTER_CTX.copy()

    agent = parsed.get("agent")
    if agent not in VALID_AGENTS:
        logger.warning("Router retornou agente inválido=%r — caindo pra faq_agent", agent)
        agent = "faq_agent"

    stage = parsed.get("stage")
    if stage not in VALID_STAGES:
        stage = "FAQ" if agent == "faq_agent" else "WELCOME"

    rt = normalize_required_tools(parsed.get("required_tools"))
    if rt is None:
        rt = _default_required_tools(agent, stage)

    return {
        "agent": agent,
        "stage": stage,
        "intent": parsed.get("intent"),
        "pedido_id": parsed.get("pedido_id"),
        "required_tools": rt,
    }


def _build_specialist(agent_name: str, context: dict, router_ctx: dict) -> Agent:
    builders = {
        "order_agent": build_order_agent,
        "product_search_agent": build_product_search_agent,
        "faq_agent": build_faq_agent,
        "sales_agent": build_sales_agent,
        "escalation_agent": build_escalation_agent,
        "onboarding_agent": build_onboarding_agent,
    }
    builder = builders.get(agent_name, build_faq_agent)
    return builder(context, router_ctx)


def _build_specialist_input(message: str, history: list, router_ctx: dict) -> str:
    history_text = _format_history(history)
    ctx_summary = []
    if router_ctx.get("intent"):
        ctx_summary.append(f"intent={router_ctx['intent']}")
    if router_ctx.get("pedido_id"):
        ctx_summary.append(f"pedido_em_andamento={router_ctx['pedido_id']}")
    parts = [f"Histórico:\n{history_text}"]
    if ctx_summary:
        parts.append(f"Contexto do router: {' | '.join(ctx_summary)}")
    parts.append(f"Mensagem atual: {message}")
    return "\n\n".join(parts)


def _agent_configured_model_id(agent: Agent) -> str:
    model = getattr(agent, "model", None)
    mid = getattr(model, "id", None) if model is not None else None
    return str(mid) if mid else "unknown"


async def run_router(
    message: str,
    context: dict,
    history: list,
    previous_router_ctx: Optional[dict] = None,
) -> dict:
    """Classifica intenção e invoca especialista. Retorna reply + router_ctx pra persistir."""

    router_agent = Agent(
        name="Router",
        model=openai_chat_for_agents(resolve_model(OPENAI_MODEL_ROUTER, context)),
        instructions=append_global_agent_max_rules(
            "Você é um classificador de intenções. Retorne SOMENTE JSON válido conforme instruções."
        ),
    )

    router_history = history[-ROUTER_HISTORY_MESSAGES:] if history else []
    router_input = build_router_prompt(
        context=context,
        history=router_history,
        prev_ctx=previous_router_ctx,
        message=message,
    )

    router_response = router_agent.run(router_input)
    router_ctx = _parse_router_response(router_response.content)
    router_model = _agent_configured_model_id(router_agent)

    agent_name = router_ctx.get("agent", "faq_agent")
    logger.info(
        "Router decidiu → model=%s | agent=%s | stage=%s | intent=%s | pedido_id=%s | required_tools=%s",
        router_model,
        agent_name,
        router_ctx.get("stage"),
        router_ctx.get("intent"),
        router_ctx.get("pedido_id"),
        format_required_tools_for_log(router_ctx),
    )

    # Especialista
    specialist = _build_specialist(agent_name, context, router_ctx)
    specialist_input = _build_specialist_input(
        message, history, router_ctx
    ) + build_router_tools_instruction_block(router_ctx)

    # Pre-guardrails (transição entre agents + trim se contexto explode)
    previous_agent = (previous_router_ctx or {}).get("agent")
    specialist_input = await apply_guardrails(
        specialist_input,
        context=context,
        router_ctx=router_ctx,
        history=history,
        previous_agent=previous_agent,
        current_user_message=message,
    )
    specialist_input = trim_specialist_input(specialist_input)

    # Roda especialista com até 3 reprocessamentos se verificar/retorno-breve vazar
    fired_guardrails_all: list[str] = []
    reprocess_count = 0
    reply = ""
    specialist_model = _agent_configured_model_id(specialist)
    while reprocess_count <= 3:
        specialist_response = specialist.run(specialist_input)
        reply_raw = (specialist_response.content or "").strip()

        post = check_post_guardrails(
            reply_raw, router_ctx, reprocess_count=reprocess_count
        )
        fired_guardrails_all.extend(post["fired_guardrails"])

        if not post["needs_reprocess"]:
            reply = post["reply_sanitized"]
            break

        # Reprocess: anexa suffix instrutivo e tenta de novo
        reprocess_count += 1
        logger.warning(
            "Reprocess #%d | agent=%s | fired=%s",
            reprocess_count, agent_name, post["fired_guardrails"],
        )
        specialist_input = specialist_input + post["reprocess_suffix"]
        reply = post["reply_sanitized"]  # fallback se exceder max

    logger.info(
        "Especialista concluído → agent=%s | model=%s | guardrails=%s | reprocess=%d | reply=%.120r",
        agent_name,
        specialist_model,
        fired_guardrails_all,
        reprocess_count,
        reply,
    )

    return {
        "reply": reply,
        "agent_used": agent_name,
        "router_ctx": router_ctx,
        "guardrails_fired": fired_guardrails_all,
        "reprocess_count": reprocess_count,
        "llm_models": {
            "router": router_model,
            "specialist": specialist_model,
        },
    }
