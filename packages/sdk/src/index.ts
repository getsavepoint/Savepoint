import { randomUUID } from 'node:crypto';
import { Client, type Transport } from '@modelcontextprotocol/client';
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/client/stdio';

// ---------------------------------------------------------------------------
// Wire types (mirrors @savepoint/server; kept dependency-free on purpose)
// ---------------------------------------------------------------------------

export type ActionType =
  | 'pg.update' | 'pg.delete' | 'stripe.refund'
  | 's3.put' | 's3.delete' | 's3.acl'
  | 'github.issue_update' | 'github.pr_update' | 'github.branch_delete'
  | 'slack.post' | 'slack.archive';

/** The five core connectors Savepoint wraps. */
export const CONNECTORS = ['postgres', 'stripe', 's3', 'github', 'slack'] as const;
export type Connector = (typeof CONNECTORS)[number];

export type Scalar = string | number | boolean | null;
export type FilterOp = 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte' | 'in' | 'not_in' | 'like' | 'ilike' | 'is_null' | 'not_null';
export type Where = Record<string, Scalar | { op: FilterOp; value?: Scalar | Scalar[] }>;

export interface AppliedMutation {
  status: 'applied';
  runId: string;
  seq: number;
  snapshotId: string;
  rowsAffected: number;
  amountCents: number;
  rows: Record<string, unknown>[];
}
export interface BlockedAction {
  status: 'blocked';
  runId: string;
  seq: number;
  snapshotId: string;
  amountCents: number;
  rowsMatched?: number;
  reason: string;
}
export interface AppliedRefund {
  status: 'applied' | 'pending';
  runId: string;
  seq: number;
  snapshotId: string;
  amountCents: number;
  refundId?: string;
  refundStatus?: string | null;
  error?: string;
}
export interface HeldEmail {
  status: 'held';
  id: string;
  runId: string;
  releaseAt: string;
}
export interface RevertReport {
  status: 'reverted' | 'partial';
  runId: string;
  complete: boolean;
  emails: { cancelled: string[]; alreadySent: string[] };
  slack: RevertSlackReport;
  steps: {
    seq: number;
    snapshotId: string;
    actionType: ActionType;
    target: string;
    status: 'reverted' | 'revert_failed';
    compensation?: Record<string, unknown>;
    error?: string;
  }[];
  remaining: number[];
}
export interface RevertSlackReport { cancelled: string[]; alreadySent: string[] }

export interface RunInfo {
  runId: string;
  snapshots: Record<string, unknown>[];
  emails: Record<string, unknown>[];
  slack: Record<string, unknown>[];
}

export interface RefundInput {
  paymentIntentId?: string;
  chargeId?: string;
  amountCents?: number;
  reason?: 'duplicate' | 'fraudulent' | 'requested_by_customer';
}
export interface EmailInput {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  from?: string;
}

export interface S3PutInput {
  key: string;
  body: string;
  encoding?: 'utf8' | 'base64';
  bucket?: string;
  contentType?: string;
  metadata?: Record<string, string>;
}
export type S3DeleteInput = { bucket?: string } & ({ keys: string[]; prefix?: never } | { prefix: string; keys?: never });
export interface S3Result {
  status: 'applied';
  runId: string; seq: number; snapshotId: string;
  bucket: string; objects: number; keys: string[]; etag?: string; amountCents: 0;
}
export interface GitHubTarget { owner?: string; repo?: string }
export interface GitHubPatch { title?: string; body?: string | null; state?: 'open' | 'closed'; labels?: string[]; base?: string }
export interface GitHubResult {
  status: 'applied';
  runId: string; seq: number; snapshotId: string; repo: string; items: number; numbers?: number[]; branches?: string[]; amountCents: 0;
}
export interface SlackPostInput { channel: string; text: string; threadTs?: string }
export type SlackResult =
  | { status: 'held'; runId: string; seq: number; snapshotId: string; id: string; channel: string; releaseAt: string; reasons: string[]; amountCents: 0 }
  | { status: 'applied'; runId: string; seq: number; snapshotId: string; channel: string; ts: string; backend: 'sink' | 'bot' | 'webhook'; amountCents: 0 };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when the blast-radius gate stops a call. The attempt is still recorded in the ledger. */
export class SavepointBlockedError extends Error {
  constructor(readonly result: BlockedAction) {
    super(result.reason);
    this.name = 'SavepointBlockedError';
  }
}

export class SavepointToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SavepointToolError';
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface SavepointClientOptions {
  /** When true (default), gated calls throw SavepointBlockedError instead of returning the blocked result. */
  throwOnBlocked?: boolean;
}

export class SavepointClient {
  private constructor(
    private readonly client: Client,
    private readonly opts: Required<SavepointClientOptions>,
  ) {}

  static async connect(transport: Transport, opts: SavepointClientOptions = {}): Promise<SavepointClient> {
    const client = new Client({ name: 'savepoint-sdk', version: '0.1.0' });
    await client.connect(transport);
    return new SavepointClient(client, { throwOnBlocked: opts.throwOnBlocked ?? true });
  }

  /** Spawn the Savepoint MCP server as a child process and connect over stdio. */
  static connectStdio(server: StdioServerParameters, opts?: SavepointClientOptions): Promise<SavepointClient> {
    return SavepointClient.connect(new StdioClientTransport(server), opts);
  }

  /** Start (or resume) a run. All actions through the handle share one runId and revert together. */
  run(runId: string = `run_${randomUUID()}`): SavepointRun {
    return new SavepointRun(this, runId);
  }

  close(): Promise<void> {
    return this.client.close();
  }

  /** @internal */
  async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const result = await this.client.callTool({ name, arguments: args });
    const sc = result.structuredContent as (Record<string, unknown> & { status?: string }) | undefined;
    if (sc === undefined) {
      const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
      throw new SavepointToolError('no_structured_content', text || `Tool ${name} returned no data`);
    }
    if (sc.status === 'blocked' && this.opts.throwOnBlocked) throw new SavepointBlockedError(sc as unknown as BlockedAction);
    if (result.isError && sc.status !== 'blocked') {
      throw new SavepointToolError(String(sc.code ?? 'tool_error'), String(sc.message ?? 'Savepoint tool failed'));
    }
    return sc as T;
  }
}

export class SavepointRun {
  constructor(
    private readonly sp: SavepointClient,
    readonly runId: string,
  ) {}

  updateRows(table: string, where: Where, set: Record<string, Scalar>) {
    return this.sp.call<AppliedMutation | BlockedAction>('savepoint_db_update', { runId: this.runId, table, where, set });
  }

  deleteRows(table: string, where: Where) {
    return this.sp.call<AppliedMutation | BlockedAction>('savepoint_db_delete', { runId: this.runId, table, where });
  }

  refund(input: RefundInput) {
    return this.sp.call<AppliedRefund | BlockedAction>('savepoint_stripe_refund', { runId: this.runId, ...input });
  }

  sendEmail(input: EmailInput) {
    return this.sp.call<HeldEmail>('savepoint_send_email', { runId: this.runId, ...input });
  }

  // ---- AWS S3 ----
  s3PutObject(input: S3PutInput) {
    return this.sp.call<S3Result | BlockedAction>('savepoint_s3_put_object', { runId: this.runId, ...input });
  }
  s3DeleteObjects(input: S3DeleteInput) {
    return this.sp.call<S3Result | BlockedAction>('savepoint_s3_delete_objects', { runId: this.runId, ...input });
  }
  s3SetBucketAcl(acl: 'private' | 'public-read' | 'public-read-write' | 'authenticated-read', bucket?: string) {
    return this.sp.call<S3Result | BlockedAction>('savepoint_s3_set_bucket_acl', { runId: this.runId, acl, ...(bucket ? { bucket } : {}) });
  }

  // ---- GitHub ----
  githubUpdateIssues(numbers: number[], patch: GitHubPatch, target: GitHubTarget = {}) {
    return this.sp.call<GitHubResult | BlockedAction>('savepoint_github_update_issues', { runId: this.runId, numbers, patch, ...target });
  }
  githubUpdatePulls(numbers: number[], patch: GitHubPatch, target: GitHubTarget = {}) {
    return this.sp.call<GitHubResult | BlockedAction>('savepoint_github_update_pulls', { runId: this.runId, numbers, patch, ...target });
  }
  githubDeleteBranches(branches: string[], target: GitHubTarget = {}) {
    return this.sp.call<GitHubResult | BlockedAction>('savepoint_github_delete_branches', { runId: this.runId, branches, ...target });
  }

  // ---- Slack ----
  slackPost(input: SlackPostInput) {
    return this.sp.call<SlackResult | BlockedAction>('savepoint_slack_post', { runId: this.runId, ...input });
  }
  slackArchiveChannel(channel: string) {
    return this.sp.call<BlockedAction>('savepoint_slack_archive_channel', { runId: this.runId, channel });
  }

  /** The five connectors grouped by system, e.g. `run.s3.put(...)`, `run.github.deleteBranches(...)`. */
  get postgres() {
    return { update: this.updateRows.bind(this), delete: this.deleteRows.bind(this) };
  }
  get stripe() {
    return { refund: this.refund.bind(this) };
  }
  get s3() {
    return { put: this.s3PutObject.bind(this), delete: this.s3DeleteObjects.bind(this), setBucketAcl: this.s3SetBucketAcl.bind(this) };
  }
  get github() {
    return { updateIssues: this.githubUpdateIssues.bind(this), updatePulls: this.githubUpdatePulls.bind(this), deleteBranches: this.githubDeleteBranches.bind(this) };
  }
  get slack() {
    return { post: this.slackPost.bind(this), archiveChannel: this.slackArchiveChannel.bind(this), email: this.sendEmail.bind(this) };
  }

  revert() {
    return this.sp.call<RevertReport>('savepoint_revert', { runId: this.runId });
  }

  inspect() {
    return this.sp.call<RunInfo>('savepoint_get_run', { runId: this.runId });
  }
}
