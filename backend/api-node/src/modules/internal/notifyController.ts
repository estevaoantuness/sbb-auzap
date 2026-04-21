import { Request, Response } from 'express'

/**
 * POST /internal/notify-escalation
 *
 * Recebe do ai-service (ou brain) uma notificação de escalação — manda pro Telegram
 * do operador (DM ou canal). Single-tenant: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID em env.
 *
 * Body:
 *   {
 *     client_name: string,
 *     client_phone: string,
 *     summary: string,
 *     last_message: string,
 *     frontend_url?: string       // link pra conversa no painel
 *   }
 */
export async function notifyEscalation(req: Request, res: Response) {
  try {
    const body = (req.body ?? {}) as {
      client_name?: unknown
      client_phone?: unknown
      summary?: unknown
      last_message?: unknown
      frontend_url?: unknown
      conversation_id?: unknown
    }

    const clientPhone = String(body.client_phone ?? '').trim()
    if (!clientPhone) {
      return res.status(400).json({ error: 'client_phone is required' })
    }

    const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim()
    const chatId = process.env.TELEGRAM_CHAT_ID?.trim()

    if (!botToken || !chatId) {
      console.warn('[notify] TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID ausentes — escalação apenas logada.')
      console.log('[notify][escalation]', body)
      return res.json({ success: true, delivered: false, reason: 'telegram_not_configured' })
    }

    const clientName = String(body.client_name ?? 'Cliente').trim()
    const summary = String(body.summary ?? '').trim() || '(sem resumo)'
    const lastMessage = String(body.last_message ?? '').trim() || '(sem última mensagem)'
    const frontendUrl = String(body.frontend_url ?? '').trim()
    const conversationId = body.conversation_id != null ? String(body.conversation_id) : ''
    const link = frontendUrl
      ? `${frontendUrl.replace(/\/$/, '')}/conversations/${conversationId || clientPhone}`
      : ''

    const text = [
      '*Atendimento escalado*',
      '',
      `*Cliente:* ${clientName}`,
      `*Telefone:* \\+${clientPhone}`,
      '',
      `*Resumo:* ${summary}`,
      '',
      `*Última mensagem:* "${lastMessage}"`,
      link ? `\n[Abrir conversa](${link})` : '',
    ]
      .filter(Boolean)
      .join('\n')

    const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: true,
      }),
    })

    if (!tgRes.ok) {
      const errTxt = await tgRes.text().catch(() => '')
      console.error('[notify] telegram falhou:', tgRes.status, errTxt)
      return res.status(502).json({ error: 'Falha ao enviar escalação ao Telegram', detail: errTxt })
    }

    res.json({ success: true, delivered: true })
  } catch (err) {
    console.error('[notify] erro:', err)
    res.status(500).json({ error: 'Failed to notify escalation' })
  }
}
