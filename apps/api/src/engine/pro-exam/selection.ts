/**
 * Question pool + adaptive item selection for professional exams.
 *
 * Pool: `selectableQuestions(domainSlug, { mode })` from the question bank —
 *   certification → visibility 'private' AND status 'active' (reviewed) only; practice → any status 'active'.
 * Questions that cannot be graded at all (no rubric and only unit-test checks) are excluded.
 *
 * Next item: never a question this agent saw in ANY earlier exam (or this one); closest available tier to the
 * current target tier; then content balance — least-used subtopic, then least-used task type in this exam —
 * then fewest `times_served`, ties broken by the exam's secret random stream.
 *
 * Randomness: each exam gets a 32-byte crypto seed; only its sha256 is stored. The seed lives in process memory and
 * drives an HMAC stream (unpredictable to agents and owners). If the process restarts mid-exam the seed is gone and
 * selection continues with fresh crypto randomness — never with a guessable value.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { selectableQuestions, type ProQuestion } from '../pro-bank/select.js';
import { normaliseRubric } from './rubric.js';
import { questionGradable } from './grading.js';
import { TIERS, isTier, type Tier } from './ability.js';

export type { ProQuestion };
export type ExamMode = 'certification' | 'practice';

/** Minimum pool for a certification exam: ≥ targetItems questions and ≥ 3 in each difficulty band. */
export const MIN_PER_BAND = 3;

export async function loadPool(domainSlug: string, mode: ExamMode): Promise<ProQuestion[]> {
  const rows = await selectableQuestions(domainSlug, { mode });
  // defence in depth: certification must never see public examples, whatever the bank returns
  const filtered = rows.filter((q) => q.status === 'active' && (mode === 'practice' || q.visibility === 'private'));
  return filtered.filter((q) => questionGradable(q, normaliseRubric(q.rubric)));
}

export function bandCounts(pool: Pick<ProQuestion, 'difficulty'>[]): Record<Tier, number> {
  const c = { beginner: 0, intermediate: 0, professional: 0, expert: 0 } as Record<Tier, number>;
  for (const q of pool) if (isTier(q.difficulty)) c[q.difficulty]++;
  return c;
}

export interface PoolCheck { ok: boolean; available: number; needed: number; perBand: Record<Tier, number>; neededPerBand: number; message: string | null }

export function checkPool(pool: Pick<ProQuestion, 'difficulty'>[], mode: ExamMode, targetItems: number): PoolCheck {
  const perBand = bandCounts(pool);
  const available = pool.length;
  if (mode === 'certification') {
    const short = TIERS.filter((t) => perBand[t] < MIN_PER_BAND);
    const ok = available >= targetItems && !short.length;
    const bands = TIERS.map((t) => `${t} ${perBand[t]}`).join(', ');
    return {
      ok, available, needed: targetItems, perBand, neededPerBand: MIN_PER_BAND,
      message: ok ? null : `Certification is not available for this domain yet: it has ${available} reviewed private question${available === 1 ? '' : 's'} (${bands}); `
        + `a ${targetItems}-item certification exam needs at least ${targetItems}, with at least ${MIN_PER_BAND} in every difficulty band. Use practice mode meanwhile.`,
    };
  }
  const needed = Math.min(targetItems, 3);
  const ok = available >= needed;
  return { ok, available, needed, perBand, neededPerBand: 0, message: ok ? null : `Practice needs at least ${needed} active questions in this domain; it has ${available}.` };
}

/* ───────────── secret randomness ───────────── */

const seeds = new Map<string, { seed: Buffer; counter: number }>();

export function newSeed(): { seed: Buffer; hash: string } {
  const seed = randomBytes(32);
  return { seed, hash: createHash('sha256').update(seed).digest('hex') };
}
export function rememberSeed(examId: string, seed: Buffer) { seeds.set(examId, { seed, counter: 0 }); }
export function forgetSeed(examId: string) { seeds.delete(examId); }

/** Uniform [0, 1) from the exam's secret HMAC stream (or fresh crypto randomness when the seed is not in memory). */
export function examRandom(examId: string): () => number {
  return () => {
    const s = seeds.get(examId);
    const bytes = s ? createHmac('sha256', s.seed).update(String(s.counter++)).digest() : randomBytes(8);
    return bytes.readUInt32BE(0) / 2 ** 32;
  };
}

/* ───────────── picking ───────────── */

export interface PickState {
  tier: Tier;
  /** question ids this agent has already been served (any exam) */
  seen: Set<string>;
  /** subtopics / task types already used in this exam (with repeats) */
  usedSubtopics: string[];
  usedTaskTypes: string[];
}

export function pickNext<Q extends Pick<ProQuestion, 'id' | 'difficulty' | 'subtopic' | 'taskType' | 'timesServed'>>(pool: Q[], st: PickState, rand: () => number): Q | null {
  const fresh = pool.filter((q) => !st.seen.has(q.id));
  if (!fresh.length) return null;
  const ti = TIERS.indexOf(st.tier);
  const dist = (q: Q) => (isTier(q.difficulty) ? Math.abs(TIERS.indexOf(q.difficulty) - ti) : 9);
  const best = Math.min(...fresh.map(dist));
  const tierCands = fresh.filter((q) => dist(q) === best);
  const count = (xs: string[], v: string) => xs.reduce((n, x) => n + (x === v ? 1 : 0), 0);
  const keyed = tierCands.map((q) => ({ q, k: [count(st.usedSubtopics, q.subtopic), count(st.usedTaskTypes, q.taskType), q.timesServed, rand()] }));
  keyed.sort((a, b) => { for (let i = 0; i < a.k.length; i++) { if (a.k[i] !== b.k[i]) return a.k[i]! - b.k[i]!; } return 0; });
  return keyed[0]!.q;
}
