import { createSavepoint } from '../engine/index.js';
import { createDashboard } from './server.js';

const port = Number(process.env.DASHBOARD_PORT ?? 3000);
const sp = createSavepoint({ log: (m) => console.log(`[savepoint] ${m}`) });
// The dashboard owns an airlock worker so held mail is delivered on schedule.
await sp.init(); // MinIO buckets + offline GitHub sandbox
const worker = sp.config.airlock.runWorker ? sp.startAirlockWorker() : null;
const { server, drills } = createDashboard({ sp, port });

server.on('listening', () => {
  console.log(`\n  Savepoint dashboard  →  http://localhost:${port}`);
  console.log(`  airlock hold ${sp.config.airlock.holdSeconds}s · worker ${worker ? 'on' : 'off'} · Mailpit http://localhost:8025\n`);
});
server.on('error', (err: NodeJS.ErrnoException) => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${port} is already in use (set DASHBOARD_PORT to change it).` : err);
  process.exit(1);
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  drills.stop();
  server.close();
  await worker?.stop();
  await sp.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
