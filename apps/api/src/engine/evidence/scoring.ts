/**
 * "Results speak" — exact scoring rules for proof-based evaluation. Pure functions; the UI shows the same table.
 *
 * 1. Trust weight (0–1) of one proof item = BASE_TRUST[kind][verified|unverified]
 *      git_repo  verified 1.00 · unverified 0.50
 *      website   verified 0.95 · unverified 0.50
 *      link      verified 0.90 · unverified 0.40     (any other public page; same ownership methods as website)
 *      pdf       0.60  (ownership not applicable)
 *      document  0.60  (ownership not applicable)
 *      image     0.30  (ownership not applicable; no OCR/vision → never quality-scored, see pipeline)
 *    then, in this order:
 *      possible_copy          → min(weight, 0.20)   same file hash / URL already submitted by another organisation
 *                                                    (lifted for repos/sites once THIS org verifies ownership)
 *      proof_not_reproduced   → weight × 0.50       the latest scored live check for the domain is more than
 *                                                    40 points below this item's quality score
 *
 * 2. Evidence score of one item (0–80) = qualityScore (0–100, from the rubric judge) × trustWeight × 0.8
 *
 * 3. Domain evidence total (0–80) = best item + diminishing bonus from the others, capped at 80:
 *      sort item scores descending s1 ≥ s2 ≥ … ;  total = min(80, s1 + Σ_{i≥2} s_i × 0.25 × 0.5^(i−2))
 *      (2nd item adds 25 % of its score, 3rd 12.5 %, 4th 6.25 %, …)
 *
 * 4. Live skill check (0–20) = liveCheckScore (0–100, judged) × 0.2 — the latest scored live check for the domain.
 *
 * 5. Proof-based total (0–100) = domain evidence total + live check contribution.
 *    Judge returns 'awaiting_judge' (under admin review) → items stay 'awaiting_judge' and contribute nothing (scores are never guessed).
 */
export type EvidenceKind = 'git_repo' | 'website' | 'pdf' | 'document' | 'image' | 'link';
export const EVIDENCE_KINDS: EvidenceKind[] = ['git_repo', 'website', 'pdf', 'document', 'image', 'link'];
export const URL_KINDS: EvidenceKind[] = ['git_repo', 'website', 'link'];
export const FILE_KINDS: EvidenceKind[] = ['pdf', 'document', 'image'];

export const BASE_TRUST: Record<EvidenceKind, { verified: number; unverified: number }> = {
  git_repo: { verified: 1.0, unverified: 0.5 },
  website: { verified: 0.95, unverified: 0.5 },
  link: { verified: 0.9, unverified: 0.4 },
  pdf: { verified: 0.6, unverified: 0.6 },
  document: { verified: 0.6, unverified: 0.6 },
  image: { verified: 0.3, unverified: 0.3 },
};

export const POSSIBLE_COPY_CAP = 0.2;
export const NOT_REPRODUCED_FACTOR = 0.5;
/** live check more than this many points below an item's quality → proof_not_reproduced */
export const NOT_REPRODUCED_GAP = 40;
export const EVIDENCE_MAX = 80;
export const LIVE_MAX = 20;
export const EVIDENCE_FACTOR = 0.8;
export const LIVE_FACTOR = 0.2;
export const SECOND_ITEM_BONUS = 0.25;

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

export interface TrustInput {
  kind: EvidenceKind;
  ownershipStatus: string;
  possibleCopy: boolean;
  proofNotReproduced: boolean;
}

export interface TrustResult {
  weight: number;
  base: number;
  factors: { rule: string; effect: string }[];
}

export function trustWeight(t: TrustInput): TrustResult {
  const b = BASE_TRUST[t.kind] ?? BASE_TRUST.link;
  const verified = t.ownershipStatus === 'verified';
  const base = verified ? b.verified : b.unverified;
  let w = base;
  const factors: TrustResult['factors'] = [{ rule: `${t.kind} · ${URL_KINDS.includes(t.kind) ? (verified ? 'ownership verified' : 'ownership not verified') : 'ownership not applicable'}`, effect: `base ${base}` }];
  if (t.possibleCopy) {
    w = Math.min(w, POSSIBLE_COPY_CAP);
    factors.push({ rule: 'possible_copy', effect: `capped at ${POSSIBLE_COPY_CAP}` });
  }
  if (t.proofNotReproduced) {
    w = w * NOT_REPRODUCED_FACTOR;
    factors.push({ rule: 'proof_not_reproduced', effect: `× ${NOT_REPRODUCED_FACTOR}` });
  }
  return { weight: round(w, 3), base, factors };
}

/** qualityScore × trustWeight × 0.8 → 0–80. */
export function evidenceScore(qualityScore: number, weight: number): number {
  const q = Math.max(0, Math.min(100, qualityScore));
  const w = Math.max(0, Math.min(1, weight));
  return round(Math.min(EVIDENCE_MAX, q * w * EVIDENCE_FACTOR));
}

/** Best item + diminishing bonus (25 %, 12.5 %, …) from the rest, capped at 80. */
export function domainEvidenceTotal(scores: number[]): number {
  const s = scores.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => b - a);
  if (!s.length) return 0;
  let total = s[0]!;
  for (let i = 1; i < s.length; i++) total += s[i]! * SECOND_ITEM_BONUS * 0.5 ** (i - 1);
  return round(Math.min(EVIDENCE_MAX, total));
}

/** live score 0–100 → contribution 0–20. */
export function liveContribution(liveScore: number | null | undefined): number {
  if (liveScore == null || !Number.isFinite(liveScore)) return 0;
  return round(Math.max(0, Math.min(100, liveScore)) * LIVE_FACTOR);
}

/** The live check failed to reproduce this item's quality. */
export function proofNotReproduced(qualityScore: number | null | undefined, latestLiveScore: number | null | undefined): boolean {
  if (qualityScore == null || latestLiveScore == null) return false;
  return qualityScore - latestLiveScore > NOT_REPRODUCED_GAP;
}

/** Scoring table for clients (UI renders exactly these numbers). */
export function scoringRules() {
  return {
    baseTrust: BASE_TRUST,
    possibleCopyCap: POSSIBLE_COPY_CAP,
    notReproduced: { gap: NOT_REPRODUCED_GAP, factor: NOT_REPRODUCED_FACTOR },
    evidenceFactor: EVIDENCE_FACTOR, evidenceMax: EVIDENCE_MAX,
    liveFactor: LIVE_FACTOR, liveMax: LIVE_MAX,
    secondItemBonus: SECOND_ITEM_BONUS,
    formulas: {
      item: 'evidenceScore = qualityScore × trustWeight × 0.8 (max 80)',
      domain: 'evidenceTotal = best item + 25% of 2nd + 12.5% of 3rd + … (max 80)',
      live: 'liveContribution = liveCheckScore × 0.2 (max 20)',
      total: 'proof total = evidenceTotal + liveContribution (max 100)',
      notReproduced: `live check > ${NOT_REPRODUCED_GAP} points below an item's quality → that item's trust × ${NOT_REPRODUCED_FACTOR} (flag proof_not_reproduced)`,
      possibleCopy: `same file/URL already submitted by another organisation → trust capped at ${POSSIBLE_COPY_CAP} (flag possible_copy; repos/sites: lifted when you verify ownership)`,
    },
  };
}
