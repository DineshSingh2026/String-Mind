/**
 * Social module (Hive Mind social layer), mounted at /social.
 *
 *   Public profiles   GET    /social/agents/:slug/profile-extras        (no auth; public agents only)
 *   Follows           POST   /social/follows                            { targetType, targetId }
 *                     DELETE /social/follows?targetType&targetId        (body also accepted)
 *                     GET    /social/follows                            my follows, with target summaries
 *                     GET    /social/follows/status?targetType&targetId { following, followers, signedIn } (no auth needed)
 *   Public rooms      GET    /social/rooms                              public + visible training sessions (no auth)
 *                     GET    /social/rooms/:id                          read-only room view (no auth; public + visible only)
 *                     GET    /social/rooms/:id/messages?after=ISO       viewer-safe transcript (no auth; public + visible only)
 *                     PATCH  /social/rooms/:id/visibility               { visibility } — participant org + training.participate
 *
 * Jobs: `social.room_activity` (notify followers about new messages in public rooms; cursor in the payload) and
 * `social.badges_sweep` (refresh badges for agents with recent activity, full sweep every ~hour).
 * Private sessions are never readable here; `moderation = 'removed'` hides a room completely.
 */
import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { BADGES } from '@aix/shared';
import { db, rowsOf, schema } from '../../db/client.js';
import { requireAuth, requirePerm } from '../../lib/auth.js';
import { audit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { PageQuery, offset, parse } from '../../lib/http.js';
import { enqueue, registerJob } from '../../jobs/queue.js';
import { publish } from '../../ws/hub.js';
import { publicAgentWhere } from '../marketplace/cards.js';
import {
  agentsForFullSweep, agentsWithActivitySince, badgeStats, confirmCountForAgent, processRoomActivity, pruneOwnJobs, refreshBadges,
} from './service.js';

export const ROOM_ACTIVITY_JOB = 'social.room_activity';
export const BADGES_SWEEP_JOB = 'social.badges_sweep';
const ROOM_ACTIVITY_INTERVAL_MS = 30_000;
const BADGES_SWEEP_INTERVAL_MS = 5 * 60_000;
const FULL_SWEEP_EVERY = 12; // badge sweeps → one full sweep per ~hour

const TargetType = z.enum(['agent', 'session', 'debate']);
const FollowBody = z.object({ targetType: TargetType, targetId: z.string().uuid() });
const Visibility = z.object({ visibility: z.enum(['public', 'private']) });

type Session = typeof schema.trainingSessions.$inferSelect;
type Msg = typeof schema.trainingMessages.$inferSelect;

const LIVE = ['active', 'paused'];

/* ───────────── helpers ───────────── */

async function publicAgentIds(ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await db().select({ id: schema.agents.id }).from(schema.agents)
    .innerJoin(schema.organisations, eq(schema.organisations.id, schema.agents.orgId))
    .where(and(publicAgentWhere(), inArray(schema.agents.id, [...new Set(ids)])));
  return new Set(rows.map((r) => r.id));
}

/** Agent summaries safe for anonymous viewers: profile slug only when the agent itself is public. */
async function roomAgents(ids: string[]) {
  const uniq = [...new Set(ids)];
  if (!uniq.length) return new Map<string, { id: string; name: string; avatar: string | null; slug: string | null; isPublic: boolean }>();
  const [rows, pub] = await Promise.all([
    db().select({ id: schema.agents.id, name: schema.agents.name, avatar: schema.agents.avatar, slug: schema.agents.slug }).from(schema.agents).where(inArray(schema.agents.id, uniq)),
    publicAgentIds(uniq),
  ]);
  return new Map(rows.map((r) => [r.id, { id: r.id, name: r.name, avatar: r.avatar, slug: pub.has(r.id) ? r.slug : null, isPublic: pub.has(r.id) }]));
}

async function domainsById(ids: string[]) {
  if (!ids.length) return new Map<string, { slug: string; name: string }>();
  const rows = await db().select({ id: schema.capabilityDomains.id, slug: schema.capabilityDomains.slug, name: schema.capabilityDomains.name })
    .from(schema.capabilityDomains).where(inArray(schema.capabilityDomains.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, { slug: r.slug, name: r.name }]));
}

async function followerCounts(targetType: string, ids: string[]) {
  if (!ids.length) return new Map<string, number>();
  const rows = await db().select({ id: schema.follows.targetId, n: count() }).from(schema.follows)
    .where(and(eq(schema.follows.targetType, targetType), inArray(schema.follows.targetId, ids))).groupBy(schema.follows.targetId);
  return new Map(rows.map((r) => [r.id, Number(r.n)]));
}

const publicRoomWhere = () => and(eq(schema.trainingSessions.visibility, 'public'), ne(schema.trainingSessions.moderation, 'removed'));

async function loadPublicRoom(id: string): Promise<Session> {
  if (!z.string().uuid().safeParse(id).success) throw notFound('Room');
  const [s] = await db().select().from(schema.trainingSessions).where(and(eq(schema.trainingSessions.id, id), publicRoomWhere())).limit(1);
  if (!s) throw notFound('Room');
  return s;
}

/** Messages a public viewer may see. Messages marked not-shared are dropped; flagged content is withheld. */
function viewerMessage(m: Msg) {
  return {
    id: m.id, sessionId: m.sessionId, senderRole: m.senderRole, senderAgentId: m.senderAgentId, stage: m.stage,
    content: m.flagged ? '' : m.content,
    flagged: m.flagged, flagReason: m.flagged ? m.flagReason : null,
    metadata: m.flagged ? { blocked: true } : {},
    createdAt: m.createdAt,
  };
}
const viewerVisible = sql`coalesce(${schema.trainingMessages.metadata}->>'shared', 'true') <> 'false'`;

function roomCard(s: Session, agents: Awaited<ReturnType<typeof roomAgents>>, domains: Map<string, { slug: string; name: string }>, msgCount: number, followers: number) {
  return {
    id: s.id, subject: s.subject, status: s.status, stage: s.stage, live: LIVE.includes(s.status),
    domain: domains.get(s.domainId) ?? null,
    learner: agents.get(s.learnerAgentId) ?? null, trainer: agents.get(s.trainerAgentId) ?? null,
    messageCount: msgCount, followers,
    startedAt: s.startedAt, endedAt: s.endedAt, createdAt: s.createdAt, updatedAt: s.updatedAt,
  };
}

async function resolveFollowTarget(targetType: string, targetId: string, userId: string): Promise<{ ok: boolean; title: string; link: string | null }> {
  const myOrgs = (await db().select({ orgId: schema.memberships.orgId }).from(schema.memberships).where(eq(schema.memberships.userId, userId))).map((m) => m.orgId);
  if (targetType === 'agent') {
    const [a] = await db().select({ id: schema.agents.id, name: schema.agents.name, slug: schema.agents.slug, orgId: schema.agents.orgId })
      .from(schema.agents).where(and(eq(schema.agents.id, targetId), isNull(schema.agents.deletedAt))).limit(1);
    if (!a) return { ok: false, title: '', link: null };
    const pub = (await publicAgentIds([a.id])).has(a.id);
    if (!pub && !myOrgs.includes(a.orgId)) return { ok: false, title: '', link: null };
    return { ok: true, title: a.name, link: pub ? `/marketplace/${a.slug}` : `/app/agents/${a.id}` };
  }
  if (targetType === 'session') {
    const [s] = await db().select().from(schema.trainingSessions).where(eq(schema.trainingSessions.id, targetId)).limit(1);
    if (!s) return { ok: false, title: '', link: null };
    const participant = myOrgs.includes(s.learnerOrgId) || myOrgs.includes(s.trainerOrgId);
    const isPublic = s.visibility === 'public' && s.moderation !== 'removed';
    if (!isPublic && !participant) return { ok: false, title: '', link: null };
    return { ok: true, title: s.subject, link: isPublic ? `/rooms/${s.id}` : `/app/training/${s.id}` };
  }
  const [d] = await db().select({ id: schema.debates.id, title: schema.debates.title, moderation: schema.debates.moderation }).from(schema.debates).where(eq(schema.debates.id, targetId)).limit(1);
  if (!d || d.moderation === 'removed') return { ok: false, title: '', link: null };
  return { ok: true, title: d.title, link: `/debates/${d.id}` };
}

/* ───────────── routes ───────────── */

export default async function routes(app: FastifyInstance) {
  app.addHook('onReady', async () => {
    await ensureScheduled().catch((e) => console.error('[social] could not schedule jobs', e));
  });

  /* ───── public profile extras ───── */
  app.get('/agents/:slug/profile-extras', async (req) => {
    const { slug } = parse(z.object({ slug: z.string().min(1).max(200) }), req.params);
    const [agent] = await db().select({ a: schema.agents }).from(schema.agents)
      .innerJoin(schema.organisations, eq(schema.organisations.id, schema.agents.orgId))
      .where(and(publicAgentWhere(), eq(schema.agents.slug, slug))).limit(1);
    if (!agent) throw notFound('Agent');
    const a = agent.a;
    const S = schema;

    const [badgeRows, stats, artefacts, artefactTotal, hive, rooms, records, followers] = await Promise.all([
      db().select().from(S.agentBadges).where(eq(S.agentBadges.agentId, a.id)),
      badgeStats(a.id),
      db().select({ id: S.learningArtefacts.id, title: S.learningArtefacts.title, domainId: S.learningArtefacts.domainId, createdAt: S.learningArtefacts.createdAt })
        .from(S.learningArtefacts)
        .where(and(eq(S.learningArtefacts.trainerAgentId, a.id), inArray(S.learningArtefacts.status, ['approved', 'applied'])))
        .orderBy(desc(S.learningArtefacts.createdAt)).limit(20),
      db().select({ n: count() }).from(S.learningArtefacts)
        .where(and(eq(S.learningArtefacts.trainerAgentId, a.id), inArray(S.learningArtefacts.status, ['approved', 'applied']))),
      db().select({ id: S.hiveLessons.id, title: S.hiveLessons.title, domainId: S.hiveLessons.domainId, sourceType: S.hiveLessons.sourceType, confirmCount: S.hiveLessons.confirmCount, disputeCount: S.hiveLessons.disputeCount, createdAt: S.hiveLessons.createdAt })
        .from(S.hiveLessons)
        .where(and(ne(S.hiveLessons.moderation, 'removed'), sql`${S.hiveLessons.agentIds} @> ${JSON.stringify([a.id])}::jsonb`))
        .orderBy(desc(S.hiveLessons.createdAt)).limit(20),
      db().select().from(S.trainingSessions)
        .where(and(publicRoomWhere(), or(eq(S.trainingSessions.learnerAgentId, a.id), eq(S.trainingSessions.trainerAgentId, a.id))))
        .orderBy(desc(S.trainingSessions.updatedAt)).limit(20),
      // learners' measured outcomes from sessions this agent trained (learning records are written after the post-assessment)
      db().select({ improvement: S.learningRecords.improvement, verified: S.learningRecords.verified }).from(S.learningRecords)
        .innerJoin(S.trainingSessions, eq(S.trainingSessions.id, S.learningRecords.sessionId))
        .where(eq(S.trainingSessions.trainerAgentId, a.id)),
      followerCounts('agent', [a.id]),
    ]);

    // confirm verdicts on artefact titles shown
    const artIds = artefacts.map((x) => x.id);
    const artConfirms = artIds.length
      ? await db().select({ id: S.knowledgeVerdicts.targetId, n: count() }).from(S.knowledgeVerdicts)
        .where(and(eq(S.knowledgeVerdicts.targetType, 'artefact'), inArray(S.knowledgeVerdicts.targetId, artIds), eq(S.knowledgeVerdicts.verdict, 'confirm'), ne(S.knowledgeVerdicts.moderation, 'removed'), ne(S.knowledgeVerdicts.agentId, a.id)))
        .groupBy(S.knowledgeVerdicts.targetId)
      : [];
    const confirmsByArt = new Map(artConfirms.map((r) => [r.id, Number(r.n)]));
    const domains = await domainsById([...artefacts.map((x) => x.domainId), ...hive.map((x) => x.domainId), ...rooms.map((r) => r.domainId)].filter(Boolean) as string[]);

    const roomIds = rooms.map((r) => r.id);
    const msgCounts = roomIds.length
      ? await db().select({ id: S.trainingMessages.sessionId, n: count() }).from(S.trainingMessages).where(inArray(S.trainingMessages.sessionId, roomIds)).groupBy(S.trainingMessages.sessionId)
      : [];
    const msgBy = new Map(msgCounts.map((r) => [r.id, Number(r.n)]));
    const ragents = await roomAgents(rooms.flatMap((r) => [r.learnerAgentId, r.trainerAgentId]));
    const roomFollowers = await followerCounts('session', roomIds);

    const measured = records.filter((r) => r.verified && r.improvement != null);
    const improved = measured.filter((r) => (r.improvement ?? 0) > 0);
    const avgImprovement = improved.length ? Math.round((improved.reduce((s, r) => s + (r.improvement ?? 0), 0) / improved.length) * 10) / 10 : null;
    const def = new Map(BADGES.map((b) => [b.slug as string, b]));

    return {
      agentId: a.id,
      followers: followers.get(a.id) ?? 0,
      badges: badgeRows.filter((b) => def.has(b.badge)).map((b) => ({ ...def.get(b.badge)!, awardedAt: b.awardedAt, meta: b.meta })),
      badgeCatalog: BADGES,
      lessonsTaught: {
        total: Number(artefactTotal[0]?.n ?? 0),
        items: artefacts.map((x) => ({ id: x.id, title: x.title, domain: x.domainId ? domains.get(x.domainId) ?? null : null, confirmations: confirmsByArt.get(x.id) ?? 0, createdAt: x.createdAt })),
      },
      hiveLessons: hive.map((h) => ({ id: h.id, title: h.title, sourceType: h.sourceType, domain: h.domainId ? domains.get(h.domainId) ?? null : null, confirmCount: h.confirmCount, disputeCount: h.disputeCount, createdAt: h.createdAt })),
      publicRooms: rooms.map((r) => ({ ...roomCard(r, ragents, domains, msgBy.get(r.id) ?? 0, roomFollowers.get(r.id) ?? 0), role: r.trainerAgentId === a.id ? 'trainer' : 'learner' })),
      helpfulness: {
        definition: 'Learners helped = learner agents whose independently measured score went up (verified post-assessment minus pre-assessment on held-out questions) after a session this agent trained. Confirmations = confirm verdicts other agents gave on lessons it taught (its own verdicts excluded).',
        sessionsTrained: stats.sessionsTrained,
        measuredSessions: measured.length,
        learnersHelped: improved.length,
        helpRate: measured.length ? Math.round((improved.length / measured.length) * 1000) / 10 : null,
        avgImprovement,
        confirmations: await confirmCountForAgent(a.id),
      },
      stats,
    };
  });

  /* ───── follows ───── */
  app.post('/follows', async (req, reply) => {
    const auth = requireAuth(req);
    const body = parse(FollowBody, req.body);
    const t = await resolveFollowTarget(body.targetType, body.targetId, auth.user.id);
    if (!t.ok) throw notFound(body.targetType === 'session' ? 'Room' : body.targetType === 'agent' ? 'Agent' : 'Debate');
    await db().insert(schema.follows).values({ userId: auth.user.id, targetType: body.targetType, targetId: body.targetId }).onConflictDoNothing();
    const n = (await followerCounts(body.targetType, [body.targetId])).get(body.targetId) ?? 0;
    return reply.status(201).send({ following: true, followers: n });
  });

  app.delete('/follows', async (req) => {
    const auth = requireAuth(req);
    const src = { ...(req.query as object), ...((req.body && typeof req.body === 'object') ? req.body as object : {}) };
    const body = parse(FollowBody, src);
    await db().delete(schema.follows).where(and(eq(schema.follows.userId, auth.user.id), eq(schema.follows.targetType, body.targetType), eq(schema.follows.targetId, body.targetId)));
    const n = (await followerCounts(body.targetType, [body.targetId])).get(body.targetId) ?? 0;
    return { following: false, followers: n };
  });

  app.get('/follows/status', async (req) => {
    const q = parse(FollowBody, req.query);
    const n = (await followerCounts(q.targetType, [q.targetId])).get(q.targetId) ?? 0;
    let following = false;
    if (req.auth) {
      const [f] = await db().select({ u: schema.follows.userId }).from(schema.follows)
        .where(and(eq(schema.follows.userId, req.auth.user.id), eq(schema.follows.targetType, q.targetType), eq(schema.follows.targetId, q.targetId))).limit(1);
      following = !!f;
    }
    return { following, followers: n, signedIn: !!req.auth };
  });

  app.get('/follows', async (req) => {
    const auth = requireAuth(req);
    const rows = await db().select().from(schema.follows).where(eq(schema.follows.userId, auth.user.id)).orderBy(desc(schema.follows.createdAt)).limit(500);
    const items = [];
    for (const f of rows) {
      const t = await resolveFollowTarget(f.targetType, f.targetId, auth.user.id);
      items.push({ targetType: f.targetType, targetId: f.targetId, createdAt: f.createdAt, available: t.ok, title: t.ok ? t.title : null, link: t.ok ? t.link : null });
    }
    return { items, total: items.length };
  });

  /* ───── public rooms ───── */
  app.get('/rooms', async (req) => {
    const q = parse(PageQuery.extend({ status: z.enum(['live', 'recent', 'all']).default('all'), agentId: z.string().uuid().optional() }), req.query);
    const conds = [publicRoomWhere()!];
    if (q.status === 'live') conds.push(inArray(schema.trainingSessions.status, [...LIVE, 'scheduled']));
    if (q.status === 'recent') conds.push(inArray(schema.trainingSessions.status, ['completed', 'failed', 'cancelled', 'disputed']));
    if (q.agentId) conds.push(or(eq(schema.trainingSessions.learnerAgentId, q.agentId), eq(schema.trainingSessions.trainerAgentId, q.agentId))!);
    const where = and(...conds);
    const liveFirst = sql`CASE WHEN ${schema.trainingSessions.status} IN ('active','paused') THEN 0 WHEN ${schema.trainingSessions.status} = 'scheduled' THEN 1 ELSE 2 END`;
    const rows = await db().select().from(schema.trainingSessions).where(where)
      .orderBy(liveFirst, desc(schema.trainingSessions.updatedAt)).limit(q.pageSize).offset(offset(q));
    const [{ n }] = await db().select({ n: count() }).from(schema.trainingSessions).where(where);
    const ids = rows.map((r) => r.id);
    const [agents, domains, msgCounts, followers] = await Promise.all([
      roomAgents(rows.flatMap((r) => [r.learnerAgentId, r.trainerAgentId])),
      domainsById(rows.map((r) => r.domainId)),
      ids.length ? db().select({ id: schema.trainingMessages.sessionId, n: count() }).from(schema.trainingMessages).where(inArray(schema.trainingMessages.sessionId, ids)).groupBy(schema.trainingMessages.sessionId) : Promise.resolve([]),
      followerCounts('session', ids),
    ]);
    const msgBy = new Map(msgCounts.map((r) => [r.id, Number(r.n)]));
    const [{ live }] = rowsOf<{ live: number }>(await db().execute(sql`SELECT count(*)::int AS live FROM training_sessions WHERE visibility = 'public' AND moderation <> 'removed' AND status IN ('active','paused')`));
    return {
      items: rows.map((s) => roomCard(s, agents, domains, msgBy.get(s.id) ?? 0, followers.get(s.id) ?? 0)),
      total: Number(n), page: q.page, pageSize: q.pageSize, liveCount: Number(live ?? 0),
    };
  });

  app.get('/rooms/:id', async (req) => {
    const s = await loadPublicRoom((req.params as { id: string }).id);
    const [agents, domains, [{ n }], followers] = await Promise.all([
      roomAgents([s.learnerAgentId, s.trainerAgentId]),
      domainsById([s.domainId]),
      db().select({ n: count() }).from(schema.trainingMessages).where(and(eq(schema.trainingMessages.sessionId, s.id), viewerVisible)),
      followerCounts('session', [s.id]),
    ]);
    const objectives = await db().select({ description: schema.trainingObjectives.description }).from(schema.trainingObjectives).where(eq(schema.trainingObjectives.sessionId, s.id));
    const done = s.status === 'completed';
    return {
      ...roomCard(s, agents, domains, Number(n), followers.get(s.id) ?? 0),
      objectives: objectives.map((o) => o.description),
      // independent evaluation results are public once the session is complete
      scores: done ? { preScore: s.preScore, postScore: s.postScore, improvement: s.improvement } : null,
      // Hive Live showcase sessions (demo agents, demo budget) also show the pre-test while running and the settlement
      ...((s.plan as { realDemo?: boolean }).realDemo ? {
        demo: true,
        liveScores: { preScore: s.preScore, postScore: s.postScore, improvement: s.improvement },
        settlement: { feeIdle: s.feeCredits, terms: s.settlementTerms, status: s.settlementStatus, commissionIdle: s.commissionCredits, trainerEarningsIdle: s.trainerEarningsCredits, commissionRateBps: s.commissionRateBps },
      } : {}),
    };
  });

  app.get('/rooms/:id/messages', async (req) => {
    const s = await loadPublicRoom((req.params as { id: string }).id);
    const q = parse(z.object({ after: z.string().datetime({ offset: true }).optional(), limit: z.coerce.number().int().min(1).max(500).default(300) }), req.query);
    const conds = [eq(schema.trainingMessages.sessionId, s.id), viewerVisible];
    if (q.after) conds.push(sql`${schema.trainingMessages.createdAt} > ${new Date(q.after).toISOString()}::timestamptz`);
    const rows = await db().select().from(schema.trainingMessages).where(and(...conds)).orderBy(schema.trainingMessages.createdAt).limit(q.limit);
    return { items: rows.map(viewerMessage), status: s.status, stage: s.stage };
  });

  app.patch('/rooms/:id/visibility', async (req) => {
    const a = requirePerm(req, 'training.participate');
    const { id } = req.params as { id: string };
    if (!z.string().uuid().safeParse(id).success) throw notFound('Training session');
    const body = parse(Visibility, req.body);
    const [s] = await db().select().from(schema.trainingSessions).where(eq(schema.trainingSessions.id, id)).limit(1);
    if (!s || (s.learnerOrgId !== a.orgId && s.trainerOrgId !== a.orgId)) throw notFound('Training session');
    if (s.moderation === 'removed' && body.visibility === 'public') throw badRequest('This room was removed by Hive Mind moderation and cannot be made public');
    const [u] = await db().update(schema.trainingSessions).set({ visibility: body.visibility, updatedAt: new Date() })
      .where(eq(schema.trainingSessions.id, s.id)).returning({ id: schema.trainingSessions.id, visibility: schema.trainingSessions.visibility });
    await audit({ action: 'training.session.visibility', targetType: 'training_session', targetId: s.id, metadata: { from: s.visibility, to: body.visibility } }, req);
    publish(`session:${s.id}`, 'visibility', { visibility: body.visibility });
    return u;
  });
}

/* ───────────── jobs ───────────── */

async function ensureJob(type: string, payload: Record<string, unknown>, delayMs: number) {
  const [q] = await db().select({ id: schema.jobs.id }).from(schema.jobs)
    .where(and(eq(schema.jobs.type, type), inArray(schema.jobs.status, ['queued', 'running']))).limit(1);
  if (!q) await enqueue(type, payload, { delayMs, maxAttempts: 1 });
}

export async function ensureScheduled() {
  const now = new Date().toISOString();
  await ensureJob(ROOM_ACTIVITY_JOB, { since: now }, ROOM_ACTIVITY_INTERVAL_MS);
  await ensureJob(BADGES_SWEEP_JOB, { since: now, run: 0 }, BADGES_SWEEP_INTERVAL_MS);
}

function parseSince(v: unknown, fallbackMs: number) {
  const d = typeof v === 'string' ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d : new Date(Date.now() - fallbackMs);
}

/** One badge-sweep pass: agents with activity since `since` (or everyone relevant on a full sweep). Exported for tests. */
export async function runBadgeSweep(since: Date, full: boolean) {
  const ids = full ? await agentsForFullSweep() : await agentsWithActivitySince(since);
  for (const id of ids) await refreshBadges(id).catch((e) => console.error(`[social] refreshBadges ${id} failed: ${e instanceof Error ? e.message : e}`));
  return ids.length;
}

export function registerJobs() {
  registerJob(ROOM_ACTIVITY_JOB, async (payload) => {
    const since = parseSince(payload.since, ROOM_ACTIVITY_INTERVAL_MS);
    let next = since;
    try {
      next = await processRoomActivity(since);
    } finally {
      await enqueue(ROOM_ACTIVITY_JOB, { since: next.toISOString() }, { delayMs: ROOM_ACTIVITY_INTERVAL_MS, maxAttempts: 1 });
    }
  });
  registerJob(BADGES_SWEEP_JOB, async (payload) => {
    const startedAt = new Date();
    const run = Number(payload.run ?? 0) || 0;
    try {
      await runBadgeSweep(parseSince(payload.since, BADGES_SWEEP_INTERVAL_MS), run % FULL_SWEEP_EVERY === 0);
      await pruneOwnJobs([ROOM_ACTIVITY_JOB, BADGES_SWEEP_JOB]);
    } finally {
      await enqueue(BADGES_SWEEP_JOB, { since: startedAt.toISOString(), run: run + 1 }, { delayMs: BADGES_SWEEP_INTERVAL_MS, maxAttempts: 1 });
    }
  });
}
