/**
 * Durable background job queue backed by the `jobs` table (no Redis needed locally).
 * Interface is intentionally small so it can be swapped for BullMQ/Redis in production.
 *
 *   registerJob('assessment.run', async (payload) => { ... })
 *   await enqueue('assessment.run', { assessmentId }, { delayMs: 0 })
 */
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import { db, rowsOf, schema } from '../db/client.js';
import { config } from '../lib/config.js';

type Handler = (payload: Record<string, unknown>, job: { id: string; attempts: number }) => Promise<void>;
const handlers = new Map<string, Handler>();
let timer: NodeJS.Timeout | null = null;
let running = 0;
let stopping = false;
/** ids of jobs this process is executing right now (released back to the queue on shutdown) */
const inFlight = new Set<string>();
const MAX_CONCURRENCY = 4;

export function registerJob(type: string, handler: Handler) {
  if (handlers.has(type)) throw new Error(`Job handler already registered: ${type}`);
  handlers.set(type, handler);
}

export async function enqueue(type: string, payload: Record<string, unknown>, opts: { delayMs?: number; maxAttempts?: number } = {}) {
  const [job] = await db().insert(schema.jobs).values({
    type, payload, runAt: new Date(Date.now() + (opts.delayMs ?? 0)), maxAttempts: opts.maxAttempts ?? 3,
  }).returning();
  if (!config.DISABLE_JOBS) setImmediate(() => void tick().catch((e) => console.error('[jobs] tick error', e)));
  return job;
}

async function claim() {
  // single-process claim; with real Postgres use FOR UPDATE SKIP LOCKED (kept compatible below)
  const rows = await db().execute<{ id: string }>(sql`
    UPDATE jobs SET status = 'running', locked_at = now(), attempts = attempts + 1
    WHERE id = (
      SELECT id FROM jobs WHERE status = 'queued' AND run_at <= now()
      ORDER BY run_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED
    ) RETURNING id`);
  const id = rowsOf<{ id: string }>(rows)[0]?.id;
  if (!id) return null;
  const [job] = await db().select().from(schema.jobs).where(eq(schema.jobs.id, id));
  return job ?? null;
}

async function runOne(job: typeof schema.jobs.$inferSelect) {
  const h = handlers.get(job.type);
  inFlight.add(job.id);
  try {
    if (!h) throw new Error(`No handler for job type ${job.type}`);
    await h(job.payload, { id: job.id, attempts: job.attempts });
    await db().update(schema.jobs).set({ status: 'completed', completedAt: new Date(), lastError: null }).where(eq(schema.jobs.id, job.id));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const retry = job.attempts < job.maxAttempts;
    await db().update(schema.jobs).set({
      status: retry ? 'queued' : 'failed', lastError: msg, lockedAt: null,
      runAt: new Date(Date.now() + 2 ** job.attempts * 1000),
    }).where(eq(schema.jobs.id, job.id));
    console.error(`[jobs] ${job.type} ${job.id} failed (attempt ${job.attempts}/${job.maxAttempts}): ${msg}`);
  } finally {
    inFlight.delete(job.id);
  }
}

export async function tick() {
  while (running < MAX_CONCURRENCY && !stopping) {
    const job = await claim();
    if (!job) return;
    running++;
    void runOne(job).finally(() => { running--; if (!stopping) void tick().catch((e) => console.error('[jobs] tick error', e)); });
  }
}

/** Run all due jobs to completion (used by tests). */
export async function drain(maxLoops = 200) {
  for (let i = 0; i < maxLoops; i++) {
    const job = await claim();
    if (!job) {
      if (running === 0) return;
      await new Promise((r) => setTimeout(r, 10));
      continue;
    }
    await runOne(job);
  }
}

export async function startWorker() {
  if (config.DISABLE_JOBS) return;
  stopping = false;
  // recover jobs left 'running' by a crash
  await db().update(schema.jobs).set({ status: 'queued', lockedAt: null })
    .where(and(eq(schema.jobs.status, 'running'), lte(schema.jobs.lockedAt, new Date(Date.now() - 5 * 60_000))));
  timer = setInterval(() => void tick().catch((e) => console.error('[jobs] tick error', e)), config.JOB_POLL_MS);
}

/**
 * Graceful stop (SIGTERM on deploy/scale-down): stop claiming, give in-flight jobs `graceMs` to finish, then put any
 * still running back to 'queued' (attempt not counted) so the next instance picks them up immediately instead of
 * waiting for the 5-minute stale-lock recovery.
 */
export async function stopWorker(graceMs = 10_000) {
  stopping = true;
  if (timer) clearInterval(timer);
  timer = null;
  const deadline = Date.now() + graceMs;
  while (inFlight.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  const left = [...inFlight];
  if (!left.length) return;
  try {
    await db().update(schema.jobs).set({ status: 'queued', lockedAt: null, runAt: new Date(), attempts: sql`greatest(${schema.jobs.attempts} - 1, 0)` })
      .where(and(inArray(schema.jobs.id, left), eq(schema.jobs.status, 'running')));
    console.warn(`[jobs] released ${left.length} in-flight job(s) back to the queue on shutdown`);
  } catch (e) {
    console.error('[jobs] could not release in-flight jobs on shutdown (they will be recovered after 5 min)', e);
  }
}

export { asc };
