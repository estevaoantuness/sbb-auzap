import crypto from 'crypto'
import type { Request, Response, NextFunction } from 'express'

/**
 * Meta Cloud API webhook — valida X-Hub-Signature-256 com WABA_APP_SECRET.
 * Rejeita 401 qualquer POST sem assinatura válida.
 *
 * CRÍTICO: rawBody precisa ser capturado ANTES do body-parser json() processar.
 * Configurar em app.ts:
 *   app.use(express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf } }))
 */
export function verifyMetaSignature(req: Request, res: Response, next: NextFunction) {
  const signature = req.header('x-hub-signature-256')
  if (!signature) {
    return res.status(401).json({ error: 'missing x-hub-signature-256' })
  }

  const secret = process.env.WABA_APP_SECRET
  if (!secret) {
    console.error('[metaSignature] WABA_APP_SECRET não configurado')
    return res.status(500).json({ error: 'server misconfigured' })
  }

  const rawBody = (req as any).rawBody as Buffer | undefined
  if (!rawBody) {
    console.error('[metaSignature] rawBody ausente — body-parser não configurou verify')
    return res.status(500).json({ error: 'server misconfigured' })
  }

  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex')

  let valid = false
  try {
    valid = signature.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  } catch {
    valid = false
  }

  if (!valid) {
    console.warn('[metaSignature] assinatura inválida', { ip: req.ip })
    return res.status(401).json({ error: 'invalid signature' })
  }

  next()
}

/**
 * Verification challenge — Meta faz GET no webhook com hub.verify_token pra confirmar ownership.
 */
export function verifyChallenge(req: Request, res: Response) {
  const mode = req.query['hub.mode']
  const token = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']

  if (mode === 'subscribe' && token === process.env.WABA_VERIFY_TOKEN) {
    return res.status(200).send(challenge)
  }
  return res.status(403).json({ error: 'verify_token mismatch' })
}
