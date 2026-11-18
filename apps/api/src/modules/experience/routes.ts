/**
 * Experience Ledger API (owner side). The agent itself records experience through /agent-api/experiences.
 *
 *   GET    /agents/:agentId                         profile: Experience Scores per domain, qualification, latest replays
 *   GET    /agents/:agentId/records                 list (?domain=&result=&q=&page=&pageSize=)
 *   POST   /agents/:agentId/records                 add one ({…}) or many ({ experiences: […] })  source 'owner'
 *   POST   /agents/:agentId/import                  bulk history { content, format? } — JSON array / JSONL / CSV  source 'import'
 *   POST   /agents/:agentId/records/:id/outcome     record the outcome of a pending decision
 *   DELETE /agents/:agentId/records/:id
 *   POST   /agents/:agentId/replays                 start a self replay { domain }
 *   GET    /agents/:agentId/replays                 list replays (self + training)
 *   GET    /replays/:id                             replay detail (hidden references only for the case owner's org)
 *   POST   /replays/:id/cancel
 *   GET    /public/:agent                           public experience profile of a public agent (scores only, never records)
 * Realtime: channel `replay:<id>` (org members of the subject or source agent).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, desc, eq, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db/client.js';
import { enqueue, registerJob } from '../../jobs/queue.js';
import { audit } from '../../lib/audit.js';
import { requirePerm } from '../../lib/auth.js';
import { notFound } from '../../lib/errors.js';
import { onTaskAnswered } from '../../lib/agent-inbox.js';
import { parse } from '../../lib/http.js';
import { getOwnedAgent } from '../../lib/tenancy.js';
import { registerChannelGuard } from '../../ws/hub.js';
import { EXPERIENCE_RESULTS, addExperiences, deleteExperience, experienceViews, listExperiences, parseImport, recordOutcome } from '../../engine/experience/ledger.js';
import {
  REPLAY_JOB, REPLAY_MAX_ITEMS, REPLAY_MIN_ITEMS, REPLAY_SWEEP_JOB, cancelReplay, createReplay, ensureReplaySweepScheduled, handleReplayTaskAnswer,
  replayView, runReplay, sweepReplays,
} from '../../engine/experience/replay.js';
import { QUALIFY, REPLAY_VALID_DAYS, STALE_PENDING_DAYS, WEIGHTS, getExperienceScores, recomputeExperienceScores, scoreView } from '../../engine/experience/score.js';
import { publicAgentWhere } from '../marketplace/cards.js';

const Id = z.string().uuid();
const AgentParam = z.object({ agentId: Id });
const RecordParam = z.object({ agentId: Id, id: Id });
const ListQuery = z.object({
  domain: z.string().max(64).optional(),
  result: z.enum(EXPERIENCE_RESULTS).optional(),
  q: z.string().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
const ImportBody = z.object({ content: z.string().min(1).max(5_000_000), format: z.enum(['json', 'jsonl', 'csv']).optional() });
const ReplayBody = z.object({ domain: z.string().max(64).default('all') });

/** How the score works and what qualifies an agent as a trainer — returned with the profile so the UI never guesses. */
export const EXPERIENCE_RULES = {
  weights: WEIGHTS,
  qualify: QUALIFY,
  replay: { minCases: REPLAY_MIN_ITEMS, maxCases: REPLAY_MAX_ITEMS, validDays: REPLAY_VALID_DAYS },
  stalePendingDays: STALE_PENDING_DAYS,
  explanation: [
    'Experience Score measures this agent\'s real track record, not its model: a new agent on the best model scores 0.',
    'Depth: how many past cases with a known outcome (witnessed cases count fully, imported/self-reported history counts half).',
    'Span: how long the agent has been doing this work (full at 24 months).',
    'Track record: how often its decisions worked (conservative lower bound). Decisions logged on Hive Mind but never resolved count as misses after 90 days.',
    'Replay: real past cases are replayed with the outcome hidden; the agent must decide again using the rest of its experience.',
  ],
};

async function profile(agentId: string) {
  let rows = await getExperienceScores(agentId);
  if (!rows.length) rows = await recomputeExperienceScores(agentId);
  const replays = await db().select().from(schema.experienceReplays)
    .where(or(eq(schema.experienceReplays.agentId, agentId), eq(schema.experienceReplays.sourceAgentId, agentId)))
    .orderBy(desc(schema.experienceReplays.createdAt)).limit(20);
  const [counts] = await db().select({
    total: sql<number>`count(*)::int`,
    pending: sql<number>`count(*) filter (where ${schema.agentExperiences.result} = 'pending')::int`,
  }).from(schema.agentExperiences).where(eq(schema.agentExperiences.agentId, agentId));
  return {
    agentId,
    totals: { records: Number(counts?.total ?? 0), pending: Number(counts?.pending ?? 0) },
    scores: rows.map(scoreView).sort((a, b) => (a.domain === 'all' ? -1 : b.domain === 'all' ? 1 : b.score - a.score)),
    replays: replays.map((r) => ({
      id: r.id, agentId: r.agentId, sourceAgentId: r.sourceAgentId, domain: r.domainSlug, purpose: r.purpose, status: r.status, mode: r.mode, score: r.score,
      itemsTotal: r.itemsTotal, itemsGraded: r.itemsGraded, error: r.error, trainingSessionId: r.trainingSessionId, createdAt: r.createdAt, completedAt: r.completedAt,
    })),
    rules: EXPERIENCE_RULES,
  };
}

async function canSeeReplay(req: FastifyRequest, replayId: string) {
  if (!Id.safeParse(replayId).success) throw notFound('Replay');
  const a = requirePerm(req, 'agents.read');
  const [r] = await db().select().from(schema.experienceReplays).where(eq(schema.experienceReplays.id, replayId)).limit(1);
  if (!r) throw notFound('Replay');
  const [source] = await db().select({ orgId: schema.agents.orgId }).from(schema.agents).where(eq(schema.agents.id, r.sourceAgentId)).limit(1);
  const ownsSubject = r.orgId === a.orgId;
  const ownsSource = source?.orgId === a.orgId;
  if (!ownsSubject && !ownsSource) throw notFound('Replay');
  return { replay: r, ownsSource, ownsSubject, auth: a };
}

export function registerJobs() {
  registerJob(REPLAY_JOB, async (p) => {
    const id = String(p.replayId ?? '');
    if (Id.safeParse(id).success) await runReplay(id);
  });
  registerJob(REPLAY_SWEEP_JOB, async () => {
    const r = await sweepReplays();
    if (r.running > 0) await ensureReplaySweepScheduled();
  });
  onTaskAnswered('experience_replay', handleReplayTaskAnswer);
}

export default async function routes(app: FastifyInstance) {
  registerChannelGuard('replay', async (auth, id) => {
    if (!Id.safeParse(id).success) return false;
    const [r] = await db().select({ orgId: schema.experienceReplays.orgId, sourceAgentId: schema.experienceReplays.sourceAgentId }).from(schema.experienceReplays).where(eq(schema.experienceReplays.id, id)).limit(1);
    if (!r) return false;
    const [src] = await db().select({ orgId: schema.agents.orgId }).from(schema.agents).where(eq(schema.agents.id, r.sourceAgentId)).limit(1);
    const orgs = [r.orgId, src?.orgId].filter((x): x is string => !!x);
    const ms = await db().select().from(schema.memberships).where(eq(schema.memberships.userId, auth.user.id));
    return ms.some((m) => orgs.includes(m.orgId));
  });

  app.get('/agents/:agentId', async (req) => {
    const a = requirePerm(req, 'agents.read');
    const { agentId } = parse(AgentParam, req.params);
    await getOwnedAgent(agentId, a.orgId);
    return profile(agentId);
  });

  app.get('/agents/:agentId/records', async (req) => {
    const a = requirePerm(req, 'agents.read');
    const { agentId } = parse(AgentParam, req.params);
    await getOwnedAgent(agentId, a.orgId);
    return listExperiences(agentId, parse(ListQuery, req.query));
  });

  app.post('/agents/:agentId/records', { bodyLimit: 2 * 1024 * 1024 }, async (req, reply) => {
    const a = requirePerm(req, 'agents.update');
    const { agentId } = parse(AgentParam, req.params);
    const agent = await getOwnedAgent(agentId, a.orgId);
    const body = req.body as { experiences?: unknown } | null;
    const items = Array.isArray(body?.experiences) ? body!.experiences as unknown[] : [body];
    const r = await addExperiences(agent, items, 'owner');
    await recomputeExperienceScores(agent.id);
    await audit({ action: 'experience.add', targetType: 'agent', targetId: agent.id, metadata: { created: r.created.length, rejected: r.rejected.length } }, req);
    return reply.status(r.created.length ? 201 : 200).send({ created: await experienceViews(r.created), duplicates: r.duplicates, rejected: r.rejected, flagged: r.flagged });
  });

  app.post('/agents/:agentId/import', { bodyLimit: 6 * 1024 * 1024 }, async (req, reply) => {
    const a = requirePerm(req, 'agents.update');
    const { agentId } = parse(AgentParam, req.params);
    const agent = await getOwnedAgent(agentId, a.orgId);
    const body = parse(ImportBody, req.body);
    const items = parseImport(body.content, body.format);
    let created = 0, duplicates = 0, flagged = 0;
    const rejected: { index: number; reason: string }[] = [];
    for (let i = 0; i < items.length; i += 500) {
      const r = await addExperiences(agent, items.slice(i, i + 500), 'import');
      created += r.created.length; duplicates += r.duplicates; flagged += r.flagged;
      rejected.push(...r.rejected.map((x) => ({ index: x.index + i, reason: x.reason })));
    }
    await recomputeExperienceScores(agent.id);
    await audit({ action: 'experience.import', targetType: 'agent', targetId: agent.id, metadata: { rows: items.length, created, rejected: rejected.length } }, req);
    return reply.status(created ? 201 : 200).send({ rows: items.length, created, duplicates, flagged, rejected: rejected.slice(0, 200), rejectedCount: rejected.length });
  });

  app.post('/agents/:agentId/records/:id/outcome', async (req) => {
    const a = requirePerm(req, 'agents.update');
    const { agentId, id } = parse(RecordParam, req.params);
    await getOwnedAgent(agentId, a.orgId);
    const e = await recordOutcome(agentId, id, req.body);
    await recomputeExperienceScores(agentId);
    return (await experienceViews([e]))[0];
  });

  app.delete('/agents/:agentId/records/:id', async (req, reply) => {
    const a = requirePerm(req, 'agents.update');
    const { agentId, id } = parse(RecordParam, req.params);
    await getOwnedAgent(agentId, a.orgId);
    await deleteExperience(agentId, id);
    await recomputeExperienceScores(agentId);
    await audit({ action: 'experience.delete', targetType: 'agent', targetId: agentId, metadata: { experienceId: id } }, req);
    return reply.status(204).send();
  });

  app.post('/agents/:agentId/replays', async (req, reply) => {
    const a = requirePerm(req, 'assessments.run');
    const { agentId } = parse(AgentParam, req.params);
    const agent = await getOwnedAgent(agentId, a.orgId);
    const { domain } = parse(ReplayBody, req.body ?? {});
    const r = await createReplay({ agentId: agent.id, domainSlug: domain, purpose: 'self', requestedBy: a.user.id });
    await enqueue(REPLAY_JOB, { replayId: r.id }, { maxAttempts: 1 });
    await audit({ action: 'experience.replay.start', targetType: 'agent', targetId: agent.id, metadata: { replayId: r.id, domain } }, req);
    return reply.status(202).send(r);
  });

  app.get('/agents/:agentId/replays', async (req) => {
    const a = requirePerm(req, 'agents.read');
    const { agentId } = parse(AgentParam, req.params);
    await getOwnedAgent(agentId, a.orgId);
    return (await profile(agentId)).replays;
  });

  app.get('/replays/:id', async (req) => {
    const { replay, ownsSource } = await canSeeReplay(req, (req.params as { id: string }).id);
    return replayView(replay.id, { revealReference: ownsSource });
  });

  app.post('/replays/:id/cancel', async (req) => {
    const { replay, ownsSubject, auth } = await canSeeReplay(req, (req.params as { id: string }).id);
    if (!ownsSubject || replay.trainingSessionId) throw notFound('Replay');
    requirePerm(req, 'assessments.run');
    const r = await cancelReplay(replay.id);
    await audit({ action: 'experience.replay.cancel', targetType: 'agent', targetId: replay.agentId, orgId: auth.orgId, actorUserId: auth.user.id, actorType: 'user', metadata: { replayId: replay.id } });
    return r;
  });

  /** Public experience profile (scores only — experience records are private to the owner). */
  app.get('/public/:agent', async (req) => {
    const key = String((req.params as { agent: string }).agent ?? '');
    const cond = Id.safeParse(key).success ? eq(schema.agents.id, key) : eq(schema.agents.slug, key);
    const [row] = await db().select({ a: schema.agents }).from(schema.agents)
      .innerJoin(schema.organisations, eq(schema.organisations.id, schema.agents.orgId)).where(and(publicAgentWhere(), cond)).limit(1);
    if (!row) throw notFound('Agent');
    const rows = await getExperienceScores(row.a.id);
    return { agentId: row.a.id, scores: rows.map(scoreView).map(({ replayId: _r, ...v }) => v), rules: EXPERIENCE_RULES };
  });
}
