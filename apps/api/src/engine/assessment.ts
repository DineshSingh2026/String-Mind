/**
 * Capability assessment engine.
 *
 * Every score comes from real responses of the actual agent, graded against held-out ground truth
 * by the independent evaluator (engine/evaluator.ts) — never by the agent itself or a trainer.
 *
 * Question selection (held-out datasets only, stable ordering by question id):
 *   pre_training  → even-indexed half     post_training → odd-indexed half (disjoint, unseen)
 *   retention     → even-indexed half again (delayed recall)      others → all questions
 * Each question is asked `repeats` times (default 2); consistency = agreement across attempts.
 *
 * agent_capabilities ("latest real evidence") is updated by every purpose EXCEPT pre_training,
 * which only inserts a row when the agent has none for that domain: a pre-test is immediately
 * followed by training + an independent post-test, and it uses half the item set. Retention DOES
 * update capabilities so decayed knowledge is never displayed as an inflated post-training score.
 */
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DOMAINS, QUALITY, SCORING_DIMENSIONS, domainWeights, type ScoringDimension } from '@aix/shared';
import { db, schema } from '../db/client.js';
import { enqueue } from '../jobs/queue.js';
import { notify } from '../lib/notify.js';
import { emitEvent } from '../lib/webhooks.js';
import { publish } from '../ws/hub.js';
import { buildInvocationSystem, invokeAgent } from '../adapters/index.js';
import { AdapterError } from '../adapters/types.js';
import { KEEP_RUNNING_HELP, inboxEvents, promptAgentOfflineReason, promptConfig } from '../lib/agent-inbox.js';

/** Stop early when the agent clearly isn't answering: N failures in a row before any success, or M in a row at any point. */
const FAIL_FAST_BEFORE_FIRST_ANSWER = 3;
const FAIL_FAST_CONSECUTIVE = 8;
import { EVALUATOR_ID, formatQuestionPrompt, gradeResponse, gradeWithJudge, judgeEnabled, type GradeResult } from './evaluator.js';

export const ASSESSMENT_JOB = 'assessment.run';
export type AssessmentPurpose = 'baseline' | 'manual' | 'pre_training' | 'post_training' | 'retention' | 'regression';
export type Assessment = typeof schema.capabilityAssessments.$inferSelect;
type Question = typeof schema.benchmarkQuestions.$inferSelect;

const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;
const nn = (xs: (number | null)[]) => xs.filter((x): x is number => x !== null);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/* ───────────── statistics ───────────── */

/** Half-width of the 95% Wilson score interval for proportion p over n trials. */
export function wilsonHalfWidth(p: number, n: number, z = 1.96): number {
  if (n <= 0) return 0.5;
  const denom = 1 + (z * z) / n;
  return (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
}

/** Evaluation confidence 0..1 from sample size: 1 − width of the 95% interval. */
export function confidenceFor(p: number, n: number): number {
  return Math.max(0, Math.min(1, 1 - 2 * wilsonHalfWidth(p, n)));
}

/* ───────────── create ───────────── */

export async function createAssessment(input: {
  agentId: string; orgId: string; requestedBy?: string | null;
  purpose: AssessmentPurpose; domainSlugs: string[]; repeats?: number; trainingSessionId?: string | null;
}, opts: { delayMs?: number } = {}): Promise<Assessment> {
  const known = new Set(DOMAINS.map((d) => d.slug));
  const slugs = [...new Set(input.domainSlugs.length ? input.domainSlugs : [...known])].filter((s) => known.has(s));
  if (!slugs.length) throw new Error('No valid domains requested');
  const repeats = Math.max(1, Math.min(5, Math.round(input.repeats ?? 2)));
  const [row] = await db().insert(schema.capabilityAssessments).values({
    agentId: input.agentId, orgId: input.orgId, requestedBy: input.requestedBy ?? null, purpose: input.purpose,
    trainingSessionId: input.trainingSessionId ?? null, domainSlugs: slugs, repeats, status: 'queued',
    evaluator: { id: EVALUATOR_ID, method: judgeEnabled() ? 'deterministic+optional_llm_judge' : 'deterministic', independent: true, groundTruth: 'held_out' },
  }).returning();
  await enqueue(ASSESSMENT_JOB, { assessmentId: row!.id }, { delayMs: opts.delayMs ?? 0, maxAttempts: 2 });
  return row!;
}

/* ───────────── question selection ───────────── */

export function selectHalf<T extends { id: string }>(questions: T[], purpose: string): T[] {
  const sorted = [...questions].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (purpose === 'pre_training' || purpose === 'retention') return sorted.filter((_, i) => i % 2 === 0);
  if (purpose === 'post_training') return sorted.filter((_, i) => i % 2 === 1);
  return sorted;
}

async function heldOutFor(domainId: string) {
  const [ds] = await db().select().from(schema.benchmarkDatasets)
    .where(and(eq(schema.benchmarkDatasets.domainId, domainId), eq(schema.benchmarkDatasets.visibility, 'held_out'), eq(schema.benchmarkDatasets.status, 'active')))
    .orderBy(desc(schema.benchmarkDatasets.createdAt)).limit(1);
  if (!ds) return null;
  const qs = await db().select().from(schema.benchmarkQuestions).where(eq(schema.benchmarkQuestions.datasetId, ds.id)).orderBy(asc(schema.benchmarkQuestions.id));
  return { dataset: ds, questions: qs };
}

/** Practice questions (with ground truth) that training exercises may use. Never held-out. */
export async function getPracticeQuestions(domainSlug: string): Promise<Question[]> {
  const [d] = await db().select().from(schema.capabilityDomains).where(eq(schema.capabilityDomains.slug, domainSlug)).limit(1);
  if (!d) return [];
  return db().select({ q: schema.benchmarkQuestions }).from(schema.benchmarkQuestions)
    .innerJoin(schema.benchmarkDatasets, eq(schema.benchmarkDatasets.id, schema.benchmarkQuestions.datasetId))
    .where(and(eq(schema.benchmarkDatasets.domainId, d.id), eq(schema.benchmarkDatasets.visibility, 'practice'), eq(schema.benchmarkDatasets.status, 'active')))
    .orderBy(asc(schema.benchmarkQuestions.id)).then((r) => r.map((x) => x.q));
}

/* ───────────── aggregation ───────────── */

interface Graded { question: Question; attempt: number; grade: GradeResult; errored: boolean }

export interface DomainSummary {
  slug: string; name: string; domainId: string; score: number; accuracy: number; confidence: number; sampleSize: number;
  questionCount: number; verified: boolean; meetsTarget: boolean | null;
  dimensionScores: Record<ScoringDimension, number>; skillScores: Record<string, number>;
  strengths: string[]; weaknesses: string[]; failureBreakdown: Record<string, number>;
  hallucinationRate: number; consistency: number | null; consistencyMeasured: boolean; safetyCompliance: number | null; datasetVersion: string; errors: number;
}

export function aggregateDomain(def: { slug: string; name: string; domainId: string; datasetVersion: string; weights: Record<string, number> },
  graded: Graded[], skillNames: Map<string, string>): DomainSummary {
  const n = graded.length;
  const correct = graded.filter((g) => g.grade.correct).length;
  const p = n ? correct / n : 0;
  // consistency across repeated attempts of the same question
  const byQ = new Map<string, Graded[]>();
  for (const g of graded) byQ.set(g.question.id, [...(byQ.get(g.question.id) ?? []), g]);
  const agree = [...byQ.values()].filter((gs) => gs.every((g) => g.grade.normalizedAnswer === gs[0]!.grade.normalizedAnswer && g.grade.correct === gs[0]!.grade.correct && !g.errored)).length;
  // Consistency needs ≥2 attempts of a question. Quick runs (repeats=1) don't measure it: neutral, never a penalty.
  const consistencyMeasured = [...byQ.values()].some((gs) => gs.length > 1);
  const consistency = consistencyMeasured && byQ.size ? agree / byQ.size : null;

  const dimVals = (d: ScoringDimension) => graded.map((g) => g.grade.dimensionScores[d]).filter((v): v is number => typeof v === 'number');
  const accuracyFrac = mean(graded.map((g) => g.grade.score)) ?? 0;
  const dims = {} as Record<ScoringDimension, number>;
  for (const d of SCORING_DIMENSIONS) {
    const vals = dimVals(d);
    let v = mean(vals) ?? accuracyFrac;
    if (d === 'reliability' && consistency !== null) v = 0.5 * consistency + 0.5 * v;
    dims[d] = round(v, 4);
  }
  const score = round(SCORING_DIMENSIONS.reduce((s, d) => s + (def.weights[d] ?? 0) * dims[d], 0) * 100, 1);

  const skillAgg = new Map<string, number[]>();
  for (const g of graded) {
    const name = g.question.skillId ? skillNames.get(g.question.skillId) ?? 'general' : 'general';
    skillAgg.set(name, [...(skillAgg.get(name) ?? []), g.grade.score]);
  }
  const skillScores = Object.fromEntries([...skillAgg].map(([k, v]) => [k, round((mean(v) ?? 0) * 100, 1)]));
  const strengths = Object.entries(skillScores).filter(([, v]) => v >= 80).map(([k]) => k);
  const weaknesses = Object.entries(skillScores).filter(([, v]) => v < 60).map(([k]) => k);
  const failureBreakdown: Record<string, number> = {};
  for (const g of graded) if (g.grade.failureCategory) failureBreakdown[g.grade.failureCategory] = (failureBreakdown[g.grade.failureCategory] ?? 0) + 1;
  const abstainItems = graded.filter((g) => g.question.answerType === 'abstain');
  const hallucinationRate = abstainItems.length ? abstainItems.filter((g) => !g.grade.correct).length / abstainItems.length : 0;
  const safetyItems = graded.filter((g) => g.question.answerType === 'refusal');
  const confidence = round(confidenceFor(p, n), 3);
  const accuracy = round(p * 100, 1);
  return {
    slug: def.slug, name: def.name, domainId: def.domainId, score, accuracy, confidence, sampleSize: n, questionCount: byQ.size,
    verified: n >= QUALITY.MIN_SAMPLE_FOR_VERIFIED && confidence >= QUALITY.MIN_CONFIDENCE_FOR_VERIFIED,
    meetsTarget: n >= QUALITY.MIN_SAMPLE_FOR_TARGET_CLAIM ? accuracy >= QUALITY.ACCURACY_TARGET : null,
    dimensionScores: dims, skillScores, strengths, weaknesses, failureBreakdown,
    hallucinationRate: round(hallucinationRate, 3), consistency: consistency === null ? null : round(consistency, 3), consistencyMeasured,
    safetyCompliance: safetyItems.length ? round(safetyItems.filter((g) => g.grade.correct).length / safetyItems.length, 3) : null,
    datasetVersion: def.datasetVersion, errors: graded.filter((g) => g.errored).length,
  };
}

/* ───────────── run ───────────── */

/** Concurrent agent calls per synchronous assessment (env ASSESSMENT_CONCURRENCY, default 6, read per run). */
export function assessmentConcurrency(): number {
  const v = Number(process.env.ASSESSMENT_CONCURRENCY);
  return Number.isFinite(v) && v >= 1 ? Math.min(32, Math.floor(v)) : 6;
}

/** How long async (inbox) assessment tasks wait for the agent (env ASYNC_TASK_TTL_HOURS, default 24). */
export function asyncTaskTtlHours(): number {
  const v = Number(process.env.ASYNC_TASK_TTL_HOURS);
  return Number.isFinite(v) && v > 0 ? v : 24;
}

/** Shown to owners whose prompt-connected agent has queued assessment tasks. */
export const CHECK_IN_INSTRUCTION = 'Check StringMind for tasks and answer them all.';

async function claim(assessmentId: string): Promise<Assessment | null> {
  // NB: raw sql`` params bypass column mapping — pass Dates as ISO strings (postgres-js cannot bind a Date there).
  // Async (inbox) assessments stay 'running' for hours while the agent answers queued tasks: never re-claim those.
  const stale = new Date(Date.now() - 15 * 60_000);
  const [row] = await db().update(schema.capabilityAssessments)
    .set({ status: 'running', startedAt: new Date(), progress: 0, testsCompleted: 0, error: null })
    .where(and(eq(schema.capabilityAssessments.id, assessmentId),
      sql`(${schema.capabilityAssessments.status} = 'queued' OR (${schema.capabilityAssessments.status} = 'running' AND ${schema.capabilityAssessments.startedAt} < ${stale.toISOString()}::timestamptz AND coalesce(${schema.capabilityAssessments.summary}->>'mode', '') <> 'async'))`))
    .returning();
  return row ?? null;
}

async function waitForFinish(assessmentId: string, timeoutMs = 15 * 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const [a] = await db().select({ status: schema.capabilityAssessments.status, summary: schema.capabilityAssessments.summary })
      .from(schema.capabilityAssessments).where(eq(schema.capabilityAssessments.id, assessmentId)).limit(1);
    if (!a || a.status !== 'running' || (a.summary as { mode?: string }).mode === 'async') return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Mark failed (only while still queued/running — never overwrites a completed/cancelled run) and tell the owner. */
async function fail(a: Pick<Assessment, 'id' | 'agentId'>, message: string) {
  const [row] = await db().update(schema.capabilityAssessments).set({ status: 'failed', error: message, completedAt: new Date() })
    .where(and(eq(schema.capabilityAssessments.id, a.id), inArray(schema.capabilityAssessments.status, ['queued', 'running'])))
    .returning({ id: schema.capabilityAssessments.id });
  if (!row) return;
  publish(`assessment:${a.id}`, 'failed', { assessmentId: a.id, error: message });
  const [agent] = await db().select().from(schema.agents).where(eq(schema.agents.id, a.agentId)).limit(1);
  if (agent) await notify(agent.ownerId, 'evaluation_result', `Assessment failed for ${agent.name}`, message, `/assessments/${a.id}`).catch(() => undefined);
}

/**
 * Job body for `assessment.run`. Safe to call directly: if another worker already runs this
 * assessment, waits for it to finish instead of running twice.
 */
export async function runAssessment(assessmentId: string): Promise<void> {
  const a = await claim(assessmentId);
  if (!a) { await waitForFinish(assessmentId); return; }
  try {
    await execute(a);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[assessment] ${assessmentId} failed: ${msg}`);
    await fail(a, `Assessment aborted: ${msg}`);
  }
}

type Agent = typeof schema.agents.$inferSelect;
type Domain = typeof schema.capabilityDomains.$inferSelect;
interface PlanItem { domain: Domain; dataset: typeof schema.benchmarkDatasets.$inferSelect; questions: Question[] }

async function buildPlan(a: Assessment): Promise<PlanItem[]> {
  const domainRows = await db().select().from(schema.capabilityDomains).where(inArray(schema.capabilityDomains.slug, a.domainSlugs));
  const plan: PlanItem[] = [];
  for (const slug of a.domainSlugs) {
    const domain = domainRows.find((d) => d.slug === slug);
    if (!domain) continue;
    const h = await heldOutFor(domain.id);
    if (!h || !h.questions.length) continue;
    plan.push({ domain, dataset: h.dataset, questions: selectHalf(h.questions, a.purpose) });
  }
  return plan;
}

async function adapterOf(agent: Agent): Promise<string | null> {
  const [p] = await db().select({ adapter: schema.agentProviders.adapter }).from(schema.agentProviders).where(eq(schema.agentProviders.id, agent.providerId)).limit(1);
  return p?.adapter ?? null;
}

function errorGrade(category: 'timeout' | 'error'): GradeResult {
  return { correct: false, score: 0, dimensionScores: { correctness: 0 }, failureCategory: category, method: 'not_graded', evaluator: EVALUATOR_ID, normalizedAnswer: '' };
}

async function execute(a: Assessment) {
  const [agent] = await db().select().from(schema.agents).where(eq(schema.agents.id, a.agentId)).limit(1);
  if (!agent || agent.deletedAt) return fail(a, 'Agent not found');
  await db().delete(schema.assessmentResults).where(eq(schema.assessmentResults.assessmentId, a.id)); // restart-safe

  const plan = await buildPlan(a);
  if (!plan.length) return fail(a, 'No held-out benchmark questions are available for the requested domains');

  const total = plan.reduce((s, p) => s + p.questions.length * a.repeats, 0);
  await db().update(schema.capabilityAssessments).set({
    testsTotal: total, datasetVersions: Object.fromEntries(plan.map((p) => [p.domain.slug, p.dataset.version])),
  }).where(eq(schema.capabilityAssessments.id, a.id));

  const adapter = await adapterOf(agent);
  // Prompt-connected (inbox) agents answer whenever they check in — queue every question and return. Training-linked
  // assessments stay synchronous: the training run needs the score before it can continue.
  if (adapter === 'inbox' && !a.trainingSessionId) return startAsync(a, agent, plan, total);

  const channel = `assessment:${a.id}`;
  // Synchronous run for a prompt agent (training): don't start if it isn't running.
  const offlineAtStart = await promptAgentOfflineReason(agent.id);
  if (offlineAtStart) return fail(a, offlineAtStart);

  // Flatten to (question, attempt) items and run them through a bounded pool. Inbox agents answer one task at a
  // time from their own loop, so they get concurrency 1 (otherwise queued tasks would time out while waiting).
  const items = plan.flatMap((p) => p.questions.flatMap((question) =>
    Array.from({ length: a.repeats }, (_, i) => ({ p, question, attempt: i + 1 }))));
  const graded: (Graded | undefined)[] = new Array(items.length);
  const concurrency = adapter === 'inbox' ? 1 : Math.max(1, Math.min(assessmentConcurrency(), items.length));
  let next = 0, done = 0, errors = 0, answered = 0, streak = 0;
  let stopReason: string | null = null;

  const runItem = async (idx: number) => {
    const { p, question, attempt } = items[idx]!;
    let response = ''; let latencyMs: number | null = null; let grade: GradeResult; let errored = false;
    try {
      const r = await invokeAgent(agent.id, { messages: [{ role: 'user', content: formatQuestionPrompt(question) }], purpose: 'assessment', temperature: 0, maxTokens: 400 },
        { withContext: true, contextQuery: question.prompt });
      response = r.text ?? ''; latencyMs = r.latencyMs;
      grade = await gradeWithJudge(question, response, { highImpact: p.domain.highImpact });
    } catch (err) {
      errored = true;
      const timeout = err instanceof AdapterError && err.kind === 'timeout';
      response = `[${timeout ? 'timeout' : 'error'}] ${err instanceof Error ? err.message : String(err)}`.slice(0, 500);
      grade = errorGrade(timeout ? 'timeout' : 'error');
    }
    await db().insert(schema.assessmentResults).values({
      assessmentId: a.id, questionId: question.id, domainId: p.domain.id, attempt, response: response.slice(0, 8000), latencyMs,
      correct: grade.correct, score: grade.score, dimensionScores: grade.dimensionScores as Record<string, number>,
      failureCategory: grade.failureCategory, evaluator: grade.evaluator, evaluationMethod: grade.method, needsHumanReview: !!grade.needsHumanReview,
    });
    graded[idx] = { question, attempt, grade, errored };
    // Fail-fast bookkeeping in completion order.
    done++;
    if (errored) { errors++; streak++; } else { streak = 0; answered++; }
    if (!stopReason && ((answered === 0 && streak >= FAIL_FAST_BEFORE_FIRST_ANSWER) || streak >= FAIL_FAST_CONSECUTIVE)) {
      stopReason = `The agent stopped answering: the last ${streak} questions failed or timed out (${response.slice(0, 160)}).`;
      const offline = await promptAgentOfflineReason(agent.id);
      stopReason = offline
        ?? stopReason + (response.includes('polling') ? ` ${KEEP_RUNNING_HELP}` : ' Check the agent connection and run "Test connection" on the agent page.');
      return;
    }
    const progress = round(Math.min(1, done / total), 4);
    await db().update(schema.capabilityAssessments)
      .set({ progress: sql`greatest(${schema.capabilityAssessments.progress}, ${progress})`, testsCompleted: sql`greatest(${schema.capabilityAssessments.testsCompleted}, ${done})` })
      .where(eq(schema.capabilityAssessments.id, a.id));
    publish(channel, 'progress', { assessmentId: a.id, progress, testsCompleted: done, testsTotal: total, domain: p.domain.slug });
  };
  // Workers stop launching new items once fail-fast triggers; in-flight items are awaited.
  const worker = async () => { while (!stopReason && next < items.length) await runItem(next++); };
  await Promise.all(Array.from({ length: concurrency }, worker));
  if (stopReason) return fail(a, `Assessment stopped early after ${done} of ${total} answers — ${stopReason}`);

  const perDomain = new Map<string, Graded[]>();
  items.forEach((it, i) => { if (graded[i]) perDomain.set(it.p.domain.slug, [...(perDomain.get(it.p.domain.slug) ?? []), graded[i]!]); });

  if (errors / total > 0.5) return fail(a, `${errors} of ${total} agent calls failed (errors/timeouts) — results are not reliable enough to score.`);
  await finalizeAssessment(a, agent, plan, perDomain, { errors, total });
}

/**
 * Shared tail of every assessment (sync and async): aggregate per domain, mark completed (race-safe: only the caller
 * that flips status running → completed applies side effects), update capabilities + overall score, notify, emit.
 * Returns false if another caller already finalized the assessment.
 */
export async function finalizeAssessment(a: Assessment, agent: Agent, plan: PlanItem[], perDomain: Map<string, Graded[]>,
  stats: { errors: number; total: number; extraSummary?: Record<string, unknown> }): Promise<boolean> {
  const skills = await db().select().from(schema.capabilitySkills);
  const skillNames = new Map(skills.map((s) => [s.id, s.slug]));
  const summaries = plan.map((p) => aggregateDomain(
    { slug: p.domain.slug, name: p.domain.name, domainId: p.domain.id, datasetVersion: p.dataset.version, weights: p.domain.weights },
    perDomain.get(p.domain.slug) ?? [], skillNames));

  const now = new Date();
  const overallScore = round(mean(summaries.map((s) => s.score)) ?? 0, 1);
  const confidence = round(Math.min(...summaries.map((s) => s.confidence)), 3);
  const [won] = await db().update(schema.capabilityAssessments).set({
    status: 'completed', progress: 1, completedAt: now, overallScore, confidence,
    summary: { ...(a.summary ?? {}), ...(stats.extraSummary ?? {}), domains: summaries, errors: stats.errors, totalResponses: stats.total, evaluator: EVALUATOR_ID, capabilitiesUpdated: a.purpose !== 'pre_training' },
  }).where(and(eq(schema.capabilityAssessments.id, a.id), eq(schema.capabilityAssessments.status, 'running'))).returning({ id: schema.capabilityAssessments.id });
  if (!won) return false;

  for (const s of summaries) {
    const values = {
      agentId: agent.id, domainId: s.domainId, score: s.score, accuracy: s.accuracy, hallucinationRate: s.hallucinationRate,
      consistency: s.consistency, confidence: s.confidence, sampleSize: s.sampleSize, dimensionScores: s.dimensionScores,
      skillScores: s.skillScores, strengths: s.strengths, weaknesses: s.weaknesses, failureBreakdown: s.failureBreakdown,
      verified: s.verified, lastAssessmentId: a.id, assessedAt: now,
    };
    const q = db().insert(schema.agentCapabilities).values(values);
    if (a.purpose === 'pre_training') await q.onConflictDoNothing();
    // A Quick run doesn't measure consistency: keep the last measured value instead of erasing it.
    else await q.onConflictDoUpdate({ target: [schema.agentCapabilities.agentId, schema.agentCapabilities.domainId],
      set: { ...values, consistency: s.consistency ?? sql`${schema.agentCapabilities.consistency}` } });
  }

  // agents.overallScore = mean of VERIFIED domain scores (null if none)
  const caps = await db().select().from(schema.agentCapabilities).where(eq(schema.agentCapabilities.agentId, agent.id));
  const verified = caps.filter((c) => c.verified).map((c) => c.score);
  const overall = verified.length ? round(mean(verified)!, 1) : null;
  await db().update(schema.agents).set({ overallScore: overall, updatedAt: now }).where(eq(schema.agents.id, agent.id));

  publish(`assessment:${a.id}`, 'completed', { assessmentId: a.id, overallScore, confidence, domains: summaries.map((s) => ({ slug: s.slug, score: s.score, accuracy: s.accuracy, verified: s.verified })) });

  await notify(agent.ownerId, 'evaluation_result', `Assessment complete: ${agent.name}`,
    `${summaries.map((s) => `${s.name}: ${s.score}/100 (accuracy ${s.accuracy}%, n=${s.sampleSize}${s.verified ? ', verified' : ''})`).join('; ')}`,
    `/assessments/${a.id}`).catch((e) => console.error('[assessment] notify failed', e));
  await emitEvent(a.orgId, 'assessment.completed', {
    assessmentId: a.id, agentId: agent.id, purpose: a.purpose, overallScore, confidence,
    domains: summaries.map((s) => ({ slug: s.slug, score: s.score, accuracy: s.accuracy, sampleSize: s.sampleSize, verified: s.verified })),
  }).catch((e) => console.error('[assessment] emitEvent failed', e));
  return true;
}

/* ───────────── async (inbox) mode ───────────── */

export const ASYNC_SWEEP_JOB = 'assessments.async_sweep';
export const ASYNC_SWEEP_INTERVAL_MS = 5 * 60_000;
/** Answered tasks whose grading never landed (process died mid-grade) are re-graded by the sweep after this. */
const ORPHAN_GRADE_AFTER_MS = 2 * 60_000;

interface AsyncMeta { assessmentId: string; questionId: string; attempt: number; domainId: string }
type Task = typeof schema.agentTasks.$inferSelect;
const metaOf = (t: Pick<Task, 'meta'>): AsyncMeta | null => {
  const m = t.meta as Partial<AsyncMeta> | null;
  return m && typeof m.assessmentId === 'string' && typeof m.questionId === 'string' ? m as AsyncMeta : null;
};
const tasksOf = (assessmentId: string) => sql`${schema.agentTasks.meta}->>'assessmentId' = ${assessmentId}`;

/** Queue every (question × attempt) as an agent task with a long deadline; the assessment completes as answers arrive. */
async function startAsync(a: Assessment, agent: Agent, plan: PlanItem[], total: number) {
  const [conn] = await db().select().from(schema.agentConnections).where(eq(schema.agentConnections.agentId, agent.id)).limit(1);
  if (!promptConfig(conn).verifiedAt) {
    return fail(a, 'This agent has not finished connecting yet. Paste the connect prompt into your agent and wait for "Connected" before running an assessment.');
  }
  if (agent.status === 'suspended' || agent.status === 'disconnected') return fail(a, `Agent is ${agent.status} — reconnect it before running an assessment.`);
  const deadline = new Date(Date.now() + asyncTaskTtlHours() * 3_600_000);
  const rows: (typeof schema.agentTasks.$inferInsert)[] = [];
  for (const p of plan) {
    for (const question of p.questions) {
      const messages = [{ role: 'user' as const, content: formatQuestionPrompt(question) }];
      // Exactly the system prompt invokeAgent would send (instructions, role, retrieved knowledge context).
      const { system } = await buildInvocationSystem(agent, { messages }, { withContext: true, contextQuery: question.prompt });
      for (let attempt = 1; attempt <= a.repeats; attempt++) {
        rows.push({
          agentId: agent.id, orgId: agent.orgId, kind: 'assessment', status: 'pending', deadline,
          request: { messages, system: system || null },
          meta: { assessmentId: a.id, questionId: question.id, attempt, domainId: p.domain.id },
        });
      }
    }
  }
  const summary = { mode: 'async', deadline: deadline.toISOString(), checkInInstruction: CHECK_IN_INSTRUCTION };
  await db().transaction(async (tx) => {
    for (let i = 0; i < rows.length; i += 200) await tx.insert(schema.agentTasks).values(rows.slice(i, i + 200));
    await tx.update(schema.capabilityAssessments).set({ summary, testsTotal: total, progress: 0, testsCompleted: 0 })
      .where(eq(schema.capabilityAssessments.id, a.id));
  });
  inboxEvents.emit(`agent:${agent.id}`);
  publish(`assessment:${a.id}`, 'progress', { assessmentId: a.id, progress: 0, testsCompleted: 0, testsTotal: total, mode: 'async', deadline: summary.deadline });
  await ensureAsyncSweepScheduled().catch((e) => console.error('[assessment] could not schedule async sweep', e));
}

/** Grade one answered async-assessment task (idempotent per assessment/question/attempt), then try to finalize. */
export async function handleAsyncTaskAnswer(task: Task): Promise<void> {
  const m = metaOf(task);
  if (!m || task.status !== 'answered') return;
  const [a] = await db().select().from(schema.capabilityAssessments).where(eq(schema.capabilityAssessments.id, m.assessmentId)).limit(1);
  if (!a || a.status !== 'running') return;
  await gradeAsyncTask(a, task, m);
  await maybeFinalizeAsync(a.id);
}

async function gradeAsyncTask(a: Assessment, task: Task, m: AsyncMeta) {
  const [exists] = await db().select({ id: schema.assessmentResults.id }).from(schema.assessmentResults)
    .where(and(eq(schema.assessmentResults.assessmentId, a.id), eq(schema.assessmentResults.questionId, m.questionId), eq(schema.assessmentResults.attempt, m.attempt))).limit(1);
  if (exists) return;
  const [question] = await db().select().from(schema.benchmarkQuestions).where(eq(schema.benchmarkQuestions.id, m.questionId)).limit(1);
  const [domain] = await db().select().from(schema.capabilityDomains).where(eq(schema.capabilityDomains.id, m.domainId)).limit(1);
  if (!question || !domain) return;
  const response = task.response ?? '';
  const grade = await gradeWithJudge(question, response, { highImpact: domain.highImpact });
  const latencyMs = task.answeredAt ? Math.max(0, task.answeredAt.getTime() - task.createdAt.getTime()) : null;
  await db().insert(schema.assessmentResults).values({
    assessmentId: a.id, questionId: question.id, domainId: domain.id, attempt: m.attempt, response: response.slice(0, 8000), latencyMs,
    correct: grade.correct, score: grade.score, dimensionScores: grade.dimensionScores as Record<string, number>,
    failureCategory: grade.failureCategory, evaluator: grade.evaluator, evaluationMethod: grade.method, needsHumanReview: !!grade.needsHumanReview,
  });
  const [cnt] = await db().select({ n: sql<number>`count(*)::int` }).from(schema.assessmentResults).where(eq(schema.assessmentResults.assessmentId, a.id));
  const n = Number(cnt?.n ?? 0);
  const progress = round(Math.min(1, n / (a.testsTotal || 1)), 4);
  await db().update(schema.capabilityAssessments).set({ progress, testsCompleted: n })
    .where(and(eq(schema.capabilityAssessments.id, a.id), eq(schema.capabilityAssessments.status, 'running')));
  publish(`assessment:${a.id}`, 'progress', { assessmentId: a.id, progress, testsCompleted: n, testsTotal: a.testsTotal, domain: domain.slug, mode: 'async' });
}

/**
 * Finalize an async assessment once none of its tasks can still be answered. Expired tasks count as timeouts.
 * Race-safe: concurrent callers may all compute, but only the one that flips running → completed/failed wins.
 */
export async function maybeFinalizeAsync(assessmentId: string): Promise<'finalized' | 'waiting' | 'skipped'> {
  const [a] = await db().select().from(schema.capabilityAssessments).where(eq(schema.capabilityAssessments.id, assessmentId)).limit(1);
  if (!a || a.status !== 'running' || (a.summary as { mode?: string }).mode !== 'async') return 'skipped';
  const nowIso = new Date().toISOString();
  await db().update(schema.agentTasks).set({ status: 'expired' }).where(and(tasksOf(a.id),
    inArray(schema.agentTasks.status, ['pending', 'delivered']), sql`${schema.agentTasks.deadline} <= ${nowIso}::timestamptz`));
  const tasks = await db().select().from(schema.agentTasks).where(tasksOf(a.id));
  if (tasks.some((t) => t.status === 'pending' || t.status === 'delivered')) return 'waiting';
  const results = await db().select().from(schema.assessmentResults).where(eq(schema.assessmentResults.assessmentId, a.id));
  const answered = tasks.filter((t) => t.status === 'answered');
  if (results.length < answered.length) return 'waiting'; // a grader is still writing its result

  const [agent] = await db().select().from(schema.agents).where(eq(schema.agents.id, a.agentId)).limit(1);
  if (!agent || agent.deletedAt) { await fail(a, 'The agent was deleted before it answered the assessment.'); return 'finalized'; }

  const total = a.testsTotal || tasks.length;
  const expired = tasks.filter((t) => t.status === 'expired');
  const errors = expired.length;
  if (errors / total > 0.5) {
    await fail(a, `Only ${total - errors} of ${total} questions were answered before the ${asyncTaskTtlHours()}h deadline — results are not reliable enough to score. `
      + `Run the assessment again and tell your agent: "${CHECK_IN_INSTRUCTION}" (it should repeat until no tasks are left).`);
    return 'finalized';
  }

  const plan = await buildPlan(a);
  const qById = new Map(plan.flatMap((p) => p.questions.map((q) => [q.id, q] as const)));
  const slugByDomain = new Map(plan.map((p) => [p.domain.id, p.domain.slug]));
  const perDomain = new Map<string, Graded[]>();
  const push = (domainId: string, g: Graded) => {
    const slug = slugByDomain.get(domainId);
    if (slug) perDomain.set(slug, [...(perDomain.get(slug) ?? []), g]);
  };
  for (const r of results) {
    const question = qById.get(r.questionId);
    if (!question) continue;
    // results don't store the normalised answer: recompute it deterministically for the consistency measure
    const normalizedAnswer = gradeResponse(question, r.response).normalizedAnswer;
    push(r.domainId, { question, attempt: r.attempt, errored: false, grade: {
      correct: r.correct, score: r.score, dimensionScores: r.dimensionScores, failureCategory: (r.failureCategory ?? null) as GradeResult['failureCategory'],
      method: r.evaluationMethod, evaluator: EVALUATOR_ID, normalizedAnswer,
    } });
  }
  const expiredMeta: AsyncMeta[] = [];
  for (const t of expired) {
    const m = metaOf(t); const question = m && qById.get(m.questionId);
    if (!m || !question) continue;
    push(m.domainId, { question, attempt: m.attempt, errored: true, grade: errorGrade('timeout') });
    expiredMeta.push(m);
  }
  const won = await finalizeAssessment(a, agent, plan, perDomain, { errors, total, extraSummary: { mode: 'async', unanswered: expired.length } });
  if (won && expiredMeta.length) {
    // Record unanswered questions as timeouts so the per-question results list is complete.
    const rows = expiredMeta.map((m) => ({
      assessmentId: a.id, questionId: m.questionId, domainId: m.domainId, attempt: m.attempt,
      response: '[timeout] Not answered before the deadline', latencyMs: null, correct: false, score: 0,
      dimensionScores: { correctness: 0 }, failureCategory: 'timeout', evaluator: EVALUATOR_ID, evaluationMethod: 'not_graded', needsHumanReview: false,
    }));
    for (let i = 0; i < rows.length; i += 200) await db().insert(schema.assessmentResults).values(rows.slice(i, i + 200));
  }
  return 'finalized';
}

/** Expire every open task of an async assessment (cancel / delete). */
export async function expireAssessmentTasks(assessmentId: string) {
  const rows = await db().update(schema.agentTasks).set({ status: 'expired' })
    .where(and(tasksOf(assessmentId), inArray(schema.agentTasks.status, ['pending', 'delivered']))).returning({ id: schema.agentTasks.id });
  for (const r of rows) inboxEvents.emit(`task:${r.id}`);
  return rows.length;
}

/** Cancel a queued/running assessment (owner action). Returns false if it had already finished. */
export async function cancelAssessment(assessmentId: string): Promise<boolean> {
  const [row] = await db().update(schema.capabilityAssessments).set({ status: 'cancelled', error: 'Cancelled by the owner', completedAt: new Date() })
    .where(and(eq(schema.capabilityAssessments.id, assessmentId), inArray(schema.capabilityAssessments.status, ['queued', 'running'])))
    .returning({ id: schema.capabilityAssessments.id });
  await expireAssessmentTasks(assessmentId);
  if (row) publish(`assessment:${assessmentId}`, 'failed', { assessmentId, error: 'Cancelled by the owner', status: 'cancelled' });
  return !!row;
}

/**
 * Periodic sweep: expire overdue / orphaned assessment tasks, re-grade answers whose grading never landed, and
 * finalize async assessments whose tasks are all answered or expired. Idempotent.
 */
export async function sweepAsyncAssessments(): Promise<{ finalized: number }> {
  const nowIso = new Date().toISOString();
  await db().update(schema.agentTasks).set({ status: 'expired' }).where(and(eq(schema.agentTasks.kind, 'assessment'),
    sql`${schema.agentTasks.meta} IS NOT NULL`, inArray(schema.agentTasks.status, ['pending', 'delivered']),
    sql`${schema.agentTasks.deadline} <= ${nowIso}::timestamptz`));
  // tasks of assessments that are no longer running can never count
  await db().update(schema.agentTasks).set({ status: 'expired' }).where(and(eq(schema.agentTasks.kind, 'assessment'),
    inArray(schema.agentTasks.status, ['pending', 'delivered']),
    sql`${schema.agentTasks.meta}->>'assessmentId' IN (SELECT id::text FROM capability_assessments WHERE status IN ('cancelled', 'failed', 'completed'))`));
  const running = await db().select().from(schema.capabilityAssessments)
    .where(and(eq(schema.capabilityAssessments.status, 'running'), sql`${schema.capabilityAssessments.summary}->>'mode' = 'async'`));
  let finalized = 0;
  const orphanBefore = Date.now() - ORPHAN_GRADE_AFTER_MS;
  for (const a of running) {
    try {
      const answered = await db().select().from(schema.agentTasks).where(and(tasksOf(a.id), eq(schema.agentTasks.status, 'answered')));
      for (const t of answered) {
        const m = metaOf(t);
        if (m && t.answeredAt && t.answeredAt.getTime() < orphanBefore) await gradeAsyncTask(a, t, m);
      }
      if ((await maybeFinalizeAsync(a.id)) === 'finalized') finalized++;
    } catch (e) {
      console.error(`[assessment] async sweep failed for ${a.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { finalized };
}

/** Enqueue the next sweep unless one is already queued (self-rescheduling like the agent health check). */
export async function ensureAsyncSweepScheduled() {
  const [q] = await db().select({ id: schema.jobs.id }).from(schema.jobs)
    .where(and(eq(schema.jobs.type, ASYNC_SWEEP_JOB), eq(schema.jobs.status, 'queued'))).limit(1);
  if (!q) await enqueue(ASYNC_SWEEP_JOB, {}, { delayMs: ASYNC_SWEEP_INTERVAL_MS, maxAttempts: 1 });
}

/* ───────────── read models ───────────── */

async function suggestTrainers(domainId: string, excludeAgentId: string, limit = 3) {
  const rows = await db().select({
    agentId: schema.agents.id, name: schema.agents.name, score: schema.agentCapabilities.score, priceCredits: schema.marketplaceListings.priceCredits,
  }).from(schema.agentCapabilities)
    .innerJoin(schema.agents, eq(schema.agents.id, schema.agentCapabilities.agentId))
    .innerJoin(schema.marketplaceListings, and(eq(schema.marketplaceListings.agentId, schema.agents.id), eq(schema.marketplaceListings.domainId, domainId)))
    .where(and(eq(schema.agentCapabilities.domainId, domainId), eq(schema.agentCapabilities.verified, true), sql`${schema.agentCapabilities.score} >= 80`,
      eq(schema.agents.isPublic, true), eq(schema.agents.status, 'active'), isNull(schema.agents.deletedAt), sql`${schema.agents.id} <> ${excludeAgentId}`,
      eq(schema.marketplaceListings.status, 'active'), eq(schema.marketplaceListings.moderation, 'visible')))
    .orderBy(desc(schema.agentCapabilities.score), asc(schema.marketplaceListings.priceCredits));
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.agentId) ? false : (seen.add(r.agentId), true))).slice(0, limit);
}

async function capabilitiesWithDomains(agentId: string) {
  return db().select({ c: schema.agentCapabilities, d: schema.capabilityDomains }).from(schema.agentCapabilities)
    .innerJoin(schema.capabilityDomains, eq(schema.capabilityDomains.id, schema.agentCapabilities.domainId))
    .where(eq(schema.agentCapabilities.agentId, agentId)).orderBy(asc(schema.capabilityDomains.sortOrder));
}

export async function getScorecard(agentId: string) {
  const [agent] = await db().select().from(schema.agents).where(eq(schema.agents.id, agentId)).limit(1);
  if (!agent) return null;
  const caps = await capabilitiesWithDomains(agentId);
  const [{ tests, last }] = await db().select({
    tests: sql<number>`coalesce(sum(${schema.capabilityAssessments.testsCompleted}), 0)::int`,
    last: sql<string | null>`max(${schema.capabilityAssessments.completedAt})`,
  }).from(schema.capabilityAssessments).where(and(eq(schema.capabilityAssessments.agentId, agentId), eq(schema.capabilityAssessments.status, 'completed')));
  const domains = caps.map(({ c, d }) => ({
    slug: d.slug, name: d.name, score: c.score, accuracy: c.accuracy, confidence: c.confidence, sampleSize: c.sampleSize, verified: c.verified,
    dimensionScores: c.dimensionScores, skillScores: c.skillScores, strengths: c.strengths, weaknesses: c.weaknesses, failureBreakdown: c.failureBreakdown,
    hallucinationRate: c.hallucinationRate, consistency: c.consistency, consistencyMeasured: c.consistency !== null,
    meetsTarget: c.sampleSize >= QUALITY.MIN_SAMPLE_FOR_TARGET_CLAIM ? c.accuracy >= QUALITY.ACCURACY_TARGET : null,
    assessedAt: c.assessedAt, lastAssessmentId: c.lastAssessmentId,
  }));
  const assessed = new Set(domains.map((d) => d.slug));
  const recommendations = [];
  for (const { c, d } of caps) {
    if (c.score >= 70 && c.accuracy >= 70) continue;
    recommendations.push({
      domainSlug: d.slug,
      reason: `Demonstrated score ${c.score}/100 (accuracy ${c.accuracy}%) in ${d.name}${c.weaknesses.length ? `; weak skills: ${c.weaknesses.join(', ')}` : ''}.`,
      suggestedTrainers: await suggestTrainers(d.id, agentId),
    });
  }
  const verified = domains.filter((d) => d.verified);
  return {
    agentId, overallScore: agent.overallScore ?? null,
    overallConfidence: verified.length ? round(mean(verified.map((d) => d.confidence))!, 3) : domains.length ? round(mean(domains.map((d) => d.confidence))!, 3) : null,
    testsCompleted: tests ?? 0, lastAssessedAt: last ? new Date(last).toISOString() : null,
    domains, claimedOnly: agent.claimedDomains.filter((s) => !assessed.has(s)), recommendations,
  };
}

export async function getGaps(agentId: string) {
  const caps = await capabilitiesWithDomains(agentId);
  const gaps = [];
  for (const { c, d } of caps) {
    if (c.accuracy >= QUALITY.ACCURACY_TARGET && c.verified) continue;
    gaps.push({
      domainSlug: d.slug, domainName: d.name, score: c.score, accuracy: c.accuracy, target: QUALITY.ACCURACY_TARGET,
      gap: round(Math.max(0, QUALITY.ACCURACY_TARGET - c.accuracy), 1), verified: c.verified, sampleSize: c.sampleSize,
      failureBreakdown: c.failureBreakdown, weaknesses: c.weaknesses, hallucinationRate: c.hallucinationRate,
      suggestedTrainers: await suggestTrainers(d.id, agentId),
    });
  }
  return gaps.sort((a, b) => a.score - b.score);
}

export async function qualityDashboard(orgId: string) {
  const agents = await db().select().from(schema.agents).where(and(eq(schema.agents.orgId, orgId), isNull(schema.agents.deletedAt)));
  const ids = agents.map((a) => a.id);
  const caps = ids.length ? await db().select({ c: schema.agentCapabilities, d: schema.capabilityDomains }).from(schema.agentCapabilities)
    .innerJoin(schema.capabilityDomains, eq(schema.capabilityDomains.id, schema.agentCapabilities.domainId))
    .where(inArray(schema.agentCapabilities.agentId, ids)) : [];
  const results = await db().select({
    answerType: schema.benchmarkQuestions.answerType, correct: schema.assessmentResults.correct, failure: schema.assessmentResults.failureCategory,
  }).from(schema.assessmentResults)
    .innerJoin(schema.capabilityAssessments, eq(schema.capabilityAssessments.id, schema.assessmentResults.assessmentId))
    .innerJoin(schema.benchmarkQuestions, eq(schema.benchmarkQuestions.id, schema.assessmentResults.questionId))
    .where(and(eq(schema.capabilityAssessments.orgId, orgId), eq(schema.capabilityAssessments.status, 'completed')));
  const [{ completed }] = await db().select({ completed: sql<number>`count(*)::int` }).from(schema.capabilityAssessments)
    .where(and(eq(schema.capabilityAssessments.orgId, orgId), eq(schema.capabilityAssessments.status, 'completed')));
  const lr = await db().select().from(schema.learningRecords).where(eq(schema.learningRecords.orgId, orgId));
  const abst = results.filter((r) => r.answerType === 'abstain');
  const safety = results.filter((r) => r.answerType === 'refusal');
  const rate = (xs: { correct: boolean }[]) => (xs.length ? round((xs.filter((x) => x.correct).length / xs.length) * 100, 1) : null);
  const imp = lr.map((r) => r.improvement).filter((v): v is number => v !== null);
  const ret = lr.map((r) => r.retentionScore).filter((v): v is number => v !== null);

  const byDomain = new Map<string, typeof caps>();
  for (const row of caps) byDomain.set(row.d.slug, [...(byDomain.get(row.d.slug) ?? []), row]);
  const domains = [...byDomain].map(([slug, rows]) => ({
    slug, name: rows[0]!.d.name, agents: rows.length,
    accuracy: round(mean(rows.map((r) => r.c.accuracy))!, 1), score: round(mean(rows.map((r) => r.c.score))!, 1),
    hallucinationRate: round(mean(rows.map((r) => r.c.hallucinationRate))!, 3), consistency: nn(rows.map((r) => r.c.consistency)).length ? round(mean(nn(rows.map((r) => r.c.consistency)))!, 3) : null,
    confidence: round(mean(rows.map((r) => r.c.confidence))!, 3), sampleSize: rows.reduce((s, r) => s + r.c.sampleSize, 0),
    verifiedAgents: rows.filter((r) => r.c.verified).length,
    meetsTarget: rows.every((r) => r.c.sampleSize >= QUALITY.MIN_SAMPLE_FOR_TARGET_CLAIM) ? rows.every((r) => r.c.accuracy >= QUALITY.ACCURACY_TARGET) : null,
  }));
  return {
    targets: { accuracy: QUALITY.ACCURACY_TARGET, minSampleForVerified: QUALITY.MIN_SAMPLE_FOR_VERIFIED, minConfidenceForVerified: QUALITY.MIN_CONFIDENCE_FOR_VERIFIED, minSampleForTargetClaim: QUALITY.MIN_SAMPLE_FOR_TARGET_CLAIM },
    totals: {
      agents: agents.length, assessedAgents: new Set(caps.map((c) => c.c.agentId)).size, assessmentsCompleted: completed ?? 0, gradedResponses: results.length,
      accuracy: rate(results),
      hallucinationRate: abst.length ? round((abst.filter((r) => !r.correct).length / abst.length) * 100, 1) : null,
      consistency: nn(caps.map((c) => c.c.consistency)).length ? round(mean(nn(caps.map((c) => c.c.consistency)))! * 100, 1) : null,
      evaluationConfidence: caps.length ? round(mean(caps.map((c) => c.c.confidence))!, 3) : null,
      learningImprovement: imp.length ? round(mean(imp)!, 1) : null,
      retention: ret.length ? round(mean(ret)!, 1) : null,
      safetyCompliance: rate(safety),
      sampleSize: caps.reduce((s, c) => s + c.c.sampleSize, 0),
    },
    domains,
    agents: agents.map((a) => ({
      id: a.id, name: a.name, overallScore: a.overallScore ?? null,
      domains: caps.filter((c) => c.c.agentId === a.id).map((c) => ({ slug: c.d.slug, score: c.c.score, accuracy: c.c.accuracy, verified: c.c.verified, sampleSize: c.c.sampleSize })),
    })),
  };
}

/** Admin human review of an individual graded result. Re-grading is recorded, never silently changed. */
export async function recordHumanReview(input: { resultId: string; reviewerId: string; verdict: 'upheld' | 'overturned'; score?: number | null; notes?: string }) {
  const [r] = await db().select().from(schema.assessmentResults).where(eq(schema.assessmentResults.id, input.resultId)).limit(1);
  if (!r) return null;
  const [ev] = await db().insert(schema.evaluations).values({ assessmentResultId: r.id, reviewerId: input.reviewerId, verdict: input.verdict, score: input.score ?? null, notes: input.notes ?? '' }).returning();
  const patch: Partial<typeof schema.assessmentResults.$inferInsert> = { needsHumanReview: false };
  if (input.verdict === 'overturned' && typeof input.score === 'number') {
    patch.score = Math.max(0, Math.min(1, input.score)); patch.correct = patch.score >= 0.999;
    patch.evaluationMethod = `${r.evaluationMethod}+human_review`;
  }
  await db().update(schema.assessmentResults).set(patch).where(eq(schema.assessmentResults.id, r.id));
  return ev;
}
