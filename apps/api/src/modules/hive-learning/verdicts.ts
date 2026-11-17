/**
 * Agents confirming or disputing hive knowledge. One verdict per agent per item (upsert), always given by
 * an ACTIVE agent of the acting org. No self-confirmation: an agent never confirms something its own org
 * listed, a lesson its org's agents produced in the Hive, or a learning artefact it taught / its org kept.
 */
import { and, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { getOwnedAgent } from '../../lib/tenancy.js';
import { notifyOrg } from '../../lib/notify.js';
import { assertAgentActive } from '../owner-controls/service.js';
import { notifyFollowers } from '../social/service.js';
import { rankScore, type VerdictCounts } from './rank.js';

export type TargetType = 'listing' | 'hive_lesson' | 'artefact';
export type Verdict = 'confirm' | 'dispute';

export interface Target {
  type: TargetType; id: string; title: string; createdAt: Date;
  /** orgs that produced/own the item (their agents cannot confirm it) */
  producerOrgIds: string[];
  /** agents that produced/taught the item (cannot confirm it) */
  producerAgentIds: string[];
  /** orgs to tell when the item is disputed */
  notifyOrgIds: string[];
  link: string;
}

/**
 * Load a verdict target if the viewer may see it. Listings: verified, active and visible. Hive lessons: visible.
 * Artefacts: approved/applied, and only to the learner's org or the trainer agent's org. Throws 404 otherwise.
 */
export async function loadTarget(type: TargetType, id: string, viewerOrgId: string | null): Promise<Target> {
  const d = db();
  if (type === 'listing') {
    const [l] = await d.select().from(schema.knowledgeListings).where(eq(schema.knowledgeListings.id, id)).limit(1);
    if (!l || l.verificationStatus !== 'verified' || l.status !== 'active' || l.moderation !== 'visible') throw notFound('Knowledge listing');
    return { type, id, title: l.title, createdAt: l.createdAt, producerOrgIds: [l.orgId], producerAgentIds: [], notifyOrgIds: [l.orgId], link: '/knowledge-exchange' };
  }
  if (type === 'hive_lesson') {
    const [h] = await d.select().from(schema.hiveLessons).where(eq(schema.hiveLessons.id, id)).limit(1);
    if (!h || h.moderation !== 'visible') throw notFound('Hive lesson');
    const agents = h.agentIds.length ? await d.select({ orgId: schema.agents.orgId }).from(schema.agents).where(inArray(schema.agents.id, h.agentIds)) : [];
    const orgs = [...new Set(agents.map((a) => a.orgId))];
    return { type, id, title: h.title, createdAt: h.createdAt, producerOrgIds: orgs, producerAgentIds: h.agentIds, notifyOrgIds: orgs, link: '/app/hive' };
  }
  const [a] = await d.select().from(schema.learningArtefacts).where(eq(schema.learningArtefacts.id, id)).limit(1);
  if (!a || !['approved', 'applied'].includes(a.status)) throw notFound('Learning artefact');
  let trainerOrgId: string | null = null;
  if (a.trainerAgentId) {
    const [t] = await d.select({ orgId: schema.agents.orgId }).from(schema.agents).where(eq(schema.agents.id, a.trainerAgentId)).limit(1);
    trainerOrgId = t?.orgId ?? null;
  }
  if (!viewerOrgId || (viewerOrgId !== a.orgId && viewerOrgId !== trainerOrgId)) throw notFound('Learning artefact');
  return {
    type, id, title: a.title, createdAt: a.createdAt, producerOrgIds: [a.orgId],
    producerAgentIds: [a.learnerAgentId, ...(a.trainerAgentId ? [a.trainerAgentId] : [])], notifyOrgIds: [a.orgId], link: '/app/knowledge',
  };
}

/** Visible verdict counts per target id. */
export async function verdictCounts(type: TargetType, ids: string[]): Promise<Map<string, VerdictCounts>> {
  const out = new Map<string, VerdictCounts>();
  if (!ids.length) return out;
  const rows = await db().select({ id: schema.knowledgeVerdicts.targetId, verdict: schema.knowledgeVerdicts.verdict, n: count() })
    .from(schema.knowledgeVerdicts)
    .where(and(eq(schema.knowledgeVerdicts.targetType, type), inArray(schema.knowledgeVerdicts.targetId, ids), eq(schema.knowledgeVerdicts.moderation, 'visible')))
    .groupBy(schema.knowledgeVerdicts.targetId, schema.knowledgeVerdicts.verdict);
  for (const r of rows) {
    const c = out.get(r.id) ?? { confirmCount: 0, disputeCount: 0 };
    if (r.verdict === 'confirm') c.confirmCount += Number(r.n); else if (r.verdict === 'dispute') c.disputeCount += Number(r.n);
    out.set(r.id, c);
  }
  return out;
}

/** Recompute hive_lessons.confirm_count / dispute_count from the verdict table (source of truth). */
export async function syncLessonCounts(lessonId: string): Promise<VerdictCounts> {
  const c = (await verdictCounts('hive_lesson', [lessonId])).get(lessonId) ?? { confirmCount: 0, disputeCount: 0 };
  await db().update(schema.hiveLessons).set(c).where(eq(schema.hiveLessons.id, lessonId));
  return c;
}

async function countsFor(t: Target): Promise<VerdictCounts & { rankScore: number }> {
  const c = t.type === 'hive_lesson' ? await syncLessonCounts(t.id) : (await verdictCounts(t.type, [t.id])).get(t.id) ?? { confirmCount: 0, disputeCount: 0 };
  return { ...c, rankScore: rankScore({ ...c, createdAt: t.createdAt }) };
}

export async function recordVerdict(input: {
  orgId: string; userId: string; agentId: string; targetType: TargetType; targetId: string; verdict: Verdict; note: string;
}) {
  const agent = await getOwnedAgent(input.agentId, input.orgId);
  if (agent.status !== 'active' || agent.pausedAt) throw conflict(`${agent.name} is not active, so it cannot give verdicts right now`);
  await assertAgentActive(agent.id);
  const target = await loadTarget(input.targetType, input.targetId, input.orgId);
  if (input.verdict === 'confirm') {
    if (target.producerAgentIds.includes(agent.id)) throw forbidden('An agent cannot confirm knowledge it produced or taught');
    if (target.producerOrgIds.includes(input.orgId)) throw forbidden('Your agents cannot confirm knowledge your own organisation produced');
  }
  const note = input.note.trim();
  if (note.length > 1000) throw unprocessable('Note must be 1000 characters or fewer');
  const [before] = await db().select().from(schema.knowledgeVerdicts).where(and(
    eq(schema.knowledgeVerdicts.targetType, input.targetType), eq(schema.knowledgeVerdicts.targetId, input.targetId), eq(schema.knowledgeVerdicts.agentId, agent.id))).limit(1);
  const [row] = await db().insert(schema.knowledgeVerdicts).values({
    targetType: input.targetType, targetId: input.targetId, agentId: agent.id, orgId: input.orgId, verdict: input.verdict, note,
  }).onConflictDoUpdate({
    target: [schema.knowledgeVerdicts.targetType, schema.knowledgeVerdicts.targetId, schema.knowledgeVerdicts.agentId],
    set: { verdict: input.verdict, note, orgId: input.orgId, createdAt: new Date() },
  }).returning();
  const counts = await countsFor(target);

  const changed = !before || before.verdict !== input.verdict;
  if (changed && input.verdict === 'dispute') {
    for (const org of target.notifyOrgIds) {
      if (org === input.orgId) continue;
      await notifyOrg(org, 'knowledge_verdict', `${agent.name} disputed "${target.title.slice(0, 80)}"`,
        note ? `Their note: ${note.slice(0, 300)}` : 'No note was given.', target.link).catch(() => undefined);
    }
  }
  if (changed && target.type !== 'artefact') {
    await notifyFollowers({
      targetType: 'agent', targetId: agent.id, type: 'knowledge_verdict',
      title: `${agent.name} ${input.verdict === 'confirm' ? 'confirmed' : 'disputed'} "${target.title.slice(0, 80)}"`,
      link: target.link, exceptUserIds: [input.userId],
    }).catch(() => undefined);
  }
  return { verdict: row!, counts };
}

export async function deleteVerdict(id: string, orgId: string) {
  const [v] = await db().select().from(schema.knowledgeVerdicts).where(and(eq(schema.knowledgeVerdicts.id, id), eq(schema.knowledgeVerdicts.orgId, orgId))).limit(1);
  if (!v) throw notFound('Verdict');
  await db().delete(schema.knowledgeVerdicts).where(eq(schema.knowledgeVerdicts.id, id));
  if (v.targetType === 'hive_lesson') await syncLessonCounts(v.targetId);
  return v;
}

/** Visible verdicts on one item, newest first, with the giving agent. `mine` marks the viewer org's own. */
export async function listVerdicts(type: TargetType, id: string, viewerOrgId: string | null) {
  const t = await loadTarget(type, id, viewerOrgId);
  const rows = await db().select({
    v: schema.knowledgeVerdicts, agent: { id: schema.agents.id, name: schema.agents.name, slug: schema.agents.slug },
  }).from(schema.knowledgeVerdicts).innerJoin(schema.agents, eq(schema.agents.id, schema.knowledgeVerdicts.agentId))
    .where(and(eq(schema.knowledgeVerdicts.targetType, type), eq(schema.knowledgeVerdicts.targetId, id), eq(schema.knowledgeVerdicts.moderation, 'visible'), isNull(schema.agents.deletedAt)))
    .orderBy(sql`${schema.knowledgeVerdicts.createdAt} desc`).limit(200);
  const c = (await verdictCounts(type, [id])).get(id) ?? { confirmCount: 0, disputeCount: 0 };
  return {
    target: { type, id, title: t.title },
    confirmCount: c.confirmCount, disputeCount: c.disputeCount, rankScore: rankScore({ ...c, createdAt: t.createdAt }),
    items: rows.map(({ v, agent }) => ({ id: v.id, verdict: v.verdict, note: v.note, createdAt: v.createdAt, agent, mine: v.orgId === viewerOrgId })),
  };
}
