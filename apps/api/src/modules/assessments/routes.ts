/**
 * Assessments module — see docs/API.md#assessments.
 * Ground truth is only ever returned to platform administrators.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DOMAINS, QUICK_ASSESSMENT_DOMAINS } from '@aix/shared';
import { db, schema } from '../../db/client.js';
import { registerJob } from '../../jobs/queue.js';
import { audit } from '../../lib/audit.js';
import { requireAuth, requirePerm } from '../../lib/auth.js';
import { notFound, unprocessable } from '../../lib/errors.js';
import { PageQuery, offset, parse } from '../../lib/http.js';
import { getOwnedAgent, getVisibleAgent } from '../../lib/tenancy.js';
import { registerChannelGuard } from '../../ws/hub.js';
import {
  ASSESSMENT_JOB, ASYNC_SWEEP_JOB, cancelAssessment, createAssessment, ensureAsyncSweepScheduled, getGaps, getScorecard, qualityDashboard,
  runAssessment, sweepAsyncAssessments,
} from '../../engine/assessment.js';
import { PROMPT_METHOD, promptConfig } from '../../lib/agent-inbox.js';
import { assertAgentActive } from '../owner-controls/service.js';

const isAdmin = (req: FastifyRequest) => !!req.auth && !req.auth.apiKeyId && ['admin', 'super_admin'].includes(req.auth.user.platformRole);
const Id = z.string().uuid();

async function loadAssessment(req: FastifyRequest, id: string) {
  const a = req.auth!;
  if (!Id.safeParse(id).success) throw notFound('Assessment');
  const [row] = await db().select().from(schema.capabilityAssessments).where(eq(schema.capabilityAssessments.id, id)).limit(1);
  if (!row || (row.orgId !== a.orgId && !isAdmin(req))) throw notFound('Assessment');
  return row;
}

export default async function routes(app: FastifyInstance) {
  app.addHook('onReady', async () => {
    // periodic expiry/finalize sweep for async (prompt-agent) assessments (idempotent; no-op if one is queued)
    await ensureAsyncSweepScheduled().catch((e) => console.error('[assessments] could not schedule async sweep', e));
  });

  registerChannelGuard('assessment', async (auth, id) => {
    if (!Id.safeParse(id).success) return false;
    const [row] = await db().select({ orgId: schema.capabilityAssessments.orgId }).from(schema.capabilityAssessments).where(eq(schema.capabilityAssessments.id, id)).limit(1);
    if (!row) return false;
    if (auth.user.platformRole === 'admin' || auth.user.platformRole === 'super_admin') return true;
    const [m] = await db().select().from(schema.memberships)
      .where(and(eq(schema.memberships.orgId, row.orgId), eq(schema.memberships.userId, auth.user.id))).limit(1);
    return !!m;
  });

  app.get('/domains', async (req) => {
    requireAuth(req);
    const domains = await db().select().from(schema.capabilityDomains).where(eq(schema.capabilityDomains.active, true)).orderBy(asc(schema.capabilityDomains.sortOrder));
    const skills = await db().select().from(schema.capabilitySkills);
    const datasets = await db().select().from(schema.benchmarkDatasets).where(eq(schema.benchmarkDatasets.status, 'active'));
    return domains.map((d) => ({
      id: d.id, slug: d.slug, name: d.name, icon: d.icon, highImpact: d.highImpact, weights: d.weights, description: d.description,
      /** false → no quick benchmark set; evaluate via Professional Evaluation */
      quickAssessment: DOMAINS.find((x) => x.slug === d.slug)?.quickAssessment !== false,
      skills: skills.filter((s) => s.domainId === d.id).map((s) => ({ id: s.id, slug: s.slug, name: s.name })),
      datasets: datasets.filter((x) => x.domainId === d.id).map((x) => ({ version: x.version, visibility: x.visibility, questionCount: x.questionCount, humanReviewedCount: x.humanReviewedCount })),
    }));
  });

  app.post('/', async (req, reply) => {
    const a = requirePerm(req, 'assessments.run');
    const body = parse(z.object({
      agentId: Id, domainSlugs: z.array(z.string()).max(DOMAINS.length).optional(), repeats: z.number().int().min(1).max(5).optional(),
    }), req.body);
    const agent = await getOwnedAgent(body.agentId, a.orgId);
    if (agent.status === 'suspended') throw unprocessable('Suspended agents cannot be assessed');
    if (agent.status === 'disconnected') throw unprocessable('Reconnect the agent before running an assessment');
    await assertAgentActive(agent.id); // owner controls: paused agents start no new assessments (409 agent_paused)
    const known = new Set(QUICK_ASSESSMENT_DOMAINS.map((d) => d.slug));
    // Default scope (no domains chosen): the agent's self-claimed domains, else "general" — a few minutes,
    // not all 20 domains (~800 answers). Users pick more domains explicitly on the Assessments page.
    const claimed = (agent.claimedDomains ?? []).filter((s) => known.has(s));
    const slugs = body.domainSlugs?.length ? body.domainSlugs : claimed.length ? claimed.slice(0, 3) : ['general'];
    const unknown = slugs.filter((s) => !known.has(s));
    if (unknown.length) throw unprocessable(`Unknown domains: ${unknown.join(', ')}`);
    // Prompt-connected agents get an async assessment (tasks wait up to 24 h) — they don't need to be online now,
    // but they must have finished the connection handshake.
    const [conn] = await db().select().from(schema.agentConnections).where(eq(schema.agentConnections.agentId, agent.id)).limit(1);
    if (conn?.method === PROMPT_METHOD && !promptConfig(conn).verifiedAt) {
      throw unprocessable('This agent has not finished connecting yet. Paste the connect prompt into your agent and wait for "Connected" before running an assessment.');
    }
    const active = await db().select({ id: schema.capabilityAssessments.id }).from(schema.capabilityAssessments)
      .where(and(eq(schema.capabilityAssessments.agentId, agent.id), inArray(schema.capabilityAssessments.status, ['queued', 'running'])));
    if (active.length >= 3) throw unprocessable('This agent already has assessments in progress — wait for them to finish');
    // Default is Quick (each question once, ~20 answers per domain); Full (repeats 2+) adds the consistency measure.
    const row = await createAssessment({ agentId: agent.id, orgId: a.orgId, requestedBy: a.user.id, purpose: 'manual', domainSlugs: slugs, repeats: body.repeats ?? 1 });
    await audit({ action: 'assessment.create', targetType: 'assessment', targetId: row.id, metadata: { agentId: agent.id, domains: slugs } }, req);
    return reply.status(202).send(row);
  });

  app.get('/', async (req) => {
    const a = requirePerm(req, 'assessments.read');
    const qy = parse(PageQuery.extend({ agentId: Id.optional(), status: z.string().optional() }), req.query);
    const where = and(eq(schema.capabilityAssessments.orgId, a.orgId),
      qy.agentId ? eq(schema.capabilityAssessments.agentId, qy.agentId) : undefined,
      qy.status ? eq(schema.capabilityAssessments.status, qy.status) : undefined);
    const items = await db().select({ a: schema.capabilityAssessments, agentName: schema.agents.name }).from(schema.capabilityAssessments)
      .innerJoin(schema.agents, eq(schema.agents.id, schema.capabilityAssessments.agentId))
      .where(where).orderBy(desc(schema.capabilityAssessments.createdAt)).limit(qy.pageSize).offset(offset(qy));
    const [{ total }] = await db().select({ total: sql<number>`count(*)::int` }).from(schema.capabilityAssessments).where(where);
    return { items: items.map((r) => ({ ...r.a, agent: { id: r.a.agentId, name: r.agentName } })), total, page: qy.page, pageSize: qy.pageSize };
  });

  app.get('/quality', async (req) => {
    const a = requirePerm(req, 'assessments.read');
    return qualityDashboard(a.orgId);
  });

  app.get('/scorecard/:agentId', async (req) => {
    const a = requireAuth(req);
    const { agentId } = req.params as { agentId: string };
    if (!Id.safeParse(agentId).success) throw notFound('Agent');
    const agent = await getVisibleAgent(agentId, a.orgId);
    if (agent.orgId === a.orgId && a.orgRole) requirePerm(req, 'assessments.read');
    const card = await getScorecard(agent.id);
    if (!card) throw notFound('Agent');
    return card;
  });

  app.get('/gaps/:agentId', async (req) => {
    const a = requirePerm(req, 'assessments.read');
    const { agentId } = req.params as { agentId: string };
    if (!Id.safeParse(agentId).success) throw notFound('Agent');
    const agent = await getOwnedAgent(agentId, a.orgId);
    return { agentId: agent.id, items: await getGaps(agent.id) };
  });

  app.get('/:id', async (req) => {
    if (!isAdmin(req)) requirePerm(req, 'assessments.read'); else requireAuth(req);
    const row = await loadAssessment(req, (req.params as { id: string }).id);
    const [agent] = await db().select({ id: schema.agents.id, name: schema.agents.name }).from(schema.agents).where(eq(schema.agents.id, row.agentId)).limit(1);
    const summary = row.summary as { domains?: unknown[] };
    return { ...row, agent, domains: summary.domains ?? [], progress: row.progress };
  });

  app.post('/:id/cancel', async (req) => {
    requirePerm(req, 'assessments.run');
    const row = await loadAssessment(req, (req.params as { id: string }).id);
    const ok = await cancelAssessment(row.id);
    if (!ok) throw unprocessable(`This assessment is already ${row.status}`);
    await audit({ action: 'assessment.cancel', targetType: 'assessment', targetId: row.id, metadata: { agentId: row.agentId } }, req);
    return { ok: true, status: 'cancelled' };
  });

  app.get('/:id/results', async (req) => {
    const admin = isAdmin(req);
    if (!admin) requirePerm(req, 'assessments.read'); else requireAuth(req);
    const row = await loadAssessment(req, (req.params as { id: string }).id);
    const qy = parse(z.object({ domain: z.string().optional() }), req.query);
    const rows = await db().select({ r: schema.assessmentResults, q: schema.benchmarkQuestions, d: schema.capabilityDomains })
      .from(schema.assessmentResults)
      .innerJoin(schema.benchmarkQuestions, eq(schema.benchmarkQuestions.id, schema.assessmentResults.questionId))
      .innerJoin(schema.capabilityDomains, eq(schema.capabilityDomains.id, schema.assessmentResults.domainId))
      .where(and(eq(schema.assessmentResults.assessmentId, row.id), qy.domain ? eq(schema.capabilityDomains.slug, qy.domain) : undefined))
      .orderBy(asc(schema.capabilityDomains.sortOrder), asc(schema.assessmentResults.questionId), asc(schema.assessmentResults.attempt));
    return {
      items: rows.map(({ r, q, d }) => ({
        id: r.id, questionId: q.id, domain: d.slug, attempt: r.attempt, kind: q.kind, difficulty: q.difficulty, answerType: q.answerType,
        prompt: q.prompt, choices: q.choices, response: r.response, latencyMs: r.latencyMs, correct: r.correct, score: r.score,
        dimensionScores: r.dimensionScores, failureCategory: r.failureCategory, evaluator: r.evaluator, evaluationMethod: r.evaluationMethod,
        needsHumanReview: r.needsHumanReview,
        ...(admin ? { groundTruth: q.groundTruth, rubric: q.rubric } : {}),
      })),
      groundTruthVisible: admin,
    };
  });
}

/** Register background job handlers for this module (called once at startup). */
export function registerJobs() {
  registerJob(ASSESSMENT_JOB, async (payload) => {
    const id = String(payload.assessmentId ?? '');
    if (!id) throw new Error('assessment.run requires assessmentId');
    await runAssessment(id);
  });
  registerJob(ASYNC_SWEEP_JOB, async () => {
    try { await sweepAsyncAssessments(); } finally { await ensureAsyncSweepScheduled(); }
  });
}

