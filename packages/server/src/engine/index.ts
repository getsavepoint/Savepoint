import { config as defaultConfig, type Config } from '../config.js';
import { createInfra, type Infra } from '../infra.js';
import { Airlock, type EmailRequest } from './airlock.js';
import { type SnapshotRow } from './ledger.js';
import { PostgresProxy, TableCatalog, type DeleteRequest, type UpdateRequest } from './postgres.js';
import { revertRun } from './revert.js';
import { StripeProxy, type RefundRequest } from './stripe.js';

export interface SavepointOptions {
  infra?: Infra;
  config?: Config;
  log?: (msg: string) => void;
}

export function createSavepoint(opts: SavepointOptions = {}) {
  const cfg = opts.config ?? defaultConfig;
  const infra = opts.infra ?? createInfra();
  const log = opts.log ?? ((m: string) => console.error(`[savepoint] ${m}`));

  const catalog = new TableCatalog(infra.pool, cfg.protectedTablePrefixes);
  const postgres = new PostgresProxy({
    pool: infra.pool,
    catalog,
    limits: cfg.gate,
    monetaryColumns: cfg.monetaryColumns,
  });
  const stripe = new StripeProxy({ pool: infra.pool, stripe: infra.stripe, limits: cfg.gate });
  const airlock = new Airlock({
    pool: infra.pool,
    redis: infra.redis,
    mailer: infra.mailer,
    holdSeconds: cfg.airlock.holdSeconds,
    defaultFrom: cfg.smtp.from,
    log,
  });

  return {
    config: cfg,
    infra,
    updateRows: (req: UpdateRequest) => postgres.update(req),
    deleteRows: (req: DeleteRequest) => postgres.delete(req),
    refund: (req: RefundRequest) => stripe.refund(req),
    sendEmail: (req: EmailRequest) => airlock.enqueue(req),
    revert: (runId: string) => revertRun({ pool: infra.pool, airlock, postgres, stripe }, runId),
    async getRun(runId: string) {
      const { rows } = await infra.pool.query<SnapshotRow>(
        'SELECT * FROM savepoint_snapshots WHERE run_id = $1 ORDER BY seq',
        [runId],
      );
      return { runId, snapshots: rows, emails: await airlock.listRun(runId) };
    },
    airlock,
    startAirlockWorker: (intervalMs?: number) => airlock.startWorker(intervalMs),
    close: () => infra.close(),
  };
}

export type Savepoint = ReturnType<typeof createSavepoint>;
