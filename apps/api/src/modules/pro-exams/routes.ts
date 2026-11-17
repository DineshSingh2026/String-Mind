/**
 * Professional exams — adaptive exam, screening (auto-evaluation on connect) and their reports.
 * Rubrics, reference solutions, red-flag texts, check specs and seeds are never returned to non-admins.
 *
 *   GET  /pool?domain=&agentId=&targetItems=   pool sizes for certification / practice (why certification is unavailable)
 *   POST /                                     start { agentId, domainSlug, mode, targetItems? }
 *   GET  /                                     list (org; ?agentId=&status=&mode=)
 *   GET  /screening/:agentId                   latest screening + strengths map
 *   POST /screening/:agentId                   run the screening now (same rules as on connect: 24 h cooldown)
 *   GET  /auto-evaluate/:agentId               { enabled (agent), global }
 *   PUT  /auto-evaluate/:agentId               { enabled } owner opt-out per agent
 *   GET|PUT /admin/auto-evaluate               global switch (system_settings pro_auto_evaluate)
 *   GET  /:id                                  status, progress, tier, items (no rubric), report
 *   POST /:id/cancel                           owner
 *   POST /:id/regrade                          owner or admin: grade items the judge could not grade, then finalize
 * Realtime: channel `pro-exam:<id>` (org members + admins).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DOMAINS } from '@aix/shared';
import { db, schema } from '../../db/client.js';
import { registerJob } from '../../jobs/queue.js';
import { audit } from '../../lib/audit.js';
import { requireAdmin, requirePerm } from '../../lib/auth.js';
import { notFound, unprocessable } from '../../lib/errors.js';
import { onTaskAnswered } from '../../lib/agent-inbox.js';
import { PageQuery, offset, parse } from '../../lib/http.js';
import { getOwnedAgent } from '../../lib/tenancy.js';
import { registerChannelGuard } from '../../ws/hub.js';
import {
  PRO_EXAM_STEP_JOB, PRO_EXAM_SWEEP_JOB, agentAutoEnabled, cancelExam, ensureSweepScheduled, examView, globalAutoEnabled, handleProExamTaskAnswer,
  latestScreening, maybeAutoEvaluate, poolInfo, regradeExam, runExamUntilIdle, setAgentAuto, setGlobalAuto, startExam, sweepProExams,
} from '../../engine/pro-exam/index.js';

const Id = z.string().uuid();
const isAdmin = (req: FastifyRequest) => !!req.auth && !req.auth.apiKeyId && ['admin', 'super_admin'].includes(req.auth.user.platformRole);
const knownDomain = (s: string) => DOMAINS.some((d) => d.slug === s);

async function loadOwnExam(req: FastifyRequest, id: string, perm: 'assessments.read' | 'assessments.run') {
  if (!Id.safeParse(id).success) throw notFound('Exam');
  const [row] = await db().select().from(schema.proExams).where(eq(schema.proExams.id, id)).limit(1);
  if (!row) throw notFound('Exam');
  if (isAdmin(req)) return row;
  const a = requirePerm(req, perm);
  if (row.orgId !== a.orgId) throw notFound('Exam');
  return row;
}

export function registerJobs() {
  registerJob(PRO_EXAM_STEP_JOB, async (p) => {
    const examId = String(p.examId ?? '');
    if (Id.safeParse(examId).success) await runExamUntilIdle(examId);
  });
  registerJob(PRO_EXAM_SWEEP_JOB, async () => {
    const r = await sweepProExams();
    if (r.running > 0) await ensureSweepScheduled();
  });
  onTaskAnswered('pro_exam', handleProExamTaskAnswer);
}

export default async function routes(app: FastifyInstance) {
  registerChannelGuard('pro-exam', async (auth, id) => {
    if (!Id.safeParse(id).success) return false;
    const [row] = await db().select({ orgId: schema.proExams.orgId }).from(schema.proExams).where(eq(schema.proExams.id, id)).limit(1);
    if (!row) return false;
    if (auth.user.platformRole === 'admin' || auth.user.platformRole === 'super_admin') return true;
    const [m] = await db().select().from(schema.memberships).where(and(eq(schema.memberships.orgId, row.orgId), eq(schema.memberships.userId, auth.user.id))).limit(1);
    return !!m;
  });

  app.get('/pool', async (req) => {
    const a = requirePerm(req, 'assessments.read');
    const q = parse(z.object({ domain: z.string().min(1), agentId: Id.optional(), targetItems: z.coerce.number().int().min(4).max(30).optional() }), req.query);
    if (!knownDomain(q.domain)) throw unprocessable(`Unknown domain: ${q.domain}`);
    if (q.agentId) await getOwnedAgent(q.agentId, a.orgId);
    return poolInfo(q.domain, q.targetItems, q.agentId);
  });

  app.post('/', async (req, reply) => {
    const a = requirePerm(req, 'assessments.run');
    const body = parse(z.object({
      agentId: Id, domainSlug: z.string().min(1), mode: z.enum(['certification', 'practice']).default('certification'),
      targetItems: z.number().int().min(4).max(30).optional(),
    }), req.body);
    const agent = await getOwnedAgent(body.agentId, a.orgId);
    const exam = await startExam({ agentId: agent.id, orgId: a.orgId, requestedBy: a.user.id, domainSlug: body.domainSlug, mode: body.mode, targetItems: body.targetItems });
    await audit({ action: 'pro_exam.start', targetType: 'pro_exam', targetId: exam.id, metadata: { agentId: agent.id, domain: body.domainSlug, mode: body.mode } }, req);
    return reply.status(202).send(await examView(exam, { admin: false }));
  });

  app.get('/', async (req) => {
    const a = requirePerm(req, 'assessments.read');
    const qy = parse(PageQuery.extend({ agentId: Id.optional(), status: z.string().optional(), mode: z.string().optional() }), req.query);
    const t = schema.proExams;
    const where = and(eq(t.orgId, a.orgId), qy.agentId ? eq(t.agentId, qy.agentId) : undefined, qy.status ? eq(t.status, qy.status) : undefined, qy.mode ? eq(t.mode, qy.mode) : undefined);
    const rows = await db().select({ e: t, agentName: schema.agents.name }).from(t).innerJoin(schema.agents, eq(schema.agents.id, t.agentId))
      .where(where).orderBy(desc(t.createdAt)).limit(qy.pageSize).offset(offset(qy));
    const [{ total }] = await db().select({ total: sql<number>`count(*)::int` }).from(t).where(where);
    return {
      items: rows.map(({ e, agentName }) => ({
        id: e.id, agent: { id: e.agentId, name: agentName }, domainSlug: e.domainSlug, mode: e.mode, status: e.status, targetItems: e.targetItems,
        score: e.score, confidence: e.confidence, axes: e.axes, ability: e.ability, abilitySe: e.abilitySe, failureReason: e.failureReason,
        createdAt: e.createdAt, completedAt: e.completedAt,
      })),
      total, page: qy.page, pageSize: qy.pageSize,
    };
  });

  app.get('/screening/:agentId', async (req) => {
    const a = requirePerm(req, 'assessments.read');
    const { agentId } = parse(z.object({ agentId: Id }), req.params);
    const agent = await getOwnedAgent(agentId, a.orgId);
    const e = await latestScreening(agent.id);
    const view = e ? await examView(e, { admin: false }) : null;
    return {
      agentId: agent.id, autoEvaluate: agentAutoEnabled(agent), globalAutoEvaluate: await globalAutoEnabled(),
      exam: view, strengths: view?.screening ?? [],
      // shape read by the evaluation hub's ScreeningMap
      domains: (view?.screening ?? []).map((d) => ({ domainSlug: d.slug, name: d.name, score: d.score, items: d.items, graded: d.graded })),
      followUp: view ? (view.report as { followUp?: unknown }).followUp ?? null : null,
    };
  });

  app.post('/screening/:agentId', async (req, reply) => {
    const a = requirePerm(req, 'assessments.run');
    const { agentId } = parse(z.object({ agentId: Id }), req.params);
    const agent = await getOwnedAgent(agentId, a.orgId);
    const r = await maybeAutoEvaluate(agent.id, 'manual', { force: true, requestedBy: a.user.id });
    if (!r.started) throw unprocessable(r.reason);
    await audit({ action: 'pro_exam.screening', targetType: 'pro_exam', targetId: r.examId, metadata: { agentId: agent.id, domains: r.domains } }, req);
    return reply.status(202).send(r);
  });

  app.get('/auto-evaluate/:agentId', async (req) => {
    const a = requirePerm(req, 'assessments.read');
    const { agentId } = parse(z.object({ agentId: Id }), req.params);
    const agent = await getOwnedAgent(agentId, a.orgId);
    return { agentId: agent.id, enabled: agentAutoEnabled(agent), global: await globalAutoEnabled() };
  });

  app.put('/auto-evaluate/:agentId', async (req) => {
    const a = requirePerm(req, 'assessments.run');
    const { agentId } = parse(z.object({ agentId: Id }), req.params);
    const { enabled } = parse(z.object({ enabled: z.boolean() }), req.body);
    const agent = await getOwnedAgent(agentId, a.orgId);
    await setAgentAuto(agent.id, enabled);
    await audit({ action: 'pro_exam.auto_evaluate', targetType: 'agent', targetId: agent.id, metadata: { enabled } }, req);
    return { agentId: agent.id, enabled, global: await globalAutoEnabled() };
  });

  app.get('/admin/auto-evaluate', async (req) => {
    requireAdmin(req);
    return { enabled: await globalAutoEnabled() };
  });

  app.put('/admin/auto-evaluate', async (req) => {
    const a = requireAdmin(req);
    const { enabled } = parse(z.object({ enabled: z.boolean() }), req.body);
    await setGlobalAuto(enabled, a.user.id);
    await audit({ action: 'pro_exam.auto_evaluate_global', targetType: 'system_setting', targetId: null, metadata: { enabled } }, req);
    return { enabled };
  });

  app.get('/:id', async (req) => {
    const { id } = req.params as { id: string };
    const exam = await loadOwnExam(req, id, 'assessments.read');
    return examView(exam, { admin: isAdmin(req) });
  });

  app.post('/:id/cancel', async (req) => {
    const { id } = req.params as { id: string };
    const exam = await loadOwnExam(req, id, 'assessments.run');
    const ok = await cancelExam(exam.id);
    if (!ok) throw unprocessable(`Exam is already ${exam.status}`);
    await audit({ action: 'pro_exam.cancel', targetType: 'pro_exam', targetId: exam.id }, req);
    return { id: exam.id, status: 'cancelled' };
  });

  app.post('/:id/regrade', async (req) => {
    const { id } = req.params as { id: string };
    const exam = await loadOwnExam(req, id, 'assessments.run');
    const r = await regradeExam(exam.id);
    await audit({ action: 'pro_exam.regrade', targetType: 'pro_exam', targetId: exam.id, metadata: r }, req);
    return r;
  });
}
