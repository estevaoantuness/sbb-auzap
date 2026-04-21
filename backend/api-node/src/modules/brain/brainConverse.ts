import { BRAIN_TOOLS, BRAIN_TOOLS_BY_NAME } from './brainActionTools'
import { getBrainOpenAiModel } from './brainModel'
import type { BrainMessage, BrainToolCallSummary } from './brain.types'

const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions'
const MAX_TOOL_STEPS = 8
const MAX_HISTORY = 12

const SYSTEM_PROMPT = `Você é o assistente do painel do Super Bem Barato. O operador te pergunta sobre
faturamento, produtos, leads, pedidos e o agente IA Maria. Você responde em PT-BR, direto, com dados REAIS
vindos das ferramentas — NUNCA invente números.

Regras:
- Se a pergunta precisa de dados, chame a ferramenta apropriada ANTES de responder.
- Use números do banco. Arredonde pra 2 casas em reais.
- Resposta curta (3-4 linhas). Se for lista, use bullets.
- Em dúvida sobre período, assuma "hoje" (faturamento) ou "últimos 7 dias" (top produtos).
- Nunca retorne SQL ou JSON bruto ao operador.`

interface OpenAiToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: OpenAiToolCall[]
  tool_call_id?: string
  name?: string
}

function toOpenAiTools() {
  return BRAIN_TOOLS.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }))
}

function clipHistory(history: BrainMessage[]): OpenAiMessage[] {
  return history
    .filter((m) => m && typeof m.content === 'string')
    .slice(-MAX_HISTORY)
    .map((m) => {
      if (m.role === 'tool') {
        return {
          role: 'tool' as const,
          content: m.content,
          tool_call_id: m.tool_call_id ?? 'unknown',
          name: m.name,
        }
      }
      return {
        role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
        content: m.content,
      }
    })
}

/**
 * Loop de tool-calling: pede resposta → executa tools → devolve pro modelo →
 * até ter a resposta final em texto (max 8 steps).
 */
export async function runBrainConverse(params: {
  apiKey: string
  message: string
  history: BrainMessage[]
}): Promise<{ reply: string; tool_calls: BrainToolCallSummary[]; model_used: string }> {
  const model = getBrainOpenAiModel()

  const messages: OpenAiMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...clipHistory(params.history),
    { role: 'user', content: params.message },
  ]

  const toolCalls: BrainToolCallSummary[] = []

  for (let step = 0; step < MAX_TOOL_STEPS; step++) {
    const res = await fetch(OPENAI_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        tools: toOpenAiTools(),
        tool_choice: 'auto',
        temperature: 0.2,
        max_tokens: 600,
      }),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error('[brain] OpenAI erro', res.status, body)
      throw new Error(`OpenAI ${res.status}: ${body.slice(0, 200)}`)
    }

    const data = (await res.json()) as {
      choices: Array<{
        message: OpenAiMessage
        finish_reason: string
      }>
    }

    const choice = data.choices?.[0]
    const msg = choice?.message
    if (!msg) {
      return {
        reply: 'Desculpa, não consegui processar. Tente reformular a pergunta.',
        tool_calls: toolCalls,
        model_used: model,
      }
    }

    // Se o modelo pediu tools, executa todas e dá a volta.
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      messages.push({
        role: 'assistant',
        content: msg.content ?? '',
        tool_calls: msg.tool_calls,
      })

      for (const call of msg.tool_calls) {
        const tool = BRAIN_TOOLS_BY_NAME[call.function.name]
        if (!tool) {
          messages.push({
            role: 'tool',
            content: JSON.stringify({ error: `tool '${call.function.name}' não existe` }),
            tool_call_id: call.id,
            name: call.function.name,
          })
          toolCalls.push({ name: call.function.name, ok: false })
          continue
        }

        let args: Record<string, unknown> = {}
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {}
        } catch {
          /* argumentos inválidos — envia objeto vazio */
        }

        try {
          const result = await tool.handler(args)
          messages.push({
            role: 'tool',
            content: result,
            tool_call_id: call.id,
            name: tool.name,
          })
          toolCalls.push({ name: tool.name, args_summary: JSON.stringify(args).slice(0, 200), ok: true })
        } catch (err) {
          const errMsg = (err as Error).message ?? String(err)
          messages.push({
            role: 'tool',
            content: JSON.stringify({ error: errMsg }),
            tool_call_id: call.id,
            name: tool.name,
          })
          toolCalls.push({ name: tool.name, ok: false })
        }
      }
      // Continua o loop pra reenviar com resultados das tools
      continue
    }

    // Resposta final em texto
    const reply = (msg.content ?? '').trim() || 'Não consegui gerar uma resposta agora.'
    return { reply, tool_calls: toolCalls, model_used: model }
  }

  return {
    reply: 'Cheguei no limite de passos sem conseguir responder — tente algo mais específico.',
    tool_calls: toolCalls,
    model_used: model,
  }
}
