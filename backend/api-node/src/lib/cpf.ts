/**
 * CPF brasileiro: apenas dígitos, 11 posições, dígitos verificadores válidos.
 */

export function normalizeCpfDigits(input: string | undefined | null): string {
  return (input ?? '').replace(/\D/g, '').slice(0, 11)
}

export function isValidCpfDigits(cpf: string): boolean {
  if (cpf.length !== 11) return false
  if (/^(\d)\1{10}$/.test(cpf)) return false

  const calc = (base: string, factor: number) => {
    let sum = 0
    for (let i = 0; i < base.length; i++) {
      sum += parseInt(base[i]!, 10) * (factor - i)
    }
    const mod = (sum * 10) % 11
    return mod === 10 ? 0 : mod
  }

  const d1 = calc(cpf.slice(0, 9), 10)
  if (d1 !== parseInt(cpf[9]!, 10)) return false
  const d2 = calc(cpf.slice(0, 10), 11)
  if (d2 !== parseInt(cpf[10]!, 10)) return false
  return true
}

/** Retorna dígitos normalizados ou null se vazio / inválido (quando obrigatório). */
export function parseOptionalCpf(input: unknown): string | null {
  if (input === undefined || input === null || input === '') return null
  const d = normalizeCpfDigits(String(input))
  if (!d) return null
  return d
}

export function assertValidCpfOrThrow(digits: string): void {
  if (!isValidCpfDigits(digits)) {
    const err = new Error('INVALID_CPF')
    ;(err as any).code = 'INVALID_CPF'
    throw err
  }
}
