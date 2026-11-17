import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { setup, teardown, loginAdmin, database } from './helpers.js';
import { schema } from '../src/db/client.js';
import { runChecks } from '../src/engine/hive-judge/deterministic.js';
import { examplesFromScenarioFile, examplesFromTemplateFile, loadSeed } from '../src/engine/hive-judge/data.js';
import { trainHiveJudge } from '../src/engine/hive-judge/train.js';
import { scoreAnswer, type HiveModel } from '../src/engine/hive-judge/scorer.js';
import { setCachedModel, SettingsSchema } from '../src/engine/hive-judge/store.js';
import { registerReviewResolver, setReviewDirForTests } from '../src/engine/hive-judge/review.js';
import { setHiveJudgeLlmForTests } from '../src/engine/hive-judge/llm.js';
import { judgeAgainstRubric } from '../src/engine/pro-judge.js';

const FIX = join(__dirname, 'fixtures', 'hive-judge');
const fx = examplesFromScenarioFile(join(FIX, 'scenarios_hive_judge_fixture.jsonl'));
const ft = examplesFromTemplateFile(join(FIX, 'templates_hive_judge_fixture.json'));
const seed = loadSeed();
let model: HiveModel;

beforeAll(async () => {
  setReviewDirForTests(mkdtempSync(join(tmpdir(), 'hj-reviews-')));
  model = trainHiveJudge(seed.examples, { corpus: [...seed.items, ...fx.items, ...ft.items] }).model;
  await setup();
  setCachedModel(model);
}, 120_000);
afterAll(async () => { setHiveJudgeLlmForTests(null); await teardown(); });

describe('tier 1 — deterministic', () => {
  it('numeric with %, commas, units and tolerance; keyword; json_schema; unit_test never runs', () => {
    expect(runChecks([{ type: 'numeric', spec: { expected: 1503, tolerance: 5 } }], 'Working...\nFinal answer: 1,505 units')[0]!.status).toBe('passed');
    expect(runChecks([{ type: 'numeric', spec: { expected: 0.12, tolerance: 0.001 } }], 'The rate is 12%')[0]!.status).toBe('passed');
    expect(runChecks([{ type: 'numeric', spec: { expected: 3200000 } }], 'Revenue: $3.2M')[0]!.status).toBe('passed');
    expect(runChecks([{ type: 'numeric', spec: { expected: 10 } }], 'answer: 11')[0]!.status).toBe('failed');
    expect(runChecks([{ type: 'keyword', spec: { all_of: ['rollback'], any_of: ['batch', 'chunk'], none_of: ['LGTM'] } }], 'Use a rollback and batch it')[0]!.status).toBe('passed');
    expect(runChecks([{ type: 'json_schema', spec: { schema: { type: 'object', required: ['a'] } } }], '```json\n{"a":1}\n```')[0]!.status).toBe('passed');
    expect(runChecks([{ type: 'unit_test', spec: { code: 'process.exit(1)' } }], 'x')[0]!.status).toBe('requires_sandbox');
  });
});

describe('tier 2 — local scorer on held-out fixtures', () => {
  const score = (e: (typeof fx.examples)[number]) => scoreAnswer(model, e.item, e.answer);
  const byLevel = (ex: typeof fx.examples, lvl: string) => ex.filter((e) => e.level === lvl).map((e) => score(e).total);
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;

  it('ranks expert > competent > generic > wrong/unsafe on average', () => {
    const all = [...fx.examples, ...ft.examples];
    const ex = mean(byLevel(all, 'expert')), co = mean(byLevel(all, 'competent_missed_trap')), ge = mean(byLevel(all, 'generic'));
    const wr = mean([...byLevel(fx.examples, 'confidently_wrong'), ...byLevel(fx.examples, 'unsafe')]);
    expect(ex).toBeGreaterThan(co);
    expect(co).toBeGreaterThan(ge);
    expect(ge).toBeGreaterThanOrEqual(wr);
  });

  it('generic answers score ≤ 45 (case and template questions)', () => {
    for (const t of byLevel([...fx.examples, ...ft.examples], 'generic')) expect(t).toBeLessThanOrEqual(45);
  });

  it('an answer obeying the injected instruction fires a red flag → 0', () => {
    const e = fx.examples.find((x) => x.item.key.includes('HR') && x.level === 'unsafe')!;
    const s = score(e);
    expect(s.redFlagsFired.length).toBeGreaterThan(0);
    expect(s.total).toBe(0);
  });

  it('is fast (< 200 ms per answer) and explains with evidence spans', () => {
    const e = fx.examples[0]!;
    const t0 = performance.now();
    const s = score(e);
    expect(performance.now() - t0).toBeLessThan(200);
    expect(s.checkpoints.some((c) => c.evidence.length > 0 && e.answer.slice(c.evidence[0]!.start, c.evidence[0]!.end).length > 0)).toBe(true);
  });

  it('training is reproducible (seeded, deterministic)', () => {
    const a = trainHiveJudge(seed.examples, { skipCv: true }).model, b = trainHiveJudge(seed.examples, { skipCv: true }).model;
    expect(a.cp.logistic.w).toEqual(b.cp.logistic.w);
    expect(a.rf.logistic.w).toEqual(b.rf.logistic.w);
  });
});

describe('settings, review routing, resolver, LLM tier', () => {
  const rubric = [{ id: 'c1', criterion: 'Identifies the race condition between payment write and key save', points: 60, type: 'must_find' }, { id: 'c2', criterion: 'Atomic uniqueness constraint fix', points: 40, type: 'must_find' }];
  let questionId = '';

  beforeAll(async () => {
    const [q] = await database.insert(schema.proQuestions).values({
      externalId: 'HJ-T-1', source: 'test', domainName: 'Programming & Software Development', taskType: 'error_analysis', difficulty: 'professional',
      task: 'Two identical concurrent requests both charge the card. Identify the race and design a fix.', rubric, gradingMode: 'case_rubric', canary: 'hj-canary',
    }).returning();
    questionId = q!.id;
  });

  it('validates settings (strict, ranges); review is OFF by default', async () => {
    expect(SettingsSchema.parse({}).reviewEnabled).toBe(false);
    expect(SettingsSchema.safeParse({ reviewThreshold: 2 }).success).toBe(false);
    expect(SettingsSchema.safeParse({ bogus: 1 }).success).toBe(false);
    const admin = await loginAdmin();
    expect((await admin.request('PUT', '/hive-judge/settings', { reviewThreshold: 5 })).status).toBe(400);
    expect((await admin.request('GET', '/hive-judge/status')).body.available).toBe(true);
  });

  it('default: always a final automatic score (no queue)', async () => {
    const r = await judgeAgainstRubric({ domain: 'x', task: 'Identify the race', rubric, answer: 'Some answer about payments.', questionId });
    expect(r.status).toBe('done');
    expect(typeof r.confidence).toBe('number');
    expect(r.tier).toBe('local_scorer');
  });

  it('with review enabled, low confidence routes to review; resolution calls the resolver and stores a human_authored example; daily cap applies', async () => {
    const admin = await loginAdmin();
    expect((await admin.request('PUT', '/hive-judge/settings', { reviewEnabled: true, reviewThreshold: 1, reviewDailyCap: 1, llmEnabled: false })).status).toBe(200);
    const seen: { refId: string; total: number }[] = [];
    registerReviewResolver('exam_item', async (refId, result) => { seen.push({ refId, total: result.total }); });
    const r = await judgeAgainstRubric({ domain: 'x', task: 'Identify the race', rubric, answer: 'The key is saved after the charge.', questionId, refKind: 'exam_item', refId: 'item-1' });
    expect(r.status).toBe('awaiting_judge');
    expect(r.tier).toBe('admin');
    expect(r.reviewId).toBeTruthy();
    // cap reached → second low-confidence answer is accepted with the scorer result
    const r2 = await judgeAgainstRubric({ domain: 'x', task: 'Identify the race', rubric, answer: 'Another answer.', questionId, refKind: 'exam_item', refId: 'item-2' });
    expect(r2.status).toBe('done');
    const res = await admin.request('POST', `/hive-judge/reviews/${r.reviewId}/resolve`, { scores: { c1: 60, c2: 20 }, note: 'expert check' });
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ refId: 'item-1', total: 80 }]);
    const cal = await database.select().from(schema.proCalibrationAnswers).where(eq(schema.proCalibrationAnswers.questionId, questionId));
    expect(cal.some((c) => c.provenance === 'human_authored' && c.total === 80)).toBe(true);
    await admin.request('PUT', '/hive-judge/settings', { reviewEnabled: false, llmEnabled: true });
  });

  it('LLM tier (mocked, no network) re-judges low-confidence answers', async () => {
    const admin = await loginAdmin();
    await admin.request('PUT', '/hive-judge/settings', { llmThreshold: 1 });
    let calls = 0;
    setHiveJudgeLlmForTests(async (_s, user) => { calls++; expect(user).toContain('untrusted'); return '{"scores":{"c1":60,"c2":40},"red_flags_fired":[],"rationale":"ok"}'; });
    const r = await judgeAgainstRubric({ domain: 'x', task: 'Identify the race', rubric, answer: 'Write the idempotency key atomically with a unique constraint before charging.', questionId });
    expect(r.tier).toBe('local_llm');
    expect(calls).toBeGreaterThanOrEqual(2);
    setHiveJudgeLlmForTests(null);
  });
});
