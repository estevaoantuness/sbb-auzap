import { Router } from 'express'
import { handleWebhook } from './webhookController'
import { handleEvolutionWebhook } from './evolutionWebhookController'
import { verifyMetaSignature, verifyChallenge } from '../../middleware/metaSignature'
import { evolutionWebhookGuard } from '../../middleware/evolutionWebhookGuard'
import { getProvider } from './providers'
import { evolutionInternals } from './providers/evolution'

const router = Router()

// ── Evolution API webhook (só ativo se WHATSAPP_PROVIDER=evolution) ──
// Declarado ANTES de /webhook (Cloud API) pra evitar conflito de roteamento.
router.post('/webhook/evolution', evolutionWebhookGuard, handleEvolutionWebhook)

// ── Cloud API webhook (só ativo se WHATSAPP_PROVIDER=cloud_api) ──
router.get('/webhook', verifyChallenge)
router.post('/webhook', verifyMetaSignature, handleWebhook)

// ── Status unificado: Baileys ou Cloud API (depende do env) ──
router.get('/status', async (_req, res) => {
  try {
    const status = await getProvider().getStatus()
    res.json({ ok: true, ...status })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// ── QR code (só Baileys): data URL pro dashboard exibir ──
router.get('/qr', async (_req, res) => {
  const provider = getProvider()
  if (!provider.getQR) {
    return res.status(404).json({ ok: false, error: 'provider não suporta QR' })
  }
  const dataUrl = await provider.getQR()
  if (!dataUrl) {
    return res.status(200).json({ ok: true, qrCodeDataUrl: null, message: 'sem QR pendente' })
  }
  res.json({ ok: true, qrCodeDataUrl: dataUrl })
})

// ── Disconnect (só Baileys): loga out + limpa sessão ──
router.post('/disconnect', async (_req, res) => {
  const provider = getProvider()
  if (!provider.disconnect) {
    return res.status(404).json({ ok: false, error: 'provider não suporta disconnect' })
  }
  await provider.disconnect()
  res.json({ ok: true })
})

// ── Pairing code (só Evolution): código de 8 dígitos como alternativa ao QR
// Mais confiável que escanear QR quando o scanner falha por qualquer motivo.
router.post('/pairing-code', async (req, res) => {
  const provider = process.env.WHATSAPP_PROVIDER || 'baileys'
  if (provider !== 'evolution') {
    return res.status(404).json({ ok: false, error: 'pairing-code só disponível no Evolution' })
  }
  const phone = req.body?.phoneNumber || req.body?.phone
  if (!phone || typeof phone !== 'string') {
    return res.status(400).json({ ok: false, error: 'body.phoneNumber é obrigatório (E.164)' })
  }
  try {
    const rawState = await evolutionInternals.getInstanceRawState()
    if (rawState === 'open') {
      return res.json({ ok: true, connected: true, message: 'WhatsApp já está conectado' })
    }
    const result = await evolutionInternals.requestPairingCode(phone)
    return res.json({
      ok: true,
      connected: false,
      pairingCode: result.pairingCode,
      instructions:
        'No WhatsApp: Configurações → Aparelhos conectados → Conectar um aparelho → Conectar com número de telefone → digite o código',
    })
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err?.message || 'pairing-code falhou' })
  }
})

// ── Reconnect (só Evolution): logout+delete+create+connect — limpa sessão
// presa quando o pareamento falha várias vezes.
router.post('/reconnect', async (_req, res) => {
  const provider = process.env.WHATSAPP_PROVIDER || 'baileys'
  if (provider !== 'evolution') {
    return res.status(404).json({ ok: false, error: 'reconnect só disponível no Evolution' })
  }
  try {
    const result = await evolutionInternals.reconnect()
    return res.json({ ok: true, qrCodeDataUrl: result.qr })
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err?.message || 'reconnect falhou' })
  }
})

export default router
