/**
 * Experience Score (0-100) per agent per domain — measures the agent's real track record, NOT the underlying model.
 * A brand-new agent on the best model scores 0 here, because it has no history.
 *
 *   Depth      30  how much resolved experience: ln(1+n_eff)/ln(1+200); n_eff = witnessed + 0.5 × self-reported
 *   Span       20  how long it has been doing this: months between first and last resolved case, full at 24
 *   Track      20  how often its decisions worked: Wilson lower bound of success rate (mixed = ½); witnessed decisions
 *                  still pending after STALE_PENDING_DAYS count as misses (no reporting only the wins)
 *   Replay     30  can it actually USE that experience: latest self replay score (real past cases, answer hidden)
 *
 * Trainer qualification (may publish a training listing in a domain): see QUALIFY (established) and PROVISIONAL.
 * Rows are derived and always recomputable from agent_experiences + experience_replays.
 */
import { and, desc, eq } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';

export const STALE_PENDING_DAYS = 90;
export const REPLAY_VALID_DAYS = 180;
/** Established trainer: a full track record in the domain. */
export const QUALIFY = { minResolved: 20, minReplayItems: 5, minReplayScore: 60, minScore: 50 } as const;
/**
 * Provisional trainer: real but shorter history. May list at a capped price and only on "pay if the learner measurably
 * improves" terms (the learner is refunded otherwise), so a weak trainer cannot be paid for no improvement.
 */
export const PROVISIONAL = { minResolved: 10, minReplayItems: 5, minReplayScore: 50, minScore: 25, maxPriceCredits: 300 } as const;
export type TrainerLevel = 'none' | 'provisional' | 'established';
export const WEIGHTS = { depth: 30, span: 20, track: 20, replay: 30 } as const;
const DEPTH_FULL_AT = 200;
const SPAN_FULL_MONTHS = 24;
const DAY = 86_400_000;

export type ExperienceScoreRow = typeof schema.agentExperienceScores.$inferSelect;

const r1 = (x: number) => Math.round(x * 10) / 10;

/** Wilson score interval lower bound (95%). */
export function wilsonLower(successes: number, n: number, z = 1.96): number {
  if (n <= 0) return 0;
  const p = successes / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.max(0, (c - m) / d);
}

export interface ScoreInput {
  records: { result: string; witnessed: boolean; source: string; occurredAt: Date; createdAt: Date }[];
  replay: { score: number; itemsGraded: number; completedAt: Date; id: string } | null;
  now?: number;
}

export function computeExperienceScore(input: ScoreInput) {
  const now = input.now ?? Date.now();
  const resolved = input.records.filter((r) => r.result !== 'pending');
  const witnessed = resolved.filter((r) => r.witnessed);
  const stale = input.records.filter((r) => r.result === 'pending' && r.source !== 'import' && now - r.createdAt.getTime() > STALE_PENDING_DAYS * DAY);
  const nEff = witnessed.length + 0.5 * (resolved.length - witnessed.length);
  const depth = Math.min(1, Math.log(1 + nEff) / Math.log(1 + DEPTH_FULL_AT));

  const times = resolved.map((r) => r.occurredAt.getTime());
  const first = times.length ? Math.min(...times) : null;
  const last = times.length ? Math.max(...times) : null;
  const spanDays = first != null && last != null ? Math.round((last - first) / DAY) : 0;
  const span = Math.min(1, spanDays / 30.44 / SPAN_FULL_MONTHS);

  const wins = resolved.reduce((a, r) => a + (r.result === 'success' ? 1 : r.result === 'mixed' ? 0.5 : 0), 0);
  const trials = resolved.length + stale.length;
  const successRate = trials ? wins / trials : null;
  const track = wilsonLower(wins, trials);

  const replayValid = !!input.replay && now - input.replay.completedAt.getTime() <= REPLAY_VALID_DAYS * DAY && input.replay.itemsGraded >= QUALIFY.minReplayItems;
  const replay = replayValid ? Math.max(0, Math.min(1, input.replay!.score / 100)) : 0;

  const components = {
    depth: r1(depth * WEIGHTS.depth), span: r1(span * WEIGHTS.span), track: r1(track * WEIGHTS.track), replay: r1(replay * WEIGHTS.replay),
    effectiveRecords: r1(nEff), stalePending: stale.length,
  };
  const score = r1(components.depth + components.span + components.track + components.replay);
  return {
    score, components, spanDays, successRate: successRate == null ? null : Math.round(successRate * 1000) / 1000,
    totalCount: input.records.length, resolvedCount: resolved.length, witnessedCount: witnessed.length,
    firstAt: first != null ? new Date(first) : null, lastAt: last != null ? new Date(last) : null,
    replayValid, replayScore: input.replay?.score ?? null,
  };
}

type Tier = { minResolved: number; minReplayScore: number; minScore: number };

function tierMissing(t: Tier, s: { score: number; resolvedCount: number; replayValid: boolean; replayScore: number | null }): string[] {
  const missing: string[] = [];
  if (s.resolvedCount < t.minResolved) missing.push(`At least ${t.minResolved} experiences with a known outcome (has ${s.resolvedCount}).`);
  if (!s.replayValid) missing.push(`A completed experience replay (≥ ${QUALIFY.minReplayItems} cases, within ${REPLAY_VALID_DAYS} days).`);
  else if ((s.replayScore ?? 0) < t.minReplayScore) missing.push(`Replay score of at least ${t.minReplayScore} (latest ${r1(s.replayScore ?? 0)}).`);
  if (s.score < t.minScore) missing.push(`Experience Score of at least ${t.minScore} (currently ${r1(s.score)}).`);
  return missing;
}

/**
 * Trainer level in one domain. `missing` = what is still needed to qualify at all (empty once qualified);
 * `nextMissing` = what is still needed for Established (empty once established).
 */
export function qualificationFor(slug: string, s: { score: number; resolvedCount: number; replayValid: boolean; replayScore: number | null }) {
  if (slug === 'all' || slug === 'general') {
    return { level: 'none' as TrainerLevel, qualified: false, missing: ['Experience must be tagged with a capability domain to train others in it.'], nextMissing: [] as string[] };
  }
  const prov = tierMissing(PROVISIONAL, s);
  const est = tierMissing(QUALIFY, s);
  const level: TrainerLevel = est.length === 0 ? 'established' : prov.length === 0 ? 'provisional' : 'none';
  return { level, qualified: level !== 'none', missing: level === 'none' ? prov : [], nextMissing: level === 'established' ? [] : est };
}

const recomputeChains = new Map<string, Promise<unknown>>();

/**
 * Recompute and persist every Experience Score row of an agent ('all' + each domain + 'general').
 * Runs one at a time per agent: several replays can finish at nearly the same moment, and a slower recompute that
 * started earlier must not overwrite a newer one with stale data.
 */
export function recomputeExperienceScores(agentId: string): Promise<ExperienceScoreRow[]> {
  const prev = recomputeChains.get(agentId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(() => computeAndStoreScores(agentId));
  recomputeChains.set(agentId, next);
  void next.catch(() => undefined).then(() => { if (recomputeChains.get(agentId) === next) recomputeChains.delete(agentId); });
  return next;
}

async function computeAndStoreScores(agentId: string): Promise<ExperienceScoreRow[]> {
  const domains = await db().select({ id: schema.capabilityDomains.id, slug: schema.capabilityDomains.slug }).from(schema.capabilityDomains);
  const slugOf = new Map(domains.map((d) => [d.id, d.slug]));
  const recs = await db().select({
    domainId: schema.agentExperiences.domainId, result: schema.agentExperiences.result, witnessed: schema.agentExperiences.witnessed,
    source: schema.agentExperiences.source, occurredAt: schema.agentExperiences.occurredAt, createdAt: schema.agentExperiences.createdAt,
  }).from(schema.agentExperiences).where(eq(schema.agentExperiences.agentId, agentId));
  const replays = await db().select().from(schema.experienceReplays)
    .where(and(eq(schema.experienceReplays.agentId, agentId), eq(schema.experienceReplays.sourceAgentId, agentId),
      eq(schema.experienceReplays.purpose, 'self'), eq(schema.experienceReplays.status, 'completed')))
    .orderBy(desc(schema.experienceReplays.completedAt));

  const groups = new Map<string, typeof recs>([['all', recs]]);
  for (const r of recs) {
    const slug = r.domainId ? (slugOf.get(r.domainId) ?? 'general') : 'general';
    groups.set(slug, [...(groups.get(slug) ?? []), r]);
  }
  // An all-domain replay also counts for each domain it covered: its graded cases of that domain give a domain replay score.
  type Rep = { id: string; score: number; itemsGraded: number; completedAt: Date };
  const derived = new Map<string, Rep>();
  const allReplay = replays.find((x) => x.domainSlug === 'all' && x.score != null && x.completedAt);
  if (allReplay) {
    const its = await db().select({ score: schema.experienceReplayItems.score, domainId: schema.agentExperiences.domainId }).from(schema.experienceReplayItems)
      .innerJoin(schema.agentExperiences, eq(schema.agentExperiences.id, schema.experienceReplayItems.experienceId))
      .where(and(eq(schema.experienceReplayItems.replayId, allReplay.id), eq(schema.experienceReplayItems.status, 'graded')));
    const acc = new Map<string, { sum: number; n: number }>();
    for (const it of its) {
      const slug = it.domainId ? slugOf.get(it.domainId) : null;
      if (!slug || it.score == null) continue;
      const a = acc.get(slug) ?? { sum: 0, n: 0 };
      a.sum += it.score; a.n++; acc.set(slug, a);
    }
    // only a replay that covered enough of the domain's cases counts for it (fewer would not be a fair test)
    for (const [slug, a] of acc) if (a.n >= QUALIFY.minReplayItems) derived.set(slug, { id: allReplay.id, score: Math.round((a.sum / a.n) * 1000) / 10, itemsGraded: a.n, completedAt: allReplay.completedAt! });
  }
  const latestFor = (slug: string): Rep | null => {
    const r = replays.find((x) => x.domainSlug === slug && x.score != null && x.completedAt) ?? (slug === 'all' ? replays.find((x) => x.score != null && x.completedAt) : undefined);
    const own: Rep | null = r ? { id: r.id, score: r.score!, itemsGraded: r.itemsGraded, completedAt: r.completedAt! } : null;
    const d = derived.get(slug) ?? null;
    const valid = (x: Rep | null) => (x && x.itemsGraded >= QUALIFY.minReplayItems ? x : null);
    const o = valid(own), dd = valid(d);
    return o && dd ? (dd.completedAt > o.completedAt ? dd : o) : (o ?? dd ?? own);
  };

  const out: ExperienceScoreRow[] = [];
  const now = new Date();
  for (const [slug, records] of groups) {
    const replay = latestFor(slug);
    const s = computeExperienceScore({ records, replay });
    const q = qualificationFor(slug, s);
    const values = {
      agentId, domainSlug: slug, score: s.score, totalCount: s.totalCount, resolvedCount: s.resolvedCount, witnessedCount: s.witnessedCount,
      successRate: s.successRate, spanDays: s.spanDays, firstAt: s.firstAt, lastAt: s.lastAt,
      replayScore: s.replayValid ? s.replayScore : null, replayId: s.replayValid ? replay!.id : null, replayAt: s.replayValid ? replay!.completedAt : null,
      qualified: q.qualified, level: q.level, components: s.components, updatedAt: now,
    };
    const [row] = await db().insert(schema.agentExperienceScores).values(values)
      .onConflictDoUpdate({ target: [schema.agentExperienceScores.agentId, schema.agentExperienceScores.domainSlug], set: values }).returning();
    out.push(row!);
  }
  // domains that lost all their records
  const keep = new Set(groups.keys());
  const stale = (await db().select().from(schema.agentExperienceScores).where(eq(schema.agentExperienceScores.agentId, agentId))).filter((r) => !keep.has(r.domainSlug));
  for (const r of stale) await db().delete(schema.agentExperienceScores).where(eq(schema.agentExperienceScores.id, r.id));
  return out;
}

export async function getExperienceScores(agentId: string): Promise<ExperienceScoreRow[]> {
  return db().select().from(schema.agentExperienceScores).where(eq(schema.agentExperienceScores.agentId, agentId));
}

export function scoreView(r: ExperienceScoreRow) {
  const q = qualificationFor(r.domainSlug, { score: r.score, resolvedCount: r.resolvedCount, replayValid: r.replayScore != null, replayScore: r.replayScore });
  return {
    domain: r.domainSlug, score: r.score, totalCount: r.totalCount, resolvedCount: r.resolvedCount, witnessedCount: r.witnessedCount,
    successRate: r.successRate, spanDays: r.spanDays, firstAt: r.firstAt, lastAt: r.lastAt,
    replayScore: r.replayScore, replayId: r.replayId, replayAt: r.replayAt, components: r.components,
    qualifiedToTrain: q.qualified, level: q.level, missing: q.missing, nextMissing: q.nextMissing, updatedAt: r.updatedAt,
  };
}

/** Trainer gate for one domain (fresh recompute so new records/replays count immediately). */
export async function trainerQualification(agentId: string, domainSlug: string) {
  const rows = await recomputeExperienceScores(agentId);
  const row = rows.find((r) => r.domainSlug === domainSlug);
  if (!row) {
    return { qualified: false, level: 'none' as TrainerLevel, score: 0, nextMissing: [] as string[], missing: [`No experience recorded in "${domainSlug}" yet. Record or import this agent's real past work in this domain, then run an experience replay.`] };
  }
  const v = scoreView(row);
  return { qualified: v.qualifiedToTrain, level: v.level, score: row.score, missing: v.missing, nextMissing: v.nextMissing, row: v };
}
