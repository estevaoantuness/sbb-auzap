/**
 * Interface comum pra providers WhatsApp — Baileys (MVP) e Cloud API (v2).
 * Seleção via env WHATSAPP_PROVIDER=baileys|cloud_api (default baileys).
 */

export type MessagingStatus =
  | 'disconnected'
  | 'connecting'
  | 'qr_pending'
  | 'connected'
  | 'banned'
  | 'unknown'

export interface ProviderStatus {
  provider: 'baileys' | 'cloud_api'
  status: MessagingStatus
  phoneNumber?: string           // só se connected (Baileys) ou sempre (Cloud API)
  tier?: string                  // só Cloud API (messaging_limit_tier)
  qrCodeDataUrl?: string         // só se status=qr_pending (Baileys)
  connectedAt?: string           // ISO
}

export interface SendOptions {
  previewUrl?: boolean
  quotedWamid?: string
}

export interface MessagingProvider {
  /** Inicializa provider (load session, start socket etc). Idempotente. */
  start(): Promise<void>

  /** Envia texto. Retorna message id (wamid ou baileys key.id). Throws em falha. */
  sendMessage(to: string, body: string, opts?: SendOptions): Promise<string>

  /** Marca msg como lida (✓✓ azul). */
  markAsRead(messageId: string): Promise<void>

  /** Status atual da conexão. */
  getStatus(): Promise<ProviderStatus>

  /** Só pra Baileys: retorna QR atual (data URL) se status=qr_pending. */
  getQR?(): Promise<string | null>

  /** Só pra Baileys: desconecta/loga out. */
  disconnect?(): Promise<void>
}
