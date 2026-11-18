import { buildApp } from './app.js';
import { initDb, closeDb } from './db/client.js';
import { migrate } from './db/migrate.js';
import { seed } from './db/seed.js';
import { config } from './lib/config.js';
import { startWorker, stopWorker } from './jobs/queue.js';
import { registerAllJobs } from './modules/index.js';
import { ensureOnchainTickScheduled } from './modules/onchain/worker.js';
import { ensureHiveLiveScheduled } from './modules/hive-live/engine.js';

async function main() {
  const db = await initDb();
  await migrate(db);
  await seed(db, { demo: config.SEED_DEMO });
  registerAllJobs();
  const app = await buildApp();
  await app.listen({ port: config.PORT, host: config.HOST });
  await startWorker();
  await ensureOnchainTickScheduled().catch((e) => console.error('[onchain] could not schedule the worker', e));
  await ensureHiveLiveScheduled().catch((e) => console.error('[hive-live] could not schedule the showcase stream', e));
  // Self-healing: during a rolling deploy the previous server can consume (and drop) a queued tick it does not know.
  // Re-arm the self-rescheduling streams every minute; each ensure* is a no-op when a tick is already queued.
  setInterval(() => {
    void ensureHiveLiveScheduled().catch(() => undefined);
    void ensureOnchainTickScheduled().catch(() => undefined);
  }, 60_000).unref();
  console.log(`\n  Hive Mind API ready  →  http://localhost:${config.PORT}   (db: ${config.DATABASE_URL ? 'postgres' : 'pglite ' + config.PGLITE_DIR})\n`);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[aix] ${signal} received — shutting down gracefully`);
    const force = setTimeout(() => { console.error('[aix] forced exit after 25s'); process.exit(1); }, 25_000);
    force.unref();
    try {
      await app.close();          // stop accepting requests, finish in-flight ones, close sockets
      await stopWorker();         // let running jobs finish (≤10s) or release them back to the queue
      await closeDb();
    } catch (err) {
      console.error('[aix] error during shutdown', err);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[aix] fatal startup error', err);
  process.exit(1);
});
