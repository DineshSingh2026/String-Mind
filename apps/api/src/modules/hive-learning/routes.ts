/**
 * hive-learning module, mounted at /hive.
 *   Verdicts:  POST /verdicts · GET /verdicts?targetType&targetId · DELETE /verdicts/:id
 *   Lessons:   GET /lessons (public, sortable by rank) · GET /lessons/:id
 *   Status:    GET /status (public: on/off, model configured, today's run count — no costs)
 *   Admin:     GET/PUT /settings · GET /runs · POST /runs/learn (manual "learn from this source now")
 */
import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db/client.js';
import { requireAdmin, requirePerm } from '../../lib/auth.js';
import { audit } from '../../lib/audit.js';
import { notFound, unprocessable } from '../../lib/errors.js';
import { PageQuery, offset, parse } from '../../lib/http.js';
import { enqueue, registerJob } from '../../jobs/queue.js';
import {
  HIVE_LEARN_JOB, HIVE_SWEEP_JOB, HiveSettings, ensureHiveSweepScheduled, enqueueHiveLearning, getHiveSettings, hiveModelInfo, hiveStatus,
  loadPublicTranscript, runHiveLearning, saveHiveSettings, sweepHiveLearning, todayRunStats, todaySpendCents, utcDayStart,
} from './service.js';
import { deleteVerdict, listVerdicts, recordVerdict } from './verdicts.js';
import { rankScore } from './rank.js';

const TargetType = z.enum(['listing', 'hive_lesson', 'artefact']);
const VerdictBody = z.object({
  agentId: z.string().uuid(),
  targetType: TargetType,
  targetId: z.string().uuid(),
  verdict: z.enum(['confirm', 'dispute']),
  note: z.string().max(1000).default(''),
});
const VerdictQuery = z.object({ targetType: TargetType, targetId: z.string().uuid() });
const LessonsQuery = PageQuery.extend({ sort: z.enum(['rank', 'recent']).default('rank'), domain: z.string().max(100).optional() });
const Id = z.object({ id: z.string().uuid() });
const LearnBody = z.object({ sourceType: z.enum(['session', 'debate']), sourceId: z.string().uuid() });

type LessonRow = typeof schema.hiveLessons.$inferSelect;

async function decorateLessons(rows: LessonRow[]) {
  const agentIds = [...new Set(rows.flatMap((r) => r.agentIds))];
  const agents = agentIds.length ? await db().select({ id: schema.agents.id, name: schema.agents.name, slug: schema.agents.slug })
    .from(schema.agents).where(and(inArray(schema.agents.id, agentIds), isNull(schema.agents.deletedAt))) : [];
  const byId = new Map(agents.map((a) => [a.id, a]));
  const domainIds = [...new Set(rows.map((r) => r.domainId).filter((x): x is string => !!x))];
  const domains = domainIds.length ? await db().select({ id: schema.capabilityDomains.id, slug: schema.capabilityDomains.slug, name: schema.capabilityDomains.name })
    .from(schema.capabilityDomains).where(inArray(schema.capabilityDomains.id, domainIds)) : [];
  const dom = new Map(domains.map((d) => [d.id, d]));
  return rows.map((r) => ({
    id: r.id, title: r.title, content: r.content, sourceType: r.sourceType, sourceId: r.sourceId,
    domain: r.domainId ? dom.get(r.domainId) ?? null : null,
    agents: r.agentIds.map((id) => byId.get(id)).filter(Boolean),
    confirmCount: r.confirmCount, disputeCount: r.disputeCount,
    rankScore: rankScore(r), createdAt: r.createdAt,
  }));
}

export default async function routes(app: FastifyInstance) {
  app.addHook('onReady', async () => {
    await ensureHiveSweepScheduled().catch((e) => console.error('[hive] could not schedule learning sweep', e));
  });

  /* ───── verdicts ───── */
  app.post('/verdicts', async (req, reply) => {
    const a = requirePerm(req, 'knowledge.write');
    const body = parse(VerdictBody, req.body);
    const r = await recordVerdict({ orgId: a.orgId, userId: a.user.id, ...body });
    await audit({ action: `hive.verdict.${body.verdict}`, targetType: body.targetType, targetId: body.targetId, metadata: { agentId: body.agentId } }, req);
    return reply.status(201).send(r);
  });

  app.get('/verdicts', async (req) => {
    const q = parse(VerdictQuery, req.query);
    return listVerdicts(q.targetType, q.targetId, req.auth?.orgId ?? null);
  });

  app.delete('/verdicts/:id', async (req, reply) => {
    const a = requirePerm(req, 'knowledge.write');
    const { id } = parse(Id, req.params);
    const v = await deleteVerdict(id, a.orgId);
    await audit({ action: 'hive.verdict.delete', targetType: v.targetType, targetId: v.targetId, metadata: { agentId: v.agentId } }, req);
    return reply.status(204).send();
  });

  /* ───── hive lessons (public) ───── */
  app.get('/lessons', async (req) => {
    const q = parse(LessonsQuery, req.query);
    const conds = [eq(schema.hiveLessons.moderation, 'visible')];
    if (q.domain) {
      const [d] = await db().select({ id: schema.capabilityDomains.id }).from(schema.capabilityDomains).where(eq(schema.capabilityDomains.slug, q.domain)).limit(1);
      if (!d) return { items: [], total: 0, page: q.page, pageSize: q.pageSize, sort: q.sort };
      conds.push(eq(schema.hiveLessons.domainId, d.id));
    }
    const where = and(...conds);
    const [{ n }] = await db().select({ n: count() }).from(schema.hiveLessons).where(where);
    // rank is the same formula as rank.ts, computed in SQL so pagination is stable
    const rankExpr = sql`0.8 * (${schema.hiveLessons.confirmCount} + 1)::float / (${schema.hiveLessons.confirmCount} + 2 * ${schema.hiveLessons.disputeCount} + 2)
      + 0.2 * exp(-greatest(extract(epoch from (now() - ${schema.hiveLessons.createdAt})), 0) / 2592000.0)`;
    const rows = await db().select().from(schema.hiveLessons).where(where)
      .orderBy(q.sort === 'rank' ? sql`${rankExpr} desc` : desc(schema.hiveLessons.createdAt), desc(schema.hiveLessons.createdAt))
      .limit(q.pageSize).offset(offset(q));
    return { items: await decorateLessons(rows), total: n, page: q.page, pageSize: q.pageSize, sort: q.sort };
  });

  app.get('/lessons/:id', async (req) => {
    const { id } = parse(Id, req.params);
    const [row] = await db().select().from(schema.hiveLessons).where(and(eq(schema.hiveLessons.id, id), eq(schema.hiveLessons.moderation, 'visible'))).limit(1);
    if (!row) throw notFound('Hive lesson');
    const [lesson] = await decorateLessons([row]);
    const verdicts = await listVerdicts('hive_lesson', id, req.auth?.orgId ?? null);
    return { ...lesson, verdicts: verdicts.items };
  });

  /* ───── status (anyone signed in or not; no costs) ───── */
  app.get('/status', async () => hiveStatus());

  /* ───── admin ───── */
  app.get('/settings', async (req) => {
    requireAdmin(req);
    const m = hiveModelInfo();
    return { settings: await getHiveSettings(), model: m ? { provider: m.provider, model: m.model } : null };
  });

  app.put('/settings', async (req) => {
    const a = requireAdmin(req);
    const body = parse(HiveSettings, req.body);
    const before = await getHiveSettings();
    const saved = await saveHiveSettings(body, a.user.id);
    await audit({ action: 'admin.hive.settings', actorType: 'admin', targetType: 'system_setting', targetId: null, metadata: { before, after: saved } }, req);
    return { settings: saved };
  });

  app.get('/runs', async (req) => {
    requireAdmin(req);
    const q = parse(PageQuery, req.query);
    const runs = await db().select().from(schema.hiveLearningRuns).orderBy(desc(schema.hiveLearningRuns.createdAt)).limit(q.pageSize).offset(offset(q));
    const [{ n }] = await db().select({ n: count() }).from(schema.hiveLearningRuns);
    const sIds = runs.filter((r) => r.sourceType === 'session').map((r) => r.sourceId);
    const dIds = runs.filter((r) => r.sourceType === 'debate').map((r) => r.sourceId);
    const sess = sIds.length ? await db().select({ id: schema.trainingSessions.id, t: schema.trainingSessions.subject }).from(schema.trainingSessions).where(inArray(schema.trainingSessions.id, sIds)) : [];
    const debs = dIds.length ? await db().select({ id: schema.debates.id, t: schema.debates.title }).from(schema.debates).where(inArray(schema.debates.id, dIds)) : [];
    const title = new Map([...sess, ...debs].map((x) => [x.id, x.t]));
    const settings = await getHiveSettings();
    const spent = await todaySpendCents();
    const stats = await todayRunStats();
    const [lessonTotal] = await db().select({ n: count() }).from(schema.hiveLessons);
    const [todayCost] = await db().select({ inTok: sql<number>`coalesce(sum(${schema.hiveLearningRuns.inputTokens}),0)`, outTok: sql<number>`coalesce(sum(${schema.hiveLearningRuns.outputTokens}),0)` })
      .from(schema.hiveLearningRuns).where(gte(schema.hiveLearningRuns.createdAt, utcDayStart()));
    return {
      today: {
        spendCents: Math.round(spent * 10_000) / 10_000, capCents: settings.dailyCapCents, runs: stats.runs, lessons: stats.lessons,
        inputTokens: Number(todayCost?.inTok ?? 0), outputTokens: Number(todayCost?.outTok ?? 0), dayStartUtc: utcDayStart(),
      },
      lessonTotal: Number(lessonTotal?.n ?? 0),
      items: runs.map((r) => ({ ...r, sourceTitle: title.get(r.sourceId) ?? null })),
      total: n, page: q.page, pageSize: q.pageSize,
    };
  });

  /** Admin: learn from one public room / closed debate now (retries a skipped or failed run; a done run is never repeated). */
  app.post('/runs/learn', async (req, reply) => {
    requireAdmin(req);
    const body = parse(LearnBody, req.body);
    const t = await loadPublicTranscript(body.sourceType, body.sourceId);
    if (!t) throw unprocessable('Only completed public rooms and closed, visible debates can be learned from');
    await enqueue(HIVE_LEARN_JOB, { ...body, retry: true }, { maxAttempts: 1 });
    await audit({ action: 'admin.hive.learn', actorType: 'admin', targetType: body.sourceType, targetId: body.sourceId }, req);
    return reply.status(202).send({ queued: true });
  });
}

export function registerJobs() {
  registerJob(HIVE_LEARN_JOB, async (payload) => {
    const sourceType = payload.sourceType === 'debate' ? 'debate' : 'session';
    const sourceId = String(payload.sourceId ?? '');
    if (!z.string().uuid().safeParse(sourceId).success) throw new Error('hive.learn requires a sourceId');
    await runHiveLearning(sourceType, sourceId, { retry: payload.retry === true });
  });
  registerJob(HIVE_SWEEP_JOB, async () => {
    try { await sweepHiveLearning(); } finally { await ensureHiveSweepScheduled(); }
  });
}

export { enqueueHiveLearning };
