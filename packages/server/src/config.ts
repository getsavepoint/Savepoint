import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Load the monorepo-root .env (packages/server/src -> repo root). Real env vars win.
const here = dirname(fileURLToPath(import.meta.url));
for (const candidate of [resolve(here, '../../../.env'), resolve(process.cwd(), '.env')]) {
  if (existsSync(candidate)) {
    process.loadEnvFile(candidate);
    break;
  }
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  return n;
}

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://savepoint:savepoint_dev_password@localhost:5432/savepoint_db',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  smtp: {
    host: process.env.SMTP_HOST ?? 'localhost',
    port: int('SMTP_PORT', 1025),
    from: process.env.SMTP_FROM ?? 'savepoint-agent@savepoint.local',
  },
  stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? '',
  gate: {
    /** A single call may touch at most this many rows (strictly more is blocked). */
    maxRows: int('SAVEPOINT_MAX_ROWS', 10),
    /** A single call may move at most this many cents (strictly more is blocked). $1,000 by default. */
    maxAmountCents: int('SAVEPOINT_MAX_AMOUNT_CENTS', 100_000),
  },
  airlock: {
    holdSeconds: int('SAVEPOINT_AIRLOCK_SECONDS', 60),
    runWorker: (process.env.SAVEPOINT_RUN_AIRLOCK_WORKER ?? 'true') !== 'false',
  },
  /** Columns whose numeric change counts as money moved for the $ gate. */
  monetaryColumns: ['balance_cents'],
  /** Tables an agent may never mutate through the proxy. */
  protectedTablePrefixes: ['savepoint_', 'schema_migrations', 'pg_'],
} as const;

export type Config = typeof config;
