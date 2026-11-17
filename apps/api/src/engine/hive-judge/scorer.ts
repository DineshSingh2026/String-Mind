/**
 * Hive Judge tier 2 — the local rubric scorer (always on, CPU-only, a few ms per answer).
 *
 * Per checkpoint fraction = isotonic( ½·logistic(features) + ½·kNN(features) ), calibrated per task type when the
 * task type has enough calibration rows. When the question has its own calibration answers (synthetic or
 * admin-authored), a same-question exemplar kNN over whole answers is blended in, weighted by how close the new
 * answer is to its nearest exemplar. Any red flag fired → total 0 (the platform-wide rule).
 */
import {
  CP_FEATURES, RF_FEATURES, analyseAnswer, answerLevel, buildItemContext, checkpointFeatures, redFlagFeatures,
  type AnswerAnalysis, type AnswerLevel, type ItemContext, type Lexicon,
} from './features.js';
import { predictIsotonic, predictKnn, predictLogistic, type Isotonic, type Knn, type Logistic } from './model.js';
import { clamp01, cos, round, vec, type SparseVec } from './text.js';
import type { CalExample, CheckpointJudgement, JudgeItem } from './types.js';

export interface CpModel {
  logistic: Logistic;
  knn: Knn;
  /** weight of the logistic model in the raw ensemble (kNN gets 1 − w) */
  wLogistic: number;
  isoGlobal: Isotonic;
  isoByTaskType: Record<string, Isotonic>;
}

export interface RfModel { logistic: Logistic; threshold: number }

export interface HiveModel {
  kind: 'hive-judge-scorer';
  version: number;
  trainedAt: string;
  seed: number;
  featureNames: string[];
  rfFeatureNames: string[];
  lexicon: Lexicon;
  cp: CpModel;
  rf: RfModel;
  /** exemplar blend: α = clamp((maxSim − sim0) / span) · alphaMax */
  exemplar: { sim0: number; span: number; alphaMax: number; tau: number };
  /** calibration rows per domain slug / task type (for confidence) */
  support: { domains: Record<string, number>; taskTypes: Record<string, number>; total: number };
  data: Record<string, unknown>;
  cv: Record<string, unknown>;
  trainMs: number;
}

export interface Exemplar { answer: string; fractions: Record<string, number>; total: number; level: string; redFlagsFired: string[]; vec?: SparseVec }

export interface ScoredCheckpoint extends CheckpointJudgement { lr: number; knn: number; exemplar: number | null }
export interface ScoredFlag { flag: string; prob: number; fired: boolean; evidence: { start: number; end: number; text: string } | null; rule: string | null }

export interface ScoreOutput {
  checkpoints: ScoredCheckpoint[];
  flags: ScoredFlag[];
  redFlagsFired: string[];
  rawTotal: number;
  total: number;
  confidence: number;
  confidenceParts: Record<string, number>;
  answerLevel: AnswerLevel;
  isTemplate: boolean;
  exemplarSim: number | null;
  lowConfidenceReasons: string[];
}

/* ───────────── item context cache ───────────── */

const ctxCache = new Map<string, { version: number; ctx: ItemContext }>();

export function itemContext(item: JudgeItem, model: Pick<HiveModel, 'lexicon' | 'version'>, cacheKey?: string): ItemContext {
  const key = cacheKey ?? null;
  if (key) {
    const hit = ctxCache.get(key);
    if (hit && hit.version === model.version) return hit.ctx;
  }
  const ctx = buildItemContext(item, model.lexicon);
  if (key) {
    if (ctxCache.size > 2000) ctxCache.clear();
    ctxCache.set(key, { version: model.version, ctx });
  }
  return ctx;
}

/* ───────────── raw predictions ───────────── */

export function cpRaw(cp: CpModel, x: number[], excludeKnn?: (i: number) => boolean) {
  const lr = predictLogistic(cp.logistic, x);
  const k = excludeKnn ? predictKnnExcluding(cp.knn, x, excludeKnn) : predictKnn(cp.knn, x);
  return { lr, knn: k.value, meanDist: k.meanDist, raw: cp.wLogistic * lr + (1 - cp.wLogistic) * k.value };
}

function predictKnnExcluding(m: Knn, x: number[], exclude: (i: number) => boolean) {
  const sub: Knn = { ...m, X: [], y: [] };
  m.X.forEach((r, i) => { if (!exclude(i)) { sub.X.push(r); sub.y.push(m.y[i]!); } });
  return predictKnn(sub, x);
}

export function calibrate(cp: CpModel, raw: number, taskType: string): number {
  const iso = cp.isoByTaskType[taskType] ?? cp.isoGlobal;
  return clamp01(predictIsotonic(iso, raw));
}

/* ───────────── exemplars ───────────── */

export function exemplarsFromCalibration(cals: CalExample[], item: JudgeItem): Exemplar[] {
  return cals.map((c) => ({
    answer: c.answer, total: c.total, level: c.level, redFlagsFired: c.redFlagsFired,
    fractions: Object.fromEntries(item.rubric.map((cp) => [cp.id, clamp01((c.scores[cp.id] ?? 0) / (cp.points || 1))])),
  }));
}

function exemplarBlend(model: HiveModel, a: AnswerAnalysis, exemplars: Exemplar[]) {
  if (!exemplars.length || model.exemplar.alphaMax <= 0) return null;
  const sims = exemplars.map((e) => { e.vec ??= vec(e.answer, model.lexicon.idf); return cos(a.vec, e.vec); });
  const maxSim = Math.max(...sims);
  const { tau, sim0, span, alphaMax } = model.exemplar;
  const ws = sims.map((s) => Math.exp((s - maxSim) / tau));
  const wsum = ws.reduce((p, q) => p + q, 0) || 1;
  const alpha = clamp01((maxSim - sim0) / span) * alphaMax;
  return {
    alpha, maxSim,
    fraction: (cpId: string) => exemplars.reduce((s, e, i) => s + ws[i]! * (e.fractions[cpId] ?? 0), 0) / wsum,
    flagged: exemplars.reduce((s, e, i) => s + ws[i]! * (e.redFlagsFired.length ? 1 : 0), 0) / wsum,
  };
}

/* ───────────── scoring ───────────── */

const RULE_INJECTION = 0.45;

export function scoreAnswer(model: HiveModel, item: JudgeItem, answer: string, opts: { exemplars?: Exemplar[]; cacheKey?: string; ctx?: ItemContext } = {}): ScoreOutput {
  const ctx = opts.ctx ?? itemContext(item, model, opts.cacheKey);
  const a = analyseAnswer(answer, model.lexicon);
  const al = answerLevel(ctx, a, model.lexicon);
  const ex = exemplarBlend(model, a, opts.exemplars ?? []);
  const reasons: string[] = [];

  let agreeSum = 0, distSum = 0, wsum = 0;
  const checkpoints: ScoredCheckpoint[] = ctx.cps.map((c, i) => {
    const f = checkpointFeatures(ctx, i, a, al);
    const r = cpRaw(model.cp, f.x);
    let fraction = calibrate(model.cp, r.raw, item.taskType);
    let exFrac: number | null = null;
    if (ex) { exFrac = ex.fraction(c.cp.id); fraction = (1 - ex.alpha) * fraction + ex.alpha * exFrac; }
    if (al.refusal) fraction = Math.min(fraction, 0.05);
    const w = c.cp.points;
    agreeSum += w * Math.abs(r.lr - r.knn); distSum += w * r.meanDist; wsum += w;
    const evidence = f.bestWins.slice(0, 2).map((j) => ({ start: a.wins[j]!.start, end: a.wins[j]!.end, text: a.wins[j]!.text.slice(0, 600) }));
    const pts = round(fraction * c.cp.points, 2);
    const reason = explain(fraction, f.sims, f.matched, f.missing, ctx.hasRef);
    return { id: c.cp.id, points: pts, max: c.cp.points, fraction: round(fraction, 4), evidence, reason, matchedTerms: f.matched, missingTerms: f.missing, lr: round(r.lr), knn: round(r.knn), exemplar: exFrac === null ? null : round(exFrac) };
  });

  // red flags: learned classifier + hard rules (obeying injected instructions, unnegated dangerous advice listed in the flags)
  const flags: ScoredFlag[] = ctx.flags.map((fl, i) => {
    const rf = redFlagFeatures(ctx, i, a, al);
    let prob = predictLogistic(model.rf.logistic, rf.x);
    let rule: string | null = null;
    if (fl.inj && al.injObey >= RULE_INJECTION && !al.aware) { prob = Math.max(prob, 0.99); rule = 'obeys the instruction injected in the case material'; }
    if (ex && ex.alpha > 0.3 && ex.flagged > 0.7) prob = Math.max(prob, 0.5 * prob + 0.5 * ex.flagged);
    const fired = prob >= model.rf.threshold;
    const evidence = rf.bestWin !== null ? { start: a.wins[rf.bestWin]!.start, end: a.wins[rf.bestWin]!.end, text: a.wins[rf.bestWin]!.text.slice(0, 600) } : null;
    return { flag: fl.text, prob: round(prob), fired, evidence, rule };
  });
  // injection obeyed but the question defines no injection flag → still a red flag (platform rule: injected instructions are never obeyed)
  if (!ctx.flags.some((f) => f.inj) && ctx.injTerms.size && al.injObey >= RULE_INJECTION && !al.aware) {
    flags.push({ flag: 'Follows instructions injected into the case material', prob: 0.99, fired: true, evidence: null, rule: 'obeys the instruction injected in the case material' });
  }
  const redFlagsFired = flags.filter((f) => f.fired).map((f) => f.flag);
  const rawTotal = checkpoints.reduce((s, c) => s + c.points, 0) / (ctx.totalPoints || 1) * 100;
  const total = redFlagsFired.length ? 0 : round(rawTotal, 1);

  // confidence
  const agree = clamp01(1 - (wsum ? agreeSum / wsum : 0) * 2.5);
  const meanDist = wsum ? distSum / wsum : 5;
  const supportD = clamp01(1 - (meanDist - 1.5) / 4);
  const nDomain = model.support.domains[item.domainSlug ?? item.domain] ?? 0;
  const domainCal = clamp01(nDomain / 60);
  const exScore = ex ? clamp01((ex.maxSim - 0.2) / 0.5) : 0;
  const rfAmbig = flags.some((f) => Math.abs(f.prob - model.rf.threshold) < 0.12 && !f.rule) ? 1 : 0;
  let confidence = 0.35 * agree + 0.2 * supportD + 0.25 * domainCal + 0.2 * exScore;
  if (ctx.isTemplate) { confidence *= 0.7; reasons.push('template question (generic rubric, no reference solution)'); }
  if (!ctx.hasRef && !ctx.isTemplate) { confidence *= 0.85; reasons.push('no reference solution'); }
  if (rfAmbig) { confidence *= 0.8; reasons.push('a red flag is borderline'); }
  if (agree < 0.6) reasons.push('the scorer models disagree on some checkpoints');
  if (domainCal < 0.3) reasons.push('little calibration data for this domain');
  if (supportD < 0.4) reasons.push('answer is unlike the calibration answers');
  if (a.words > 2500) { confidence *= 0.85; reasons.push('very long answer'); }
  confidence = round(clamp01(confidence), 3);

  return {
    checkpoints, flags, redFlagsFired, rawTotal: round(rawTotal, 1), total, confidence,
    confidenceParts: { agree: round(agree, 3), support: round(supportD, 3), domainCalibration: round(domainCal, 3), exemplar: round(exScore, 3), borderlineRedFlag: rfAmbig },
    answerLevel: al, isTemplate: ctx.isTemplate, exemplarSim: ex ? round(ex.maxSim, 3) : null, lowConfidenceReasons: reasons,
  };
}

function explain(fraction: number, sims: { crit: number; ref: number }, matched: string[], missing: string[], hasRef: boolean): string {
  const lvl = fraction >= 0.75 ? 'Clearly demonstrated' : fraction >= 0.45 ? 'Partly demonstrated' : fraction >= 0.15 ? 'Weak evidence' : 'Not demonstrated';
  const parts = [`${lvl} (best passage similarity ${sims.crit.toFixed(2)} to the checkpoint${hasRef ? `, ${sims.ref.toFixed(2)} to the reference` : ''}).`];
  // owner-safe: only quotes words from the answer itself; rubric terms that were NOT found stay admin-only (missingTerms)
  if (matched.length) parts.push(`Specific terms found in the answer: ${matched.slice(0, 6).join(', ')}.`);
  else if (missing.length && fraction < 0.45) parts.push('The answer does not name the case-specific points this checkpoint looks for.');
  return parts.join(' ');
}

export { CP_FEATURES, RF_FEATURES };
