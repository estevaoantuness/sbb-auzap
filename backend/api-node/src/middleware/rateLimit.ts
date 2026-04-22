import { sendAlert } from '../lib/telegramAlert'

const WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? '60000')        // 1 min
const MAX_PER_WINDOW = Number(process.env.RATE_LIMIT_MAX_PER_WINDOW ?? '20') // 20 msgs/min
const BURST_ALERT_THRESHOLD = Number(process.env.RATE_LIMIT_BURST_ALERT ?? '50')

interface Bucket { count: number; resetAt: number; alerted: boolean }
const buckets = new Map<string, Bucket>()

export function rateLimitByWaId(waId: string): { allowed: boolean; resetIn: number; count: number } {
  const now = Date.now()
  const bucket = buckets.get(waId)
  if (!bucket || bucket.resetAt < now) {
    buckets.set(waId, { count: 1, resetAt: now + WINDOW_MS, alerted: false })
    return { allowed: true, resetIn: WINDOW_MS, count: 1 }
  }
  bucket.count++
  // Alerta operador se cliente dispara burst suspeito
  if (bucket.count >= BURST_ALERT_THRESHOLD && !bucket.alerted) {
    bucket.alerted = true
    void sendAlert(
      `⚠️ Rate limit burst: waId=${waId} já enviou ${bucket.count} msgs em ${Math.ceil((now - (bucket.resetAt - WINDOW_MS))/1000)}s. Possível abuse ou bug.`,
      'warn'
    )
  }
  if (bucket.count > MAX_PER_WINDOW) {
    return { allowed: false, resetIn: bucket.resetAt - now, count: bucket.count }
  }
  return { allowed: true, resetIn: bucket.resetAt - now, count: bucket.count }
}

// GC leve a cada 60s
setInterval(() => {
  const now = Date.now()
  for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k)
}, 60_000)

export function rateLimitStats(): { totalBuckets: number; topWaIds: Array<{waId: string; count: number}> } {
  const top = Array.from(buckets.entries())
    .map(([waId, b]) => ({ waId, count: b.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
  return { totalBuckets: buckets.size, topWaIds: top }
}

export const RATE_LIMIT_MAX_PER_WINDOW = MAX_PER_WINDOW
