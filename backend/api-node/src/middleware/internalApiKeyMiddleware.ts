import { Request, Response, NextFunction } from 'express'

const HEADER = 'x-internal-key'

export function internalApiKeyMiddleware(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.INTERNAL_API_KEY?.trim()
  if (!expected) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(503).json({ error: 'INTERNAL_API_KEY não configurada' })
    }
    console.warn('[security] INTERNAL_API_KEY não definida — /internal aceito sem chave (apenas desenvolvimento)')
    return next()
  }
  const raw = req.headers[HEADER]
  const provided = Array.isArray(raw) ? raw[0] : raw
  if (provided !== expected) {
    return res.status(401).json({ error: 'Chave interna inválida ou ausente' })
  }
  next()
}
