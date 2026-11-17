/**
 * Ability estimation for the adaptive professional exam (pure functions, no DB).
 *
 * Model: Rasch / 1-PL logistic with partial credit. Each graded item contributes an observed proportion
 * x = itemScore / 100 ∈ [0, 1] and an expected proportion P(θ) = 1 / (1 + exp(−D·a·(θ − b))), D = 1.7 (the usual
 * scaling that makes the logistic close to the normal ogive), a = 1 unless the question has calibrated IRT params.
 * Item difficulty b comes from `pro_questions.irt.b` when present, else from its tier:
 *   beginner −1.5 · intermediate −0.5 · professional +0.5 · expert +1.5
 * θ is the MAP estimate with a N(0, 1) prior (keeps estimates finite after all-correct / all-wrong runs), found by
 * Newton-Raphson on the log-posterior. SE(θ) = 1 / √(Σ D²a²P(1−P) + 1).
 *
 * Tier movement (by performance only, never by self-reported experience): start at 'professional'; after each
 * graded item move up one tier if its score ≥ 70, down one if < 40, otherwise stay. Ungraded items (awaiting judge,
 * timeouts, errors) do not move the tier.
 */
export const TIERS = ['beginner', 'intermediate', 'professional', 'expert'] as const;
export type Tier = (typeof TIERS)[number];
export const START_TIER: Tier = 'professional';
export const TIER_B: Record<Tier, number> = { beginner: -1.5, intermediate: -0.5, professional: 0.5, expert: 1.5 };
export const UP_THRESHOLD = 70;
export const DOWN_THRESHOLD = 40;
export const D = 1.7;
/** Stop rule: SE below this after at least MIN_ITEMS_FOR_SE_STOP graded items. */
export const SE_STOP = 0.4;
export const MIN_ITEMS_FOR_SE_STOP = 6;
export const DEFAULT_TARGET_ITEMS = 10;
/** Items sent together per adaptive step (both from the current tier, different subtopics). */
export const BATCH_SIZE = 2;
export const MAX_TARGET_ITEMS = 30;

export const isTier = (s: string): s is Tier => (TIERS as readonly string[]).includes(s);

export function nextTier(current: Tier, itemScore: number | null): Tier {
  if (itemScore === null || !Number.isFinite(itemScore)) return current;
  const i = TIERS.indexOf(current);
  if (itemScore >= UP_THRESHOLD) return TIERS[Math.min(TIERS.length - 1, i + 1)]!;
  if (itemScore < DOWN_THRESHOLD) return TIERS[Math.max(0, i - 1)]!;
  return current;
}

/** Tier after a sequence of item scores (null = ungraded, no movement). */
export function tierAfter(scores: (number | null)[], start: Tier = START_TIER): Tier {
  return scores.reduce<Tier>((t, s) => nextTier(t, s), start);
}

export interface Response { b: number; a?: number; score: number }

/** Difficulty b of a question: calibrated irt.b if present, else the tier default. */
export function difficultyOf(q: { difficulty: string; irt?: Record<string, number | null> | null }): { a: number; b: number } {
  const irt = q.irt ?? {};
  const b = typeof irt.b === 'number' && Number.isFinite(irt.b) ? irt.b : TIER_B[isTier(q.difficulty) ? q.difficulty : 'professional'];
  const a = typeof irt.a === 'number' && Number.isFinite(irt.a) && irt.a > 0 ? irt.a : 1;
  return { a, b };
}

const p = (theta: number, a: number, b: number) => 1 / (1 + Math.exp(-D * a * (theta - b)));

/** MAP ability estimate and standard error. With no responses: θ = 0, SE = 1 (the prior). */
export function estimateAbility(responses: Response[]): { theta: number; se: number } {
  let theta = 0;
  for (let iter = 0; iter < 50; iter++) {
    let grad = -theta; // d/dθ log N(0,1)
    let info = 1; // −d²/dθ² of the prior
    for (const r of responses) {
      const a = r.a ?? 1;
      const x = Math.max(0, Math.min(1, r.score / 100));
      const pr = p(theta, a, r.b);
      grad += D * a * (x - pr);
      info += D * D * a * a * pr * (1 - pr);
    }
    const step = grad / info;
    theta += Math.max(-1, Math.min(1, step));
    if (Math.abs(step) < 1e-6) break;
  }
  theta = Math.max(-4, Math.min(4, theta));
  let info = 1;
  for (const r of responses) { const a = r.a ?? 1; const pr = p(theta, a, r.b); info += D * D * a * a * pr * (1 - pr); }
  return { theta: round(theta, 4), se: round(1 / Math.sqrt(info), 4) };
}

/** Ability θ mapped linearly to 0-100 over [−3, +3] (θ = 0 → 50; professional b = 0.5 → 58.3; expert b = 1.5 → 75). */
export function abilityToScore(theta: number): number {
  return round(Math.max(0, Math.min(100, ((theta + 3) / 6) * 100)), 1);
}

export function shouldStop(gradedCount: number, consumedCount: number, se: number, targetItems: number): 'target_reached' | 'precision_reached' | null {
  if (consumedCount >= targetItems) return 'target_reached';
  if (gradedCount >= MIN_ITEMS_FOR_SE_STOP && se < SE_STOP) return 'precision_reached';
  return null;
}

export function round(v: number, d = 1) { return Math.round(v * 10 ** d) / 10 ** d; }
