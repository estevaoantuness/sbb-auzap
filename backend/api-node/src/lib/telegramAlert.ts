/**
 * Telegram alert helper — notificação de operador humano em eventos críticos:
 *   - Escalação manual / prompt_injection_suspected
 *   - Falha permanente de envio (após retries)
 *   - Erros não recuperáveis no worker
 *
 * Config via env:
 *   TELEGRAM_ALERT_BOT_TOKEN — token do bot
 *   TELEGRAM_ALERT_CHAT_ID   — chat id (suporta -100... pra grupos)
 *
 * Silencioso se envs ausentes (não derruba o worker).
 */

export type AlertSeverity = 'info' | 'warn' | 'error'

const SEVERITY_EMOJI: Record<AlertSeverity, string> = {
  info: 'ℹ️',
  warn: '⚠️',
  error: '🚨',
}

/**
 * Envia alerta via Telegram Bot API. Fire-and-forget — nunca throw
 * (um alerta falho não deve derrubar o worker).
 */
export async function sendAlert(
  message: string,
  severity: AlertSeverity = 'error'
): Promise<void> {
  const token = process.env.TELEGRAM_ALERT_BOT_TOKEN
  const chatId = process.env.TELEGRAM_ALERT_CHAT_ID

  if (!token || !chatId) {
    // Config ausente — log local e segue. Não queremos crashar silenciosamente
    // em dev, mas também não queremos bloquear em prod se rotacionaram o token.
    console.warn('[telegramAlert] config ausente (TELEGRAM_ALERT_BOT_TOKEN/CHAT_ID)')
    return
  }

  const emoji = SEVERITY_EMOJI[severity]
  const timestamp = new Date().toISOString()
  const text = `${emoji} *sbb-auzap* — \`${severity.toUpperCase()}\`\n${message}\n\n_${timestamp}_`

  const url = `https://api.telegram.org/bot${token}/sendMessage`
  const body = {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      console.error('[telegramAlert] sendMessage falhou', {
        status: res.status,
        body: errBody.slice(0, 500),
      })
    }
  } catch (err) {
    console.error('[telegramAlert] network error', err)
  }
}
