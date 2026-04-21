import { Request, Response } from 'express'
import { BrainService } from '../brain/brain.service'
import type { BrainMessage } from '../brain/brain.types'

const brain = new BrainService()

/**
 * POST /chat/business
 *
 * Rota legada mantida para compatibilidade com front-end antigo. Apenas delega
 * para o `BrainService` (que é o sucessor do `sbb-dashboard-ai-chat`).
 *
 * Prefira `POST /brain/chat` nas integrações novas.
 */
export async function chatBusiness(req: Request, res: Response) {
  try {
    const { message, history } = (req.body ?? {}) as {
      message?: unknown
      history?: unknown
    }

    const msg = typeof message === 'string' ? message.trim() : ''
    if (!msg) {
      return res.status(400).json({ error: 'message is required' })
    }

    const hist: BrainMessage[] = Array.isArray(history)
      ? (history as any[])
          .map((h) => {
            if (!h || typeof h !== 'object') return null
            const role = h.role === 'assistant' ? 'assistant' : h.role === 'tool' ? 'tool' : 'user'
            const content = typeof h.content === 'string' ? h.content : ''
            if (!content) return null
            return { role, content } as BrainMessage
          })
          .filter((m): m is BrainMessage => m !== null)
      : []

    const result = await brain.chat(msg, hist)
    res.json({
      response: result.reply,
      timestamp: new Date().toISOString(),
      tool_calls: result.tool_calls,
      model_used: result.model_used,
    })
  } catch (err) {
    console.error('[chat] chatBusiness error:', err)
    res.status(500).json({ error: 'Failed to process message' })
  }
}
