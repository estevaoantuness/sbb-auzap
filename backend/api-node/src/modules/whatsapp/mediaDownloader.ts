/**
 * WhatsApp Cloud API — Media download helper.
 *
 * Meta não entrega bytes no webhook; entrega um `media.id`. Pra transcrever/OCR
 * precisa fazer 2 requests:
 *   1. GET /{media_id}?fields=url,mime_type,file_size,messaging_product
 *        → retorna URL temporária (expira em ~5min) + metadata
 *   2. GET <url> com Authorization header
 *        → baixa os bytes
 *
 * Limites:
 *   - MAX_MEDIA_BYTES (padrão 5 MB) aplicado a qualquer tipo
 *   - MAX_AUDIO_SECONDS (padrão 120s) aplicado se tipo = audio e duration conhecido
 *
 * Rejeição explícita (throw) — caller (worker) captura e escala/ignora.
 */

const GRAPH_API_VERSION = 'v17.0'
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024 // 5MB

export interface MediaDownloadResult {
  base64: string
  mimeType: string
  sizeBytes: number
  durationSeconds?: number
}

export interface MediaMetadata {
  url: string
  mimeType: string
  fileSize?: number
  durationSeconds?: number
}

export class MediaTooLargeError extends Error {
  constructor(public sizeBytes: number, public limitBytes: number) {
    super(`media exceeds limit: ${sizeBytes}B > ${limitBytes}B`)
    this.name = 'MediaTooLargeError'
  }
}

export class AudioTooLongError extends Error {
  constructor(public durationSeconds: number, public limitSeconds: number) {
    super(`audio exceeds limit: ${durationSeconds}s > ${limitSeconds}s`)
    this.name = 'AudioTooLongError'
  }
}

/**
 * Baixa mídia do Cloud API e retorna base64 + metadata.
 *
 * @param mediaId  wamid da mídia (media.id no webhook)
 * @param opts.isAudio  se true, aplica MAX_AUDIO_SECONDS
 * @throws MediaTooLargeError | AudioTooLongError | Error (rede/auth)
 */
export async function downloadMedia(
  mediaId: string,
  opts?: { isAudio?: boolean }
): Promise<MediaDownloadResult> {
  const accessToken = mustEnv('WABA_ACCESS_TOKEN')
  const maxBytes = Number(process.env.MAX_MEDIA_BYTES ?? String(DEFAULT_MAX_BYTES))
  const maxAudioSeconds = Number(process.env.MAX_AUDIO_SECONDS ?? '120')

  // 1. Metadata — URL + mime_type + file_size (se disponível)
  const metadata = await fetchMediaMetadata(mediaId, accessToken)

  // Early rejection via file_size (evita download se metadata já diz que é grande)
  if (metadata.fileSize && metadata.fileSize > maxBytes) {
    throw new MediaTooLargeError(metadata.fileSize, maxBytes)
  }

  if (opts?.isAudio && metadata.durationSeconds && metadata.durationSeconds > maxAudioSeconds) {
    throw new AudioTooLongError(metadata.durationSeconds, maxAudioSeconds)
  }

  // 2. Download com Authorization
  const res = await fetch(metadata.url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`[mediaDownloader] ${res.status} ao baixar media ${mediaId}: ${body.slice(0, 200)}`)
  }

  const arrayBuffer = await res.arrayBuffer()
  const sizeBytes = arrayBuffer.byteLength

  // Late rejection — se metadata.file_size estava ausente
  if (sizeBytes > maxBytes) {
    throw new MediaTooLargeError(sizeBytes, maxBytes)
  }

  const base64 = Buffer.from(arrayBuffer).toString('base64')

  return {
    base64,
    mimeType: metadata.mimeType,
    sizeBytes,
    durationSeconds: metadata.durationSeconds,
  }
}

/**
 * Consulta /{media_id} do Graph API pra pegar URL temporária + metadata.
 */
async function fetchMediaMetadata(mediaId: string, accessToken: string): Promise<MediaMetadata> {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${mediaId}?fields=url,mime_type,file_size,messaging_product`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(
      `[mediaDownloader] metadata ${res.status} pra media ${mediaId}: ${body.slice(0, 200)}`
    )
  }

  const data = (await res.json()) as {
    url?: string
    mime_type?: string
    file_size?: number
    duration?: number
  }

  if (!data.url || !data.mime_type) {
    throw new Error(`[mediaDownloader] metadata incompleta pra media ${mediaId}`)
  }

  return {
    url: data.url,
    mimeType: data.mime_type,
    fileSize: typeof data.file_size === 'number' ? data.file_size : undefined,
    // Cloud API não expõe duration no /media (só no webhook payload do áudio).
    // Caller deve passar durationSeconds via verificação no worker antes de chamar.
    durationSeconds: typeof data.duration === 'number' ? data.duration : undefined,
  }
}

function mustEnv(key: string): string {
  const v = process.env[key]
  if (!v) throw new Error(`env ${key} missing`)
  return v
}
