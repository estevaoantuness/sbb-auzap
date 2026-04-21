/**
 * IDs @db.Uuid no Postgres rejeitam strings arbitrárias; Prisma dispara erro antes do "not found".
 */
const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

export function isUuidString(value: string): boolean {
  return UUID_RE.test(value.trim())
}

/** UUID normalizado ou undefined se vazio / inválido (params opcionais: ignora lixo do LLM). */
export function parseOptionalUuid(raw: string | undefined | null): string | undefined {
  if (raw == null) return undefined
  const t = String(raw).trim()
  if (!t) return undefined
  return isUuidString(t) ? t : undefined
}
