"""
Categorias de ferramentas/dados que o router declara para o turno atual.
None = compatibilidade (especialista mantém prompt completo).
Lista explícita = o modelo prioriza só o que foi indicado; `['none']` = turno só conversa.

Categorias SBB:
- products:  tool `buscar_produto`
- orders:    tools `criar_pedido` / `adicionar_item` / `remover_item` / `confirmar_pedido`
- customer:  tools de cliente (`detalhes_cliente`, `atualizar_cliente`, `registrar_preferencia`)
- none:      conversa curta sem tools de dados (saudação, encerramento)
"""

from __future__ import annotations

import logging

logger = logging.getLogger("ai-service.router_tool_plan")

VALID_CATEGORIES = frozenset({"none", "products", "orders", "customer"})


def normalize_required_tools(raw) -> list[str] | None:
    if raw is None:
        return None
    if not isinstance(raw, list):
        logger.warning("required_tools não é lista — ignorando: %r", raw)
        return None
    out: list[str] = []
    for x in raw:
        t = str(x).strip().lower()
        if not t:
            continue
        if t not in VALID_CATEGORIES:
            logger.warning("required_tools token desconhecido ignorado: %r", x)
            continue
        out.append(t)
    if not out:
        return ["none"]
    if "none" in out and len(out) > 1:
        out = [x for x in out if x != "none"]
    if not out:
        return ["none"]
    return out


def router_says_conversation_only(router_ctx: dict) -> bool:
    """Turno explícito sem tools de dados (saudação, agradecimento, etc.)."""
    rt = router_ctx.get("required_tools")
    if rt is None:
        return False
    return rt == ["none"]


def router_wants_category(router_ctx: dict, category: str) -> bool:
    """True se o router pediu essa categoria ou não restringiu o turno (None)."""
    if category not in VALID_CATEGORIES:
        return True
    rt = router_ctx.get("required_tools")
    if rt is None:
        return True
    if rt == ["none"]:
        return False
    return category in rt


def format_required_tools_for_log(router_ctx: dict) -> str:
    rt = router_ctx.get("required_tools")
    if rt is None:
        return "full_legacy"
    return ",".join(rt) if rt else "none"


def build_router_tools_instruction_block(router_ctx: dict) -> str:
    """Bloco curto anexado ao input do especialista explicando o que pode chamar."""
    rt = router_ctx.get("required_tools")
    if rt is None:
        return (
            "\n\n━━━ ROTEADOR — FERRAMENTAS DESTE TURNO ━━━\n"
            "required_tools: (não enviado — use o fluxo completo do seu prompt e chame tools "
            "quando precisar de dados do sistema.)\n"
        )
    if rt == ["none"]:
        return (
            "\n\n━━━ ROTEADOR — FERRAMENTAS DESTE TURNO ━━━\n"
            "required_tools: [none]\n"
            "Regra: NÃO chame buscar_produto, criar_pedido/adicionar_item nem tools de cliente "
            "neste turno. Responda com cumprimento, encerramento ou conversa curta usando só "
            "histórico e contexto. Exceção: escalar_humano se o cliente pedir atendente "
            "explicitamente.\n"
        )
    legend = (
        "products=buscar_produto | orders=criar_pedido/adicionar_item/remover_item/confirmar_pedido | "
        "customer=detalhes_cliente/atualizar_cliente/registrar_preferencia"
    )
    return (
        "\n\n━━━ ROTEADOR — FERRAMENTAS DESTE TURNO ━━━\n"
        f"required_tools: {rt}\n"
        f"({legend})\n"
        "Regra: priorize chamar só o que este turno exige; não dispare leituras de produto/cliente "
        "que não sejam coerentes com a lista. Se faltar um dado fora das categorias, pergunte ao "
        "cliente ou responda o que couber sem inventar valor/estoque. escalar_humano sempre "
        "disponível quando o cliente pedir atendente.\n"
    )
