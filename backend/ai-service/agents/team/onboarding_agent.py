from __future__ import annotations

from agno.agent import Agent

from agents.router_tool_plan import router_says_conversation_only
from config import OPENAI_MODEL, resolve_model
from prompts.shared.supermarket_shared import block_identity, shared_footer
from prompts.shared_blocks import append_global_agent_max_rules
from tools.customer_tools import build_customer_tools
from tools.escalation_tools import build_escalation_tools
from utils.openai_chat import openai_chat_for_agents


def _build_onboarding_prompt(context: dict, router_ctx: dict) -> str:
    assistant_name = context.get("assistant_name") or "Maria"
    company_name = (
        context.get("store_name") or context.get("company_name") or "Super Bem Barato"
    )
    client_name = context.get("customer_name")

    intro = """━━━ FUNÇÃO — onboarding ━━━
Primeira mensagem / saudação / abertura. Cliente chegou agora no WhatsApp.

FLUXO:
1. Cumprimente simples e aberto:
   "Oi! Sou a Maria, do Super Bem Barato. Como posso te ajudar?"
2. NUNCA ofereça menu ("você quer X, Y ou Z?") — apenas aguarde.
3. Se o cliente já sinalizou demanda (pedido, preço, dúvida) → o router encaminha ao
   especialista correto; não force fluxo de saudação.
4. Use `registrar_preferencia` pra salvar o nome do cliente se ele se apresentar.
5. Se o cliente pedir humano ou tema fora do escopo → use `escalar_humano`.

FORMATO:
• 1-2 linhas apenas.
• Sem emoji na abertura.
• Sem perguntar dados pessoais se o cliente só cumprimentou.
"""

    return (
        block_identity(assistant_name, company_name, client_name)
        + "\n\n"
        + intro
        + "\n"
        + shared_footer(context, include_store=False)
    )


def build_onboarding_agent(context: dict, router_ctx: dict) -> Agent:
    lead_id = int(context.get("lead_id") or 0)
    conversa_id = int((router_ctx or {}).get("conversa_id") or context.get("conversa_id") or 0)

    if router_says_conversation_only(router_ctx):
        tools: list = []
    else:
        tools = build_customer_tools(lead_id, conversa_id) + build_escalation_tools(
            lead_id, conversa_id
        )

    return Agent(
        name="Onboarding Agent",
        model=openai_chat_for_agents(resolve_model(OPENAI_MODEL, context)),
        instructions=append_global_agent_max_rules(
            _build_onboarding_prompt(context, router_ctx)
        ),
        tools=tools,
        tool_call_limit=2,
    )
