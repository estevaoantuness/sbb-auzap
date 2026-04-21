"""
Referência única de fuso para o ai-service: America/Sao_Paulo (horário de Brasília).

Usar sempre estas funções em vez de date.today() ou UTC-3 fixo, para alinhar com DST e regras IANA.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

SAO_PAULO = ZoneInfo("America/Sao_Paulo")

# Mesmos rótulos que main.py injeta em today_weekday (consistência nos prompts).
_PT_WEEKDAY_LABELS = [
    "Segunda-feira",
    "Terça-feira",
    "Quarta-feira",
    "Quinta-feira",
    "Sexta-feira",
    "Sábado",
    "Domingo",
]


def weekday_label_pt(d: date) -> str:
    """Nome do dia da semana em português (capitalizado, com hífen)."""
    return _PT_WEEKDAY_LABELS[d.weekday()]


def calendar_dates_reference_pt(start: date, days: int = 45) -> str:
    """
    Uma linha por dia: YYYY-MM-DD (DD/MM/YYYY) → dia da semana em PT.
    O LLM erra weekday com frequência; a tabela vem do Python (correta).
    """
    lines: list[str] = []
    for i in range(days):
        d = start + timedelta(days=i)
        lines.append(
            f"  {d.isoformat()} ({d.strftime('%d/%m/%Y')}) → {_PT_WEEKDAY_LABELS[d.weekday()]}"
        )
    return (
        "CALENDÁRIO (Brasília — **única** fonte válida para dia da semana de cada data abaixo; "
        "**não** deduza mentalmente):\n"
        + "\n".join(lines)
    )


def today_sao_paulo() -> date:
    """Data civil de hoje em São Paulo."""
    return datetime.now(SAO_PAULO).date()


def now_sao_paulo() -> datetime:
    """Agora com tzinfo=America/Sao_Paulo."""
    return datetime.now(SAO_PAULO)


def now_sao_paulo_naive() -> datetime:
    """Hora local de SP sem tzinfo (útil para comparar com TIME do Postgres legado)."""
    return datetime.now(SAO_PAULO).replace(tzinfo=None)
