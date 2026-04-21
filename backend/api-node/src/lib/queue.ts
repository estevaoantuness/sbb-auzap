import PgBoss from 'pg-boss'

/**
 * pg-boss em sbb-postgres — fila persistente pra mensagens inbound.
 *
 * Features usadas:
 *   - singletonKey = conversa_id → serializa processamento por conversa
 *   - startAfter (delay) + merge = coalescing de burst
 *   - expireInSeconds = job timeout → DLQ
 *
 * Schema pgboss.* é criado automaticamente na primeira execução.
 */

export const QUEUE_INBOUND = 'auzap:msg_inbound'
export const QUEUE_RETRY_SEND = 'auzap:retry_send'

let bossInstance: PgBoss | null = null

export async function getBoss(): Promise<PgBoss> {
  if (bossInstance) return bossInstance

  const boss = new PgBoss({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.PGBOSS_POOL_MAX ?? '5'),     // pool separado do Prisma
    archiveCompletedAfterSeconds: 60 * 60 * 24,           // histórico 24h
    deleteAfterDays: 7,                                   // purge
    retentionHours: 24 * 7,
  })

  boss.on('error', (err) => console.error('[pg-boss] error', err))
  await boss.start()
  bossInstance = boss
  return boss
}

export interface InboundJob {
  waId: string               // telefone Cloud API wa_id
  messageId: string          // Meta wamid
  conversaId?: number        // preenchido no primeiro enqueue se lead já existe
  userMessage: string
  mediaType?: 'audio' | 'image' | 'document'
  mediaUrl?: string
  receivedAt: string         // ISO timestamp
}

/**
 * Enqueue com coalescing window — se nova msg do mesmo waId chega em <COALESCING_WINDOW_MS,
 * pg-boss mantém o job pendente (singletonKey) e o worker pega o último.
 * Pra agregar MENSAGENS concatenadas num único turno, usar merger custom no worker.
 */
export async function enqueueInbound(job: InboundJob): Promise<string | null> {
  const boss = await getBoss()
  const windowMs = Number(process.env.COALESCING_WINDOW_MS ?? '8000')

  return boss.send(QUEUE_INBOUND, job as unknown as object, {
    singletonKey: `conv:${job.waId}`,
    startAfter: Math.ceil(windowMs / 1000),
    expireInSeconds: 900,                                 // 15min → DLQ
    retryLimit: 3,
    retryBackoff: true,
  })
}

/**
 * Registrar worker — chamado no startup do api-node.
 * pg-boss v10 usa `batchSize` e `includeMetadata` no WorkOptions (teamSize removido na v10).
 */
export async function registerInboundWorker(
  handler: (jobs: InboundJob[]) => Promise<void>
): Promise<void> {
  const boss = await getBoss()
  const concurrency = Number(process.env.INBOUND_CONCURRENCY ?? '10')

  await boss.work<InboundJob>(
    QUEUE_INBOUND,
    { batchSize: concurrency },
    async (jobs) => {
      const payloads = jobs.map((j) => j.data)
      await handler(payloads)
    }
  )
}

/**
 * Job agendado — agregador de jobs schedulados.
 * Substituto do pg_cron se este não estiver disponível (fallback do D9 caminho C).
 */
export async function scheduleMaintenanceJobs(): Promise<void> {
  const boss = await getBoss()

  // Ex: boss.schedule('rotate-partitions', '0 3 * * *', { task: 'rotate_runs_partitions' })
  await boss.schedule('rotate-partitions', '0 3 * * *', {})
  await boss.schedule('purge-pii', '15 3 * * *', {})
  await boss.schedule('cleanup-tool-cache', '0 * * * *', {})
  await boss.schedule('close-inactive-conversations', '*/15 * * * *', {})
}
