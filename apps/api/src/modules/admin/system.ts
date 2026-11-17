import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, gte, ilike, isNull, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db/client.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { PageQuery, offset, parse } from '../../lib/http.js';
import { IdParam, adminAudit } from './common.js';

const isUuid = (s: string) => z.string().uuid().safeParse(s).success;

export default async function system(app: FastifyInstance) {
  /* ───────────── Audit log ───────────── */
  app.get('/audit', async (req) => {
    const q = parse(PageQuery.extend({ action: z.string().optional(), actor: z.string().optional(), orgId: z.string().uuid().optional() }), req.query);
    const conds: SQL[] = [];
    if (q.action) conds.push(ilike(schema.auditLogs.action, `${q.action}%`));
    if (q.orgId) conds.push(eq(schema.auditLogs.orgId, q.orgId));
    if (q.actor) {
      if (isUuid(q.actor)) conds.push(eq(schema.auditLogs.actorUserId, q.actor));
      else conds.push(sql`${schema.auditLogs.actorUserId} in (select id from users where email ilike ${`%${q.actor}%`})`);
    }
    const where = conds.length ? and(...conds) : undefined;
    const [{ total }] = await db().select({ total: count() }).from(schema.auditLogs).where(where);
    const rows = await db().select({ l: schema.auditLogs, email: schema.users.email }).from(schema.auditLogs)
      .leftJoin(schema.users, eq(schema.users.id, schema.auditLogs.actorUserId))
      .where(where).orderBy(desc(schema.auditLogs.createdAt)).limit(q.pageSize).offset(offset(q));
    return { items: rows.map(({ l, email }) => ({ ...l, actorEmail: email })), total: Number(total), page: q.page, pageSize: q.pageSize };
  });

  /* ───────────── Security ───────────── */
  app.get('/security', async () => {
    const d = db();
    const day = new Date(Date.now() - 86400_000);
    const week = new Date(Date.now() - 7 * 86400_000);
    const failed = eq(schema.auditLogs.action, 'auth.login_failed');
    const [c24] = await d.select({ n: count() }).from(schema.auditLogs).where(and(failed, gte(schema.auditLogs.createdAt, day)));
    const [c7] = await d.select({ n: count() }).from(schema.auditLogs).where(and(failed, gte(schema.auditLogs.createdAt, week)));
    const byIp = await d.select({ ip: schema.auditLogs.ip, n: sql<number>`count(*)::int` }).from(schema.auditLogs)
      .where(and(failed, gte(schema.auditLogs.createdAt, week))).groupBy(schema.auditLogs.ip).orderBy(desc(sql`count(*)`)).limit(10);
    const suspicious = await d.select().from(schema.auditLogs)
      .where(or(failed, ilike(schema.auditLogs.action, '%mfa_failed%'), ilike(schema.auditLogs.action, 'admin.%suspend%'), ilike(schema.auditLogs.action, '%plagiarism%'), ilike(schema.auditLogs.action, '%fraud%')))
      .orderBy(desc(schema.auditLogs.createdAt)).limit(50);
    const flagged = await d.select({ m: schema.trainingMessages, subject: schema.trainingSessions.subject }).from(schema.trainingMessages)
      .innerJoin(schema.trainingSessions, eq(schema.trainingSessions.id, schema.trainingMessages.sessionId))
      .where(eq(schema.trainingMessages.flagged, true)).orderBy(desc(schema.trainingMessages.createdAt)).limit(50);
    const [flaggedTotal] = await d.select({ n: count() }).from(schema.trainingMessages).where(eq(schema.trainingMessages.flagged, true));
    const [openFraud] = await d.select({ n: count() }).from(schema.fraudFlags).where(eq(schema.fraudFlags.status, 'open'));
    return {
      failedLogins: { last24h: Number(c24?.n ?? 0), last7d: Number(c7?.n ?? 0), byIp: byIp.map((r) => ({ ip: r.ip, count: Number(r.n) })) },
      suspiciousEvents: suspicious,
      flaggedMessages: { total: Number(flaggedTotal?.n ?? 0), items: flagged.map(({ m, subject }) => ({ id: m.id, sessionId: m.sessionId, subject, senderRole: m.senderRole, senderAgentId: m.senderAgentId, flagReason: m.flagReason, excerpt: m.content.slice(0, 300), createdAt: m.createdAt })) },
      openFraudFlags: Number(openFraud?.n ?? 0),
    };
  });

  /* ───────────── Settings ───────────── */
  app.get('/settings', async () => db().select().from(schema.systemSettings).orderBy(schema.systemSettings.key));
  app.get('/settings/:key', async (req) => {
    const { key } = parse(z.object({ key: z.string().min(1).max(100) }), req.params);
    const [s] = await db().select().from(schema.systemSettings).where(eq(schema.systemSettings.key, key)).limit(1);
    if (!s) throw notFound('Setting');
    return s;
  });
  app.put('/settings/:key', async (req) => {
    const { key } = parse(z.object({ key: z.string().regex(/^[a-z0-9_.-]{1,100}$/i) }), req.params);
    const { value } = parse(z.object({ value: z.unknown() }), req.body);
    if (value === undefined) throw badRequest('value is required');
    const [before] = await db().select().from(schema.systemSettings).where(eq(schema.systemSettings.key, key)).limit(1);
    const actorId = req.auth!.user.id;
    const [row] = await db().insert(schema.systemSettings).values({ key, value: value as object, updatedBy: actorId })
      .onConflictDoUpdate({ target: schema.systemSettings.key, set: { value: value as object, updatedBy: actorId, updatedAt: new Date() } }).returning();
    await adminAudit(req, 'settings.update', 'system_setting', key, { before: before?.value ?? null, after: value });
    return row;
  });

  /* ───────────── Jobs ───────────── */
  app.get('/jobs', async (req) => {
    const q = parse(PageQuery.extend({ status: z.enum(['queued', 'running', 'completed', 'failed']).optional(), type: z.string().optional() }), req.query);
    const conds: SQL[] = [];
    if (q.status) conds.push(eq(schema.jobs.status, q.status));
    if (q.type) conds.push(eq(schema.jobs.type, q.type));
    const where = conds.length ? and(...conds) : undefined;
    const [{ total }] = await db().select({ total: count() }).from(schema.jobs).where(where);
    const items = await db().select().from(schema.jobs).where(where).orderBy(desc(schema.jobs.createdAt)).limit(q.pageSize).offset(offset(q));
    return { items, total: Number(total), page: q.page, pageSize: q.pageSize };
  });

  app.post('/jobs/:id/retry', async (req) => {
    const { id } = parse(IdParam, req.params);
    const [j] = await db().select().from(schema.jobs).where(eq(schema.jobs.id, id)).limit(1);
    if (!j) throw notFound('Job');
    if (j.status !== 'failed') throw badRequest(`Only failed jobs can be retried (job is ${j.status})`);
    const [upd] = await db().update(schema.jobs).set({ status: 'queued', attempts: 0, runAt: new Date(), lockedAt: null, completedAt: null }).where(eq(schema.jobs.id, id)).returning();
    await adminAudit(req, 'job.retry', 'job', id, { type: j.type, lastError: j.lastError });
    return upd;
  });

  /* ───────────── System health ───────────── */
  app.get('/system-health', async () => {
    const t0 = performance.now();
    let dbOk = true;
    try { await db().execute(sql`select 1`); } catch { dbOk = false; }
    const latencyMs = Math.round((performance.now() - t0) * 100) / 100;
    const byStatus = await db().select({ status: schema.jobs.status, n: sql<number>`count(*)::int` }).from(schema.jobs).groupBy(schema.jobs.status);
    const [oldest] = await db().select({ at: sql<string | null>`min(${schema.jobs.runAt})` }).from(schema.jobs).where(and(eq(schema.jobs.status, 'queued'), sql`${schema.jobs.runAt} <= now()`));
    const health = await db().select({ health: schema.agents.health, n: sql<number>`count(*)::int` }).from(schema.agents).where(isNull(schema.agents.deletedAt)).groupBy(schema.agents.health);
    const providers = await db().select({ status: schema.agentProviders.status, n: sql<number>`count(*)::int` }).from(schema.agentProviders).groupBy(schema.agentProviders.status);
    const jobs = Object.fromEntries(byStatus.map((r) => [r.status, Number(r.n)]));
    return {
      status: dbOk ? 'ok' : 'degraded',
      db: { ok: dbOk, latencyMs },
      jobs: { queued: jobs.queued ?? 0, running: jobs.running ?? 0, failed: jobs.failed ?? 0, completed: jobs.completed ?? 0, oldestQueuedAgeSeconds: oldest?.at ? Math.max(0, Math.round((Date.now() - new Date(oldest.at).getTime()) / 1000)) : null },
      agentsByHealth: Object.fromEntries(health.map((r) => [r.health, Number(r.n)])),
      providersByStatus: Object.fromEntries(providers.map((r) => [r.status, Number(r.n)])),
      time: new Date().toISOString(),
    };
  });
}
