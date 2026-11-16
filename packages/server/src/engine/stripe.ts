import type pg from 'pg';
import Stripe from 'stripe';
import { z } from 'zod';
import { evaluateGate, type GateLimits } from './gate.js';
import {
  assertRunId,
  insertSnapshot,
  lockRunXact,
  nextSeq,
  SavepointError,
  type SnapshotRow,
} from './ledger.js';

export const refundRequestSchema = z
  .object({
    runId: z.string(),
    paymentIntentId: z.string().startsWith('pi_').optional(),
    chargeId: z.string().startsWith('ch_').optional(),
    /** Omit to refund the full remaining refundable amount. */
    amountCents: z.number().int().positive().optional(),
    reason: z.enum(['duplicate', 'fraudulent', 'requested_by_customer']).optional(),
  })
  .refine((r) => Boolean(r.paymentIntentId) !== Boolean(r.chargeId), {
    message: 'Provide exactly one of paymentIntentId or chargeId',
  });
export type RefundRequest = z.infer<typeof refundRequestSchema>;

export type RefundResult =
  | { status: 'applied'; runId: string; seq: number; snapshotId: string; amountCents: number; refundId: string; refundStatus: string | null }
  | { status: 'blocked'; runId: string; seq: number; snapshotId: string; amountCents: number; reason: string }
  | { status: 'pending'; runId: string; seq: number; snapshotId: string; amountCents: number; error: string };

interface RefundBeforeState {
  charge: Stripe.Charge;
  paymentIntent: Stripe.PaymentIntent | null;
}

const idOf = (v: string | { id: string } | null | undefined) => (v == null ? null : typeof v === 'string' ? v : v.id);

export interface StripeProxyDeps {
  pool: pg.Pool;
  stripe: Stripe | null;
  limits: GateLimits;
}

export class StripeProxy {
  constructor(private readonly deps: StripeProxyDeps) {}

  private get stripe(): Stripe {
    if (!this.deps.stripe) throw new SavepointError('stripe_not_configured', 'STRIPE_SECRET_KEY is not set');
    return this.deps.stripe;
  }

  async refund(req: RefundRequest): Promise<RefundResult> {
    assertRunId(req.runId);
    const stripe = this.stripe;

    // 1. Pre-flight: capture the exact Before State from Stripe.
    let paymentIntent: Stripe.PaymentIntent | null = null;
    let charge: Stripe.Charge;
    if (req.paymentIntentId) {
      paymentIntent = await stripe.paymentIntents.retrieve(req.paymentIntentId, { expand: ['latest_charge'] });
      const latest = paymentIntent.latest_charge;
      if (!latest) throw new SavepointError('no_charge', `${req.paymentIntentId} has no charge to refund`);
      charge = typeof latest === 'string' ? await stripe.charges.retrieve(latest) : latest;
    } else {
      charge = await stripe.charges.retrieve(req.chargeId!);
      const piId = idOf(charge.payment_intent);
      if (piId) paymentIntent = await stripe.paymentIntents.retrieve(piId);
    }
    const refundable = charge.amount_captured - charge.amount_refunded;
    const amountCents = req.amountCents ?? refundable;
    if (amountCents <= 0) throw new SavepointError('nothing_refundable', `Charge ${charge.id} has nothing left to refund`);
    if (amountCents > refundable) {
      throw new SavepointError('over_refund', `Requested ${amountCents} but only ${refundable} cents are refundable on ${charge.id}`);
    }
    const before: RefundBeforeState = { charge, paymentIntent };

    // 2. Gate + ledger write (committed BEFORE the external call).
    const decision = evaluateGate({ rowsAffected: 1, amountCents }, this.deps.limits);
    const client = await this.deps.pool.connect();
    let snap: SnapshotRow;
    try {
      await client.query('BEGIN');
      await lockRunXact(client, req.runId);
      const seq = await nextSeq(client, req.runId);
      snap = await insertSnapshot(client, {
        runId: req.runId,
        seq,
        actionType: 'stripe.refund',
        target: charge.id,
        status: decision.allowed ? 'pending' : 'blocked',
        request: req,
        beforeState: before,
        rowsAffected: 1,
        amountCents,
        ...(decision.allowed ? {} : { blockReason: decision.reason }),
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    const base = { runId: req.runId, seq: snap.seq, snapshotId: snap.id, amountCents };
    if (!decision.allowed) return { status: 'blocked', ...base, reason: decision.reason };

    // 3. Execute. The idempotency key ties the Stripe refund to this ledger row.
    try {
      const refund = await stripe.refunds.create(
        {
          charge: charge.id,
          amount: amountCents,
          ...(req.reason ? { reason: req.reason } : {}),
          metadata: { savepoint_run_id: req.runId, savepoint_snapshot_id: snap.id },
        },
        { idempotencyKey: `savepoint-refund-${snap.id}` },
      );
      await this.deps.pool.query(
        `UPDATE savepoint_snapshots SET status = 'applied', after_state = $2 WHERE id = $1`,
        [snap.id, JSON.stringify(refund)],
      );
      return { status: 'applied', ...base, refundId: refund.id, refundStatus: refund.status };
    } catch (err) {
      const message = (err as Error).message;
      if (err instanceof Stripe.errors.StripeConnectionError || err instanceof Stripe.errors.StripeAPIError) {
        // Outcome unknown: leave 'pending' so revert() reconciles against Stripe.
        await this.deps.pool.query(`UPDATE savepoint_snapshots SET error = $2 WHERE id = $1`, [snap.id, message]);
        return { status: 'pending', ...base, error: message };
      }
      await this.deps.pool.query(`UPDATE savepoint_snapshots SET status = 'failed', error = $2 WHERE id = $1`, [snap.id, message]);
      throw err;
    }
  }

  /**
   * Compensating inverse of a refund. Stripe refunds cannot be undone directly,
   * so: cancel it if it is still cancellable; otherwise re-charge the same
   * amount to the same customer + payment method (off-session).
   */
  async compensate(snap: SnapshotRow): Promise<Record<string, unknown>> {
    const stripe = this.stripe;
    const before = snap.before_state as RefundBeforeState;
    let refund = (snap.after_state as Stripe.Refund | null) ?? null;

    if (!refund) {
      // 'pending' snapshot: find out whether the refund actually happened.
      const list = await stripe.refunds.list({ charge: before.charge.id, limit: 100 });
      refund = list.data.find((r) => r.metadata?.savepoint_snapshot_id === snap.id) ?? null;
      if (!refund) return { type: 'noop', note: 'Refund was never created at Stripe' };
    }

    refund = await stripe.refunds.retrieve(refund.id);
    if (refund.status === 'failed' || refund.status === 'canceled') {
      return { type: 'noop', refundId: refund.id, note: `Refund already ${refund.status}` };
    }
    if (refund.status === 'pending' || refund.status === 'requires_action') {
      try {
        const cancelled = await stripe.refunds.cancel(refund.id);
        return { type: 'refund_cancelled', refundId: cancelled.id, refundStatus: cancelled.status };
      } catch {
        // Not cancellable after all; fall through to re-charge.
      }
    }

    const pi = before.paymentIntent;
    const customer = idOf(pi?.customer);
    const paymentMethod = idOf(pi?.payment_method);
    if (!pi || !customer || !paymentMethod) {
      throw new SavepointError(
        'not_compensable',
        `Refund ${refund.id} succeeded and the original payment has no reusable customer + payment method; manual action required`,
      );
    }
    const recharge = await stripe.paymentIntents.create(
      {
        amount: refund.amount,
        currency: refund.currency,
        customer,
        payment_method: paymentMethod,
        confirm: true,
        off_session: true,
        description: `Savepoint revert of ${refund.id} (run ${snap.run_id})`,
        metadata: { savepoint_run_id: snap.run_id, savepoint_snapshot_id: snap.id, savepoint_reverses: refund.id },
      },
      { idempotencyKey: `savepoint-revert-${snap.id}` },
    );
    if (recharge.status !== 'succeeded') {
      throw new SavepointError('recharge_failed', `Compensating charge ${recharge.id} ended in status ${recharge.status}`);
    }
    return { type: 'recharged', refundId: refund.id, paymentIntentId: recharge.id, amountCents: recharge.amount };
  }
}
