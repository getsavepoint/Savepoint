# Savepoint (prototype)

A safety proxy for AI agents. It sits between an agent and the systems it changes:

- **Pre-flight snapshot and blast-radius gate.** Postgres `UPDATE`/`DELETE` and Stripe refunds go through the proxy. A single call that affects more than 10 rows or moves more than $1,000 is blocked. Every call is recorded in `savepoint_snapshots`, blocked ones included, and each applied call stores the exact Before State.
- **60-second staging airlock.** Outbound email waits in `savepoint_airlock_queue`, pinned by a Redis key with a TTL. After 60s it is released to SMTP (Mailpit).
- **Deterministic LIFO `revert(runId)`.** This cancels the run's held emails. Then it undoes every applied action in reverse `seq` order: it restores or re-inserts Postgres rows from the snapshots, and it compensates Stripe refunds, either by cancelling them or by re-charging the same amount off-session. It stops at the first failure and resumes when you call it again.

## Packages

| Package | What |
| --- | --- |
| `packages/server` (`@savepoint/server`) | Engine, migrations and seed, MCP server (stdio), airlock worker |
| `packages/sdk` (`@savepoint/sdk`) | Typed client (`SavepointClient` / `SavepointRun`) that talks to the MCP server |

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

`savepoint_db_update`, `savepoint_db_delete`, `savepoint_stripe_refund`, `savepoint_send_email`, `savepoint_revert`, `savepoint_get_run`. When the gate blocks a call, the tool returns `isError: true` with `status: "blocked"` and the reason.

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

## Licensing (open core)

| Path | License |
| --- | --- |
| `packages/sdk` | MIT |
| `packages/server` | FSL-1.1-MIT (converts to MIT after two years) |
| `ee/` | Proprietary, all rights reserved |
