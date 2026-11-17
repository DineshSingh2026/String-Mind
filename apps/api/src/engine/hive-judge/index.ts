/**
 * Hive Judge — tiered local judge: deterministic → local scorer (always on) → optional local LLM → optional admin review.
 */
import type { JudgeInput, JudgeResult } from '../pro-judge.js';
import { runChecks } from './deterministic.js';
import { itemFromInput, loadCalibrationExamples, loadCorpus, loadExemplars, loadQuestion, loadSeed } from './data.js';
import { llmJudge, llmModelName } from './llm.js';
import { createReview, openedToday, resetResolutionsCount, type RefKind } from './review.js';
import { exemplarsFromCalibration, scoreAnswer, type HiveModel } from './scorer.js';
import { cachedModel, getSettings, loadModel, saveModel } from './store.js';
import { trainHiveJudge } from './train.js';
import type { CalExample } from './types.js';

export type HiveJudgeInput = JudgeInput & {
  refKind?: RefKind; refId?: string; questionId?: string; domainSlug?: string;
  deterministicChecks?: Record<string, unknown>[]; expectedElements?: string[];
};

let training: Promise<HiveModel> | null = null;

/** Train (seed + DB calibration answers, DB bank as lexicon corpus) and persist a new model version. */
export function trainAndSave(opts: { seed?: number } = {}): Promise<HiveModel> {
  training ??= (async () => {
    try {
      const seed = loadSeed();
      let dbEx: CalExample[] = [];
      let corpus = seed.items;
      try { dbEx = await loadCalibrationExamples(); corpus = [...seed.items, ...(await loadCorpus())]; } catch { /* db unavailable → seed only */ }
      const prev = cachedModel() ?? await loadModel().catch(() => null);
      const { model } = trainHiveJudge([...seed.examples, ...dbEx], { seed: opts.seed, corpus, version: (prev?.version ?? 0) + 1 });
      await saveModel(model).catch(() => undefined);
      resetResolutionsCount();
      return model;
    } finally { training = null; }
  })();
  return training;
}

export async function ensureModel(): Promise<HiveModel> {
  return cachedModel() ?? (await loadModel().catch(() => null)) ?? trainAndSave();
}

const exemplarCache = new Map<string, { at: number; ex: CalExample[] }>();

export async function hiveJudge(input: HiveJudgeInput): Promise<JudgeResult> {
  const model = await ensureModel();
  const name = `hive-judge:v${model.version}`;
  const q = input.questionId ? await loadQuestion(input.questionId).catch(() => null) : null;
  const item = itemFromInput(input, q);
  const none = (status: JudgeResult['status'], rationale: string, error?: string): JudgeResult => ({ status, scores: {}, total: 0, redFlagsFired: [], rationale, model: name, ...(error ? { error } : {}) });

  // tier 1: deterministic
  const checks = runChecks(item.deterministicChecks, input.answer);
  if (!item.rubric.length) {
    const g = checks.filter((c) => c.status === 'passed' || c.status === 'failed');
    if (!g.length) return none('error', 'The question has no rubric checkpoints to judge against.', 'empty_rubric');
    const total = Math.round((100 * g.filter((c) => c.status === 'passed').length) / g.length * 10) / 10;
    return { status: 'done', scores: {}, total, redFlagsFired: [], rationale: g.map((c) => `${c.type}: ${c.status}`).join('; '), model: name, confidence: 1, tier: 'deterministic' };
  }
  if (!input.answer.trim()) {
    return { status: 'done', scores: Object.fromEntries(item.rubric.map((c) => [c.id, 0])), total: 0, redFlagsFired: [], rationale: 'The answer was empty.', model: name, confidence: 1, tier: 'deterministic' };
  }

  // tier 2: local scorer (+ same-question exemplars)
  let exemplars: CalExample[] = [];
  if (q) {
    const hit = exemplarCache.get(q.id);
    if (hit && Date.now() - hit.at < 60_000) exemplars = hit.ex;
    else {
      const rows = await loadExemplars(q.id).catch(() => []);
      exemplars = rows.map((c) => ({ id: c.id, item, level: c.level, answer: c.answer, scores: c.scores ?? {}, total: c.total, redFlagsFired: c.redFlagsFired ?? [], provenance: c.provenance }));
      exemplarCache.set(q.id, { at: Date.now(), ex: exemplars });
    }
  }
  const s = scoreAnswer(model, item, input.answer, { exemplars: exemplarsFromCalibration(exemplars, item), cacheKey: item.key });
  const scores: Record<string, number> = Object.fromEntries(s.checkpoints.map((c) => [c.id, c.points]));
  // binding deterministic failures zero their linked checkpoints (or every must_find checkpoint when unlinked)
  for (const c of checks) {
    if (c.status !== 'failed' || !c.binding) continue;
    const ids = c.checkpoints.length ? c.checkpoints : item.rubric.filter((r) => !r.type || r.type === 'must_find').map((r) => r.id);
    for (const id of ids) if (id in scores) scores[id] = 0;
  }
  const max = item.rubric.reduce((a, c) => a + c.points, 0) || 1;
  let fired = s.redFlagsFired;
  let total = fired.length ? 0 : Math.round((Object.values(scores).reduce((a, b) => a + b, 0) / max) * 1000) / 10;
  let confidence = s.confidence;
  let tier: JudgeResult['tier'] = 'local_scorer';
  let modelName = name;
  const settings = await getSettings().catch(() => null);

  // tier 3: optional local LLM for low confidence
  if (settings?.llmEnabled !== false && confidence < (settings?.llmThreshold ?? 0.6)) {
    const llm = await llmJudge(input).catch(() => null);
    if (llm) {
      const w = settings?.llmBlendWeight ?? 0.5;
      for (const c of item.rubric) scores[c.id] = Math.round(((1 - w) * (scores[c.id] ?? 0) + w * (llm.scores[c.id] ?? 0)) * 100) / 100;
      fired = [...new Set([...fired, ...llm.redFlagsFired])];
      total = fired.length ? 0 : Math.round((Object.values(scores).reduce((a, b) => a + b, 0) / max) * 1000) / 10;
      const agree = 1 - Math.min(1, Math.abs(llm.total - s.rawTotal) / 50);
      confidence = Math.round(Math.min(1, confidence + 0.35 * agree) * 1000) / 1000;
      tier = 'local_llm';
      modelName = `${name}+${llmModelName()}`;
    }
  }

  const rationale = [
    `Hive Judge local scorer${tier === 'local_llm' ? ' blended with the local LLM' : ''}; confidence ${confidence}.`,
    fired.length ? `Red flag(s): ${fired.join('; ')}.` : '',
    s.lowConfidenceReasons.length ? `Low-confidence factors: ${s.lowConfidenceReasons.join(', ')}.` : '',
  ].filter(Boolean).join(' ');
  const result: JudgeResult = {
    status: 'done', scores, total, redFlagsFired: fired, rationale, model: modelName, confidence, tier,
    checkpoints: s.checkpoints.map((c) => ({ id: c.id, points: scores[c.id] ?? c.points, max: c.max, evidence: c.evidence, reason: c.reason })),
    checks: checks.map((c) => ({ type: c.type, status: c.status, checkpoints: c.checkpoints })),
  };

  // tier 4: admin review (off by default; capped per day — beyond the cap the scorer result stands, marked low-confidence)
  if (settings?.reviewEnabled && confidence < settings.reviewThreshold && openedToday() < settings.reviewDailyCap) {
    const r = createReview(input, result, s.lowConfidenceReasons);
    return { ...result, status: 'awaiting_judge', tier: 'admin', reviewId: r.id };
  }
  return result;
}
