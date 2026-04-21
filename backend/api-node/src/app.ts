import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'

import whatsappRoutes from './modules/whatsapp/whatsappRoutes'
import conversationRoutes from './modules/conversations/conversationRoutes'
import clientRoutes from './modules/clients/clientRoutes'
import campaignRoutes from './modules/campaigns/campaigns.routes'
import dashboardRoutes from './modules/dashboard/dashboardRoutes'
import brainRoutes from './modules/brain/brain.routes'
import internalRoutes from './modules/internal/internalRoutes'
import settingsRoutes from './modules/settings/settingsRoutes'
import chatRoutes from './modules/chat/chatRoutes'
import devToolsRoutes from './modules/dev-tools/devToolsRoutes'

dotenv.config()

const VERSION = process.env.APP_VERSION ?? '1.0.0'
const SERVICE_NAME = 'sbb-auzap-api'

const app = express()

// ─────────────────────────────────────────
// CORS
//   - dev (NODE_ENV !== 'production'): libera tudo.
//   - prod: restrict a VITE_API_NODE_URL (dashboard) e a lista opcional
//     ALLOWED_ORIGINS (CSV).
// ─────────────────────────────────────────
const isProd = process.env.NODE_ENV === 'production'
const allowedOrigins = new Set<string>([
  ...(process.env.VITE_API_NODE_URL ? [process.env.VITE_API_NODE_URL] : []),
  ...(process.env.ALLOWED_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean) ?? []),
])

app.use(
  cors({
    origin: (origin, callback) => {
      if (!isProd) return callback(null, true)
      // sem origin = same-origin/curl/healthcheck → permite
      if (!origin) return callback(null, true)
      if (allowedOrigins.has(origin)) return callback(null, true)
      return callback(new Error(`Origin ${origin} not allowed by CORS`))
    },
    credentials: true,
  }),
)

// ─────────────────────────────────────────
// Body parser com captura de rawBody
// CRÍTICO: middleware `metaSignature.ts` valida HMAC do webhook Meta lendo
// `req.rawBody`. Sem o `verify`, a assinatura nunca bate.
// ─────────────────────────────────────────
app.use(
  express.json({
    limit: '5mb',
    verify: (req, _res, buf) => {
      ;(req as any).rawBody = buf
    },
  }),
)

// ─────────────────────────────────────────
// Health
// ─────────────────────────────────────────
app.get('/health', (_req, res) =>
  res.json({ status: 'ok', service: SERVICE_NAME, version: VERSION }),
)

// ─────────────────────────────────────────
// Rotas
// ─────────────────────────────────────────
app.use('/whatsapp', whatsappRoutes)
app.use('/conversations', conversationRoutes)
app.use('/clients', clientRoutes)
app.use('/campaigns', campaignRoutes)
app.use('/dashboard', dashboardRoutes)
app.use('/brain', brainRoutes)
app.use('/internal', internalRoutes)
app.use('/settings', settingsRoutes)
app.use('/chat', chatRoutes)
app.use('/dev-tools', devToolsRoutes)

export default app
