/**
 * Hive Judge — training + honest evaluation.
 *
 *  1. Lexicon (idf + per-domain distinctive vocabulary) from QUESTION-side text only (case material, tasks, reference
 *     solutions, rubrics, traps, bank items). Calibration answers never feed the lexicon → no leakage into CV.
 *  2. Features per (answer, checkpoint) and per (answer, red flag); labels = expected points ÷ max points, and
 *     expected red flags.
 *  3. Grouped K-fold cross-validation BY QUESTION (all answers of a scenario are held out together): every metric is
 *     computed on answers to questions the fold model has never seen.
 *  4. Same-question exemplar mode is evaluated separately (leave-one-answer-out on calibrated questions).
 *  5. Final model = fit on all data; red-flag threshold and exemplar blend come from the out-of-fold predictions.
 */
import {
  CP_FEATURES, RF_FEATURES, analyseAnswer, answerLevel, buildItemContext, checkpointFeatures, normaliseFiredFlags, redFlagFeatures,
  type Lexicon,
} from './features.js';
import { fitIsotonic, fitKnn, fitLogistic, groupFolds, predictLogistic, roundArr, type Isotonic, type Logistic } from './model.js';
import { calibrate, cpRaw, scoreAnswer, type CpModel, type HiveModel, type RfModel, type ScoreOutput } from './scorer.js';
import { buildIdf, clamp01, contentTokens, cos, round, vec } from './text.js';
import type { CalExample, JudgeItem } from './types.js';

export const DEFAULT_SEED = 20261117;

/* ───────────── lexicon ───────────── */

const itemDoc = (it: JudgeItem) => [it.caseMaterial, it.task, it.referenceSolution, it.subtopic, ...it.rubric.map((c) => `${c.criterion} ${c.evidence_of_success ?? ''}`), ...it.traps, ...it.expectedElements, ...it.redFlags].join('\n');

export function buildLexicon(items: JudgeItem[]): Lexicon {
  const seen = new Set<string>();
  const uniq = items.filter((i) => (seen.has(i.key) ? false : (seen.add(i.key), true)));
  const docs = uniq.map(itemDoc);
  const idf = buildIdf(docs, 2);
  // distinctive vocabulary per domain: p(t | domain) / p(t), df within the domain ≥ 2
  const byDomain = new Map<string, Set<string>[]>();
  uniq.forEach((it, i) => {
    const k = it.domainSlug ?? it.domain;
    if (!k) return;
    const arr = byDomain.get(k) ?? [];
    arr.push(new Set(contentTokens(docs[i]!)));
    byDomain.set(k, arr);
  });
  const dfAll = new Map<string, number>();
  for (const sets of byDomain.values()) for (const s of sets) for (const t of s) dfAll.set(t, (dfAll.get(t) ?? 0) + 1);
  const N = [...byDomain.values()].reduce((s, a) => s + a.length, 0) || 1;
  const domainVocab: Record<string, string[]> = {};
  for (const [d, sets] of byDomain) {
    const df = new Map<string, number>();
    for (const s of sets) for (const t of s) df.set(t, (df.get(t) ?? 0) + 1);
    const Nd = sets.length;
    const minDf = Nd >= 6 ? 2 : 1;
    domainVocab[d] = [...df.entries()]
      .filter(([t, c]) => c >= minDf && t.length > 2)
      .map(([t, c]) => ({ t, s: ((c + 0.5) / (Nd + 1)) / (((dfAll.get(t) ?? 0) + 0.5) / (N + 1)) }))
      .filter((x) => x.s >= (byDomain.size > 1 ? 2 : 0))
      .sort((a, b) => b.s - a.s).slice(0, 400).map((x) => x.t);
  }
  return { idf, domainVocab };
}

/* ───────────── featurisation ───────────── */

interface CpRow { x: number[]; y: number; w: number; group: string; taskType: string; ex: number }
interface RfRow { x: number[]; y: number; w: number; group: string; ex: number }

const PROVENANCE_WEIGHT: Record<string, number> = { human_authored: 3, human_verified: 2, synthetic: 1 };

export function featurise(examples: CalExample[], lex: Lexicon) {
  const cp: CpRow[] = [];
  const rf: RfRow[] = [];
  const ctxs = new Map<string, ReturnType<typeof buildItemContext>>();
  examples.forEach((e, ex) => {
    let ctx = ctxs.get(e.item.key);
    if (!ctx) { ctx = buildItemContext(e.item, lex); ctxs.set(e.item.key, ctx); }
    const a = analyseAnswer(e.answer, lex);
    const al = answerLevel(ctx, a, lex);
    const pw = PROVENANCE_WEIGHT[e.provenance] ?? 1;
    const avgPts = ctx.totalPoints / Math.max(1, ctx.cps.length);
    ctx.cps.forEach((c, i) => {
      const s = e.scores[c.cp.id];
      if (s === undefined || !Number.isFinite(s)) return;
      const f = checkpointFeatures(ctx!, i, a, al);
      cp.push({ x: f.x, y: clamp01(s / (c.cp.points || 1)), w: pw * Math.sqrt(c.cp.points / (avgPts || 1)), group: e.item.key, taskType: e.item.taskType, ex });
    });
    const fired = new Set(normaliseFiredFlags(e.redFlagsFired, e.item.redFlags, lex.idf));
    ctx.flags.forEach((fl, i) => {
      rf.push({ x: redFlagFeatures(ctx!, i, a, al).x, y: fired.has(fl.text) ? 1 : 0, w: pw, group: e.item.key, ex });
    });
  });
  return { cp, rf };
}

/* ───────────── fitting ───────────── */

function fitCp(rows: CpRow[], wLogistic = 0.5): CpModel {
  const X = rows.map((r) => r.x), y = rows.map((r) => r.y), w = rows.map((r) => r.w);
  const logistic = fitLogistic(X, y, { weights: w, l2: 0.02, iters: 500, lr: 0.05 });
  const knn = fitKnn(X, y, 15, 1500);
  // in-sample raw ensemble with kNN neighbours from the SAME question excluded (mimics an unseen question)
  const knnGroups = sampleGroups(rows, knn.X.length);
  const base: CpModel = { logistic, knn, wLogistic, isoGlobal: { xs: [], ys: [] }, isoByTaskType: {} };
  const raws = rows.map((r) => cpRaw(base, r.x, (i) => knnGroups[i] === r.group).raw);
  base.isoGlobal = fitIsotonic(raws, y, w);
  const byType = new Map<string, number[]>();
  rows.forEach((r, i) => { const a = byType.get(r.taskType) ?? []; a.push(i); byType.set(r.taskType, a); });
  for (const [t, idx] of byType) {
    if (idx.length < 60 || new Set(idx.map((i) => rows[i]!.group)).size < 5) continue;
    // shrink toward the global calibration: per-type isotonic fit on a 50/50 mix of type rows and global predictions
    const xs = idx.map((i) => raws[i]!), ys = idx.map((i) => rows[i]!.y), ws = idx.map((i) => rows[i]!.w);
    base.isoByTaskType[t] = fitIsotonic([...xs, ...xs], [...ys, ...xs.map((v) => calibrate(base, v, '__global__'))], [...ws, ...ws]);
  }
  base.isoGlobal = compactIso(base.isoGlobal);
  for (const k of Object.keys(base.isoByTaskType)) base.isoByTaskType[k] = compactIso(base.isoByTaskType[k]!);
  return base;
}

/** fitKnn subsamples rows evenly; reproduce the same subsampling for the group labels. */
function sampleGroups(rows: CpRow[], kept: number): string[] {
  if (rows.length <= kept) return rows.map((r) => r.group);
  const step = rows.length / kept;
  return Array.from({ length: kept }, (_, i) => rows[Math.floor(i * step)]!.group);
}

const compactIso = (m: Isotonic): Isotonic => ({ xs: roundArr(m.xs, 5), ys: roundArr(m.ys, 5) });

function answerFlagProbs(rows: RfRow[], logistic: Logistic) {
  const byEx = new Map<number, { p: number; y: number }>();
  for (const r of rows) {
    const p = predictLogistic(logistic, r.x);
    const cur = byEx.get(r.ex) ?? { p: 0, y: 0 };
    byEx.set(r.ex, { p: Math.max(cur.p, p), y: Math.max(cur.y, r.y) });
  }
  return [...byEx.values()];
}

/** Lowest-false-positive threshold that keeps answer-level red-flag recall ≥ target (F2 as tie-break). */
export function selectThreshold(pairs: { p: number; y: number }[], targetRecall = 0.95): number {
  const pos = pairs.filter((x) => x.y === 1).length;
  if (!pos) return 0.6;
  let best = { t: 0.5, score: -1 };
  for (let t = 0.5; t <= 0.951; t += 0.01) {
    const tp = pairs.filter((x) => x.y === 1 && x.p >= t).length;
    const fp = pairs.filter((x) => x.y === 0 && x.p >= t).length;
    const recall = tp / pos, precision = tp + fp ? tp / (tp + fp) : 1;
    const f2 = recall + precision ? (5 * precision * recall) / (4 * precision + recall) : 0;
    const score = (recall >= targetRecall ? 1 : 0) + f2;
    if (score > best.score + 1e-9) best = { t: round(t, 2), score };
  }
  return best.t;
}

function fitRf(rows: RfRow[]): RfModel {
  if (!rows.length) return { logistic: { w: new Array(RF_FEATURES.length).fill(0), b: -4, scaler: { mean: new Array(RF_FEATURES.length).fill(0), std: new Array(RF_FEATURES.length).fill(1) } }, threshold: 0.6 };
  const pos = rows.filter((r) => r.y === 1).length;
  const ratio = pos ? Math.min(6, (rows.length - pos) / pos) : 1;
  const logistic = fitLogistic(rows.map((r) => r.x), rows.map((r) => r.y), { weights: rows.map((r) => r.w * (r.y ? ratio : 1)), l2: 0.05, iters: 500 });
  return { logistic, threshold: selectThreshold(answerFlagProbs(rows, logistic), 0.97) };
}

function supportOf(examples: CalExample[]) {
  const domains: Record<string, number> = {}, taskTypes: Record<string, number> = {};
  for (const e of examples) {
    const d = e.item.domainSlug ?? e.item.domain;
    domains[d] = (domains[d] ?? 0) + 1;
    taskTypes[e.item.taskType] = (taskTypes[e.item.taskType] ?? 0) + 1;
  }
  return { domains, taskTypes, total: examples.length };
}

function assemble(lex: Lexicon, cp: CpModel, rf: RfModel, examples: CalExample[], seed: number, version: number): HiveModel {
  return {
    kind: 'hive-judge-scorer', version, trainedAt: new Date().toISOString(), seed, featureNames: [...CP_FEATURES], rfFeatureNames: [...RF_FEATURES],
    lexicon: lex, cp, rf, exemplar: { sim0: 0.2, span: 0.5, alphaMax: 0.5, tau: 0.04 }, support: supportOf(examples), data: {}, cv: {}, trainMs: 0,
  };
}

/* ───────────── metrics ───────────── */

export const LEVEL_RANK: Record<string, number> = { expert: 4, competent_missed_trap: 3, competent: 3, generic: 2, confidently_wrong: 1, unsafe: 1, wrong: 1 };

export interface Pred { total: number; fired: boolean; fractions: Record<string, number>; confidence: number }

export interface MetricBlock {
  answers: number; questions: number; mae: number | null; within10: number | null; checkpointMae: number | null;
  rankPairs: number; rankOrderAccuracy: number | null; levelPairs: number; levelOrderAccuracy: number | null; levelChainAccuracy: number | null;
  redFlagRecall: number | null; redFlagAnswers: number; unsafeRecall: number | null; redFlagFalsePositiveOnExpert: number | null;
  genericAnswers: number; genericAtMost45: number | null; meanConfidence: number | null; confidenceErrorCorrelation: number | null;
  byLevel: Record<string, { n: number; meanExpected: number; meanPredicted: number }>;
}

function spearman(a: number[], b: number[]) {
  if (a.length < 3) return null;
  const rank = (v: number[]) => { const idx = v.map((x, i) => ({ x, i })).sort((p, q) => p.x - q.x); const r = new Array(v.length); idx.forEach((o, k) => { r[o.i] = k; }); return r as number[]; };
  const ra = rank(a), rb = rank(b), n = a.length;
  const ma = ra.reduce((s, x) => s + x, 0) / n, mb = rb.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (ra[i]! - ma) * (rb[i]! - mb); da += (ra[i]! - ma) ** 2; db += (rb[i]! - mb) ** 2; }
  return da && db ? round(num / Math.sqrt(da * db), 3) : null;
}

export function computeMetrics(examples: CalExample[], preds: Pred[]): MetricBlock {
  const n = examples.length;
  const pct = (x: number, d: number) => (d ? round((100 * x) / d, 1) : null);
  let ae = 0, w10 = 0, cpErr = 0, cpN = 0;
  const errs: number[] = [], confs: number[] = [];
  const byLevel: MetricBlock['byLevel'] = {};
  examples.forEach((e, i) => {
    const p = preds[i]!;
    const err = Math.abs(p.total - e.total);
    ae += err; if (err <= 10) w10++;
    errs.push(err); confs.push(p.confidence);
    for (const c of e.item.rubric) {
      const s = e.scores[c.id];
      if (s === undefined) continue;
      cpErr += Math.abs((p.fractions[c.id] ?? 0) - clamp01(s / (c.points || 1))); cpN++;
    }
    const b = byLevel[e.level] ?? { n: 0, meanExpected: 0, meanPredicted: 0 };
    b.n++; b.meanExpected += e.total; b.meanPredicted += p.total; byLevel[e.level] = b;
  });
  for (const b of Object.values(byLevel)) { b.meanExpected = round(b.meanExpected / b.n, 1); b.meanPredicted = round(b.meanPredicted / b.n, 1); }
  // pairwise ordering within each question
  const byQ = new Map<string, number[]>();
  examples.forEach((e, i) => { const a = byQ.get(e.item.key) ?? []; a.push(i); byQ.set(e.item.key, a); });
  let rp = 0, rc = 0, lp = 0, lc = 0, chains = 0, chainOk = 0;
  for (const idx of byQ.values()) {
    for (let x = 0; x < idx.length; x++) for (let y = x + 1; y < idx.length; y++) {
      const i = idx[x]!, j = idx[y]!;
      const de = examples[i]!.total - examples[j]!.total, dp = preds[i]!.total - preds[j]!.total;
      if (Math.abs(de) >= 10) { rp++; rc += dp === 0 ? 0.5 : Math.sign(dp) === Math.sign(de) ? 1 : 0; }
      const li = LEVEL_RANK[examples[i]!.level], lj = LEVEL_RANK[examples[j]!.level];
      if (li !== undefined && lj !== undefined && li !== lj) {
        lp++;
        const want = Math.sign(li - lj);
        lc += dp === 0 ? 0.5 : Math.sign(dp) === want ? 1 : 0;
      }
    }
    // chain: expert > competent > generic > every wrong/unsafe answer
    const get = (lvl: number) => idx.filter((i) => LEVEL_RANK[examples[i]!.level] === lvl).map((i) => preds[i]!.total);
    const L4 = get(4), L3 = get(3), L2 = get(2), L1 = get(1);
    if (L4.length && L3.length && L2.length && L1.length) {
      chains++;
      if (Math.min(...L4) > Math.max(...L3) && Math.min(...L3) > Math.max(...L2) && Math.min(...L2) > Math.max(...L1)) chainOk++;
    }
  }
  const flagged = examples.map((e, i) => ({ e, p: preds[i]! })).filter((x) => x.e.redFlagsFired.length > 0);
  const unsafe = examples.map((e, i) => ({ e, p: preds[i]! })).filter((x) => x.e.level === 'unsafe');
  const experts = examples.map((e, i) => ({ e, p: preds[i]! })).filter((x) => x.e.level === 'expert' && !x.e.redFlagsFired.length);
  const generic = examples.map((e, i) => ({ e, p: preds[i]! })).filter((x) => x.e.level === 'generic');
  return {
    answers: n, questions: byQ.size, mae: n ? round(ae / n, 2) : null, within10: pct(w10, n), checkpointMae: cpN ? round(cpErr / cpN, 3) : null,
    rankPairs: rp, rankOrderAccuracy: pct(rc, rp), levelPairs: lp, levelOrderAccuracy: pct(lc, lp), levelChainAccuracy: chains ? pct(chainOk, chains) : null,
    redFlagAnswers: flagged.length, redFlagRecall: pct(flagged.filter((x) => x.p.fired).length, flagged.length),
    unsafeRecall: pct(unsafe.filter((x) => x.p.fired || x.p.total <= 10).length, unsafe.length),
    redFlagFalsePositiveOnExpert: pct(experts.filter((x) => x.p.fired).length, experts.length),
    genericAnswers: generic.length, genericAtMost45: pct(generic.filter((x) => x.p.total <= 45).length, generic.length),
    meanConfidence: n ? round(confs.reduce((s, x) => s + x, 0) / n, 3) : null,
    // negative = higher confidence goes with lower error (what we want)
    confidenceErrorCorrelation: spearman(confs, errs),
    byLevel,
  };
}

const predOf = (s: ScoreOutput): Pred => ({ total: s.total, fired: s.redFlagsFired.length > 0, fractions: Object.fromEntries(s.checkpoints.map((c) => [c.id, c.fraction])), confidence: s.confidence });

/* ───────────── main entry ───────────── */

export interface TrainOptions { seed?: number; folds?: number; version?: number; corpus?: JudgeItem[]; skipCv?: boolean }

export interface TrainResult { model: HiveModel; oof: ScoreOutput[] | null }

export function trainHiveJudge(examplesIn: CalExample[], opts: TrainOptions = {}): TrainResult {
  const t0 = Date.now();
  const seed = opts.seed ?? DEFAULT_SEED;
  // stable order → reproducible
  const examples = [...examplesIn].sort((a, b) => (a.item.key + a.id < b.item.key + b.id ? -1 : 1));
  const items = [...examples.map((e) => e.item), ...(opts.corpus ?? [])];
  const lex = buildLexicon(items);
  const feats = featurise(examples, lex);
  const groups = [...new Set(examples.map((e) => e.item.key))];
  const k = Math.min(opts.folds ?? 5, groups.length);

  let oof: ScoreOutput[] | null = null;
  let cv: Record<string, unknown> = { note: 'not enough distinct questions for cross-validation (need ≥ 3)' };
  let rfThreshold: number | null = null;
  let exemplarParams = { sim0: 0.2, span: 0.5, alphaMax: 0.5, tau: 0.04 };
  if (!opts.skipCv && k >= 3 && feats.cp.length) {
    const fold = groupFolds(examples.map((e) => e.item.key), k, seed);
    oof = new Array(examples.length);
    const rfOof: { p: number; y: number }[] = [];
    for (let f = 0; f < k; f++) {
      const trainEx = new Set(examples.map((e, i) => (fold.get(e.item.key) !== f ? i : -1)).filter((i) => i >= 0));
      const cpRows = feats.cp.filter((r) => trainEx.has(r.ex));
      const rfRows = feats.rf.filter((r) => trainEx.has(r.ex));
      if (!cpRows.length) continue;
      const m = assemble(lex, fitCp(cpRows), fitRf(rfRows), examples.filter((_, i) => trainEx.has(i)), seed, -1 - f);
      m.exemplar.alphaMax = 0;
      examples.forEach((e, i) => {
        if (trainEx.has(i)) return;
        const s = scoreAnswer(m, e.item, e.answer, { cacheKey: `cv:${f}:${e.item.key}` });
        oof![i] = s;
        const maxP = Math.max(0, ...s.flags.filter((x) => !x.rule).map((x) => x.prob));
        const ruleFired = s.flags.some((x) => x.rule && x.fired);
        rfOof.push({ p: ruleFired ? 1 : maxP, y: e.redFlagsFired.length ? 1 : 0 });
      });
    }
    // red-flag threshold from out-of-fold probabilities (recall-first), applied to the OOF predictions for reporting
    rfThreshold = selectThreshold(rfOof, 0.95);
    examples.forEach((e, i) => {
      const s = oof![i];
      if (!s) return;
      for (const fl of s.flags) if (!fl.rule) fl.fired = fl.prob >= rfThreshold!;
      s.redFlagsFired = s.flags.filter((x) => x.fired).map((x) => x.flag);
      s.total = s.redFlagsFired.length ? 0 : s.rawTotal;
    });
    const valid = examples.map((e, i) => ({ e, s: oof![i] })).filter((x) => x.s);
    const overall = computeMetrics(valid.map((x) => x.e), valid.map((x) => predOf(x.s!)));
    const byDomain: Record<string, MetricBlock> = {};
    const byMode: Record<string, MetricBlock> = {};
    const bySource: Record<string, MetricBlock> = {};
    const groupBy = (key: (e: CalExample) => string, out: Record<string, MetricBlock>) => {
      const m = new Map<string, number[]>();
      valid.forEach((x, i) => { const kk = key(x.e); const a = m.get(kk) ?? []; a.push(i); m.set(kk, a); });
      for (const [kk, idx] of m) out[kk] = computeMetrics(idx.map((i) => valid[i]!.e), idx.map((i) => predOf(valid[i]!.s!)));
    };
    groupBy((e) => e.item.domainSlug ?? e.item.domain, byDomain);
    groupBy((e) => (e.item.gradingMode === 'template_rubric' ? 'template' : 'case'), byMode);
    groupBy((e) => e.item.source, bySource);

    // exemplar mode (question already has calibration answers): leave-one-answer-out over OOF scores, small grid
    const exEval = evaluateExemplarMode(examples, oof, lex);
    exemplarParams = exEval.best;
    cv = {
      method: `grouped ${k}-fold cross-validation by question (seed ${seed}); answers to a held-out question are never seen in training`,
      folds: k, redFlagThreshold: rfThreshold, overall, byDomain, byGradingMode: byMode, bySource,
      exemplarMode: exEval.metrics, exemplarParams,
    };
  }

  const final = assemble(lex, fitCp(feats.cp), fitRf(feats.rf), examples, seed, opts.version ?? 1);
  if (rfThreshold !== null) final.rf.threshold = rfThreshold;
  final.exemplar = exemplarParams;
  final.cv = cv;
  final.data = dataCounts(examples);
  final.trainMs = Date.now() - t0;
  return { model: final, oof };
}

function evaluateExemplarMode(examples: CalExample[], oof: (ScoreOutput | undefined)[], lex: Lexicon) {
  const byQ = new Map<string, number[]>();
  examples.forEach((e, i) => { if (oof[i]) { const a = byQ.get(e.item.key) ?? []; a.push(i); byQ.set(e.item.key, a); } });
  const vecs = examples.map((e) => vec(e.answer, lex.idf));
  const eligible = [...byQ.values()].filter((a) => a.length >= 3).flat();
  const grid: { sim0: number; span: number; alphaMax: number; tau: number }[] = [];
  for (const alphaMax of [0, 0.3, 0.5, 0.7]) for (const tau of [0.03, 0.08]) grid.push({ sim0: 0.2, span: 0.5, alphaMax, tau });
  const run = (g: typeof grid[number]) => {
    const preds: Pred[] = [];
    for (const i of eligible) {
      const e = examples[i]!, s = oof[i]!;
      const others = byQ.get(e.item.key)!.filter((j) => j !== i);
      const sims = others.map((j) => cos(vecs[i]!, vecs[j]!));
      const maxSim = Math.max(...sims);
      const ws = sims.map((x) => Math.exp((x - maxSim) / g.tau));
      const wsum = ws.reduce((p, q) => p + q, 0) || 1;
      const alpha = clamp01((maxSim - g.sim0) / g.span) * g.alphaMax;
      const fractions: Record<string, number> = {};
      let pts = 0;
      for (const c of e.item.rubric) {
        const exF = others.reduce((acc, j, k) => acc + ws[k]! * clamp01((examples[j]!.scores[c.id] ?? 0) / (c.points || 1)), 0) / wsum;
        const own = s.checkpoints.find((x) => x.id === c.id)?.fraction ?? 0;
        fractions[c.id] = (1 - alpha) * own + alpha * exF;
        pts += fractions[c.id]! * c.points;
      }
      const tot = e.item.rubric.reduce((a, c) => a + c.points, 0) || 1;
      const fired = s.redFlagsFired.length > 0;
      preds.push({ total: fired ? 0 : round((pts / tot) * 100, 1), fired, fractions, confidence: s.confidence });
    }
    return computeMetrics(eligible.map((i) => examples[i]!), preds);
  };
  let best = grid[0]!, bestM = run(best);
  for (const g of grid.slice(1)) {
    const m = run(g);
    if ((m.mae ?? 1e9) < (bestM.mae ?? 1e9) - 0.05) { best = g; bestM = m; }
  }
  return {
    best,
    metrics: { method: 'leave-one-answer-out on questions with ≥ 3 calibration answers (OOF scorer + same-question exemplar kNN); blend chosen on the same data from a 8-point grid, so slightly optimistic', params: best, ...bestM },
  };
}

function dataCounts(examples: CalExample[]) {
  const byProvenance: Record<string, number> = {}, byLevel: Record<string, number> = {}, bySource: Record<string, number> = {};
  for (const e of examples) {
    byProvenance[e.provenance] = (byProvenance[e.provenance] ?? 0) + 1;
    byLevel[e.level] = (byLevel[e.level] ?? 0) + 1;
    bySource[e.item.source] = (bySource[e.item.source] ?? 0) + 1;
  }
  return {
    answers: examples.length, questions: new Set(examples.map((e) => e.item.key)).size, byProvenance, byLevel, bySource,
    synthetic: byProvenance.synthetic ?? 0, humanVerified: (byProvenance.human_verified ?? 0) + (byProvenance.human_authored ?? 0),
  };
}
