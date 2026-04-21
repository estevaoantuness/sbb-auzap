from __future__ import annotations

from agno.agent import Agent

from agents.router_tool_plan import router_says_conversation_only
from config import OPENAI_MODEL_ADVANCED, resolve_model
from prompts.shared_blocks import append_global_agent_max_rules
from prompts.specialists.sales import build_sales_prompt
from tools.customer_tools import build_customer_tools
from tools.escalation_tools import build_escalation_tools
from tools.product_tools import build_product_tools
from utils.openai_chat import openai_chat_for_agents


def build_sales_agent(context: dict, router_ctx: dict) -> Agent:
    lead_id = int(context.get("lead_id") or 0)
    conversa_id = int((router_ctx or {}).get("conversa_id") or context.get("conversa_id") or 0)

    if router_says_conversation_only(router_ctx):
        tools: list = []
    else:
        tools = (
            build_product_tools()
            + build_customer_tools(lead_id, conversa_id)
            + build_escalation_tools(lead_id, conversa_id)
        )

    return Agent(
        name="Sales Agent",
        model=openai_chat_for_agents(
            resolve_model(OPENAI_MODEL_ADVANCED, context), advanced=True
        ),
        instructions=append_global_agent_max_rules(build_sales_prompt(context, router_ctx)),
        tools=tools,
        tool_call_limit=3,
    )
