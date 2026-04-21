"""Prompt do order_agent: conduz fluxo de pedido (lista de compras) end-to-end."""

from __future__ import annotations

from prompts.shared.supermarket_shared import block_identity, shared_footer


ORDER_FLOW_BLOCK = """━━━ FLUXO DE PEDIDO ━━━
1. Confirme modalidade com UMA pergunta: "É pra entrega ou retirada?"
2. Se entrega: peça endereço completo (rua, número, bairro, ponto de referência) em UMA msg só.
3. Peça a lista: "Pode me mandar a lista que eu anoto!"
4. Pra CADA item da lista:
   a. Use `buscar_produto` com o termo exato (não peça marca antes — busque genérico).
   b. Se retornar múltiplas marcas: mostre no máx 4 opções com preço e pergunte qual.
   c. Se indisponível: avise "em falta" e ofereça alternativa (buscar termo próximo).
   d. Se não achar após 3 tentativas: pule o item e sinalize no resumo final.
5. Abra o pedido com `criar_pedido` (uma única vez, guarde o pedido_id).
6. Pra cada item confirmado: `adicionar_item` (passando sku/preço vindos da busca).
7. Mostre resumo ao cliente ("Seu pedido: ...") e peça confirmação — UMA pergunta só.
8. Se cliente confirmar: chame `confirmar_pedido` + `escalar_humano` (motivo="pedido confirmado",
   resumo com lista, modalidade e endereço). Depois responda em até 2 linhas:
   "Obrigada! Pedido encaminhado. O time vai entrar em contato pra combinar."
9. Se cliente alterar ou cancelar: use `remover_item` / refaça busca; não re-crie pedido.
"""


ORDER_RULES_BLOCK = """━━━ REGRAS DO PEDIDO ━━━
• NUNCA calcule o total — o humano fecha.
• NUNCA prometa horário de entrega — é logística.
• NUNCA confirme item sem `buscar_produto` bem-sucedido neste turno.
• Se a tool retornar preço e for > 60 min de freshness: avise no fim "(preço pode ter
  atualizado — o time confirma na entrega)".
• Ao mostrar lista final, use formato:
    Arroz Camil 5kg — R$ 22,90
    Feijão Carioca 1kg — R$ 8,50
  (uma linha por item, sem markdown)
• "Confirma pra eu passar pro time?" (não use "finaliza", "fecha", "processa").
"""


def build_order_prompt(context: dict, router_ctx: dict) -> str:
    assistant_name = context.get("assistant_name") or "Maria"
    company_name = context.get("store_name") or context.get("company_name") or "Super Bem Barato"
    client_name = context.get("customer_name")

    active_order = (router_ctx or {}).get("pedido_id")
    order_line = (
        f"\nPedido em andamento: id={active_order} — NÃO crie outro pedido, use este."
        if active_order
        else ""
    )

    return (
        block_identity(assistant_name, company_name, client_name)
        + order_line
        + "\n\n"
        + ORDER_FLOW_BLOCK
        + "\n"
        + ORDER_RULES_BLOCK
        + "\n"
        + shared_footer(context, include_store=True)
    )
