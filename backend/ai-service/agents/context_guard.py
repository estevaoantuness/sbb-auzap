"""
Camada de guardrails de pré e pós-processamento — Maria v2 (Super Bem Barato).

Versão enxuta (petshop-specific foi removido). Mantém:
  - apply_guardrails (pré): transição entre agentes, trim de contexto
  - check_post_guardrails (pós): detecta "vou verificar"/"retorno em breve" fora de
    escalation (reprocessa); detecta vazamento de tool JSON
  - _sanitize_specialist_reply: remove tool JSON blobs e ruído vaza do modelo
  - parse_tool_result_dict: utility pra extrair dict de tool_result
  - trim_specialist_input: enxuga prompt quando contexto explode
"""

from __future__ import annotations

import ast
import json
import logging
import re

logger = logging.getLogger("ai-service.context_guard")


# ═══════════════════════════════════════════════════════════════════════════
# Padrões que NÃO podem aparecer na resposta ao cliente fora de escalation
# ═══════════════════════════════════════════════════════════════════════════

_VERIFICAR_FAMILY = re.compile(
    r"(?is)\b(?:"
    r"vou\s+verificar|"
    r"deixa(?:\s+eu)?\s+verificar|"
    r"estou\s+verificando|"
    r"vou\s+ver\s+isso|"
    r"deixa\s+eu\s+ver\s+isso"
    r")\b"
)
_RETORNO_BREVE = re.compile(r"(?is)\b(?:te\s+)?retorno\s+em\s+breve\b")
_ALINHAR_EQUIPE = re.compile(r"(?is)\b(?:vou|vamos)\s+alinhar\s+com\s+(?:a\s+)?equipe\b")
_JA_PASSEI_EQUIPE = re.compile(
    r"(?is)\bjá\s+(?:passei|encaminhei)\s+(?:para\s+|pra\s+)?(?:a\s+)?equipe\b"
)

_VERIFICAR_REPROCESS_MAX = 3

_REPROCESS_VERIFICAR_SUFFIX = """
━━━ REPROCESSAMENTO OBRIGATÓRIO (sistema) ━━━
A resposta anterior foi rejeitada: usou frase(s) do tipo "vou verificar" / "retorno em breve"
fora do fluxo de escalonamento humano.
Gere UMA nova resposta ao cliente, em português, curta (WhatsApp):
• PROIBIDO: "vou verificar", "deixa eu verificar", "estou verificando", "retorno em breve",
  "só um instante", "aguarde", "vou alinhar com a equipe", sem ter chamado escalate_to_human.
• Se precisa de dados (preço, estoque), chame a tool `buscar_produto` AGORA e responda com o resultado.
• Seja direto: informação ou pergunta final, sem narrar processo.
"""


# ═══════════════════════════════════════════════════════════════════════════
# Sanitização de vazamento de tool JSON na resposta
# ═══════════════════════════════════════════════════════════════════════════

_TOOL_JSON_SIGNATURE_KEYS = frozenset({
    "lead_id", "conversa_id", "pedido_id", "sku", "item_id", "telefone",
    "target_date", "company_id", "client_id", "action", "tool", "arguments",
})


def _strip_leading_tool_json_blob(text: str) -> str:
    """Remove objeto JSON inicial que parece payload de tool (não mensagem ao usuário)."""
    s = text.lstrip()
    if not s.startswith("{"):
        return text
    depth = 0
    for i, c in enumerate(s):
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                blob = s[: i + 1]
                try:
                    obj = json.loads(blob)
                    if isinstance(obj, dict) and set(obj.keys()) & _TOOL_JSON_SIGNATURE_KEYS:
                        rest = s[i + 1 :].lstrip()
                        logger.warning(
                            "Sanitize reply | removido JSON de tool | keys=%s",
                            list(obj.keys())[:10],
                        )
                        return rest
                except json.JSONDecodeError:
                    pass
                return text
    return text


def _sanitize_specialist_reply(reply: str) -> str:
    """Remove JSON de tools, vazamentos de Responses API, e ruído estilo CJK spam."""
    if not (reply or "").strip():
        return reply
    out = reply.strip()
    for _ in range(4):
        nxt = _strip_leading_tool_json_blob(out)
        if nxt == out:
            break
        out = nxt
    # Vazamentos tipo `to=functions.xyz`
    out = re.sub(r"(?im)^\s*to=functions\.[a-z_0-9]+\s*$", "", out)
    out = re.sub(r"(?im)^\s*to=functions\.[a-z_0-9]+\s*\n", "", out)
    # Ruído CJK (chinês/tailandês) solto entre tokens — degeneração com contexto longo
    out = re.sub(r"[\u4e00-\u9fff\u0e00-\u0e7f]{4,}", " ", out)
    out = re.sub(r"[ \t]{2,}", " ", out)
    out = re.sub(r"\n{3,}", "\n\n", out).strip()
    return out


# ═══════════════════════════════════════════════════════════════════════════
# Pré-processamento
# ═══════════════════════════════════════════════════════════════════════════

async def apply_guardrails(
    specialist_input: str,
    context: dict,
    router_ctx: dict,
    history: list,
    previous_agent: str | None = None,
    current_user_message: str = "",
) -> str:
    """
    Chamado antes de specialist.run(). Adiciona blocos instrutivos quando
    detecta contextos ambíguos (transição entre agentes).
    """
    agent = router_ctx.get("agent", "")

    if previous_agent and previous_agent != agent:
        specialist_input = _guardrail_agent_transition(
            specialist_input, router_ctx, previous_agent, history
        )

    return specialist_input


def _guardrail_agent_transition(
    specialist_input: str,
    router_ctx: dict,
    previous_agent: str,
    history: list,
) -> str:
    """Informa ao novo agente que houve transição — pra não repetir perguntas já feitas."""
    current = router_ctx.get("agent", "")
    last_user_msg = ""
    last_assistant_msg = ""
    for msg in reversed(history):
        role = msg.get("role", "")
        content = (msg.get("content") or "").strip()
        if role == "user" and not last_user_msg:
            last_user_msg = content[:200]
        elif role == "assistant" and not last_assistant_msg:
            last_assistant_msg = content[:200]
        if last_user_msg and last_assistant_msg:
            break

    block = [
        "\n\n━━━ TRANSIÇÃO DE AGENTE ━━━",
        f"Turno anterior era do **{previous_agent}**; agora você é **{current}**.",
        f"Última msg do cliente: {last_user_msg or '(não registrada)'}",
        f"Última resposta do assistente: {last_assistant_msg or '(não registrada)'}",
        "Não reinicie do zero. Continue o fluxo reconhecendo o que já foi dito.",
    ]
    return specialist_input + "\n".join(block)


def trim_specialist_input(specialist_input: str, max_chars: int = 12000) -> str:
    """Enxuga prompt quando contexto acumula em conversa longa."""
    if len(specialist_input) <= max_chars:
        return specialist_input
    # Mantém começo (system) e fim (mais recente); corta meio
    head = specialist_input[: max_chars // 3]
    tail = specialist_input[-(max_chars // 2) :]
    logger.info(
        "trim_specialist_input | original=%d chars -> trimmed=%d chars",
        len(specialist_input),
        len(head) + len(tail) + 50,
    )
    return (
        head
        + "\n\n━━━ TRECHO DE CONTEXTO OMITIDO (histórico antigo) ━━━\n\n"
        + tail
    )


# ═══════════════════════════════════════════════════════════════════════════
# Pós-processamento
# ═══════════════════════════════════════════════════════════════════════════

def _reply_triggers_verificar_reprocess(reply: str) -> bool:
    if not (reply or "").strip():
        return False
    if _VERIFICAR_FAMILY.search(reply):
        return True
    if _RETORNO_BREVE.search(reply):
        return True
    if _ALINHAR_EQUIPE.search(reply):
        return True
    if _JA_PASSEI_EQUIPE.search(reply):
        return True
    return False


def check_post_guardrails(
    reply: str,
    router_ctx: dict,
    *,
    reprocess_count: int = 0,
) -> dict:
    """
    Checa resposta final depois do specialist.
    Retorna dict com:
      - reply_sanitized: resposta após sanitize
      - needs_reprocess: bool — true se precisa chamar specialist de novo com suffix
      - reprocess_suffix: texto pra anexar ao próximo specialist_input
      - fired_guardrails: lista de nomes de guardrails acionados (pra log/agent.runs)
    """
    fired = []
    sanitized = _sanitize_specialist_reply(reply)
    if sanitized != reply:
        fired.append("tool_json_leak")

    agent = router_ctx.get("agent", "")
    is_escalation = agent == "escalation_agent"

    if not is_escalation and _reply_triggers_verificar_reprocess(sanitized):
        fired.append("verificar_reprocess")
        if reprocess_count < _VERIFICAR_REPROCESS_MAX:
            return {
                "reply_sanitized": sanitized,
                "needs_reprocess": True,
                "reprocess_suffix": _REPROCESS_VERIFICAR_SUFFIX,
                "fired_guardrails": fired,
            }
        # Após 3 tentativas, aceita mas registra
        logger.warning(
            "check_post_guardrails | verificar_family após %d reprocess — aceitando mesmo assim",
            reprocess_count,
        )

    return {
        "reply_sanitized": sanitized,
        "needs_reprocess": False,
        "reprocess_suffix": "",
        "fired_guardrails": fired,
    }


# ═══════════════════════════════════════════════════════════════════════════
# Utilities
# ═══════════════════════════════════════════════════════════════════════════

def parse_tool_result_dict(raw: str | dict) -> dict | None:
    """Tenta extrair dict de um tool_result que pode vir como dict, JSON, ou repr Python."""
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str):
        return None
    s = raw.strip()
    if not s:
        return None
    # JSON primeiro
    try:
        obj = json.loads(s)
        if isinstance(obj, dict):
            return obj
    except json.JSONDecodeError:
        pass
    # Python literal
    try:
        obj = ast.literal_eval(s)
        if isinstance(obj, dict):
            return obj
    except (ValueError, SyntaxError):
        pass
    return None
