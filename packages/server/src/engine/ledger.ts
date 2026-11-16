import type pg from 'pg';

export type ActionType = 'pg.update' | 'pg.delete' | 'stripe.refund';
export type SnapshotStatus = 'pending' | 'applied' | 'blocked' | 'failed' | 'reverted' | 'revert_failed';

export interface SnapshotRow {
  id: string;
  run_id: string;
  seq: number;
  action_type: ActionType;
  target: string;
  status: SnapshotStatus;
  request: unknown;
  before_state: unknown;
  after_state: unknown | null;
  rows_affected: number | null;
  amount_cents: string | null;
  block_reason: string | null;
  error: string | null;
  compensation: unknown | null;
  created_at: Date;
  reverted_at: Date | null;
}

export interface NewSnapshot {
  runId: string;
  seq: number;
  actionType: ActionType;
  target: string;
  status: SnapshotStatus;
  request: unknown;
  beforeState: unknown;
  afterState?: unknown;
  rowsAffected?: number;
  amountCents?: number;
  blockReason?: string;
}

export const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function runLockKey(runId: string): string {
  return `savepoint:run:${runId}`;
}

/**
 * Serialises every mutation (and revert) within one run, so per-run `seq` is
 * gap-free and LIFO order is exactly the order the calls were applied in.
 * Must be called inside a transaction.
 */
export async function lockRunXact(client: pg.PoolClient, runId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [runLockKey(runId)]);
}

export async function nextSeq(client: pg.PoolClient, runId: string): Promise<number> {
  const { rows } = await client.query<{ seq: number }>(
    'SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM savepoint_snapshots WHERE run_id = $1',
    [runId],
  );
  return rows[0]!.seq;
}

export async function insertSnapshot(client: pg.PoolClient | pg.Pool, s: NewSnapshot): Promise<SnapshotRow> {
  const { rows } = await client.query<SnapshotRow>(
    `INSERT INTO savepoint_snapshots
       (run_id, seq, action_type, target, status, request, before_state, after_state,
        rows_affected, amount_cents, block_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      s.runId,
      s.seq,
      s.actionType,
      s.target,
      s.status,
      JSON.stringify(s.request),
      JSON.stringify(s.beforeState),
      s.afterState === undefined ? null : JSON.stringify(s.afterState),
      s.rowsAffected ?? null,
      s.amountCents ?? null,
      s.blockReason ?? null,
    ],
  );
  return rows[0]!;
}

export function assertRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new SavepointError('invalid_run_id', `runId must match ${RUN_ID_PATTERN}`);
  }
}

export class SavepointError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SavepointError';
  }
}
