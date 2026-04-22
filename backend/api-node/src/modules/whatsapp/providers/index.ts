/**
 * Provider selector — escolhe Baileys (default MVP) ou Cloud API (v2) via env.
 *
 *   WHATSAPP_PROVIDER=baileys  (default)
 *   WHATSAPP_PROVIDER=cloud_api
 */

import type { MessagingProvider } from './types'
import { baileysProvider } from './baileys'
import * as cloudApi from './cloudApi'
import { evolutionProvider } from './evolution'

function cloudApiAdapter(): MessagingProvider {
  return {
    async start() {
      // Cloud API não precisa start — webhook externo é push
    },
    sendMessage: (to, body, opts) => cloudApi.sendMessage(to, body, opts),
    markAsRead: (id) => cloudApi.markAsRead(id),
    async getStatus() {
      const tier = await cloudApi.getTier().catch(() => null)
      return {
        provider: 'cloud_api' as const,
        status: tier ? 'connected' : 'unknown',
        tier: tier ?? undefined,
        phoneNumber: process.env.WABA_PHONE_NUMBER_ID,
      }
    },
  }
}

let cached: MessagingProvider | null = null

export function getProvider(): MessagingProvider {
  if (cached) return cached
  const choice = (process.env.WHATSAPP_PROVIDER || 'baileys').toLowerCase()
  switch (choice) {
    case 'cloud_api':
      cached = cloudApiAdapter()
      break
    case 'evolution':
      cached = evolutionProvider
      break
    default:
      cached = baileysProvider
  }
  const resolved =
    choice === 'cloud_api' || choice === 'evolution' ? choice : 'baileys'
  console.log(`[whatsapp] provider selecionado: ${resolved}`)
  return cached
}

export async function startProvider(): Promise<void> {
  const p = getProvider()
  await p.start()
}

export type { MessagingProvider, ProviderStatus, SendOptions } from './types'
