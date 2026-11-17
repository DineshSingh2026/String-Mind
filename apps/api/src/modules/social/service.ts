/**
 * Social service: shared helpers other modules call. OWNED BY the Social feature (profiles, badges, follows, public rooms).
 * Signatures here are a contract — implement the bodies, don't change the parameters.
 */
import { and, avg, count, eq, gte, inArray, isNotNull, ne, notInArray, sql } from 'drizzle-orm';
import { BADGES, type BadgeSlug, type NotificationType } from '@aix/shared';
import { db, rowsOf, schema } from '../../db/client.js';
import { notify } from '../../lib/notify.js';

export type FollowTarget = 'agent' | 'session' | 'debate';

/** At most one notification per follower per target in this window. */
export const FOLLOW_NOTIFY_THROTTLE_MS = 10 * 60_000;

/**
 * Throttle memory: `${userId}|${targetType}|${targetId}` → last notified epoch ms.
 * Process-local (like the per-API-key rate limiter); a restart can at most send one extra notification per pair.
 */
const lastNotified = new Map<string, number>();

/** Test helper: forget throttle state. */
export function resetFollowThrottle() { lastNotified.clear(); }

function pruneThrottle(now: number) {
  if (lastNotified.size < 5000) return;
  for (const [k, t] of lastNotified) if (now - t >= FOLLOW_NOTIFY_THROTTLE_MS) lastNotified.delete(k);
}

/**
 * Notify every user following `targetType/targetId` (e.g. an agent that just spoke, a room that got a new message).
 * Must be cheap and safe to call often: implementations should de-duplicate/throttle per follower.
 * Never notify the actor themselves (pass `exceptUserIds`).
 */
export async function notifyFollowers(input: {
  targetType: FollowTarget; targetId: string; type: NotificationType; title: string; body?: string; link?: string; exceptUserIds?: string[];
}): Promise<void> {
  const followers = await db().select({ userId: schema.follows.userId }).from(schema.follows)
    .where(and(eq(schema.follows.targetType, input.targetType), eq(schema.follows.targetId, input.targetId)));
  if (!followers.length) return;
  const except = new Set(input.exceptUserIds ?? []);
  const now = Date.now();
  pruneThrottle(now);
  for (const { userId } of followers) {
    if (except.has(userId)) continue;
    const key = `${userId}|${input.targetType}|${input.targetId}`;
    const last = lastNotified.get(key);
    if (last != null && now - last < FOLLOW_NOTIFY_THROTTLE_MS) continue;
    lastNotified.set(key, now);
    try {
      await notify(userId, input.type, input.title.slice(0, 200), (input.body ?? '').slice(0, 500), input.link);
    } catch (e) {
      lastNotified.delete(key);
      console.error(`[social] notify follower ${userId} failed: ${e instanceof Error ? e.message : e}`);
    }
  }
}

/* ───────────── badges ───────────── */

/** Real activity numbers behind every badge for one agent. Exported for the profile endpoint and tests. */
export async function badgeStats(agentId: string) {
  const S = schema;
  const [caps, lessons, mentor, rating, debateWins, rep, confirms] = await Promise.all([
    db().select({ score: S.agentCapabilities.score, verified: S.agentCapabilities.verified }).from(S.agentCapabilities)
      .where(eq(S.agentCapabilities.agentId, agentId)),
    db().select({ n: count() }).from(S.learningArtefacts)
      .where(and(eq(S.learningArtefacts.trainerAgentId, agentId), inArray(S.learningArtefacts.status, ['approved', 'applied']))),
    db().select({ n: count() }).from(S.trainingSessions)
      .where(and(eq(S.trainingSessions.trainerAgentId, agentId), eq(S.trainingSessions.status, 'completed'))),
    db().select({ n: count(), avg: avg(S.reviews.rating) }).from(S.reviews)
      .where(and(eq(S.reviews.agentId, agentId), eq(S.reviews.status, 'published'))),
    db().select({ n: count() }).from(S.debates)
      .where(and(eq(S.debates.winnerAgentId, agentId), eq(S.debates.status, 'closed'), ne(S.debates.moderation, 'removed'))),
    db().select({ components: S.agentReputation.components }).from(S.agentReputation).where(eq(S.agentReputation.agentId, agentId)).limit(1),
    confirmCountForAgent(agentId),
  ]);
  const bestVerified = caps.filter((c) => c.verified).reduce((m, c) => Math.max(m, c.score), -1);
  const repWins = Number((rep[0]?.components as Record<string, unknown> | undefined)?.debateWins ?? 0) || 0;
  return {
    bestVerifiedScore: bestVerified >= 0 ? Math.round(bestVerified * 10) / 10 : null,
    lessonsTaught: Number(lessons[0]?.n ?? 0),
    sessionsTrained: Number(mentor[0]?.n ?? 0),
    reviewCount: Number(rating[0]?.n ?? 0),
    avgRating: rating[0]?.avg != null ? Math.round(Number(rating[0].avg) * 100) / 100 : null,
    debateWins: Math.max(Number(debateWins[0]?.n ?? 0), repWins),
    confirmVerdicts: confirms,
  };
}

/**
 * Confirm verdicts other agents gave on knowledge this agent produced:
 * learning artefacts where it was the trainer (target 'artefact') + hive lessons that name it (target 'hive_lesson').
 * Its own verdicts and removed verdicts do not count.
 */
export async function confirmCountForAgent(agentId: string): Promise<number> {
  const res = await db().execute(sql`
    SELECT count(*)::int AS n FROM knowledge_verdicts v
    WHERE v.verdict = 'confirm' AND v.moderation <> 'removed' AND v.agent_id <> ${agentId}
      AND (
        (v.target_type = 'artefact' AND v.target_id IN (SELECT id FROM learning_artefacts WHERE trainer_agent_id = ${agentId}))
        OR (v.target_type = 'hive_lesson' AND v.target_id IN (
              SELECT id FROM hive_lessons WHERE moderation <> 'removed' AND agent_ids @> ${JSON.stringify([agentId])}::jsonb))
      )`);
  return Number(rowsOf<{ n: number }>(res)[0]?.n ?? 0);
}

type Stats = Awaited<ReturnType<typeof badgeStats>>;

/** Which badges the numbers earn, with the evidence stored in agent_badges.meta. Rules mirror BADGES in @aix/shared. */
export function earnedBadges(s: Stats): Map<BadgeSlug, Record<string, unknown>> {
  const out = new Map<BadgeSlug, Record<string, unknown>>();
  if (s.bestVerifiedScore != null && s.bestVerifiedScore >= 80) out.set('verified_specialist', { bestVerifiedScore: s.bestVerifiedScore });
  if (s.lessonsTaught >= 1) out.set('first_lesson', { lessonsTaught: s.lessonsTaught });
  if (s.sessionsTrained >= 10) out.set('mentor_10', { sessionsTrained: s.sessionsTrained });
  if (s.reviewCount >= 5 && s.avgRating != null && s.avgRating >= 4.5) out.set('crowd_favourite', { avgRating: s.avgRating, reviewCount: s.reviewCount });
  if (s.debateWins >= 3) out.set('debate_champion', { debateWins: s.debateWins });
  if (s.confirmVerdicts >= 5) out.set('knowledge_confirmed', { confirmVerdicts: s.confirmVerdicts });
  return out;
}

/** Recompute badges for one agent from real activity. Safe to call after any event that could earn a badge. */
export async function refreshBadges(agentId: string): Promise<void> {
  const [agent] = await db().select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.id, agentId)).limit(1);
  if (!agent) return;
  const earned = earnedBadges(await badgeStats(agentId));
  const known = BADGES.map((b) => b.slug as string);
  const keep = [...earned.keys()] as string[];
  // remove known badges no longer earned (badges with other slugs are left alone)
  const lost = known.filter((k) => !keep.includes(k));
  if (lost.length) {
    await db().delete(schema.agentBadges).where(and(eq(schema.agentBadges.agentId, agentId), inArray(schema.agentBadges.badge, lost)));
  }
  for (const [badge, meta] of earned) {
    await db().insert(schema.agentBadges).values({ agentId, badge, meta })
      .onConflictDoUpdate({ target: [schema.agentBadges.agentId, schema.agentBadges.badge], set: { meta } });
  }
}

/* ───────────── sweeps (called by jobs in routes.ts) ───────────── */

/** Agents with activity since `since` that could change a badge (finished sessions, reviews, debates, verdicts, capabilities). */
export async function agentsWithActivitySince(since: Date): Promise<string[]> {
  const S = schema;
  const ids = new Set<string>();
  const [sessions, reviews, debates, caps, verdictsArt, verdictsHive] = await Promise.all([
    db().select({ t: S.trainingSessions.trainerAgentId, l: S.trainingSessions.learnerAgentId }).from(S.trainingSessions)
      .where(and(gte(S.trainingSessions.updatedAt, since), inArray(S.trainingSessions.status, ['completed', 'failed', 'cancelled', 'disputed']))),
    db().select({ a: S.reviews.agentId }).from(S.reviews).where(gte(S.reviews.createdAt, since)),
    db().select({ w: S.debates.winnerAgentId }).from(S.debates).where(and(gte(S.debates.updatedAt, since), isNotNull(S.debates.winnerAgentId))),
    db().select({ a: S.agentCapabilities.agentId }).from(S.agentCapabilities).where(gte(S.agentCapabilities.assessedAt, since)),
    db().select({ t: S.learningArtefacts.trainerAgentId }).from(S.knowledgeVerdicts)
      .innerJoin(S.learningArtefacts, eq(S.learningArtefacts.id, S.knowledgeVerdicts.targetId))
      .where(and(gte(S.knowledgeVerdicts.createdAt, since), eq(S.knowledgeVerdicts.targetType, 'artefact'))),
    db().select({ ids: S.hiveLessons.agentIds }).from(S.knowledgeVerdicts)
      .innerJoin(S.hiveLessons, eq(S.hiveLessons.id, S.knowledgeVerdicts.targetId))
      .where(and(gte(S.knowledgeVerdicts.createdAt, since), eq(S.knowledgeVerdicts.targetType, 'hive_lesson'))),
  ]);
  for (const r of sessions) { ids.add(r.t); ids.add(r.l); }
  for (const r of reviews) ids.add(r.a);
  for (const r of debates) if (r.w) ids.add(r.w);
  for (const r of caps) ids.add(r.a);
  for (const r of verdictsArt) if (r.t) ids.add(r.t);
  for (const r of verdictsHive) for (const id of r.ids ?? []) ids.add(id);
  return [...ids];
}

/** Every agent that holds a badge or has any badge-relevant record (full periodic sweep). */
export async function agentsForFullSweep(): Promise<string[]> {
  const res = await db().execute(sql`
    SELECT agent_id AS id FROM agent_badges
    UNION SELECT agent_id FROM agent_reputation
    UNION SELECT agent_id FROM agent_capabilities WHERE verified = true
    UNION SELECT trainer_agent_id FROM learning_artefacts WHERE trainer_agent_id IS NOT NULL AND status IN ('approved','applied')`);
  return rowsOf<{ id: string }>(res).map((r) => r.id).filter(Boolean);
}

/**
 * Room activity: notify followers about new messages in PUBLIC, visible training sessions created after `since`.
 * Returns the newest message timestamp processed (the next cursor).
 */
export async function processRoomActivity(since: Date): Promise<Date> {
  const S = schema;
  const rows = await db().select({
    id: S.trainingMessages.id, sessionId: S.trainingMessages.sessionId, senderAgentId: S.trainingMessages.senderAgentId,
    senderRole: S.trainingMessages.senderRole, flagged: S.trainingMessages.flagged, createdAt: S.trainingMessages.createdAt,
  }).from(S.trainingMessages)
    .innerJoin(S.trainingSessions, eq(S.trainingSessions.id, S.trainingMessages.sessionId))
    .where(and(
      sql`${S.trainingMessages.createdAt} > ${since.toISOString()}::timestamptz`,
      eq(S.trainingSessions.visibility, 'public'), ne(S.trainingSessions.moderation, 'removed'),
    ))
    .orderBy(S.trainingMessages.createdAt).limit(1000);
  if (!rows.length) return since;
  const cursor = rows[rows.length - 1]!.createdAt;

  const bySession = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!bySession.has(r.sessionId)) bySession.set(r.sessionId, []);
    bySession.get(r.sessionId)!.push(r);
  }
  const sessions = await db().select({ id: S.trainingSessions.id, subject: S.trainingSessions.subject, l: S.trainingSessions.learnerAgentId, t: S.trainingSessions.trainerAgentId })
    .from(S.trainingSessions).where(inArray(S.trainingSessions.id, [...bySession.keys()]));
  const agentIds = [...new Set(sessions.flatMap((s) => [s.l, s.t]))];
  const agents = agentIds.length
    ? await db().select({ id: S.agents.id, name: S.agents.name, ownerId: S.agents.ownerId }).from(S.agents).where(inArray(S.agents.id, agentIds))
    : [];
  const agentById = new Map(agents.map((a) => [a.id, a]));

  for (const s of sessions) {
    const msgs = bySession.get(s.id) ?? [];
    const owners = [agentById.get(s.l)?.ownerId, agentById.get(s.t)?.ownerId].filter(Boolean) as string[];
    const link = `/rooms/${s.id}`;
    const speakers = [...new Set(msgs.filter((m) => m.senderAgentId && !m.flagged && (m.senderRole === 'trainer' || m.senderRole === 'learner')).map((m) => m.senderAgentId!))];
    const names = speakers.map((id) => agentById.get(id)?.name).filter(Boolean) as string[];
    await notifyFollowers({
      targetType: 'session', targetId: s.id, type: 'followed_room_activity',
      title: `New activity in a room you follow`,
      body: `${s.subject}: ${msgs.length} new message${msgs.length === 1 ? '' : 's'}${names.length ? ` from ${names.join(' and ')}` : ''}.`,
      link, exceptUserIds: owners,
    });
    for (const agentId of speakers) {
      const a = agentById.get(agentId);
      if (!a) continue;
      await notifyFollowers({
        targetType: 'agent', targetId: agentId, type: 'followed_agent_activity',
        title: `${a.name} is speaking in a public room`,
        body: s.subject,
        link, exceptUserIds: [a.ownerId],
      });
    }
  }
  return cursor;
}

/** Clean up finished runs of our own recurring jobs so the jobs table does not grow without bound. */
export async function pruneOwnJobs(types: string[]) {
  await db().delete(schema.jobs).where(and(
    inArray(schema.jobs.type, types), notInArray(schema.jobs.status, ['queued', 'running']),
    sql`${schema.jobs.createdAt} < ${new Date(Date.now() - 24 * 3600_000).toISOString()}::timestamptz`,
  ));
}
