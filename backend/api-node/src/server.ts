import 'dotenv/config'
import app from './app'
import { getBoss, scheduleMaintenanceJobs } from './lib/queue'
import { startInboundWorker } from './modules/whatsapp/worker'
import { registerRetryWorker } from './modules/whatsapp/retrySender'
import { startProvider } from './modules/whatsapp/providers'

async function main() {
  const boss = await getBoss()
  console.log('[server] pg-boss started')

  await startInboundWorker()
  console.log('[server] inbound worker started')

  await registerRetryWorker()
  console.log('[server] retry worker registered')

  await startProvider()
  console.log('[server] whatsapp provider started')

  await scheduleMaintenanceJobs()
  console.log('[server] maintenance jobs scheduled')

  const port = Number(process.env.PORT ?? 3000)
  const server = app.listen(port, () => {
    console.log(`[server] listening on ${port}`)
  })

  const shutdown = async (signal: string) => {
    console.log(`[server] ${signal} — stopping gracefully`)
    try {
      server.close()
      await boss.stop()
    } catch (err) {
      console.error('[server] erro no shutdown', err)
    }
    process.exit(0)
  }

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM')
  })
  process.on('SIGINT', () => {
    void shutdown('SIGINT')
  })
}

main().catch((err) => {
  console.error('[server] fatal', err)
  process.exit(1)
})
