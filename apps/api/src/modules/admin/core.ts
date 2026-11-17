import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { CREDIT_CURRENCY } from '@aix/shared';
import { db, schema } from '../../db/client.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { PageQuery, offset, parse } from '../../lib/http.js';
import { notify } from '../../lib/notify.js';
import { recomputeReputation } from '../reputation/service.js';
import { IdParam, actor, adminAudit, publicUser } from './common.js';

const n = (v: unknown) => Number(v ?? 0);

export default async function core(app: FastifyInstance) {
  /* ───────────── Overview ───────────── */
  app.get('/overview', async () => {
    const d = db();
    const [users] = await d.select({ total: sql<number>`count(*)::int`, active: sql<number>`count(*) filter (where status = 'active')::int` }).from(schema.users).where(isNull(schema.users.deletedAt));
    const [orgs] = await d.select({ total: sql<number>`count(*)::int` }).from(schema.organisations);
    const agentsBy = await d.select({ status: schema.agents.status, n: sql<number>`count(*)::int` }).from(schema.agents).where(isNull(schema.agents.deletedAt)).groupBy(schema.agents.status);
    const sessionsBy = await d.select({ status: schema.trainingSessions.status, n: sql<number>`count(*)::int` }).from(schema.trainingSessions).groupBy(schema.trainingSessions.status);
    // IDLE token economy (no fiat): issuance via welcome bonuses, circulation in org wallets, platform commission.
    const [bonus] = await d.select({ count: sql<number>`count(*)::int`, total: sql<number>`coalesce(sum(amount),0)::bigint` }).from(schema.transactions).where(eq(schema.transactions.type, 'welcome_bonus'));
    const [circ] = await d.select({ total: sql<number>`coalesce(sum(available + locked + withdrawable),0)::bigint` }).from(schema.wallets).where(eq(schema.wallets.kind, 'org'));
    const [comm] = await d.select({ total: sql<number>`coalesce(sum(commission_credits),0)::bigint` }).from(schema.trainingSessions).where(eq(schema.trainingSessions.settlementStatus, 'settled'));
    const [platformWallet] = await d.select().from(schema.wallets).where(eq(schema.wallets.kind, 'platform')).limit(1);
    const jobsBy = await d.select({ status: schema.jobs.status, n: sql<number>`count(*)::int` }).from(schema.jobs).groupBy(schema.jobs.status);
    const toObj = (rows: { status: string; n: number }[]) => Object.fromEntries(rows.map((r) => [r.status, n(r.n)]));
    const s = toObj(sessionsBy);
    return {
      users: { total: n(users?.total), active: n(users?.active) },
      orgs: n(orgs?.total),
      agents: { total: agentsBy.reduce((a, r) => a + n(r.n), 0), byStatus: toObj(agentsBy) },
      sessions: { total: sessionsBy.reduce((a, r) => a + n(r.n), 0), byStatus: s },
      failedSessions: s.failed ?? 0,
      tokens: { currency: CREDIT_CURRENCY, welcomeBonusesGranted: n(bonus?.count), welcomeBonusIssued: n(bonus?.total), inCirculation: n(circ?.total) },
      commissions: { currency: CREDIT_CURRENCY, trainingCommissionCredits: n(comm?.total), platformRevenueBalance: platformWallet ? platformWallet.available + platformWallet.withdrawable : 0 },
      jobs: toObj(jobsBy),
    };
  });

  /* ───────────── Users ───────────── */
  app.get('/users', async (req) => {
    const q = parse(PageQuery.extend({ q: z.string().trim().optional(), status: z.string().optional() }), req.query);
    const conds: SQL[] = [];
    if (q.q) conds.push(or(ilike(schema.users.email, `%${q.q}%`), ilike(schema.users.name, `%${q.q}%`))!);
    if (q.status) conds.push(eq(schema.users.status, q.status));
    const where = conds.length ? and(...conds) : undefined;
    const [{ total }] = await db().select({ total: count() }).from(schema.users).where(where);
    const rows = await db().select().from(schema.users).where(where).orderBy(desc(schema.users.createdAt)).limit(q.pageSize).offset(offset(q));
    return { items: rows.map(publicUser), total: n(total), page: q.page, pageSize: q.pageSize };
  });

  app.patch('/users/:id', async (req) => {
    const me = actor(req);
    const { id } = parse(IdParam, req.params);
    const body = parse(z.object({ status: z.enum(['active', 'suspended']).optional(), platformRole: z.enum(['user', 'admin', 'super_admin']).optional() }), req.body);
    if (id === me.user.id) throw forbidden('You cannot change your own status or role.');
    if (body.platformRole && me.user.platformRole !== 'super_admin') throw forbidden('Only super admins can change platform roles.');
    const [u] = await db().select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
    if (!u) throw notFound('User');
    if (u.platformRole === 'super_admin' && me.user.platformRole !== 'super_admin') throw forbidden('Only super admins can modify a super admin.');
    const [upd] = await db().update(schema.users).set({ ...body, updatedAt: new Date() }).where(eq(schema.users.id, id)).returning();
    if (body.status === 'suspended') await db().update(schema.sessions).set({ revokedAt: new Date() }).where(and(eq(schema.sessions.userId, id), isNull(schema.sessions.revokedAt)));
    await adminAudit(req, 'user.update', 'user', id, { before: { status: u.status, platformRole: u.platformRole }, after: body });
    return publicUser(upd!);
  });

  /* ───────────── Agents ───────────── */
  app.get('/agents', async (req) => {
    const q = parse(PageQuery.extend({ q: z.string().trim().optional(), status: z.string().optional() }), req.query);
    const conds: SQL[] = [isNull(schema.agents.deletedAt)];
    if (q.q) conds.push(or(ilike(schema.agents.name, `%${q.q}%`), ilike(schema.agents.slug, `%${q.q}%`))!);
    if (q.status) conds.push(eq(schema.agents.status, q.status));
    const where = and(...conds);
    const [{ total }] = await db().select({ total: count() }).from(schema.agents).where(where);
    const rows = await db().select({ a: schema.agents, orgName: schema.organisations.name, privateNetwork: schema.organisations.privateNetwork, provider: schema.agentProviders.slug })
      .from(schema.agents)
      .innerJoin(schema.organisations, eq(schema.organisations.id, schema.agents.orgId))
      .innerJoin(schema.agentProviders, eq(schema.agentProviders.id, schema.agents.providerId))
      .where(where).orderBy(desc(schema.agents.createdAt)).limit(q.pageSize).offset(offset(q));
    return {
      items: rows.map(({ a, orgName, privateNetwork, provider }) => ({
        id: a.id, slug: a.slug, name: a.name, orgId: a.orgId, orgName, privateNetwork, provider, modelName: a.modelName, status: a.status, health: a.health,
        isPublic: a.isPublic, verificationStatus: a.verificationStatus, overallScore: a.overallScore, createdAt: a.createdAt,
      })),
      total: n(total), page: q.page, pageSize: q.pageSize,
    };
  });

  app.post('/agents/:id/suspend', async (req) => {
    const { id } = parse(IdParam, req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(1000) }), req.body);
    const agent = await suspendAgent(id, reason);
    await adminAudit(req, 'agent.suspend', 'agent', id, { reason }, agent.orgId);
    return agent;
  });

  app.post('/agents/:id/unsuspend', async (req) => {
    const { id } = parse(IdParam, req.params);
    const [a] = await db().select().from(schema.agents).where(eq(schema.agents.id, id)).limit(1);
    if (!a) throw notFound('Agent');
    if (a.status !== 'suspended') throw badRequest('Agent is not suspended');
    // Owner must re-publish and re-activate listings deliberately.
    const [upd] = await db().update(schema.agents).set({ status: 'active', updatedAt: new Date() }).where(eq(schema.agents.id, id)).returning();
    await recomputeReputation(id);
    await notify(a.ownerId, 'system', `Agent ${a.name} reinstated`, 'Your agent is active again. Re-publish it and re-activate listings when ready.', `/agents/${a.id}`);
    await adminAudit(req, 'agent.unsuspend', 'agent', id, {}, a.orgId);
    return upd;
  });

  app.post('/agents/:id/verify', async (req) => {
    const { id } = parse(IdParam, req.params);
    const { status } = parse(z.object({ status: z.enum(['unverified', 'pending', 'verified', 'rejected']) }), req.body);
    const [a] = await db().update(schema.agents).set({ verificationStatus: status, updatedAt: new Date() }).where(eq(schema.agents.id, id)).returning();
    if (!a) throw notFound('Agent');
    await adminAudit(req, 'agent.verify', 'agent', id, { status }, a.orgId);
    return a;
  });

  /* ───────────── Providers ───────────── */
  app.get('/providers', async () => {
    const providers = await db().select().from(schema.agentProviders).orderBy(schema.agentProviders.name);
    const health = await db().select({ providerId: schema.agents.providerId, health: schema.agents.health, n: sql<number>`count(*)::int` })
      .from(schema.agents).where(isNull(schema.agents.deletedAt)).groupBy(schema.agents.providerId, schema.agents.health);
    return providers.map((p) => ({ ...p, agentsByHealth: Object.fromEntries(health.filter((h) => h.providerId === p.id).map((h) => [h.health, n(h.n)])) }));
  });
  app.get('/providers/:id', async (req) => {
    const { id } = parse(IdParam, req.params);
    const [p] = await db().select().from(schema.agentProviders).where(eq(schema.agentProviders.id, id)).limit(1);
    if (!p) throw notFound('Provider');
    return p;
  });
  app.patch('/providers/:id', async (req) => {
    const { id } = parse(IdParam, req.params);
    const { status } = parse(z.object({ status: z.enum(['active', 'beta', 'disabled']) }), req.body);
    const [p] = await db().update(schema.agentProviders).set({ status }).where(eq(schema.agentProviders.id, id)).returning();
    if (!p) throw notFound('Provider');
    await adminAudit(req, 'provider.update', 'agent_provider', id, { status });
    return p;
  });

  /* ───────────── Training sessions ───────────── */
  app.get('/training-sessions', async (req) => {
    const q = parse(PageQuery.extend({ status: z.string().optional() }), req.query);
    const where = q.status ? eq(schema.trainingSessions.status, q.status) : undefined;
    const [{ total }] = await db().select({ total: count() }).from(schema.trainingSessions).where(where);
    const rows = await db().select().from(schema.trainingSessions).where(where).orderBy(desc(schema.trainingSessions.createdAt)).limit(q.pageSize).offset(offset(q));
    const ids = [...new Set(rows.flatMap((r) => [r.learnerAgentId, r.trainerAgentId]))];
    const names = new Map((ids.length ? await db().select({ id: schema.agents.id, name: schema.agents.name }).from(schema.agents).where(inArray(schema.agents.id, ids)) : []).map((a) => [a.id, a.name]));
    return { items: rows.map((s) => ({ ...s, learnerName: names.get(s.learnerAgentId), trainerName: names.get(s.trainerAgentId) })), total: n(total), page: q.page, pageSize: q.pageSize };
  });

  /* ───────────── Benchmarks (admins may see ground truth) ───────────── */
  app.get('/benchmarks', async () => {
    const rows = await db().select({ ds: schema.benchmarkDatasets, slug: schema.capabilityDomains.slug, name: schema.capabilityDomains.name })
      .from(schema.benchmarkDatasets).innerJoin(schema.capabilityDomains, eq(schema.capabilityDomains.id, schema.benchmarkDatasets.domainId))
      .orderBy(schema.capabilityDomains.sortOrder, schema.benchmarkDatasets.visibility);
    return rows.map(({ ds, slug, name }) => ({ ...ds, domainSlug: slug, domainName: name }));
  });

  app.get('/benchmarks/:datasetId/questions', async (req) => {
    const { datasetId } = parse(z.object({ datasetId: z.string().uuid() }), req.params);
    const q = parse(PageQuery.extend({ humanReviewed: z.enum(['true', 'false']).optional() }), req.query);
    const conds: SQL[] = [eq(schema.benchmarkQuestions.datasetId, datasetId)];
    if (q.humanReviewed) conds.push(eq(schema.benchmarkQuestions.humanReviewed, q.humanReviewed === 'true'));
    const [{ total }] = await db().select({ total: count() }).from(schema.benchmarkQuestions).where(and(...conds));
    const items = await db().select().from(schema.benchmarkQuestions).where(and(...conds)).orderBy(schema.benchmarkQuestions.createdAt).limit(q.pageSize).offset(offset(q));
    return { items, total: n(total), page: q.page, pageSize: q.pageSize };
  });

  app.post('/benchmarks/questions/:id/review', async (req) => {
    const { id } = parse(IdParam, req.params);
    const { humanReviewed } = parse(z.object({ humanReviewed: z.boolean() }), req.body);
    const [qrow] = await db().update(schema.benchmarkQuestions).set({ humanReviewed }).where(eq(schema.benchmarkQuestions.id, id)).returning();
    if (!qrow) throw notFound('Question');
    const [{ c }] = await db().select({ c: count() }).from(schema.benchmarkQuestions).where(and(eq(schema.benchmarkQuestions.datasetId, qrow.datasetId), eq(schema.benchmarkQuestions.humanReviewed, true)));
    await db().update(schema.benchmarkDatasets).set({ humanReviewedCount: n(c) }).where(eq(schema.benchmarkDatasets.id, qrow.datasetId));
    await adminAudit(req, 'benchmark.question_review', 'benchmark_question', id, { humanReviewed });
    return qrow;
  });

  /* ───────────── Human review queue ───────────── */
  app.get('/human-review', async (req) => {
    const q = parse(PageQuery, req.query);
    const where = eq(schema.assessmentResults.needsHumanReview, true);
    const [{ total }] = await db().select({ total: count() }).from(schema.assessmentResults).where(where);
    const rows = await db().select({ r: schema.assessmentResults, q: schema.benchmarkQuestions, agentId: schema.capabilityAssessments.agentId, agentName: schema.agents.name, domain: schema.capabilityDomains.slug })
      .from(schema.assessmentResults)
      .innerJoin(schema.benchmarkQuestions, eq(schema.benchmarkQuestions.id, schema.assessmentResults.questionId))
      .innerJoin(schema.capabilityAssessments, eq(schema.capabilityAssessments.id, schema.assessmentResults.assessmentId))
      .innerJoin(schema.agents, eq(schema.agents.id, schema.capabilityAssessments.agentId))
      .innerJoin(schema.capabilityDomains, eq(schema.capabilityDomains.id, schema.assessmentResults.domainId))
      .where(where).orderBy(schema.assessmentResults.createdAt).limit(q.pageSize).offset(offset(q));
    return {
      items: rows.map(({ r, q: qq, agentId, agentName, domain }) => ({
        id: r.id, assessmentId: r.assessmentId, agent: { id: agentId, name: agentName }, domainSlug: domain,
        question: { id: qq.id, prompt: qq.prompt, kind: qq.kind, difficulty: qq.difficulty, answerType: qq.answerType, groundTruth: qq.groundTruth, rubric: qq.rubric },
        response: r.response, correct: r.correct, score: r.score, failureCategory: r.failureCategory, evaluator: r.evaluator, evaluationMethod: r.evaluationMethod, createdAt: r.createdAt,
      })),
      total: n(total), page: q.page, pageSize: q.pageSize,
    };
  });

  app.post('/human-review/:resultId', async (req) => {
    const me = actor(req);
    const { resultId } = parse(z.object({ resultId: z.string().uuid() }), req.params);
    const body = parse(z.object({ verdict: z.enum(['upheld', 'overturned']), score: z.number().min(0).max(100).optional(), notes: z.string().max(4000).default('') }), req.body);
    const [r] = await db().select().from(schema.assessmentResults).where(eq(schema.assessmentResults.id, resultId)).limit(1);
    if (!r) throw notFound('Assessment result');
    const result = await db().transaction(async (tx) => {
      const [ev] = await tx.insert(schema.evaluations).values({ assessmentResultId: r.id, reviewerId: me.user.id, verdict: body.verdict, score: body.score ?? null, notes: body.notes }).returning();
      const patch = body.verdict === 'overturned'
        ? { correct: !r.correct, score: body.score ?? (r.correct ? 0 : 100), needsHumanReview: false, evaluator: `human:${me.user.id}`, evaluationMethod: 'human_review' }
        : { needsHumanReview: false, ...(body.score != null ? { score: body.score } : {}) };
      const [upd] = await tx.update(schema.assessmentResults).set(patch).where(eq(schema.assessmentResults.id, r.id)).returning();
      return { evaluation: ev, result: upd };
    });
    await adminAudit(req, 'human_review', 'assessment_result', resultId, { verdict: body.verdict, before: { correct: r.correct, score: r.score }, after: { correct: result.result!.correct, score: result.result!.score } });
    return result;
  });
}

/** Suspend: status suspended, hidden from marketplace, listings paused, owner notified, reputation recomputed. */
export async function suspendAgent(id: string, reason: string) {
  const [a] = await db().select().from(schema.agents).where(eq(schema.agents.id, id)).limit(1);
  if (!a) throw notFound('Agent');
  const [upd] = await db().update(schema.agents).set({ status: 'suspended', isPublic: false, updatedAt: new Date() }).where(eq(schema.agents.id, id)).returning();
  await db().update(schema.marketplaceListings).set({ status: 'paused', updatedAt: new Date() })
    .where(and(eq(schema.marketplaceListings.agentId, id), eq(schema.marketplaceListings.status, 'active')));
  await recomputeReputation(id);
  await notify(a.ownerId, 'security_alert', `Agent ${a.name} suspended`, `Your agent was suspended by Hive Mind moderation: ${reason}`, `/agents/${a.id}`);
  return upd!;
}
