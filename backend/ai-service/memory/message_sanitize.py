"""
Compacta respostas longas do assistente ao persistir no Redis.
O cliente recebe o texto completo na API; o histórico evita repetir catálogos já injetados.
"""

import re


def sanitize_assistant_for_history(content: str) -> str:
    if not content or not content.strip():
        return content
    s = content.strip()
    if len(s) < 1800:
        return content

    newlines = s.count("\n")
    price_hits = len(re.findall(r"R\$\s*[\d.,]+", s))
    bullet_hits = s.count("•") + s.count("* ") + s.count("- ")

    long_catalog = newlines >= 14 and price_hits >= 3
    dense_list = bullet_hits >= 12 and price_hits >= 2

    if long_catalog or dense_list or (len(s) > 8000 and price_hits >= 2):
        return (
            "[Histórico: lista longa de serviços/preços omitida — use o catálogo e dados "
            "já injetados nesta sessão (get_services / blocos do sistema).]"
        )

    if len(s) > 7000:
        return s[:4500] + "\n[… resposta truncada no histórico por tamanho …]"

    return content
