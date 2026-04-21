import { Router, Request, Response } from 'express'
import { internalApiKeyMiddleware } from '../../middleware/internalApiKeyMiddleware'
import { notifyEscalation } from './notifyController'
import { enqueueInbound } from '../../lib/queue'

const router = Router()

// Todas as rotas /internal/* exigem x-internal-key
router.use(internalApiKeyMiddleware)

// ─── POST /internal/notify-escalation ────────────────────────────────────────
router.post('/notify-escalation', notifyEscalation)

// ─── GET /internal/ai-service/health ─────────────────────────────────────────
// Proxy pro ai-service health check. Útil pro watchdog do ops dashboard.
router.get('/ai-service/health', async (_req: Request, res: Response) => {
  try {
    const base = process.env.AI_SERVICE_URL?.trim() || 'http://localhost:8000'
    const url = base.replace(/\/$/, '') + '/health'

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)

    try {
      const r = await fetch(url, { signal: controller.signal })
      clearTimeout(timeout)
      const body = await r.text().catch(() => '')
      return res.status(r.ok ? 200 : 502).json({
        upstream_status: r.status,
        upstream_url: url,
        body: safeJson(body),
      })
    } catch (err) {
      clearTimeout(timeout)
      return res.status(502).json({
        upstream_status: 0,
        upstream_url: url,
        error: (err as Error).message ?? String(err),
      })
    }
  } catch (err) {
    console.error('[internal] ai-service/health error:', err)
    return res.status(500).json({ error: 'Failed to check ai-service health' })
  }
})

// ─── POST /internal/debug/simulate-message ───────────────────────────────────
/**
 * Enfileira um job em pg-boss como se fosse vindo do webhook Cloud API.
 * Uso exclusivo dos smoke tests do Bloco 5 (NUNCA expor pra fora).
 *
 * Body: { phone: string, message: string, message_id?: string }
 */
router.post('/debug/simulate-message', async (req: Request, res: Response) => {
  try {
    const phone = String(req.body?.phone ?? '').replace(/\D/g, '')
    const message = String(req.body?.message ?? '').trim()
    if (!phone || !message) {
      return res.status(400).json({ error: 'phone e message são obrigatórios' })
    }

    const messageId = String(req.body?.message_id ?? '').trim() ||
      `simulated-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    const jobId = await enqueueInbound({
      waId: phone,
      messageId,
      userMessage: message,
      receivedAt: new Date().toISOString(),
    })

    res.json({ success: true, job_id: jobId, wa_id: phone, message_id: messageId })
  } catch (err) {
    console.error('[internal] simulate-message error:', err)
    res.status(500).json({ error: 'Failed to enqueue simulated message' })
  }
})

function safeJson(raw: string): unknown {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return raw.slice(0, 500)
  }
}

export default router
