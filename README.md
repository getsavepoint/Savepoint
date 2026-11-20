https://github.com/user-attachments/assets/88c5df8b-a6a8-4367-90e0-110e434b1a25

# <img src="assets/savepoint-logo.svg" alt="Savepoint" width="34" height="34" align="top"> Savepoint



[![npm: savepoint-sdk](https://img.shields.io/npm/v/savepoint-sdk?label=savepoint-sdk)](https://www.npmjs.com/package/savepoint-sdk) [![npm: savepoint-mcp](https://img.shields.io/npm/v/savepoint-mcp?label=savepoint-mcp)](https://www.npmjs.com/package/savepoint-mcp) · https://github.com/getsavepoint/savepoint

A safety proxy for AI agents. It sits between an agent and the systems it changes:

- **Pre-flight snapshot and blast-radius gate.** Postgres `UPDATE`/`DELETE` and Stripe refunds go through the proxy. A single call that affects more than 10 rows or moves more than $1,000 is blocked. Every call is recorded in `savepoint_snapshots`, blocked ones included, and each applied call stores the exact Before State.
- **60-second staging airlock.** Outbound email waits in `savepoint_airlock_queue`, pinned by a Redis key with a TTL. After 60s it is released to SMTP (Mailpit).
- **Deterministic LIFO `revert(runId)`.** This cancels the run's held emails. Then it undoes every applied action in reverse `seq` order: it restores or re-inserts Postgres rows from the snapshots, and it compensates Stripe refunds, either by cancelling them or by re-charging the same amount off-session. It stops at the first failure and resumes when you call it again.

## 3-line quickstart

```bash
npm install savepoint-sdk      # typed client
npx savepoint-mcp              # the MCP proxy (needs DATABASE_URL / REDIS_URL, see .env.example)
```

```bash
docker compose up -d && npm install && npm run db:seed   # postgres, redis, mailpit, minio (all local, $0)
npm run dashboard                                        # http://localhost:3000 · side-by-side demo: http://localhost:3000/demo
```

```ts
import { SavepointClient } from 'savepoint-sdk';
const sp  = await SavepointClient.connectStdio({ command: 'npx', args: ['-y', 'savepoint-mcp'] });
const run = sp.run();                                       // 1. one run = one undo unit
try { await myAgent(run); } catch { await run.revert(); }   // 2-3. unchanged agent; crash → LIFO undo
```

Works with MCP clients, Anthropic / OpenAI / Gemini tool calls (`anthropicTools`, `openAITools`, `geminiTools` + `run.call(name, args)`)
and LangGraph. Copy-paste snippets for each are in [packages/sdk/README.md](packages/sdk/README.md).
Docker is only needed for the backing services; the dashboard and MCP server run on a current Node (uses `process.loadEnvFile`).
Stop the stack with `docker compose down` (add `-v` to wipe data).

## Packages

| Package | What |
| --- | --- |
| `packages/server` (`savepoint-mcp`) | Engine, migrations and seed, MCP server (stdio), airlock worker |
| `packages/sdk` (`savepoint-sdk`) | Typed client (`SavepointClient` / `SavepointRun`) that talks to the MCP server |

## Quick start

```bash
docker compose up -d
npm install
npm run db:seed            # runs migrations, then seeds 5,000 customers (deterministic)
SAVEPOINT_AIRLOCK_SECONDS=3 npm run demo   # end-to-end assertions
npx tsx packages/sdk/examples/quickstart.ts # SDK -> MCP stdio -> engine
```

- MCP server over stdio: `npm run dev`. It runs the airlock worker in-process unless `SAVEPOINT_RUN_AIRLOCK_WORKER=false`.
- Standalone airlock worker: `npm run worker`.
- Mailpit UI: http://localhost:8025

### MCP tools

`savepoint_db_update`, `savepoint_db_delete`, `savepoint_stripe_refund`, `savepoint_stripe_authorize_hold`, `savepoint_stripe_capture_holds`, `savepoint_send_email`, S3/GitHub/Slack tools, `savepoint_revert`, `savepoint_get_run`. When the gate blocks a call, the tool returns `isError: true` with `status: "blocked"` and the reason.

## Known prototype limits

- The Postgres proxy accepts structured `where`/`set` calls, not raw SQL. Target tables need an `id` primary key. Tables starting with `savepoint_` are protected.
- A Stripe refund can only be compensated if the original PaymentIntent has a customer and a reusable payment method. Otherwise revert stops with `revert_failed` and someone has to fix it by hand. Live keys (`sk_live_`) are refused.
- Email delivery is at-most-once. A message that is mid-send when the process crashes stays in `releasing` and is not retried. Email that has already been sent cannot be recalled; `revert` lists it under `alreadySent`.
- When a revert restores a row that changed after the agent touched it, the row ID is listed under `drifted`. The snapshot is still applied.

## Visual Trace & Airlock Dashboard

```bash
npm run dashboard   # http://localhost:3000 (needs `docker compose up -d`)
```

Live run/tool-call trace with Before-State snapshots, the 60-second staging airlock
(Release Early / Kill Switch), Shadow-State Replay, and a one-click Chaos Drill
(Gemini agent or a deterministic scripted agent). Binds to 127.0.0.1 only.

## Hosted Cloud & Design-Partner Pilot

Skip self-hosting Postgres, Redis, and the airlock worker. We deploy, secure, and manage a dedicated Savepoint instance wired to your stack—complete with private auth, custom blast-radius limits, connector allow-lists, and airlock hold windows.

> [!NOTE]
> **Design-Partner Pilots ($500–$1,000/mo):** Turnkey hosted airlock and custom guardrails for startup teams shipping agents in production. [**Apply for a Hosted Pilot →**](https://tally.so/r/J1l5dY)

### Self-Hosting on Railway (Internal Use)

To self-host `savepoint-mcp` internally using the included `Dockerfile` and `railway.json`:
1. Create a Railway project from this repo and add the Postgres and Redis plugins.
2. Set `DATABASE_URL`, `REDIS_URL`, `DASHBOARD_ALLOWED_HOSTS=<your-app>.up.railway.app`, and (optional) `SAVEPOINT_PILOT_URL`. The container binds `0.0.0.0` and reads Railway's `PORT`.
3. Run `npm run db:migrate -w savepoint-mcp` once in the Railway shell (we recommend starting with Stripe Test Mode keys while validating rules).

*Security note: The open-core dashboard ships without built-in login auth—place self-hosted deployments behind Railway private networking or an auth proxy before exposing publicly.*

## Licensing (open core)

| Path | License |
| --- | --- |
| `packages/sdk` | MIT |
| `packages/server` | FSL-1.1-MIT (converts to MIT after two years) |
| `ee/` | Proprietary, all rights reserved (private, never published to npm) |

## Connectors (Phase 2B)

All five connectors are gated, snapshotted and revertable (strict LIFO) with `$0` local sandboxes:

| Connector | Sandbox | Snapshot | Gate |
| --- | --- | --- | --- |
| PostgreSQL | docker `postgres` | rows as JSON | >10 rows / >$1,000 |
| Stripe | test mode | charge + PI | >$1,000 |
| AWS S3 | docker `minio` (`savepoint-minio`) | bytes + metadata copied to a recovery-vault bucket | >10 object deletes, public ACLs |
| GitHub | built-in offline REST sandbox (:4010); real API when `GITHUB_TOKEN` is set | issue/PR fields, branch head SHAs | >10 items, protected branches |
| Slack | local inbox sink; live when `SLACK_BOT_TOKEN`/`SLACK_WEBHOOK_URL` set | message + airlock row | @channel/external/webhook airlocked 60s; >10 msgs, archiving blocked |

```bash
docker compose up -d      # postgres, redis, mailpit, minio
npm run db:migrate && npm run db:seed
npm test                  # connector integration tests
npm run drill:5tool       # headless 5-tool chaos drill (or use the dashboard button)
```

## Side-by-side disaster demo (Phase 2C)

`npm run dashboard`, then open http://localhost:3000/demo and press **Run Side-by-Side Comparison** (about 45 s, built for a silent launch video).
The same rogue agent runs twice against disposable sandboxes (`demo_*` tables, `demo/` S3 prefixes, an in-memory Stripe; nothing real is touched):

| | Unprotected | Protected by Savepoint |
| --- | --- | --- |
| Step 1: wipe 200 balances | all 200 overwritten | blocked by the gate, retry of 10 is snapshotted |
| Step 2: $249 charge + duplicate $500 refunds | captured, $1,000 out | auth-hold only, refunds snapshotted |
| Step 3: delete 25 invoices, email a stranger | deleted, email delivered | blocked, retry vaulted, email held in the airlock |
| Step 4: crash | permanent damage | `revert(runId)` in well under a second, 100% restored |

## Non-custodial Stripe auth-hold and optional fee

- `savepoint_stripe_authorize_hold` creates a PaymentIntent with `capture_method: 'manual'`: funds are authorized, not moved.
  Call `savepoint_stripe_capture_holds` once the multi-step run verifies cleanly. `revert(runId)` cancels uncaptured holds with
  `paymentIntents.cancel` (a captured hold is refunded instead). Savepoint never holds customer money.
- `SAVEPOINT_CONNECT_FEE_BPS` (default `0`) sets a Stripe Connect `application_fee_amount` on captured holds only.
  Allowed values: `0`, or `25` to `50` (0.25%-0.50%); it requires `SAVEPOINT_CONNECT_ACCOUNT` (hosted Connect mode).
  Self-hosted installs leave it at 0. Database, S3, GitHub and Slack/Email rollbacks are always free.
- Live Stripe test-mode check: `npm run check:stripe-hold -w savepoint-mcp`.
