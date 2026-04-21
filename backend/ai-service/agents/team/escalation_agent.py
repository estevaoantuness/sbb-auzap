from __future__ import annotations

from agno.agent import Agent

from config import OPENAI_MODEL, resolve_model
from prompts.shared_blocks import append_global_agent_max_rules
from prompts.specialists.escalation import build_escalation_prompt
from tools.escalation_tools import build_escalation_tools
from utils.openai_chat import openai_chat_for_agents


def build_escalation_agent(context: dict, router_ctx: dict) -> Agent:
    lead_id = int(context.get("lead_id") or 0)
    conversa_id = int((router_ctx or {}).get("conversa_id") or context.get("conversa_id") or 0)

    return Agent(
        name="Escalation Agent",
        model=openai_chat_for_agents(resolve_model(OPENAI_MODEL, context)),
        instructions=append_global_agent_max_rules(
            build_escalation_prompt(context, router_ctx)
        ),
        tools=build_escalation_tools(lead_id, conversa_id),
        tool_call_limit=2,
    )
