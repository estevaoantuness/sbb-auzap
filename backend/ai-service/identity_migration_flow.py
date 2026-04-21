"""
Stub: identity_migration_flow desligado no Super Bem Barato.

O fluxo original (recadastro CPF/manual_phone do petshop AuZap) não se aplica ao SBB —
Maria v2 identifica o cliente pelo telefone do WhatsApp e não exige CPF pra operar.

Mantido como módulo por compat com main.py que chama `try_handle_identity_migration`.
"""

from __future__ import annotations


async def try_handle_identity_migration(
    company_id: int,
    client_phone: str,
    user_message: str,
    context: dict,
):  # noqa: ARG001 — compat signature
    """Always returns None — SBB não usa recadastro."""
    return None
