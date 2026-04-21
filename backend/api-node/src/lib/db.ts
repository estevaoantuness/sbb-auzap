import { PrismaClient } from '@prisma/client'

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined
}

/**
 * Prisma client singleton. Pool size declarado via DATABASE_URL:
 *   postgresql://user:pwd@host:6432/sbb?schema=public&connection_limit=10
 *
 * PgBouncer em SESSION mode (multi-schema requer `SET search_path` persistente).
 */
export const prisma = global.__prisma ?? new PrismaClient({
  log: process.env.NODE_ENV === 'production' ? ['warn', 'error'] : ['query', 'warn', 'error'],
})

if (process.env.NODE_ENV !== 'production') {
  global.__prisma = prisma
}

export default prisma
