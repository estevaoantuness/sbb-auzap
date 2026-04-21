"""
Prompts reescritos para o contexto Super Bem Barato (Maria v2).

Substitui a versão petshop. Exporta: `build_sales_prompt`, `build_faq_prompt`,
`build_escalation_prompt`. Mantém os nomes esperados pelos módulos em
`prompts/specialists/*.py` (que fazem re-export).
"""

from __future__ import annotations

from prompts.shared.supermarket_shared import (
    block_identity,
    shared_footer,
    build_store_block,
)


def _client_name(context: dict) -> str | None:
    for key in ("customer_name", "client_name"):
        v = (context.get(key) or "").strip()
        if v:
            return v
    client = context.get("client") or {}
    name = (client.get("name") or "").strip() if isinstance(client, dict) else ""
    return name or None


def build_sales_prompt(context: dict, router_ctx: dict) -> str:
    """sales_agent = explicação de ofertas, promoções e incentivo a fechar pedido."""
    assistant_name = context.get("assistant_name") or "Maria"
    company_name = (
        context.get("store_name") or context.get("company_name") or "Super Bem Barato"
    )
    client_name = _client_name(context)

    top_categorias = context.get("top_categorias") or []
    segmento = context.get("segmento")
    ultimo = context.get("ultimo_pedido") or {}

    perfil_lines: list[str] = []
    if segmento:
        perfil_lines.append(f"Segmento RFM: {segmento}")
    if top_categorias:
        perfil_lines.append(f"Top categorias: {', '.join(top_categorias[:5])}")
    if ultimo.get("created_at"):
        perfil_lines.append(f"Último pedido: {ultimo.get('created_at')}")
    perfil_block = (
        "━━━ PERFIL DO CLIENTE ━━━\n" + "\n".join(perfil_lines) + "\n"
        if perfil_lines
        else ""
    )

    sales_rules = """━━━ REGRAS DE VENDAS ━━━
• NUNCA empurre produto — só sugira quando fizer sentido (cliente perguntou ou item relacionado
  ao que está comprando).
• Ao mencionar oferta/promo: use SEMPRE `buscar_produto` pra confirmar preco_promo + estoque.
• Se cliente demonstrar intenção de comprar → sinalize pro order_agent (router cuida).
• NUNCA invente desconto ou combo — só confirme o que o ERP retornar.
• Enviar link do tabloide: só quando o cliente pedir explicitamente.
"""

    return (
        block_identity(assistant_name, company_name, client_name)
        + "\n\n"
        + perfil_block
        + sales_rules
        + "\n"
        + shared_footer(context, include_store=False)
    )


def build_faq_prompt(context: dict, router_ctx: dict) -> str:
    """faq_agent = horário, endereço, pagamento, política, dúvidas gerais."""
    assistant_name = context.get("assistant_name") or "Maria"
    company_name = (
        context.get("store_name") or context.get("company_name") or "Super Bem Barato"
    )
    client_name = _client_name(context)

    faq_rules = """━━━ FAQ — O QUE VOCÊ RESPONDE DIRETO ━━━
• Horário de funcionamento.
• Endereço e telefone.
• Formas de pagamento (Dinheiro, PIX, Cartão débito/crédito — na entrega/retirada).
• Como pedir pelo WhatsApp.
• Link do tabloide (quando pedirem).

━━━ FORA DO FAQ — ESCALE ━━━
• Taxa / área / prazo de entrega → `escalar_humano` com motivo "dúvida de entrega".
• Valor total de pedido em andamento → humano.
• Qualquer coisa que precise confirmação operacional.

━━━ FORMATO ━━━
• Máximo 2 linhas.
• Responda APENAS o que foi perguntado — sem descarregar tudo que sabe.
"""

    return (
        block_identity(assistant_name, company_name, client_name)
        + "\n\n"
        + build_store_block(context)
        + "\n\n"
        + faq_rules
        + "\n"
        + shared_footer(context, include_store=False)
    )


def build_escalation_prompt(context: dict, _router_ctx: dict) -> str:
    assistant_name = context.get("assistant_name") or "Maria"
    company_name = (
        context.get("store_name") or context.get("company_name") or "Super Bem Barato"
    )
    client_name = _client_name(context)

    escalation_rules = """━━━ FUNÇÃO — escalation_agent ━━━
Você é o ponto de saída pra humano. Sua ação principal: chamar `escalar_humano`.

QUANDO CHAMAR escalar_humano:
1) Pedido explícito de atendente, humano, pessoa, responsável, gerente.
2) B2B, spam, parceria comercial — claramente fora do escopo.
3) Reclamação complexa / insatisfação persistente (≥2 reclamações).
4) Dúvida de entrega (taxa, área, prazo) — sem inventar valor.
5) Status de pedido já confirmado (humano cuida).
6) Pedido de parar de enviar mensagens.

QUANDO NÃO CHAMAR:
• Só saudação, "oi", "obrigado" isolado → cumprimente curto e pergunte como ajudar.

FLUXO:
1) Se couber: chame `escalar_humano` primeiro com motivo + resumo + última_mensagem.
2) Após success: responda em até 2 linhas dizendo que vai passar pro time.
   "Deixa eu te passar pra um atendente que resolve isso com você."
3) NUNCA mencione bot, IA, sistema.
4) NUNCA prometa horário exato de retorno.
"""

    return (
        block_identity(assistant_name, company_name, client_name)
        + "\n\n"
        + escalation_rules
        + "\n"
        + shared_footer(context, include_store=False)
    )
