/**
 * QR cache for Evolution.
 *
 * Evolution pushes fresh QR codes via the `qrcode.updated` webhook every
 * rotation. Caching those lets us serve the freshest QR on every dashboard
 * poll without hammering `/instance/connect` (which also causes rotation).
 *
 * Portado do mevoaiwebsite — ver services/whatsapp.service.js#handleQRCodeWebhook.
 */

interface CachedQR {
  qr: string
  updatedAt: number
}

const cache = new Map<string, CachedQR>()

const TTL_MS = 45_000 // QRs rotate every ~30s; margin of 15s

export function setQR(instance: string, base64: string): void {
  const qr = base64.startsWith('data:image/')
    ? base64
    : `data:image/png;base64,${base64}`
  cache.set(instance, { qr, updatedAt: Date.now() })
}

export function getQR(instance: string): string | null {
  const entry = cache.get(instance)
  if (!entry) return null
  if (Date.now() - entry.updatedAt > TTL_MS) {
    cache.delete(instance)
    return null
  }
  return entry.qr
}

export function clearQR(instance: string): void {
  cache.delete(instance)
}
