/**
 * Evolution webhook guard — defesa em camadas.
 *
 * 1. apikey header match contra EVOLUTION_API_KEY (SEMPRE, mesmo em dev).
 * 2. Em produção com EVOLUTION_ALLOWED_IPS configurado: bloqueia IPs fora da allowlist.
 *
 * Não valida assinatura HMAC (Evolution não provê) — apikey é o único segredo compartilhado.
 */

import type { Request, Response, NextFunction } from 'express'

function parseAllowedIps(): string[] {
  const raw = process.env.EVOLUTION_ALLOWED_IPS || ''
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

export function evolutionWebhookGuard(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const expectedKey = process.env.EVOLUTION_API_KEY
  if (!expectedKey) {
    console.error('[evolution] EVOLUTION_API_KEY não configurado — rejeitando webhook')
    res.status(500).json({ error: 'server misconfigured' })
    return
  }

  const provided = req.header('apikey') || req.header('apiKey')
  if (!provided || provided !== expectedKey) {
    console.warn('[evolution] apikey inválido ou ausente', {
      ip: req.ip,
      hasHeader: Boolean(provided),
    })
    res.status(401).json({ error: 'invalid apikey' })
    return
  }

  const allowedIps = parseAllowedIps()
  const isProd = process.env.NODE_ENV === 'production'
  if (isProd && allowedIps.length > 0) {
    const clientIp = req.ip || ''
    const match = allowedIps.some((allowed) => {
      if (allowed === clientIp) return true
      // Tolera IPv6-mapped IPv4 (::ffff:1.2.3.4)
      if (clientIp.endsWith(`:${allowed}`)) return true
      return false
    })
    if (!match) {
      console.warn('[evolution] IP bloqueado pela allowlist', {
        ip: clientIp,
        allowed: allowedIps,
      })
      res.status(403).json({ error: 'ip not allowed' })
      return
    }
  }

  next()
}
