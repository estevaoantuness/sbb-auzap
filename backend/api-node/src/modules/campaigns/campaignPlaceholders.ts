/**
 * Resolver de placeholders de template de campanha — Superbem.
 *
 * Tokens suportados (case-insensitive, espaços ao redor ignorados):
 *   {nome}                       — nome_real ?? nome_whatsapp ?? 'cliente'
 *   {bairro}                     — bairro ?? ''
 *   {ultimo_produto_consultado}  — última busca/consulta registrada em produtos_consultados
 *
 * Tokens ausentes no ctx viram string vazia (NUNCA mantém o placeholder bruto
 * — a Meta rejeita mensagens com texto tipo "{nome}" e cobra o dinheiro mesmo assim).
 */

export interface PlaceholderContext {
  nome?: string | null
  bairro?: string | null
  ultimo_produto_consultado?: string | null
  [k: string]: string | null | undefined
}

const TOKEN_RE = /\{\s*([a-z_][a-z0-9_]*)\s*\}/gi

export function renderCampaignTemplate(template: string, ctx: PlaceholderContext): string {
  if (!template) return ''
  return template.replace(TOKEN_RE, (_match, keyRaw: string) => {
    const key = keyRaw.toLowerCase()
    const val = ctx[key]
    if (val == null) return ''
    return String(val).trim()
  })
}

/**
 * Extrai a lista de tokens usados no template (diagnóstico / UI — "faltou nome?").
 */
export function extractTokens(template: string): string[] {
  const seen = new Set<string>()
  const re = new RegExp(TOKEN_RE.source, 'gi')
  let m: RegExpExecArray | null
  while ((m = re.exec(template)) !== null) {
    seen.add(m[1]!.toLowerCase())
  }
  return [...seen]
}
