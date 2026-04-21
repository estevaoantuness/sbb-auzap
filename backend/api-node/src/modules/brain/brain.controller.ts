import { Request, Response } from 'express'
import { BrainService } from './brain.service'
import type { BrainMessage } from './brain.types'

const service = new BrainService()

export async function chat(req: Request, res: Response) {
  try {
    const { message, history, session_id } = (req.body ?? {}) as {
      message?: unknown
      history?: unknown
      session_id?: unknown
    }

    const msg = typeof message === 'string' ? message.trim() : ''
    if (!msg) {
      return res.status(400).json({ error: 'message (string) is required' })
    }

    const hist: BrainMessage[] = Array.isArray(history)
      ? (history as any[])
          .map((h) => {
            if (!h || typeof h !== 'object') return null
            const role = h.role === 'assistant' ? 'assistant' : h.role === 'tool' ? 'tool' : 'user'
            const content = typeof h.content === 'string' ? h.content : ''
            if (!content) return null
            return { role, content, tool_call_id: h.tool_call_id, name: h.name } as BrainMessage
          })
          .filter((m): m is BrainMessage => m !== null)
      : []

    const result = await service.chat(msg, hist)
    res.json({ ...result, session_id: session_id ?? null })
  } catch (err) {
    console.error('[brain] controller error:', err)
    res.status(500).json({ error: 'Failed to process brain chat' })
  }
}
