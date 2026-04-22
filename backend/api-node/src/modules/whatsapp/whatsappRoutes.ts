import { Router } from 'express'
import { handleWebhook } from './webhookController'
import { handleEvolutionWebhook } from './evolutionWebhookController'
import { verifyMetaSignature, verifyChallenge } from '../../middleware/metaSignature'
import { evolutionWebhookGuard } from '../../middleware/evolutionWebhookGuard'
import { getProvider } from './providers'

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

export default router
