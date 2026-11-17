/**
 * Owner controls (mounted at /owner): pause / resume an agent, rotate its agent link, the agent activity log,
 * and user reports for any content type (POST /owner/reports).
 *
 * AuthZ: every agent route is org-scoped through getOwnedAgent (404 for other tenants' agents, never 403).
 * Agent tokens are never returned here — a rotated link returns a NEW one-time claim prompt, exactly once.
 */
import type { FastifyInstance } from 'fastify';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, rowsOf, schema } from '../../db/client.js';
import { audit } from '../../lib/audit.js';
import { requireAuth, requirePerm } from '../../lib/auth.js';
import { AppError, conflict, notFound, unprocessable } from '../../lib/errors.js';
import { parse } from '../../lib/http.js';
import { getOwnedAgent } from '../../lib/tenancy.js';
import {
  PROMPT_METHOD, buildConnectPrompt, expireOpenTasks, freshClaim, inboxEvents, promptConfig, publishConnectionState,
} from '../../lib/agent-inbox.js';
import { getProviderById } from '../agents/service.js';

const IdParam = z.object({ id: z.string().uuid() });

/** Sensitive owner writes: a few per minute per principal is plenty for humans (the global limiter keys by session/key). */
const ownerWriteLimit = { rateLimit: { max: 30, timeWindow: '1 minute' } };
const rotateLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };
const reportLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

export const REPORT_TARGET_TYPES = [
  'agent', 'listing', 'knowledge', 'review', 'user', 'session', 'debate', 'debate_message', 'hive_lesson', 'verdict',
] as const;
export type ReportTargetType = (typeof REPORT_TARGET_TYPES)[number];

export const REPORT_REASONS = ['spam', 'harassment', 'unsafe', 'prompt_injection', 'misinformation', 'impersonation', 'other'] as const;

const ReportBody = z.object({
  targetType: z.enum(REPORT_TARGET_TYPES),
  targetId: z.string().uuid(),
  reason: z.enum(REPORT_REASONS),
  details: z.string().trim().max(2000).default(''),
}).refine((b) => b.reason !== 'other' || b.details.length >= 3, { message: 'Please describe the problem when choosing "other"', path: ['details'] });

const ActivityQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  source: z.enum(['audit', 'task', 'session', 'assessment']).optional(),
});

/** Wake any long-poll of this agent so pause / resume / rotation take effect immediately. */
const wake = (agentId: string) => inboxEvents.emit(`agent:${agentId}`);

/**
 * Does the report target exist and may this user see it? (404 otherwise — never confirm the existence of private content.)
 */
async function assertReportable(type: ReportTargetType, id: string, orgId: string | null): Promise<void> {
  const one = async (q: Promise<unknown[]>) => (await q).length > 0;
  let ok = false;
  switch (type) {
    case 'agent': {
      const [a] = await db().select({ orgId: schema.agents.orgId, isPublic: schema.agents.isPublic }).from(schema.agents)
        .where(and(eq(schema.agents.id, id), isNull(schema.agents.deletedAt))).limit(1);
      ok = !!a && (a.isPublic || a.orgId === orgId);
      break;
    }
    case 'listing': ok = await one(db().select({ id: schema.marketplaceListings.id }).from(schema.marketplaceListings).where(eq(schema.marketplaceListings.id, id)).limit(1)); break;
    case 'knowledge': ok = await one(db().select({ id: schema.knowledgeListings.id }).from(schema.knowledgeListings).where(eq(schema.knowledgeListings.id, id)).limit(1)); break;
    case 'review': ok = await one(db().select({ id: schema.reviews.id }).from(schema.reviews).where(eq(schema.reviews.id, id)).limit(1)); break;
    case 'user': ok = await one(db().select({ id: schema.users.id }).from(schema.users).where(and(eq(schema.users.id, id), isNull(schema.users.deletedAt))).limit(1)); break;
    case 'session': {
      const [s] = await db().select({ visibility: schema.trainingSessions.visibility, l: schema.trainingSessions.learnerOrgId, t: schema.trainingSessions.trainerOrgId })
        .from(schema.trainingSessions).where(eq(schema.trainingSessions.id, id)).limit(1);
      ok = !!s && (s.visibility === 'public' || s.l === orgId || s.t === orgId);
      break;
    }
    case 'debate': ok = await one(db().select({ id: schema.debates.id }).from(schema.debates).where(eq(schema.debates.id, id)).limit(1)); break;
    case 'debate_message': ok = await one(db().select({ id: schema.debateMessages.id }).from(schema.debateMessages).where(eq(schema.debateMessages.id, id)).limit(1)); break;
    case 'hive_lesson': ok = await one(db().select({ id: schema.hiveLessons.id }).from(schema.hiveLessons).where(eq(schema.hiveLessons.id, id)).limit(1)); break;
    case 'verdict': ok = await one(db().select({ id: schema.knowledgeVerdicts.id }).from(schema.knowledgeVerdicts).where(eq(schema.knowledgeVerdicts.id, id)).limit(1)); break;
  }
  if (!ok) throw notFound('Reported content');
}

type ActivityRow = { source: string; ref_id: string; kind: string; at: string | Date; actor_type: string | null; actor_name: string | null; meta: Record<string, unknown> | null };

/** One merged timeline (audit log + agent events) as a UNION ALL; every branch is filtered to this agent. */
function activityUnion(agentId: string, orgId: string) {
  return sql`
    SELECT 'audit' AS source, a.id::text AS ref_id, a.action AS kind, a.created_at AS at, a.actor_type AS actor_type,
           CASE WHEN a.actor_type = 'admin' THEN NULL ELSE u.name END AS actor_name,
           CASE WHEN a.actor_type = 'admin' THEN '{}'::jsonb ELSE a.metadata END AS meta
      FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
     WHERE a.target_type = 'agent' AND a.target_id = ${agentId}
    UNION ALL
    SELECT 'task', t.id::text, 'task.delivered', t.delivered_at, 'agent', NULL, jsonb_build_object('taskKind', t.kind)
      FROM agent_tasks t WHERE t.agent_id = ${agentId}::uuid AND t.delivered_at IS NOT NULL
    UNION ALL
    SELECT 'task', t.id::text, 'task.answered', t.answered_at, 'agent', NULL, jsonb_build_object('taskKind', t.kind)
      FROM agent_tasks t WHERE t.agent_id = ${agentId}::uuid AND t.answered_at IS NOT NULL
    UNION ALL
    SELECT 'session', s.id::text, 'session.created', s.created_at, 'system', NULL,
           jsonb_build_object('subject', s.subject, 'role', CASE WHEN s.learner_agent_id = ${agentId}::uuid THEN 'learner' ELSE 'trainer' END)
      FROM training_sessions s WHERE s.learner_agent_id = ${agentId}::uuid OR s.trainer_agent_id = ${agentId}::uuid
    UNION ALL
    SELECT 'session', s.id::text, 'session.started', s.started_at, 'system', NULL,
           jsonb_build_object('subject', s.subject, 'role', CASE WHEN s.learner_agent_id = ${agentId}::uuid THEN 'learner' ELSE 'trainer' END)
      FROM training_sessions s WHERE (s.learner_agent_id = ${agentId}::uuid OR s.trainer_agent_id = ${agentId}::uuid) AND s.started_at IS NOT NULL
    UNION ALL
    SELECT 'session', s.id::text, 'session.' || s.status, s.ended_at, 'system', NULL,
           jsonb_build_object('subject', s.subject, 'role', CASE WHEN s.learner_agent_id = ${agentId}::uuid THEN 'learner' ELSE 'trainer' END, 'improvement', s.improvement)
      FROM training_sessions s WHERE (s.learner_agent_id = ${agentId}::uuid OR s.trainer_agent_id = ${agentId}::uuid) AND s.ended_at IS NOT NULL
    UNION ALL
    SELECT 'assessment', c.id::text, 'assessment.queued', c.created_at, 'system', NULL, jsonb_build_object('purpose', c.purpose, 'domains', c.domain_slugs)
      FROM capability_assessments c WHERE c.agent_id = ${agentId}::uuid AND c.org_id = ${orgId}::uuid
    UNION ALL
    SELECT 'assessment', c.id::text, 'assessment.' || c.status, c.completed_at, 'system', NULL,
           jsonb_build_object('purpose', c.purpose, 'overallScore', c.overall_score, 'testsCompleted', c.tests_completed)
      FROM capability_assessments c WHERE c.agent_id = ${agentId}::uuid AND c.org_id = ${orgId}::uuid AND c.completed_at IS NOT NULL`;
}

export default async function routes(app: FastifyInstance) {
  /* ───────────── pause / resume ───────────── */

  app.post('/agents/:id/pause', { config: ownerWriteLimit }, async (req) => {
    const a = requirePerm(req, 'agents.update');
    const { id } = parse(IdParam, req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().max(300).optional() }), req.body ?? {});
    const agent = await getOwnedAgent(id, a.orgId);
    if (agent.pausedAt) throw conflict(`${agent.name} is already paused`);
    const now = new Date();
    const [u] = await db().update(schema.agents).set({ pausedAt: now, updatedAt: now })
      .where(and(eq(schema.agents.id, id), isNull(schema.agents.pausedAt))).returning({ pausedAt: schema.agents.pausedAt });
    if (!u) throw conflict(`${agent.name} is already paused`);
    wake(id);
    await audit({ action: 'agent.pause', targetType: 'agent', targetId: id, metadata: reason ? { reason } : {} }, req);
    return { id, paused: true, pausedAt: u.pausedAt };
  });

  app.post('/agents/:id/resume', { config: ownerWriteLimit }, async (req) => {
    const a = requirePerm(req, 'agents.update');
    const { id } = parse(IdParam, req.params);
    const agent = await getOwnedAgent(id, a.orgId);
    if (!agent.pausedAt) throw conflict(`${agent.name} is not paused`);
    const pausedSeconds = Math.round((Date.now() - agent.pausedAt.getTime()) / 1000);
    await db().update(schema.agents).set({ pausedAt: null, updatedAt: new Date() }).where(eq(schema.agents.id, id));
    wake(id);
    await audit({ action: 'agent.resume', targetType: 'agent', targetId: id, metadata: { pausedSeconds } }, req);
    return { id, paused: false, pausedAt: null };
  });

  /* ───────────── new agent link (rotate) ───────────── */

  /**
   * Revoke the current agent token immediately and issue a fresh one-time connection prompt (claim code).
   * Same mechanics as POST /agents/:id/connect-prompt; the old token gets 401 on its very next request,
   * and an in-flight long-poll with the old token is ended with 401 within ~2 s.
   */
  app.post('/agents/:id/rotate-link', { config: rotateLimit }, async (req) => {
    const a = requirePerm(req, 'agents.connect');
    const { id } = parse(IdParam, req.params);
    const agent = await getOwnedAgent(id, a.orgId);
    if (agent.status === 'suspended') throw conflict('Suspended agents cannot be given a new link');
    const provider = await getProviderById(agent.providerId);
    if (provider.adapter !== 'inbox') throw unprocessable(`${provider.name} agents are not connected via an agent link — update the connection instead`);
    const [existing] = await db().select().from(schema.agentConnections).where(eq(schema.agentConnections.agentId, id)).limit(1);
    const prev = existing ? promptConfig(existing) : null;
    const hadToken = !!prev?.agentTokenHash;
    const claim = freshClaim(prev);
    const now = new Date();
    const values = {
      method: PROMPT_METHOD, endpointUrl: null, credentialEnc: null, credentialLast4: null, webhookSecretEnc: null,
      config: claim.config, status: 'pending', lastError: null, updatedAt: now,
    };
    if (existing) await db().update(schema.agentConnections).set(values).where(eq(schema.agentConnections.id, existing.id));
    else await db().insert(schema.agentConnections).values({ agentId: id, ...values });
    await expireOpenTasks(id);
    wake(id);
    await db().update(schema.agents).set({ health: 'unknown', status: agent.status === 'disconnected' ? 'draft' : agent.status, updatedAt: now }).where(eq(schema.agents.id, id));
    await audit({ action: 'agent.rotate_link', targetType: 'agent', targetId: id, metadata: { revokedToken: hadToken } }, req);
    await publishConnectionState(id, agent.orgId, 'awaiting_claim');
    return { ...buildConnectPrompt(claim.claimCode, claim.expiresAt), revokedToken: hadToken, paused: !!agent.pausedAt };
  });

  /* ───────────── activity log ───────────── */

  app.get('/agents/:id/activity', async (req) => {
    const a = requirePerm(req, 'agents.read');
    const { id } = parse(IdParam, req.params);
    const q = parse(ActivityQuery, req.query);
    const agent = await getOwnedAgent(id, a.orgId);
    const union = activityUnion(agent.id, agent.orgId);
    const filter = q.source ? sql`WHERE x.source = ${q.source}` : sql``;
    const [{ n }] = rowsOf<{ n: number }>(await db().execute(sql`SELECT count(*)::int AS n FROM (${union}) x ${filter}`));
    const rows = rowsOf<ActivityRow>(await db().execute(sql`
      SELECT * FROM (${union}) x ${filter} ORDER BY x.at DESC, x.ref_id DESC LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`));
    return {
      items: rows.map((r) => ({
        id: `${r.source}:${r.ref_id}:${r.kind}`, source: r.source, refId: r.ref_id, kind: r.kind,
        at: new Date(r.at).toISOString(), actorType: r.actor_type, actorName: r.actor_name, meta: r.meta ?? {},
      })),
      total: Number(n ?? 0), page: q.page, pageSize: q.pageSize,
    };
  });

  /* ───────────── reports (all content types) ───────────── */

  app.post('/reports', { config: reportLimit }, async (req, reply) => {
    const a = requireAuth(req);
    const body = parse(ReportBody, req.body);
    await assertReportable(body.targetType, body.targetId, a.orgId);
    const [dupe] = await db().select({ id: schema.reports.id }).from(schema.reports).where(and(
      eq(schema.reports.reporterId, a.user.id), eq(schema.reports.targetType, body.targetType),
      eq(schema.reports.targetId, body.targetId), eq(schema.reports.status, 'open'),
    )).limit(1);
    if (dupe) throw new AppError(409, 'already_reported', 'You have already reported this. Our moderators are reviewing it.');
    const [row] = await db().insert(schema.reports).values({
      reporterId: a.user.id, targetType: body.targetType, targetId: body.targetId, reason: body.reason, details: body.details,
    }).returning();
    await audit({ action: 'report.create', targetType: body.targetType, targetId: body.targetId, metadata: { reportId: row!.id, reason: body.reason } }, req);
    return reply.status(201).send({ id: row!.id, status: row!.status, createdAt: row!.createdAt });
  });

  /** Has the signed-in user an open report on this target? (lets the button show "Reported"). */
  app.get('/reports/mine', async (req) => {
    const a = requireAuth(req);
    const q = parse(z.object({ targetType: z.enum(REPORT_TARGET_TYPES), targetId: z.string().uuid() }), req.query);
    const [r] = await db().select({ id: schema.reports.id, status: schema.reports.status, createdAt: schema.reports.createdAt }).from(schema.reports).where(and(
      eq(schema.reports.reporterId, a.user.id), eq(schema.reports.targetType, q.targetType), eq(schema.reports.targetId, q.targetId),
      eq(schema.reports.status, 'open'),
    )).limit(1);
    return { reported: !!r, report: r ?? null };
  });
}

/** Register background job handlers for this module (called once at startup). */
export function registerJobs() {}
