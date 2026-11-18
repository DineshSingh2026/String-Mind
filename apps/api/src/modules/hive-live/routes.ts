/** Hive Live: GET /status (is the showcase stream running?). The stream itself is a self-rescheduling job. */
import type { FastifyInstance } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { registerJob } from '../../jobs/queue.js';
import { HIVE_LIVE_JOB, ensureHiveLiveScheduled, hiveLiveEnabled, hiveLiveTick } from './engine.js';

export function registerJobs() {
  registerJob(HIVE_LIVE_JOB, async () => {
    try { await hiveLiveTick(); } finally { await ensureHiveLiveScheduled(); }
  });
}

export default async function routes(app: FastifyInstance) {
  app.get('/status', { config: { public: true } }, async () => {
    const [d] = await db().select({ n: sql<number>`count(*)::int` }).from(schema.debates).where(and(eq(schema.debates.demo, true), eq(schema.debates.status, 'live')));
    const [r] = await db().select({ n: sql<number>`count(*)::int` }).from(schema.trainingSessions).where(and(eq(schema.trainingSessions.status, 'active'), sql`${schema.trainingSessions.plan}->>'live' = 'true'`));
    return { enabled: hiveLiveEnabled(), liveDebates: Number(d?.n ?? 0), liveRooms: Number(r?.n ?? 0) };
  });
}
