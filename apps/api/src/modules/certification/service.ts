/**
 * Certification service (Professional Evaluation).
 *
 * Called by the exam engine when a pro exam completes and by proof-based evaluation when evidence or a live check is
 * scored. Recomputes agent_certifications for (agentId, domainSlug) from REAL completed results only — nothing is
 * self-reported, estimated or carried over from a result that no longer qualifies.
 *
 * The rules live in CERTIFICATION_RULES (served verbatim by GET /certifications/rules so the UI shows exactly what the
 * code does). Every stored certification carries a `breakdown` that explains each number.
 */
import { and, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { notifyOrg } from '../../lib/notify.js';
import { refreshBadges } from '../social/service.js';
import { EVIDENCE_MAX, LIVE_FACTOR, SECOND_ITEM_BONUS, domainEvidenceTotal } from '../../engine/evidence/scoring.js';

export type CertLevel = 'none' | 'practitioner' | 'professional' | 'expert';
export type CertStatus = 'active' | 'expired' | 'revoked';

const LEVEL_ORDER: CertLevel[] = ['none', 'practitioner', 'professional', 'expert'];
export const levelRank = (l: string | null | undefined) => Math.max(0, LEVEL_ORDER.indexOf((l ?? 'none') as CertLevel));

/**
 * THE certification rules. Single source of truth: used by the computation below, by the trainer gate, and shown in
 * the UI via GET /certifications/rules.
 */
export const CERTIFICATION_RULES = {
  version: 1,
  exam: {
    /** only finished sittings in certification mode count — practice exams NEVER certify */
    status: 'completed',
    mode: 'certification',
    /** sittings whose confidence is below this are ignored (not enough evidence for a verdict) */
    minConfidence: 0.6,
    /** the LATEST qualifying sitting is used, even if an older one scored higher (no cherry-picking) */
    pick: 'latest',
  },
  proof: {
    /** uploaded proof of past work contributes at most 80 points (owned by engine/evidence/scoring.ts) */
    evidenceCap: EVIDENCE_MAX,
    /**
     * evidence total = best scored item + 25 % of the 2nd + 12.5 % of the 3rd + … capped at evidenceCap — computed by
     * domainEvidenceTotal() in engine/evidence/scoring.ts (the proof engine's rule; factors listed here for display)
     */
    evidenceBonusFactors: [SECOND_ITEM_BONUS, SECOND_ITEM_BONUS / 2, SECOND_ITEM_BONUS / 4, SECOND_ITEM_BONUS / 8],
    /** latest scored live "replicate the skill" check contributes score × 0.2 (max 20) */
    liveCheckWeight: LIVE_FACTOR,
    /** without a scored live check the proof path is capped at 80 and can reach at most 'practitioner' on its own */
    maxScoreWithoutLiveCheck: 80,
    maxLevelWithoutLiveCheck: 'practitioner' as CertLevel,
    /** a removed (moderated) evidence item voids the proof path in that domain — removed content earns no credit */
    removedEvidenceVoidsProof: true,
  },
  combined: { examWeight: 0.6, proofWeight: 0.4 },
  levels: [
    { level: 'practitioner' as CertLevel, min: 60, requiresExam: false },
    { level: 'professional' as CertLevel, min: 75, requiresExam: false },
    { level: 'expert' as CertLevel, min: 88, requiresExam: true },
  ],
  /** results older than this do not count; a certification expires 12 months after its oldest contributing result */
  validityMonths: 12,
  /** trainers may list in a domain with a verified capability ≥ 70 OR an active certification at this level or above */
  trainerGateMinLevel: 'professional' as CertLevel,
  explain: [
    'Professional exam path: the latest completed certification-mode exam with confidence ≥ 0.6 gives the exam score. Practice exams never certify.',
    'Proof path: uploaded evidence (best item plus a diminishing bonus from further items, max 80) plus the latest scored live check × 0.2 (max 20). Without a live check the proof path is capped at 80 and on its own reaches at most Practitioner.',
    'Both paths: 0.6 × exam + 0.4 × proof. One path: that path alone.',
    'Levels: Practitioner ≥ 60, Professional ≥ 75, Expert ≥ 88 (Expert also requires a professional exam). Below 60 there is no certification.',
    'The newest result always replaces older ones, even if it is lower — older, better results cannot be cherry-picked.',
    'Results older than 12 months stop counting; certifications expire 12 months after their oldest contributing result.',
    'Certifications are revoked if the agent is suspended or removed, if evidence is removed by moderation (proof path voided), or by a Hive Mind administrator.',
  ],
} as const;

const R = CERTIFICATION_RULES;
const round1 = (n: number) => Math.round(n * 10) / 10;
const addMonths = (d: Date, m: number) => { const x = new Date(d); x.setMonth(x.getMonth() + m); return x; };

/**
 * Evidence total from per-item evidence scores (0-80 each). The total itself comes from the proof engine's
 * domainEvidenceTotal(); `parts` only explains each item's contribution for the breakdown.
 */
export function evidenceTotal(scores: number[]): { total: number; parts: { score: number; factor: number; points: number }[] } {
  const sorted = scores.filter((s) => Number.isFinite(s) && s > 0).sort((a, b) => b - a);
  const parts = sorted.map((score, i) => {
    const factor = i === 0 ? 1 : SECOND_ITEM_BONUS * 0.5 ** (i - 1);
    return { score: round1(score), factor, points: round1(score * factor) };
  });
  return { total: round1(domainEvidenceTotal(sorted)), parts };
}

/** Level for a combined score. `examPath` = whether the exam path contributed; `proofOnlyNoLive` applies the cap. */
export function levelFor(score: number, opts: { examPath: boolean; proofOnlyNoLive: boolean }): CertLevel {
  let level: CertLevel = 'none';
  for (const l of R.levels) if (score >= l.min && (!l.requiresExam || opts.examPath)) level = l.level;
  if (opts.proofOnlyNoLive && levelRank(level) > levelRank(R.proof.maxLevelWithoutLiveCheck)) level = R.proof.maxLevelWithoutLiveCheck;
  return level;
}

export interface CertificationComputation {
  level: CertLevel;
  score: number;
  examScore: number | null;
  evidenceScore: number | null;
  liveCheckScore: number | null;
  confidence: number | null;
  examId: string | null;
  expiresAt: Date | null;
  /** newest contributing result date — used to decide whether an admin revocation is superseded */
  newestResultAt: Date | null;
  hasInputs: boolean;
  revokeReason: string | null;
  breakdown: Record<string, unknown>;
}

/** Pure computation from the current DB state (no writes). Exported for the hub/tests. */
export async function computeCertification(agentId: string, domainSlug: string, now = new Date()): Promise<CertificationComputation> {
  const cutoff = addMonths(now, -R.validityMonths);
  const [agent] = await db().select({ id: schema.agents.id, status: schema.agents.status, deletedAt: schema.agents.deletedAt })
    .from(schema.agents).where(eq(schema.agents.id, agentId)).limit(1);

  // ── exam path ──
  const exams = await db().select().from(schema.proExams).where(and(
    eq(schema.proExams.agentId, agentId), eq(schema.proExams.domainSlug, domainSlug),
    eq(schema.proExams.status, R.exam.status), eq(schema.proExams.mode, R.exam.mode),
  )).orderBy(desc(sql`coalesce(${schema.proExams.completedAt}, ${schema.proExams.updatedAt})`));
  const qualifying = exams.filter((e) => e.score != null && (e.confidence ?? 0) >= R.exam.minConfidence);
  const latestExam = qualifying[0] ?? null;
  const examAt = latestExam ? (latestExam.completedAt ?? latestExam.updatedAt) : null;
  const examFresh = !!latestExam && examAt! >= cutoff;
  const exam = examFresh ? latestExam : null;
  const examScore = exam ? round1(Math.max(0, Math.min(100, exam.score!))) : null;
  const ignoredLowConfidence = exams.filter((e) => e.score != null && (e.confidence ?? 0) < R.exam.minConfidence).length;

  // ── proof path ──
  const evidence = await db().select().from(schema.evidenceSubmissions).where(and(
    eq(schema.evidenceSubmissions.agentId, agentId), eq(schema.evidenceSubmissions.domainSlug, domainSlug),
  ));
  const removed = evidence.filter((e) => e.moderation === 'removed');
  const scoredItems = evidence.filter((e) => e.moderation !== 'removed' && e.status === 'scored' && e.evidenceScore != null);
  const freshItems = scoredItems.filter((e) => e.updatedAt >= cutoff);
  const proofVoided = R.proof.removedEvidenceVoidsProof && removed.length > 0;
  const ranked = proofVoided ? [] : freshItems.filter((e) => e.evidenceScore! > 0).sort((a, b) => b.evidenceScore! - a.evidenceScore!);
  const ev = evidenceTotal(ranked.map((e) => Math.min(R.proof.evidenceCap, e.evidenceScore!)));
  const [live] = await db().select().from(schema.evidenceLiveChecks).where(and(
    eq(schema.evidenceLiveChecks.agentId, agentId), eq(schema.evidenceLiveChecks.domainSlug, domainSlug),
    eq(schema.evidenceLiveChecks.status, 'scored'),
  )).orderBy(desc(schema.evidenceLiveChecks.updatedAt)).limit(1);
  const liveFresh = !!live && live.score != null && live.updatedAt >= cutoff;
  const proofPath = ranked.length > 0;
  const liveCheckScore = proofPath && liveFresh ? round1(Math.max(0, Math.min(100, live!.score!))) : null;
  const liveContribution = liveCheckScore != null ? round1(liveCheckScore * R.proof.liveCheckWeight) : 0;
  const proofScore = proofPath
    ? round1(Math.min(liveCheckScore != null ? 100 : R.proof.maxScoreWithoutLiveCheck, ev.total + liveContribution))
    : null;

  // ── combine ──
  let score = 0;
  let formula = 'no qualifying results';
  if (examScore != null && proofScore != null) {
    score = round1(R.combined.examWeight * examScore + R.combined.proofWeight * proofScore);
    formula = `${R.combined.examWeight} × exam ${examScore} + ${R.combined.proofWeight} × proof ${proofScore} = ${score}`;
  } else if (examScore != null) {
    score = examScore; formula = `exam only: ${examScore}`;
  } else if (proofScore != null) {
    score = proofScore; formula = `proof only: ${proofScore}${liveCheckScore == null ? ' (no live check — capped at 80, max Practitioner)' : ''}`;
  }
  const examPath = examScore != null;
  const proofOnlyNoLive = !examPath && proofScore != null && liveCheckScore == null;
  const uncappedLevel = levelFor(score, { examPath, proofOnlyNoLive: false });
  const level = levelFor(score, { examPath, proofOnlyNoLive });

  const contributingDates: Date[] = [];
  if (exam) contributingDates.push(examAt!);
  if (proofPath) {
    for (const e of ranked) contributingDates.push(e.updatedAt);
    if (liveCheckScore != null) contributingDates.push(live!.updatedAt);
  }
  const oldest = contributingDates.length ? new Date(Math.min(...contributingDates.map((d) => d.getTime()))) : null;
  const newest = contributingDates.length ? new Date(Math.max(...contributingDates.map((d) => d.getTime()))) : null;
  const hasInputs = examPath || proofPath;

  let revokeReason: string | null = null;
  if (!agent || agent.deletedAt) revokeReason = 'agent_removed';
  else if (agent.status === 'suspended') revokeReason = 'agent_suspended';
  else if (!hasInputs && proofVoided) revokeReason = 'content_removed';

  const notes: string[] = [];
  if (latestExam && !examFresh) notes.push(`The latest qualifying exam (${examAt!.toISOString().slice(0, 10)}) is older than ${R.validityMonths} months and no longer counts.`);
  if (ignoredLowConfidence) notes.push(`${ignoredLowConfidence} completed certification exam(s) ignored because confidence was below ${R.exam.minConfidence}.`);
  if (proofVoided) notes.push(`${removed.length} evidence item(s) were removed by moderation — the proof path is voided in this domain.`);
  if (scoredItems.length > freshItems.length) notes.push(`${scoredItems.length - freshItems.length} evidence item(s) are older than ${R.validityMonths} months and no longer count.`);
  if (live && live.score != null && !liveFresh) notes.push(`The latest live check is older than ${R.validityMonths} months and no longer counts.`);
  if (proofOnlyNoLive && levelRank(uncappedLevel) > levelRank(level)) notes.push(`Score ${score} would reach ${uncappedLevel}, but proof without a scored live check is capped at ${R.proof.maxLevelWithoutLiveCheck}.`);
  if (!examPath && score >= 88) notes.push('Expert additionally requires the professional exam path.');

  const breakdown: Record<string, unknown> = {
    rulesVersion: R.version,
    computedAt: now.toISOString(),
    exam: exam ? {
      examId: exam.id, score: examScore, confidence: exam.confidence, completedAt: examAt!.toISOString(),
      note: 'Latest completed certification-mode exam with confidence ≥ 0.6.',
    } : null,
    proof: proofPath ? {
      items: ev.parts.map((p, i) => ({ ...p, id: ranked[i]?.id, title: ranked[i]?.title })),
      evidenceTotal: ev.total,
      evidenceRule: `best item + 25% of the 2nd + 12.5% of the 3rd + … (max ${R.proof.evidenceCap})`,
      liveCheck: liveCheckScore != null ? { id: live!.id, score: liveCheckScore, weight: R.proof.liveCheckWeight, points: liveContribution, scoredAt: live!.updatedAt.toISOString() } : null,
      proofScore,
      capped: liveCheckScore == null ? `No scored live check: proof capped at ${R.proof.maxScoreWithoutLiveCheck} and max level ${R.proof.maxLevelWithoutLiveCheck}.` : null,
    } : null,
    combined: { formula, score, weights: examPath && proofPath ? R.combined : null },
    level: { level, thresholds: R.levels, uncappedLevel },
    validity: { months: R.validityMonths, oldestResultAt: oldest?.toISOString() ?? null, expiresAt: oldest ? addMonths(oldest, R.validityMonths).toISOString() : null },
    notes,
  };

  return {
    level, score, examScore, evidenceScore: proofPath ? ev.total : null, liveCheckScore,
    confidence: exam?.confidence ?? null, examId: exam?.id ?? null,
    expiresAt: oldest ? addMonths(oldest, R.validityMonths) : null, newestResultAt: newest,
    hasInputs, revokeReason, breakdown,
  };
}

type CertRow = typeof schema.agentCertifications.$inferSelect;
const LEVEL_LABEL: Record<CertLevel, string> = { none: 'No certification', practitioner: 'Certified Practitioner', professional: 'Certified Professional', expert: 'Certified Expert' };
export const levelLabel = (l: string) => LEVEL_LABEL[(l as CertLevel)] ?? l;

/**
 * Recompute the certification for (agentId, domainSlug) and upsert agent_certifications. Signature is fixed — other
 * modules call this after an exam completes or proof is scored.
 *
 * - No qualifying results and no existing row → nothing is written.
 * - Agent suspended/removed → status 'revoked' (lifted automatically by a later recompute once the agent is active).
 * - Admin revocation sticks until a NEW result (newer than the revocation) arrives.
 * - All results expired → status 'expired'.
 * Notifies the owner org (type 'evaluation_result') when the effective level or status changes, and refreshes badges.
 */
export async function recomputeCertification(agentId: string, domainSlug: string): Promise<void> {
  await recomputeCertificationRow(agentId, domainSlug);
}

/** Same as recomputeCertification but returns the stored row (null when nothing exists). */
export async function recomputeCertificationRow(agentId: string, domainSlug: string, now = new Date()): Promise<CertRow | null> {
  const c = await computeCertification(agentId, domainSlug, now);
  const [existing] = await db().select().from(schema.agentCertifications)
    .where(and(eq(schema.agentCertifications.agentId, agentId), eq(schema.agentCertifications.domainSlug, domainSlug))).limit(1);
  if (!existing && (!c.hasInputs || c.revokeReason)) return null;

  const prevRevocation = (existing?.breakdown as { revocation?: { by: string; at: string; reason: string } } | undefined)?.revocation;
  let status: CertStatus = 'active';
  let revocation: Record<string, unknown> | null = null;
  if (c.revokeReason) {
    status = 'revoked'; revocation = { by: 'system', reason: c.revokeReason, at: (prevRevocation?.by === 'system' && prevRevocation.reason === c.revokeReason ? prevRevocation.at : now.toISOString()) };
  } else if (existing?.status === 'revoked' && prevRevocation?.by === 'admin' && !(c.newestResultAt && c.newestResultAt > new Date(prevRevocation.at))) {
    status = 'revoked'; revocation = prevRevocation; // admin revocation stands until a newer result arrives
  } else if (!c.hasInputs) {
    status = 'expired';
  }

  const effectiveLevel: CertLevel = status === 'active' ? c.level : 'none';
  const changed = !existing || existing.level !== effectiveLevel || existing.status !== status || existing.score !== c.score;
  const values = {
    level: effectiveLevel,
    score: c.score, examScore: c.examScore, evidenceScore: c.evidenceScore, liveCheckScore: c.liveCheckScore,
    confidence: c.confidence, examId: c.examId, status,
    breakdown: { ...c.breakdown, ...(revocation ? { revocation } : {}), ...(status !== 'active' ? { computedLevel: c.level } : {}) },
    issuedAt: changed ? now : existing!.issuedAt,
    expiresAt: c.expiresAt,
    updatedAt: now,
  };
  const [row] = await db().insert(schema.agentCertifications).values({ agentId, domainSlug, ...values })
    .onConflictDoUpdate({ target: [schema.agentCertifications.agentId, schema.agentCertifications.domainSlug], set: values }).returning();

  const prevEffective = existing ? (existing.status === 'active' ? existing.level : 'none') : 'none';
  if (prevEffective !== effectiveLevel || (existing && existing.status !== status)) {
    await notifyLevelChange(agentId, domainSlug, prevEffective, effectiveLevel, status, c.score).catch((e) => console.error('[certification] notify failed', e));
  }
  await refreshBadges(agentId).catch((e) => console.error(`[certification] refreshBadges ${agentId} failed`, e));
  return row ?? null;
}

async function domainLabel(slug: string) {
  const [d] = await db().select({ name: schema.capabilityDomains.name }).from(schema.capabilityDomains).where(eq(schema.capabilityDomains.slug, slug)).limit(1);
  return d?.name ?? slug;
}

async function notifyLevelChange(agentId: string, domainSlug: string, from: string, to: CertLevel, status: CertStatus, score: number) {
  const [a] = await db().select({ orgId: schema.agents.orgId, name: schema.agents.name }).from(schema.agents).where(eq(schema.agents.id, agentId)).limit(1);
  if (!a) return;
  const dn = await domainLabel(domainSlug);
  const title = status === 'revoked' ? `${a.name}: certification revoked · ${dn}`
    : status === 'expired' ? `${a.name}: certification expired · ${dn}`
    : to === 'none' ? `${a.name}: no certification level · ${dn}`
    : `${a.name}: ${levelLabel(to)} · ${dn}`;
  const body = status === 'active'
    ? `Combined score ${score}. Level changed from ${from} to ${to}. See "how this was calculated" for the full breakdown.`
    : `Previous level: ${from}.`;
  await notifyOrg(a.orgId, 'evaluation_result', title, body, `/app/evaluation?agentId=${agentId}`);
}

/** Admin revocation (sticks until a newer result arrives). Returns the updated row. */
export async function revokeCertification(id: string, reason: string, adminUserId: string): Promise<CertRow | null> {
  const [existing] = await db().select().from(schema.agentCertifications).where(eq(schema.agentCertifications.id, id)).limit(1);
  if (!existing) return null;
  const now = new Date();
  const [row] = await db().update(schema.agentCertifications).set({
    status: 'revoked', level: 'none', updatedAt: now,
    breakdown: { ...existing.breakdown, computedLevel: existing.level, revocation: { by: 'admin', reason, at: now.toISOString(), adminUserId } },
  }).where(eq(schema.agentCertifications.id, id)).returning();
  if (existing.status === 'active' && existing.level !== 'none') {
    await notifyLevelChange(existing.agentId, existing.domainSlug, existing.level, 'none', 'revoked', existing.score).catch((e) => console.error('[certification] notify failed', e));
  }
  await refreshBadges(existing.agentId).catch(() => undefined);
  return row ?? null;
}

/** Trainer gate helper: active, unexpired certification at ≥ trainerGateMinLevel in the domain. */
export async function hasTrainerCertification(agentId: string, domainSlug: string, now = new Date()): Promise<CertRow | null> {
  const [c] = await db().select().from(schema.agentCertifications).where(and(
    eq(schema.agentCertifications.agentId, agentId), eq(schema.agentCertifications.domainSlug, domainSlug),
    eq(schema.agentCertifications.status, 'active'),
  )).limit(1);
  if (!c || levelRank(c.level) < levelRank(R.trainerGateMinLevel)) return null;
  if (c.expiresAt && c.expiresAt <= now) return null;
  return c;
}

/** Active, unexpired certifications with a level for the agents (used by marketplace cards / public profile). */
export async function activeCertifications(agentIds: string[], now = new Date()): Promise<CertRow[]> {
  if (!agentIds.length) return [];
  const rows = await db().select().from(schema.agentCertifications).where(and(
    inArray(schema.agentCertifications.agentId, agentIds), eq(schema.agentCertifications.status, 'active'),
  ));
  return rows.filter((r) => r.level !== 'none' && (!r.expiresAt || r.expiresAt > now));
}

/**
 * Daily sweep: recompute certifications that (a) passed their expiry, (b) are active but whose agent is suspended or
 * removed, or (c) were revoked by the system and may be restorable. Returns how many rows were recomputed.
 */
export async function sweepCertifications(now = new Date()): Promise<number> {
  const A = schema.agents;
  const C = schema.agentCertifications;
  const rows = await db().select({ agentId: C.agentId, domainSlug: C.domainSlug }).from(C)
    .innerJoin(A, eq(A.id, C.agentId))
    .where(or(
      and(eq(C.status, 'active'), lte(C.expiresAt, now)),
      and(eq(C.status, 'active'), or(eq(A.status, 'suspended'), sql`${A.deletedAt} is not null`)),
      and(eq(C.status, 'revoked'), eq(A.status, 'active'), isNull(A.deletedAt), sql`${C.breakdown} -> 'revocation' ->> 'by' = 'system'`),
    ));
  for (const r of rows) {
    await recomputeCertificationRow(r.agentId, r.domainSlug, now).catch((e) => console.error(`[certification] sweep ${r.agentId}/${r.domainSlug} failed`, e));
  }
  return rows.length;
}
