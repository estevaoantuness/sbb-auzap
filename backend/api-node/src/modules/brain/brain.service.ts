import { runBrainConverse } from './brainConverse'
import type { BrainMessage, BrainResponse } from './brain.types'

/**
 * BrainService — chat do dashboard operator (Superbem).
 *
 * Sucessor do workflow N8N `sbb-dashboard-ai-chat`.
 * Operador pergunta em linguagem natural ("quanto vendi hoje?"), brain consulta
 * tools (views do public.* + agent.runs) e retorna resposta narrativa.
 */
export class BrainService {
  async chat(message: string, history: BrainMessage[] = []): Promise<BrainResponse> {
    const apiKey = process.env.OPENAI_API_KEY?.trim()
    if (!apiKey) {
      return {
        reply: 'O assistente não está configurado — OPENAI_API_KEY ausente no servidor.',
        tool_calls: [],
      }
    }

    const trimmed = message.trim()
    if (!trimmed) {
      return {
        reply: 'Me faz uma pergunta — algo tipo "quanto vendi hoje?" ou "top 5 produtos da semana".',
        tool_calls: [],
      }
    }

    try {
      const result = await runBrainConverse({ apiKey, message: trimmed, history })
      return result
    } catch (err) {
      console.error('[brain] chat error:', err)
      return {
        reply: 'Algo deu errado ao consultar os dados. Tenta de novo em 10s.',
        tool_calls: [],
      }
    }
  }
}
