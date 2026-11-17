/**
 * Reputation service. Score 0–100 computed ONLY from verified platform data:
 *  - verified capability (mean of verified agent_capabilities scores)
 *  - training success rate (as trainer: completed sessions with improvement > 0 and settled / finished sessions)
 *  - average learner improvement (as trainer, completed sessions)
 *  - average rating (published reviews tied to COMPLETED sessions only)
 *  - completion rate (either role: completed / (completed + failed + cancelled))
 *  - knowledge quality (verified, visible knowledge listings whose source belongs to the agent)
 * Penalties: safety incidents (flagged training messages sent by the agent, suspension) and disputes lost.
 * Claimed domains and self-declared data are never used.
 */
import { and, avg, count, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { REPUTATION_LEVELS } from '@aix/shared';
import { db, schema } from '../../db/client.js';

export const REPUTATION_WEIGHTS = {
  verifiedCapability: 0.3,
  trainingSuccessRate: 0.2,
  learnerImprovement: 0.15,
  rating: 0.15,
  completionRate: 0.1,
  knowledgeQuality: 0.1,
} as const;

/** Minimum completed trainer sessions required for each trainer-tier level. */
export const LEVEL_MIN_SESSIONS: Record<string, number> = {
  new_contributor: 0,
  verified_agent: 0,
  skilled_trainer: 3,
  expert_trainer: 10,
  elite_contributor: 25,
  top_performer: 50,
};

const SAFETY_PENALTY = 5;
const SAFETY_PENALTY_CAP = 30;
const DISPUTE_PENALTY = 10;
const DISPUTE_PENALTY_CAP = 40;
/** +20 points of learner improvement maps to a full 100 on the improvement component. */
const IMPROVEMENT_FULL_SCALE = 20;

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const round1 = (n: number) => Math.round(n * 10) / 10;

export function levelFor(score: number, verifiedCapabilities: number, completedTrainerSessions: number, suspended = false): string {
  if (suspended) return 'new_contributor';
  for (let i = REPUTATION_LEVELS.length - 1; i >= 0; i--) {
    const l = REPUTATION_LEVELS[i]!;
    if (score < l.min) continue;
    if (l.slug !== 'new_contributor' && verifiedCapabilities < 1) continue;
    if (completedTrainerSessions < (LEVEL_MIN_SESSIONS[l.slug] ?? 0)) continue;
    return l.slug;
  }
  return 'new_contributor';
}

export interface ReputationComponents {
  verifiedCapability: number | null;
  verifiedDomains: number;
  trainingSuccessRate: number | null;
  avgLearnerImprovement: number | null;
  avgRating: number | null;
  ratingCount: number;
  completionRate: number | null;
  knowledgeQuality: number | null;
  safetyIncidents: number;
  disputesLost: number;
  sessionsCompleted: number;
  sessionsFailed: number;
}

export async function computeReputation(agentId: string) {
  const d = db();
  const T = schema.trainingSessions;
  const [agent] = await d.select().from(schema.agents).where(eq(schema.agents.id, agentId)).limit(1);
  if (!agent) return null;

  const [cap] = await d.select({ n: count(), mean: avg(schema.agentCapabilities.score) }).from(schema.agentCapabilities)
    .where(and(eq(schema.agentCapabilities.agentId, agentId), eq(schema.agentCapabilities.verified, true)));
  const verifiedDomains = Number(cap?.n ?? 0);
  const verifiedCapability = cap?.mean != null ? Number(cap.mean) : null;

  // As trainer
  const trainerRows = await d.select({ status: T.status, improvement: T.improvement, settlementStatus: T.settlementStatus })
    .from(T).where(and(eq(T.trainerAgentId, agentId), inArray(T.status, ['completed', 'failed'])));
  const completed = trainerRows.filter((r) => r.status === 'completed');
  const failed = trainerRows.filter((r) => r.status === 'failed');
  const successes = completed.filter((r) => (r.improvement ?? 0) > 0 && r.settlementStatus === 'settled').length;
  const trainingSuccessRate = trainerRows.length ? (successes / trainerRows.length) * 100 : null;
  const imps = completed.map((r) => r.improvement).filter((x): x is number => x != null);
  const avgLearnerImprovement = imps.length ? imps.reduce((a, b) => a + b, 0) / imps.length : null;

  // Ratings only from reviews tied to completed sessions where this agent was the trainer
  const [rating] = await d.select({ n: count(), mean: avg(schema.reviews.rating) }).from(schema.reviews)
    .innerJoin(T, eq(T.id, schema.reviews.sessionId))
    .where(and(eq(schema.reviews.agentId, agentId), eq(schema.reviews.status, 'published'), eq(T.status, 'completed'), eq(T.trainerAgentId, agentId)));
  const ratingCount = Number(rating?.n ?? 0);
  const avgRating = rating?.mean != null ? Number(rating.mean) : null;

  // Completion rate, either role
  const [comp] = await d.select({
    done: sql<number>`count(*) filter (where ${T.status} = 'completed')::int`,
    total: sql<number>`count(*) filter (where ${T.status} in ('completed','failed','cancelled'))::int`,
  }).from(T).where(sql`${T.trainerAgentId} = ${agentId} or ${T.learnerAgentId} = ${agentId}`);
  const completionRate = comp && Number(comp.total) > 0 ? (Number(comp.done) / Number(comp.total)) * 100 : null;

  // Knowledge quality: verified + visible listings from sources attached to this agent
  const [kq] = await d.select({ mean: avg(schema.knowledgeListings.qualityScore) }).from(schema.knowledgeListings)
    .innerJoin(schema.knowledgeSources, eq(schema.knowledgeSources.id, schema.knowledgeListings.sourceId))
    .where(and(eq(schema.knowledgeSources.agentId, agentId), eq(schema.knowledgeListings.verificationStatus, 'verified'),
      eq(schema.knowledgeListings.moderation, 'visible'), isNotNull(schema.knowledgeListings.qualityScore)));
  const knowledgeQuality = kq?.mean != null ? Number(kq.mean) : null;

  // Safety incidents
  const [flags] = await d.select({ n: count() }).from(schema.trainingMessages)
    .where(and(eq(schema.trainingMessages.senderAgentId, agentId), eq(schema.trainingMessages.flagged, true)));
  const suspended = agent.status === 'suspended';
  const safetyIncidents = Number(flags?.n ?? 0) + (suspended ? 1 : 0);

  // Disputes lost (as trainer: resolved with a refund to the learner)
  const [dl] = await d.select({ n: count() }).from(schema.disputes)
    .innerJoin(T, eq(T.id, schema.disputes.sessionId))
    .where(and(eq(T.trainerAgentId, agentId), inArray(schema.disputes.status, ['resolved_refund', 'resolved_partial'])));
  const disputesLost = Number(dl?.n ?? 0);

  const c: ReputationComponents = {
    verifiedCapability, verifiedDomains, trainingSuccessRate, avgLearnerImprovement, avgRating, ratingCount,
    completionRate, knowledgeQuality, safetyIncidents, disputesLost,
    sessionsCompleted: completed.length, sessionsFailed: failed.length,
  };

  const W = REPUTATION_WEIGHTS;
  const parts = {
    verifiedCapability: (verifiedCapability ?? 0) * W.verifiedCapability,
    trainingSuccessRate: (trainingSuccessRate ?? 0) * W.trainingSuccessRate,
    learnerImprovement: clamp(((avgLearnerImprovement ?? 0) / IMPROVEMENT_FULL_SCALE) * 100) * W.learnerImprovement,
    rating: (avgRating != null ? ((avgRating - 1) / 4) * 100 : 0) * W.rating,
    completionRate: (completionRate ?? 0) * W.completionRate,
    knowledgeQuality: (knowledgeQuality ?? 0) * W.knowledgeQuality,
  };
  const safetyPenalty = Math.min(SAFETY_PENALTY_CAP, safetyIncidents * SAFETY_PENALTY);
  const disputePenalty = Math.min(DISPUTE_PENALTY_CAP, disputesLost * DISPUTE_PENALTY);
  const raw = Object.values(parts).reduce((a, b) => a + b, 0) - safetyPenalty - disputePenalty;
  const score = round1(clamp(raw));
  const level = levelFor(score, verifiedDomains, completed.length, suspended);

  return {
    agentId, score, level, components: c,
    breakdown: { ...Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, round1(v)])), safetyPenalty: -safetyPenalty, disputePenalty: -disputePenalty },
  };
}

/** Reputation components owned by other modules; preserved across recomputes. */
const FOREIGN_COMPONENT_KEYS = new Set(['debateWins', 'debateLosses', 'debateTies']);

/** Recompute and persist an agent's reputation. Safe to call repeatedly; no-op for unknown agents. */
export async function recomputeReputation(agentId: string): Promise<void> {
  const r = await computeReputation(agentId);
  if (!r) return;
  const c = r.components;
  const row = {
    score: r.score,
    level: r.level,
    sessionsCompleted: c.sessionsCompleted,
    sessionsFailed: c.sessionsFailed,
    trainingSuccessRate: round1(c.trainingSuccessRate ?? 0),
    avgLearnerImprovement: round1(c.avgLearnerImprovement ?? 0),
    avgRating: c.avgRating != null ? Math.round(c.avgRating * 100) / 100 : null,
    ratingCount: c.ratingCount,
    disputesLost: c.disputesLost,
    safetyIncidents: c.safetyIncidents,
    // weighted contributions + raw values (keys omitted when there is no data)
    components: Object.fromEntries(Object.entries({
      ...Object.fromEntries(Object.entries(r.breakdown).map(([k, v]) => [`weighted_${k}`, v])),
      verifiedCapability: c.verifiedCapability, verifiedDomains: c.verifiedDomains,
      completionRate: c.completionRate, knowledgeQuality: c.knowledgeQuality,
    }).filter(([, v]) => v != null).map(([k, v]) => [k, round1(v as number)])) as Record<string, number>,
    updatedAt: new Date(),
  };
  // Keep components written by other features (e.g. debateWins/debateLosses/debateTies from debates):
  // merge instead of overwriting, so a recompute never wipes them.
  const [prev] = await db().select({ components: schema.agentReputation.components }).from(schema.agentReputation)
    .where(eq(schema.agentReputation.agentId, agentId)).limit(1);
  const foreign = Object.fromEntries(Object.entries(prev?.components ?? {}).filter(([k]) => FOREIGN_COMPONENT_KEYS.has(k)));
  const merged = { ...row, components: { ...foreign, ...row.components } };
  await db().insert(schema.agentReputation).values({ agentId, ...merged })
    .onConflictDoUpdate({ target: schema.agentReputation.agentId, set: merged });
}
