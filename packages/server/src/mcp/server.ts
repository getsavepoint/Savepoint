import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { emailRequestSchema } from '../engine/airlock.js';
import type { Savepoint } from '../engine/index.js';
import { RUN_ID_PATTERN } from '../engine/ledger.js';
import { deleteRequestSchema, updateRequestSchema } from '../engine/postgres.js';
import { refundRequestSchema } from '../engine/stripe.js';

const runId = z.string().regex(RUN_ID_PATTERN).describe('Agent run / session id. Every action in a run can be reverted together.');

type ToolResult = {
  content: { type: 'text'; text: string }[];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};

function ok(value: unknown, isError = false): ToolResult {
  const structured = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  return { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured, ...(isError ? { isError } : {}) };
}

async function guard(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const value = (await fn()) as { status?: string };
    // A blocked call is a tool-level failure the agent must see and react to.
    return ok(value, value?.status === 'blocked');
  } catch (err) {
    const e = err as Error & { code?: string };
    return ok({ status: 'error', code: e.code ?? 'internal_error', message: e.message }, true);
  }
}

export function createMcpServer(sp: Savepoint): McpServer {
  const server = new McpServer({ name: 'savepoint', version: '0.1.0' }, { capabilities: { tools: {} } });
  const { maxRows, maxAmountCents } = sp.config.gate;
  const gateNote = `Blocked if it affects more than ${maxRows} rows or moves more than $${maxAmountCents / 100} in one call; the Before State is snapshotted so the run can be reverted.`;

  server.registerTool(
    'savepoint_db_update',
    {
      title: 'Update rows (gated + snapshotted)',
      description: `UPDATE rows in a Postgres table. "where" maps column -> value (equality) or {op, value}; conditions are AND-ed. ${gateNote}`,
      inputSchema: updateRequestSchema.extend({ runId }),
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    (args) => guard(() => sp.updateRows(args)),
  );

  server.registerTool(
    'savepoint_db_delete',
    {
      title: 'Delete rows (gated + snapshotted)',
      description: `DELETE rows from a Postgres table. ${gateNote}`,
      inputSchema: deleteRequestSchema.extend({ runId }),
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    (args) => guard(() => sp.deleteRows(args)),
  );

  server.registerTool(
    'savepoint_stripe_refund',
    {
      title: 'Refund a Stripe payment (gated + snapshotted)',
      description: `Refund a Stripe payment intent or charge (test mode only). Omit amountCents for a full refund. ${gateNote}`,
      inputSchema: refundRequestSchema,
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    (args) => guard(() => sp.refund(args)),
  );

  server.registerTool(
    'savepoint_send_email',
    {
      title: 'Send email via the staging airlock',
      description: `Queue an outbound email. It is held for ${sp.config.airlock.holdSeconds}s in the airlock before delivery and is cancelled if the run is reverted in that window.`,
      inputSchema: emailRequestSchema,
      annotations: { openWorldHint: true },
    },
    (args) => guard(() => sp.sendEmail(args)),
  );

  server.registerTool(
    'savepoint_revert',
    {
      title: 'Revert a run',
      description:
        'Cancel the run\'s held emails, then undo every applied action in strict last-in-first-out order (restore Postgres rows from snapshots, compensate Stripe refunds). Safe to call again; it resumes after a failure.',
      inputSchema: z.object({ runId }),
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    ({ runId }) =>
      guard(async () => {
        const report = await sp.revert(runId);
        return { status: report.complete ? 'reverted' : 'partial', ...report };
      }),
  );

  server.registerTool(
    'savepoint_get_run',
    {
      title: 'Inspect a run',
      description: 'Return the snapshot ledger and airlock queue entries for a run.',
      inputSchema: z.object({ runId }),
      annotations: { readOnlyHint: true },
    },
    ({ runId }) => guard(() => sp.getRun(runId)),
  );

  return server;
}
