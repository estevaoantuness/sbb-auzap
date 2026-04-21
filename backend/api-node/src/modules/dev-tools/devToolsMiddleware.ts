import { Request, Response, NextFunction } from 'express'

const DEV_TOOLS_KEY = process.env.DEV_TOOLS_KEY || ''

/**
 * Middleware que valida o header x-dev-tools-key contra a env DEV_TOOLS_KEY.
 * Sem key configurada no servidor, bloqueia tudo.
 */
export function verifyDevToolsKey(req: Request, res: Response, next: NextFunction) {
  if (!DEV_TOOLS_KEY) {
    return res.status(403).json({ error: 'Dev tools desabilitado neste ambiente.' })
  }

  const clientKey = req.headers['x-dev-tools-key'] as string | undefined

  if (!clientKey || clientKey !== DEV_TOOLS_KEY) {
    return res.status(401).json({ error: 'Chave dev-tools inválida.' })
  }

  next()
}
