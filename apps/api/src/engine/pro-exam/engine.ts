/**
 * Professional exam engine (orchestration + DB). Pure parts live in ability.ts, grading.ts, render.ts, selection.ts.
 *
 * Two exam modes share this engine:
 *   - adaptive ('certification' | 'practice'): one domain, items chosen by performance, sent in steps of BATCH_SIZE (2)
 *     items together (same current tier, different subtopics). Default 10 items (max 30); stops early when SE < 0.4
 *     after ≥ 6 graded items.
 *   - 'screening' (auto-evaluation on connect): 2 items in each of up to 6 domains, ALL sent at once (sync agents:
 *     bounded concurrency 4; prompt agents: one batch of tasks for a single check-in); per-domain results form the
 *     strengths map, then a full adaptive exam starts automatically in the best 1–2 domains (see auto.ts).
 *
 * Lifecycle: queued → running → completed | awaiting_judge | failed | cancelled ('grading' while a regrade finalizes).
 * Grading is inline the moment an answer arrives (the judge is local and fast). Items the judge cannot grade (it errored)
 * stay 'awaiting_judge' and do not move the tier; the exam then ends as 'awaiting_judge'
 * with NO score until finalizeExamIfReady() / POST /:id/regrade grades them.
 *
 * Adaptive overall score (only when every item is graded):
 *   abilityScore = θ mapped linearly from [−3, +3] to [0, 100];  rawMean = mean graded item score (0-100)
 *   score        = 0.6 × abilityScore + 0.4 × rawMean
 * Adaptive confidence (0-1) = min(1, graded / 10) × (0.5 + 0.5 × seFactor) × (0.7 + 0.3 × judgeReliability)
 *   seFactor = clamp((1 − SE) / 0.7, 0, 1); judgeReliability = mean over judged items of (agreement.agreed ? 1 : 0)
 *   when the judge reports pass agreement, else its `confidence` (0-1), else 1.
 * Screening score = mean graded item score; screening confidence = 0.5 × graded / items (a screen, never a certificate).
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { DOMAINS } from '@aix/shared';
import { db, schema } from '../../db/client.js';
import { enqueue } from '../../jobs/queue.js';
import { notifyOrg } from '../../lib/notify.js';
import { publish } from '../../ws/hub.js';
import { buildInvocationSystem, invokeAgent } from '../../adapters/index.js';
import { cleanText, inboxEvents, MAX_RESULT_CHARS, promptConfig } from '../../lib/agent-inbox.js';
import { AppError, unprocessable } from '../../lib/errors.js';
import { assertAgentActive } from '../../modules/owner-controls/service.js';
import { recomputeCertification } from '../../modules/certification/service.js';
import { judgeAgainstRubric, proJudgeAvailable, type JudgeResult } from '../pro-judge.js';
import {
  BATCH_SIZE, DEFAULT_TARGET_ITEMS, MAX_TARGET_ITEMS, START_TIER, abilityToScore, difficultyOf, estimateAbility, nextTier, round, shouldStop, type Tier,
} from './ability.js';
import { combineItemGrade, computeAxes, runDeterministicChecks, type AxisItem, type CheckResult } from './grading.js';
import { renderPrompt, variationRubricNote, variationText } from './render.js';
import { normaliseRubric } from './rubric.js';
import { checkPool, examRandom, forgetSeed, loadPool, newSeed, pickNext, rememberSeed, type ExamMode, type ProQuestion } from './selection.js';

export const PRO_EXAM_STEP_JOB = 'pro_exam.step';
export const PRO_EXAM_SWEEP_JOB = 'pro_exam.sweep';
export const SWEEP_INTERVAL_MS = 5 * 60_000;
export const MIN_TARGET_ITEMS = 4;
export const TWIST_PROBABILITY = 0.5;
export const SYNC_CONCURRENCY = 4;
export const SCREENING_ITEMS_PER_DOMAIN = 2;
export const SCREENING_MAX_DOMAINS = 6;
const SYNC_STALE_MS = 10 * 60_000;
const MAX_FAILED_ITEMS = 3;

export type Exam = typeof schema.proExams.$inferSelect;
export type ExamItem = typeof schema.proExamItems.$inferSelect;
type Agent = typeof schema.agents.$inferSelect;
export type AnyMode = ExamMode | 'screening';
const ACTIVE = ['queued', 'running', 'grading'];
const OPEN = ['queued', 'running', 'grading', 'awaiting_judge'];
const FINAL_ITEM = ['graded', 'awaiting_judge', 'timeout', 'error'];

export const channelOf = (examId: string) => `pro-exam:${examId}`;
export const examLink = (examId: string) => `/app/evaluation/exams/${examId}`;
export const domainName = (slug: string) => DOMAINS.find((d) => d.slug === slug)?.name ?? slug;

/** Async (inbox) item deadline (env PRO_EXAM_TASK_TTL_HOURS, default 24). */
export function proExamTaskTtlMs(): number {
  const v = Number(process.env.PRO_EXAM_TASK_TTL_HOURS);
  return (Number.isFinite(v) && v > 0 ? v : 24) * 3_600_000;
}

/* ───────────── per-key lock (single process) ───────────── */

const locks = new Map<string, Promise<void>>();
export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(() => undefined, () => undefined);
  locks.set(key, tail);
  void tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return run;
}

/* ───────────── helpers ───────────── */

export async function adapterOf(agent: Pick<Agent, 'providerId'>): Promise<string | null> {
  const [p] = await db().select({ adapter: schema.agentProviders.adapter }).from(schema.agentProviders).where(eq(schema.agentProviders.id, agent.providerId)).limit(1);
  return p?.adapter ?? null;
}

/** Question ids this agent has been served in any exam (screening included). */
export async function seenQuestionIds(agentId: string): Promise<Set<string>> {
  const rows = await db().select({ q: schema.proExamItems.questionId }).from(schema.proExamItems)
    .innerJoin(schema.proExams, eq(schema.proExams.id, schema.proExamItems.examId)).where(eq(schema.proExams.agentId, agentId));
  return new Set(rows.map((r) => r.q));
}

export async function loadExam(id: string) {
  const [e] = await db().select().from(schema.proExams).where(eq(schema.proExams.id, id)).limit(1);
  return e ?? null;
}

export async function itemsWithQuestions(examId: string) {
  return db().select({ item: schema.proExamItems, q: schema.proQuestions }).from(schema.proExamItems)
    .innerJoin(schema.proQuestions, eq(schema.proQuestions.id, schema.proExamItems.questionId))
    .where(eq(schema.proExamItems.examId, examId)).orderBy(asc(schema.proExamItems.position));
}
type Row = Awaited<ReturnType<typeof itemsWithQuestions>>[number];
const rep = (e: Pick<Exam, 'report'>) => (e.report ?? {}) as Record<string, unknown>;

async function requireConnected(agent: Agent, adapter: string | null) {
  if (adapter !== 'inbox') return;
  const [conn] = await db().select().from(schema.agentConnections).where(eq(schema.agentConnections.agentId, agent.id)).limit(1);
  if (!promptConfig(conn).verifiedAt) throw unprocessable('This agent has not finished connecting yet. Paste the connect prompt into your agent and wait for "Connected" before starting an exam.');
}

/* ───────────── pool / start ───────────── */

export async function poolInfo(domainSlug: string, targetItems = DEFAULT_TARGET_ITEMS, agentId?: string) {
  const [cert, practice] = await Promise.all([loadPool(domainSlug, 'certification'), loadPool(domainSlug, 'practice')]);
  const seen = agentId ? await seenQuestionIds(agentId) : new Set<string>();
  return {
    domainSlug, targetItems,
    certification: { ...checkPool(cert, 'certification', targetItems), unseen: cert.filter((q) => !seen.has(q.id)).length },
    practice: { ...checkPool(practice, 'practice', targetItems), unseen: practice.filter((q) => !seen.has(q.id)).length },
  };
}

export interface StartInput {
  agentId: string; orgId: string; requestedBy: string | null; domainSlug: string; mode: ExamMode; targetItems?: number;
  /** started automatically (auto-evaluation); `next` = further domains to examine after this one */
  auto?: { trigger: string; screeningId?: string; next?: string[] };
}

/** Validate and create an adaptive exam (status queued) and enqueue its first step. Throws AppError with a clear message. */
export async function startExam(input: StartInput): Promise<Exam> {
  const target = Math.max(MIN_TARGET_ITEMS, Math.min(MAX_TARGET_ITEMS, Math.round(input.targetItems ?? DEFAULT_TARGET_ITEMS)));
  if (!DOMAINS.some((d) => d.slug === input.domainSlug)) throw unprocessable(`Unknown domain: ${input.domainSlug}`);
  await assertAgentActive(input.agentId);
  const [agent] = await db().select().from(schema.agents).where(eq(schema.agents.id, input.agentId)).limit(1);
  if (!agent || agent.orgId !== input.orgId) throw new AppError(404, 'not_found', 'Agent not found');
  const adapter = await adapterOf(agent);
  await requireConnected(agent, adapter);
  const open = await db().select({ id: schema.proExams.id }).from(schema.proExams)
    .where(and(eq(schema.proExams.agentId, agent.id), inArray(schema.proExams.status, ACTIVE)));
  if (open.length) throw new AppError(409, 'exam_in_progress', 'This agent already has a professional exam in progress — finish or cancel it first.');

  const pool = await loadPool(input.domainSlug, input.mode);
  const check = checkPool(pool, input.mode, target);
  if (!check.ok) throw unprocessable(check.message ?? 'Not enough questions', { pool: { available: check.available, needed: check.needed, perBand: check.perBand, neededPerBand: check.neededPerBand } });
  const seen = await seenQuestionIds(agent.id);
  const unseen = pool.filter((q) => !seen.has(q.id)).length;
  let targetItems = target;
  if (input.mode === 'certification' && unseen < target) {
    throw unprocessable(`This agent has already been served ${pool.length - unseen} of the ${pool.length} certification questions in this domain; only ${unseen} unseen remain and a ${target}-item exam needs ${target}. Questions are never repeated — wait for new reviewed questions.`);
  }
  if (input.mode === 'practice') {
    if (unseen < Math.min(3, target)) throw unprocessable(`This agent has already seen ${pool.length - unseen} of the ${pool.length} practice questions in this domain; at least 3 unseen are needed.`);
    targetItems = Math.min(target, unseen);
  }

  const { seed, hash } = newSeed();
  const [exam] = await db().insert(schema.proExams).values({
    agentId: agent.id, orgId: agent.orgId, domainSlug: input.domainSlug, requestedBy: input.requestedBy, status: 'queued',
    mode: input.mode, seedHash: hash, targetItems,
    report: {
      currentTier: START_TIER, trajectory: [], delivery: adapter === 'inbox' ? 'async' : 'sync',
      pool: { available: check.available, perBand: check.perBand, unseen }, ...(input.auto ? { auto: input.auto } : {}),
    },
  }).returning();
  rememberSeed(exam!.id, seed);
  await enqueue(PRO_EXAM_STEP_JOB, { examId: exam!.id }, { maxAttempts: 3 });
  return exam!;
}

/** Create a screening exam over `domains` (2 items each, all sent at once). Caller checks auto-evaluation rules. */
export async function startScreening(agent: Agent, domains: string[], opts: { trigger: string; requestedBy?: string | null; followUp?: boolean }): Promise<Exam> {
  const adapter = await adapterOf(agent);
  await requireConnected(agent, adapter);
  const { seed, hash } = newSeed();
  const [exam] = await db().insert(schema.proExams).values({
    agentId: agent.id, orgId: agent.orgId, domainSlug: 'screening', requestedBy: opts.requestedBy ?? null, status: 'queued',
    mode: 'screening', seedHash: hash, targetItems: domains.length * SCREENING_ITEMS_PER_DOMAIN,
    report: { delivery: adapter === 'inbox' ? 'async' : 'sync', screening: { domains, trigger: opts.trigger, followUp: opts.followUp !== false } },
  }).returning();
  rememberSeed(exam!.id, seed);
  await enqueue(PRO_EXAM_STEP_JOB, { examId: exam!.id }, { maxAttempts: 3 }); // wakes the worker immediately
  return exam!;
}

/* ───────────── state ───────────── */

export interface ExamState {
  tier: Tier; theta: number; se: number; graded: number; awaiting: number; errors: number; timeouts: number; consumed: number;
  trajectory: { position: number; tier: string; score: number | null; status: string; ability: number; se: number }[];
}

export function computeState(rows: { item: Pick<ExamItem, 'position' | 'status' | 'score'>; q: Pick<ProQuestion, 'difficulty' | 'irt'> }[]): ExamState {
  let tier: Tier = START_TIER;
  const responses: { a: number; b: number; score: number }[] = [];
  const trajectory: ExamState['trajectory'] = [];
  let graded = 0, awaiting = 0, errors = 0, timeouts = 0;
  let est = { theta: 0, se: 1 };
  for (const { item, q } of rows) {
    if (item.status === 'graded' && item.score !== null) {
      graded++;
      responses.push({ ...difficultyOf(q), score: item.score });
      est = estimateAbility(responses);
      tier = nextTier(tier, item.score);
    } else if (item.status === 'awaiting_judge') awaiting++;
    else if (item.status === 'error') errors++;
    else if (item.status === 'timeout') timeouts++;
    trajectory.push({ position: item.position, tier: q.difficulty, score: item.status === 'graded' ? item.score : null, status: item.status, ability: est.theta, se: est.se });
  }
  return { tier, theta: est.theta, se: est.se, graded, awaiting, errors, timeouts, consumed: graded + awaiting, trajectory };
}

/* ───────────── grading ───────────── */

async function gradeItem(exam: Pick<Exam, 'id' | 'domainSlug'>, item: ExamItem, q: ProQuestion): Promise<ExamItem> {
  const answer = item.answer ?? '';
  const rubric = normaliseRubric(q.rubric);
  const checks = runDeterministicChecks(q.deterministicChecks, answer);
  const prevChecks = (item.checks ?? {}) as Record<string, unknown>;
  const twistNote = typeof prevChecks.twistRubricNote === 'string' ? prevChecks.twistRubricNote : '';
  let judge: JudgeResult | null = null;
  if (rubric.length && proJudgeAvailable()) {
    try {
      judge = await judgeAgainstRubric({
        domain: q.domainName || domainName(q.domainSlug ?? exam.domainSlug), task: item.renderedPrompt, rubric,
        referenceSolution: [q.referenceSolution, twistNote ? `Variant note (a twist was added to the task): ${twistNote}` : ''].filter(Boolean).join('\n\n'),
        redFlags: q.redFlags ?? [], answer,
        // lets the Hive Judge use this question's own calibration exemplars, traps and expected elements
        refKind: 'exam_item', refId: item.id, questionId: q.id, domainSlug: q.domainSlug ?? exam.domainSlug,
        caseMaterial: q.caseMaterial || undefined,
      });
    } catch (e) {
      judge = { status: 'error', scores: {}, total: 0, redFlagsFired: [], rationale: 'The judge failed.', model: null, error: e instanceof Error ? e.message : String(e) };
    }
  }
  const g = combineItemGrade(rubric, checks, judge);
  const judgement = judge
    ? { ...judge, finalScores: g.finalScores, zeroedByChecks: g.zeroedByChecks, ...(g.reason ? { reason: g.reason } : {}) }
    : { status: rubric.length ? 'awaiting_judge' : 'not_needed', reason: g.reason ?? null };
  const [row] = await db().update(schema.proExamItems).set({
    status: g.status, score: g.score, checks: { ...prevChecks, results: checks }, judgement: judgement as Record<string, unknown>,
  }).where(eq(schema.proExamItems.id, item.id)).returning();
  publish(channelOf(exam.id), 'item_graded', { examId: exam.id, itemId: item.id, position: item.position, status: g.status, score: g.score, domain: q.domainSlug });
  return row!;
}

/** Per-item judge reliability in [0, 1] (agreement if reported, else confidence, else 1). */
function judgeReliability(j: Record<string, unknown>): number {
  const ag = j.agreement as { agreed?: boolean } | undefined;
  if (ag && typeof ag.agreed === 'boolean') return ag.agreed ? 1 : 0;
  const c = j.confidence;
  return typeof c === 'number' && Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 1;
}

/* ───────────── dispatch ───────────── */

interface Planned { q: ProQuestion; twist: string | null; twistSource: string | null; twistRubricNote: string | null }

async function chooseTwist(q: ProQuestion, rand: () => number): Promise<Omit<Planned, 'q'>> {
  if (rand() >= TWIST_PROBABILITY) return { twist: null, twistSource: null, twistRubricNote: null };
  const vars = (q.variations ?? []).filter((v) => variationText(v));
  if (vars.length) {
    const v = vars[Math.floor(rand() * vars.length)]!;
    return { twist: variationText(v), twistSource: 'question', twistRubricNote: variationRubricNote(v) };
  }
  if (q.domainSlug) {
    const tw = await db().select().from(schema.proTwists).where(eq(schema.proTwists.domainSlug, q.domainSlug));
    if (tw.length) { const t = tw[Math.floor(rand() * tw.length)]!; return { twist: t.twist, twistSource: 'domain', twistRubricNote: t.rubricEffect || null }; }
  }
  return { twist: null, twistSource: null, twistRubricNote: null };
}

/** Insert planned items, bump times_served, then send them all (inbox: one batch of tasks; sync: bounded concurrency). */
async function insertAndDispatch(exam: Exam, agent: Agent, planned: Planned[], startPosition: number): Promise<'waiting' | 'continue'> {
  const items: { item: ExamItem; q: ProQuestion }[] = [];
  for (const [i, p] of planned.entries()) {
    const [item] = await db().insert(schema.proExamItems).values({
      examId: exam.id, questionId: p.q.id, position: startPosition + i, twist: p.twist, renderedPrompt: renderPrompt(p.q, p.twist), status: 'pending',
      checks: { twistSource: p.twistSource, twistRubricNote: p.twistRubricNote },
    }).returning();
    items.push({ item: item!, q: p.q });
  }
  await db().update(schema.proQuestions).set({ timesServed: sql`${schema.proQuestions.timesServed} + 1` }).where(inArray(schema.proQuestions.id, planned.map((p) => p.q.id)));
  publish(channelOf(exam.id), 'items_sent', { examId: exam.id, items: items.map(({ item, q }) => ({ itemId: item.id, position: item.position, tier: q.difficulty, domain: q.domainSlug })) });

  const adapter = await adapterOf(agent);
  if (adapter === 'inbox') {
    const ttl = proExamTaskTtlMs();
    const tasks: (typeof schema.agentTasks.$inferInsert)[] = [];
    for (const { item, q } of items) {
      const messages = [{ role: 'user' as const, content: item.renderedPrompt }];
      const { system } = await buildInvocationSystem(agent, { messages }, { withContext: true, contextQuery: q.task });
      tasks.push({ agentId: agent.id, orgId: agent.orgId, kind: 'pro_exam', status: 'pending', deadline: new Date(Date.now() + ttl),
        request: { messages, system: system || null }, meta: { examId: exam.id, itemId: item.id } });
    }
    await db().transaction(async (tx) => {
      await tx.insert(schema.agentTasks).values(tasks);
      await tx.update(schema.proExamItems).set({ status: 'sent' }).where(inArray(schema.proExamItems.id, items.map((x) => x.item.id)));
    });
    inboxEvents.emit(`agent:${agent.id}`);
    await ensureSweepScheduled().catch(() => undefined);
    return 'waiting';
  }

  await db().update(schema.proExamItems).set({ status: 'sent' }).where(inArray(schema.proExamItems.id, items.map((x) => x.item.id)));
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const { item, q } = items[next++]!;
      try {
        const r = await invokeAgent(agent.id, { messages: [{ role: 'user', content: item.renderedPrompt }], purpose: 'assessment', temperature: 0, maxTokens: 2000, timeoutMs: 120_000 },
          { withContext: true, contextQuery: q.task });
        const [answered] = await db().update(schema.proExamItems).set({ status: 'answered', answer: cleanText(r.text ?? '', MAX_RESULT_CHARS), answeredAt: new Date() })
          .where(eq(schema.proExamItems.id, item.id)).returning();
        await gradeItem(exam, answered!, q);
      } catch (err) {
        await db().update(schema.proExamItems).set({ status: 'error', answer: `[error] ${err instanceof Error ? err.message : String(err)}`.slice(0, 500) })
          .where(eq(schema.proExamItems.id, item.id));
        publish(channelOf(exam.id), 'item_graded', { examId: exam.id, itemId: item.id, position: item.position, status: 'error', score: null });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SYNC_CONCURRENCY, items.length) }, worker));
  return 'continue';
}

/* ───────────── stepping ───────────── */

async function failExam(exam: Pick<Exam, 'id' | 'orgId' | 'agentId'>, message: string) {
  const [row] = await db().update(schema.proExams).set({ status: 'failed', failureReason: message, completedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(schema.proExams.id, exam.id), inArray(schema.proExams.status, ACTIVE))).returning({ id: schema.proExams.id });
  if (!row) return;
  await expireExamTasks(exam.id);
  forgetSeed(exam.id);
  publish(channelOf(exam.id), 'failed', { examId: exam.id, error: message });
  await notifyOrg(exam.orgId, 'evaluation_result', 'Professional exam failed', message, examLink(exam.id)).catch(() => undefined);
}

/**
 * Advance an exam: grade answered items, then send the next batch (adaptive) or all items (screening), or finalize.
 * Returns 'continue' when another step can run right away (sync agents), 'waiting' when answers are outstanding,
 * 'done' when the exam is finished / not running. Serialized per exam.
 */
export function advanceExam(examId: string): Promise<'continue' | 'waiting' | 'done'> {
  return withLock(examId, () => stepLocked(examId));
}

/** Run steps until the exam waits for async answers or is done (job handler, tests). */
export async function runExamUntilIdle(examId: string, maxSteps = 40): Promise<'waiting' | 'done'> {
  for (let i = 0; i < maxSteps; i++) {
    const r = await advanceExam(examId);
    if (r !== 'continue') return r;
  }
  return 'waiting';
}

async function gradeOutstanding(exam: Exam): Promise<Row[]> {
  const rows = await itemsWithQuestions(exam.id);
  const delivery = rep(exam).delivery;
  for (const r of rows) {
    if (r.item.status === 'answered') r.item = await gradeItem(exam, r.item, r.q);
    else if ((r.item.status === 'pending' || (r.item.status === 'sent' && delivery !== 'async')) && Date.now() - r.item.createdAt.getTime() > SYNC_STALE_MS) {
      [r.item] = await db().update(schema.proExamItems).set({ status: 'error', answer: '[error] the item was interrupted before the agent answered' })
        .where(eq(schema.proExamItems.id, r.item.id)).returning() as [ExamItem];
    }
  }
  return rows;
}

async function stepLocked(examId: string): Promise<'continue' | 'waiting' | 'done'> {
  let exam = await loadExam(examId);
  if (!exam || !['queued', 'running'].includes(exam.status)) return 'done';
  if (exam.status === 'queued') {
    [exam] = await db().update(schema.proExams).set({ status: 'running', startedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(schema.proExams.id, examId), eq(schema.proExams.status, 'queued'))).returning();
    if (!exam) return 'done';
    publish(channelOf(examId), 'started', { examId, mode: exam.mode });
  }
  let rows = await gradeOutstanding(exam);
  if (rows.some((r) => !FINAL_ITEM.includes(r.item.status))) return 'waiting';

  const [agent] = await db().select().from(schema.agents).where(eq(schema.agents.id, exam.agentId)).limit(1);
  if (!agent) { await failExam(exam, 'Agent not found'); return 'done'; }
  const rand = examRandom(exam.id);

  /* screening: plan + send everything once, finalize when all items are final */
  if (exam.mode === 'screening') {
    if (!rows.length) {
      const domains = ((rep(exam).screening ?? {}) as { domains?: string[] }).domains ?? [];
      const seen = await seenQuestionIds(exam.agentId);
      const planned: Planned[] = [];
      for (const d of domains) {
        const pool = await loadPool(d, 'certification');
        const used: string[] = [];
        for (let k = 0; k < SCREENING_ITEMS_PER_DOMAIN; k++) {
          const q = pickNext(pool, { tier: START_TIER, seen, usedSubtopics: used, usedTaskTypes: [] }, rand);
          if (!q) break;
          seen.add(q.id); used.push(q.subtopic);
          planned.push({ q, ...(await chooseTwist(q, rand)) });
        }
      }
      if (!planned.length) { await failExam(exam, 'No unseen reviewed questions are available in the screening domains.'); return 'done'; }
      await db().update(schema.proExams).set({ targetItems: planned.length, updatedAt: new Date() }).where(eq(schema.proExams.id, exam.id));
      if (!(await activeOrFail(exam))) return 'done';
      const r = await insertAndDispatch({ ...exam, targetItems: planned.length }, agent, planned, 1);
      if (r === 'waiting') return 'waiting';
      rows = await itemsWithQuestions(exam.id);
    }
    if (rows.some((r) => !FINAL_ITEM.includes(r.item.status))) return 'waiting';
    await finalizeExam(exam.id, 'screening_complete');
    return 'done';
  }

  /* adaptive */
  const st = computeState(rows);
  await saveState(exam, st);
  const failed = st.errors + st.timeouts;
  if (failed >= MAX_FAILED_ITEMS) {
    const last = [...rows].reverse().find((r) => r.item.status === 'error' || r.item.status === 'timeout');
    await failExam(exam, `The agent did not answer ${failed} exam items (errors or timeouts). Last: ${(last?.item.answer ?? '').slice(0, 200)}`);
    return 'done';
  }
  const stop = shouldStop(st.graded, st.consumed, st.se, exam.targetItems);
  if (stop) { await finalizeExam(exam.id, stop); return 'done'; }

  const pool = await loadPool(exam.domainSlug, exam.mode as ExamMode);
  const seen = await seenQuestionIds(exam.agentId);
  const usedSub = rows.map((r) => r.q.subtopic), usedTask = rows.map((r) => r.q.taskType);
  const batch = Math.max(1, Math.min(BATCH_SIZE, exam.targetItems - st.consumed));
  const planned: Planned[] = [];
  for (let k = 0; k < batch; k++) {
    const q = pickNext(pool, { tier: st.tier, seen, usedSubtopics: usedSub, usedTaskTypes: usedTask }, rand);
    if (!q) break;
    seen.add(q.id); usedSub.push(q.subtopic); usedTask.push(q.taskType);
    planned.push({ q, ...(await chooseTwist(q, rand)) });
  }
  if (!planned.length) {
    if (st.consumed > 0) { await finalizeExam(exam.id, 'pool_exhausted'); return 'done'; }
    await failExam(exam, 'No unseen questions are left for this agent in this domain.');
    return 'done';
  }
  if (!(await activeOrFail(exam))) return 'done';
  return insertAndDispatch(exam, agent, planned, rows.length + 1);
}

/** Owner controls: no new items for a paused / suspended / disconnected agent (the exam fails with the reason). */
async function activeOrFail(exam: Exam): Promise<boolean> {
  try { await assertAgentActive(exam.agentId); return true; } catch (e) {
    await failExam(exam, `Exam stopped: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

async function saveState(exam: Exam, st: ExamState) {
  await db().update(schema.proExams).set({
    ability: st.graded ? st.theta : null, abilitySe: st.graded ? st.se : null,
    report: { ...rep(exam), currentTier: st.tier, trajectory: st.trajectory, counts: { graded: st.graded, awaitingJudge: st.awaiting, errors: st.errors, timeouts: st.timeouts } },
    updatedAt: new Date(),
  }).where(eq(schema.proExams.id, exam.id));
  publish(channelOf(exam.id), 'progress', { examId: exam.id, tier: st.tier, ability: st.theta, se: st.se, graded: st.graded, awaiting: st.awaiting, target: exam.targetItems });
}

/* ───────────── finalize ───────────── */

export function examScore(theta: number, itemScores: number[]): { abilityScore: number; rawMean: number; score: number } {
  const abilityScore = abilityToScore(theta);
  const rawMean = itemScores.length ? round(itemScores.reduce((s, v) => s + v, 0) / itemScores.length, 1) : 0;
  return { abilityScore, rawMean, score: round(0.6 * abilityScore + 0.4 * rawMean, 1) };
}

export function examConfidence(graded: number, se: number, judgeRel: number): number {
  const n = Math.min(1, graded / DEFAULT_TARGET_ITEMS);
  const seFactor = Math.max(0, Math.min(1, (1 - se) / 0.7));
  return round(n * (0.5 + 0.5 * seFactor) * (0.7 + 0.3 * judgeRel), 3);
}

export interface ScreeningDomainResult { slug: string; name: string; items: number; graded: number; pending: number; score: number | null }

export function screeningResults(rows: Row[], domains: string[]): ScreeningDomainResult[] {
  return domains.map((slug) => {
    const mine = rows.filter((r) => r.q.domainSlug === slug);
    const g = mine.filter((r) => r.item.status === 'graded' && r.item.score !== null);
    return {
      slug, name: domainName(slug), items: mine.length, graded: g.length, pending: mine.filter((r) => r.item.status === 'awaiting_judge').length,
      score: g.length ? round(g.reduce((s, r) => s + r.item.score!, 0) / g.length, 1) : null,
    };
  }).filter((d) => d.items > 0).sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}

function axisItemsOf(graded: Row[]): AxisItem[] {
  return graded.map((r) => {
    const j = r.item.judgement as { finalScores?: Record<string, number>; redFlagsFired?: string[]; status?: string };
    return {
      taskType: r.q.taskType, rubric: normaliseRubric(r.q.rubric), finalScores: j.finalScores ?? {}, score: r.item.score!,
      redFlagsFired: j.redFlagsFired?.length ?? 0, redFlagsDefined: (r.q.redFlags ?? []).length, judged: j.status === 'done',
    };
  });
}

/**
 * Finalize (race-safe; only the caller that flips running|grading → final applies side effects).
 * 'completed' when every answered item is graded, else 'awaiting_judge' (no score is invented).
 */
export async function finalizeExam(examId: string, stopReason: string): Promise<Exam | null> {
  const exam = await loadExam(examId);
  if (!exam || !['running', 'grading'].includes(exam.status)) return null;
  const rows = await itemsWithQuestions(examId);
  const st = computeState(rows);
  const graded = rows.filter((r) => r.item.status === 'graded' && r.item.score !== null);
  const judged = graded.filter((r) => (r.item.judgement as { status?: string }).status === 'done');
  const judgeRel = judged.length ? judged.reduce((s, r) => s + judgeReliability(r.item.judgement), 0) / judged.length : 1;
  const tokens = judged.reduce((acc, r) => {
    const u = (r.item.judgement as { usage?: { inputTokens?: number; outputTokens?: number; calls?: number } }).usage;
    return { inputTokens: acc.inputTokens + (u?.inputTokens ?? 0), outputTokens: acc.outputTokens + (u?.outputTokens ?? 0), calls: acc.calls + (u?.calls ?? 0) };
  }, { inputTokens: 0, outputTokens: 0, calls: 0 });
  const judgeModel = judged.map((r) => (r.item.judgement as { model?: string | null }).model).find(Boolean) ?? null;
  const screening = exam.mode === 'screening';
  const sDomains = ((rep(exam).screening ?? {}) as { domains?: string[] }).domains ?? [];
  const sResults = screening ? screeningResults(rows, sDomains) : null;
  const baseReport: Record<string, unknown> = {
    ...rep(exam), stopReason,
    counts: { graded: st.graded, awaitingJudge: st.awaiting, errors: st.errors, timeouts: st.timeouts },
    judge: { model: judgeModel, judgedItems: judged.length, reliability: judged.length ? round(judgeRel, 3) : null, tokens },
    ...(screening ? { screening: { ...(rep(exam).screening as object), results: sResults } } : { currentTier: st.tier, trajectory: st.trajectory }),
  };

  if (st.awaiting > 0) {
    const [won] = await db().update(schema.proExams).set({
      status: 'awaiting_judge', score: null, confidence: null, axes: {}, ability: !screening && st.graded ? st.theta : null, abilitySe: !screening && st.graded ? st.se : null,
      judgeModel, completedAt: new Date(), updatedAt: new Date(),
      report: { ...baseReport, note: `${st.awaiting} answer(s) are waiting for the judge (it could not grade them). No score is reported until they are graded.` },
    }).where(and(eq(schema.proExams.id, examId), inArray(schema.proExams.status, ['running', 'grading']))).returning();
    if (!won) return null;
    await expireExamTasks(examId);
    publish(channelOf(examId), 'awaiting_judge', { examId, awaiting: st.awaiting, graded: st.graded });
    await notifyOrg(exam.orgId, 'evaluation_result', screening ? 'Screening awaiting review' : 'Professional exam awaiting review',
      `All answers are in. ${st.awaiting} answer(s) are waiting for the judge; the score will appear once they are graded.`, examLink(examId)).catch(() => undefined);
    return won;
  }
  const failedItems = st.errors + st.timeouts;
  if (!graded.length || (screening && failedItems > rows.length / 2)) {
    await failExam(exam, graded.length ? `The agent answered only ${graded.length} of ${rows.length} screening items.` : 'No exam item could be graded.');
    return null;
  }

  const axes = computeAxes(axisItemsOf(graded));
  let score: number; let confidence: number; let scoring: Record<string, unknown>;
  if (screening) {
    score = round(graded.reduce((s, r) => s + r.item.score!, 0) / graded.length, 1);
    confidence = round(0.5 * (graded.length / Math.max(1, rows.length)), 3);
    scoring = { formula: 'screening score = mean graded item score; confidence = 0.5 × graded / items' };
  } else {
    const sc = examScore(st.theta, graded.map((r) => r.item.score!));
    score = sc.score; confidence = examConfidence(st.graded, st.se, judgeRel);
    scoring = { ...sc, formula: 'score = 0.6 × abilityScore + 0.4 × rawMean; abilityScore = (θ + 3) / 6 × 100' };
  }
  const [won] = await db().update(schema.proExams).set({
    status: 'completed', score, axes, confidence, ability: screening ? null : st.theta, abilitySe: screening ? null : st.se, judgeModel,
    completedAt: new Date(), updatedAt: new Date(), report: { ...baseReport, scoring, note: null },
  }).where(and(eq(schema.proExams.id, examId), inArray(schema.proExams.status, ['running', 'grading']))).returning();
  if (!won) return null;
  forgetSeed(examId);
  await expireExamTasks(examId);
  const [agent] = await db().select().from(schema.agents).where(eq(schema.agents.id, exam.agentId)).limit(1);
  publish(channelOf(examId), 'completed', { examId, score, axes, confidence, ...(sResults ? { screening: sResults } : {}) });

  if (screening) {
    await notifyOrg(exam.orgId, 'evaluation_result', `Screening complete: ${agent?.name ?? 'agent'}`,
      `Strongest: ${sResults!.slice(0, 3).map((d) => `${d.name} ${d.score ?? '—'}`).join(', ')}.`, examLink(examId)).catch(() => undefined);
    if (agent && (rep(exam).screening as { followUp?: boolean })?.followUp !== false) await startFollowUp(won, agent, sResults!);
  } else {
    await recomputeCertification(exam.agentId, exam.domainSlug).catch((e) => console.error('[pro-exam] recomputeCertification failed', e));
    await notifyOrg(exam.orgId, 'evaluation_result', `Professional exam complete: ${agent?.name ?? 'agent'}`,
      `${domainName(exam.domainSlug)} (${exam.mode}): ${score}/100 over ${st.graded} items, confidence ${Math.round(confidence * 100)}%.`, examLink(examId)).catch(() => undefined);
    await continueAutoChain(won).catch((e) => console.error('[pro-exam] auto chain failed', e));
  }
  return won;
}

/** Best certification-or-practice mode for an automatic full exam in `slug` (null = not enough questions). */
export async function autoModeFor(slug: string, agentId: string, target = DEFAULT_TARGET_ITEMS): Promise<ExamMode | null> {
  const info = await poolInfo(slug, target, agentId);
  if (info.certification.ok && info.certification.unseen >= target) return 'certification';
  if (info.practice.ok && info.practice.unseen >= 3) return 'practice';
  return null;
}

/** After a screening: full adaptive exam in the best domain, the second-best (score ≥ 40) chained after it. */
async function startFollowUp(screening: Exam, agent: Agent, results: ScreeningDomainResult[]) {
  const ranked = results.filter((d) => d.score !== null);
  const picks = ranked.slice(0, 2).filter((d, i) => i === 0 || (d.score ?? 0) >= 40).map((d) => d.slug);
  const followUp: Record<string, unknown> = { domains: picks, startedExamId: null, error: null };
  try {
    const started = await startAutoExam(agent, picks, { trigger: 'screening', screeningId: screening.id });
    followUp.startedExamId = started?.id ?? null;
    if (!started) followUp.error = 'No follow-up domain has enough unseen questions for a full exam.';
  } catch (e) { followUp.error = e instanceof Error ? e.message : String(e); }
  await db().update(schema.proExams).set({ report: { ...rep(screening), followUp } }).where(eq(schema.proExams.id, screening.id));
  publish(channelOf(screening.id), 'follow_up', { examId: screening.id, ...followUp });
}

/** Start an automatic full exam in the first workable domain of `domains`; the rest are chained via report.auto.next. */
export async function startAutoExam(agent: Agent, domains: string[], auto: { trigger: string; screeningId?: string }): Promise<Exam | null> {
  for (let i = 0; i < domains.length; i++) {
    const mode = await autoModeFor(domains[i]!, agent.id);
    if (!mode) continue;
    return startExam({ agentId: agent.id, orgId: agent.orgId, requestedBy: null, domainSlug: domains[i]!, mode, auto: { ...auto, next: domains.slice(i + 1) } });
  }
  return null;
}

async function continueAutoChain(exam: Exam) {
  const auto = rep(exam).auto as { trigger: string; screeningId?: string; next?: string[] } | undefined;
  if (!auto?.next?.length) return;
  const [agent] = await db().select().from(schema.agents).where(eq(schema.agents.id, exam.agentId)).limit(1);
  if (!agent) return;
  try { await assertAgentActive(agent.id); } catch { return; }
  await startAutoExam(agent, auto.next, { trigger: auto.trigger, screeningId: auto.screeningId }).catch((e) => console.error('[pro-exam] chained exam not started', e));
}

/* ───────────── async answers, sweep, cancel, regrade ───────────── */

type Task = typeof schema.agentTasks.$inferSelect;

/** onTaskAnswered('pro_exam'): store the (untrusted) answer, grade it inline and advance. Idempotent. */
export async function handleProExamTaskAnswer(task: Task): Promise<void> {
  let meta = task.meta as { examId?: string; itemId?: string } | null;
  if (!meta?.itemId) {
    const [t] = await db().select({ meta: schema.agentTasks.meta }).from(schema.agentTasks).where(eq(schema.agentTasks.id, task.id)).limit(1);
    meta = (t?.meta ?? null) as typeof meta;
  }
  if (!meta?.examId || !meta.itemId || task.status !== 'answered') return;
  const [upd] = await db().update(schema.proExamItems).set({ status: 'answered', answer: cleanText(task.response ?? '', MAX_RESULT_CHARS), answeredAt: task.answeredAt ?? new Date() })
    .where(and(eq(schema.proExamItems.id, meta.itemId), eq(schema.proExamItems.examId, meta.examId), eq(schema.proExamItems.status, 'sent'))).returning({ id: schema.proExamItems.id });
  if (!upd) return;
  publish(channelOf(meta.examId), 'item_answered', { examId: meta.examId, itemId: meta.itemId });
  try {
    await advanceExam(meta.examId); // grades now; sends the next batch / finalizes when the batch is complete
  } catch (e) {
    console.error(`[pro-exam] inline advance failed for ${meta.examId}`, e);
    await enqueue(PRO_EXAM_STEP_JOB, { examId: meta.examId }, { maxAttempts: 3 }); // retry in the background
  }
}

const examTasks = (examId: string) => and(eq(schema.agentTasks.kind, 'pro_exam'), sql`${schema.agentTasks.meta}->>'examId' = ${examId}`);

export async function expireExamTasks(examId: string) {
  const rows = await db().update(schema.agentTasks).set({ status: 'expired' })
    .where(and(examTasks(examId), inArray(schema.agentTasks.status, ['pending', 'delivered']))).returning({ id: schema.agentTasks.id });
  for (const r of rows) inboxEvents.emit(`task:${r.id}`);
  return rows.length;
}

/** Expire overdue pro-exam tasks → items 'timeout', then advance running exams. Self-rescheduling while exams run. */
export async function sweepProExams(): Promise<{ timedOut: number; running: number }> {
  const nowIso = new Date().toISOString();
  const expired = await db().update(schema.agentTasks).set({ status: 'expired' }).where(and(eq(schema.agentTasks.kind, 'pro_exam'),
    inArray(schema.agentTasks.status, ['pending', 'delivered']), sql`${schema.agentTasks.deadline} <= ${nowIso}::timestamptz`)).returning();
  let timedOut = 0;
  for (const t of expired) {
    const m = t.meta as { examId?: string; itemId?: string } | null;
    if (!m?.itemId) continue;
    const [u] = await db().update(schema.proExamItems).set({ status: 'timeout', answer: '[timeout] Not answered before the deadline' })
      .where(and(eq(schema.proExamItems.id, m.itemId), eq(schema.proExamItems.status, 'sent'))).returning({ id: schema.proExamItems.id });
    if (u) timedOut++;
  }
  const running = await db().select({ id: schema.proExams.id }).from(schema.proExams).where(eq(schema.proExams.status, 'running'));
  for (const e of running) await runExamUntilIdle(e.id, 3).catch((err) => console.error(`[pro-exam] sweep advance ${e.id} failed`, err));
  return { timedOut, running: running.length };
}

export async function ensureSweepScheduled() {
  const [q] = await db().select({ id: schema.jobs.id }).from(schema.jobs)
    .where(and(eq(schema.jobs.type, PRO_EXAM_SWEEP_JOB), eq(schema.jobs.status, 'queued'))).limit(1);
  if (!q) await enqueue(PRO_EXAM_SWEEP_JOB, {}, { delayMs: SWEEP_INTERVAL_MS, maxAttempts: 1 });
}

export async function cancelExam(examId: string): Promise<boolean> {
  return withLock(examId, async () => {
    const [row] = await db().update(schema.proExams).set({ status: 'cancelled', failureReason: 'Cancelled by the owner', completedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(schema.proExams.id, examId), inArray(schema.proExams.status, OPEN))).returning({ id: schema.proExams.id });
    await expireExamTasks(examId);
    forgetSeed(examId);
    if (row) publish(channelOf(examId), 'cancelled', { examId });
    return !!row;
  });
}

/**
 * Grade items still 'awaiting_judge' (re-asking the judge — they only exist when the judge errored) and finalize the
 * exam when nothing is pending. Safe to call any time (idempotent). If another module updates an item row itself
 * (status 'graded', score, judgement), calling this afterwards just finalizes.
 */
export async function finalizeExamIfReady(examId: string): Promise<{ regraded: number; stillPending: number; status: string }> {
  return withLock(examId, async () => {
    const exam = await loadExam(examId);
    if (!exam) throw new AppError(404, 'not_found', 'Exam not found');
    if (!['awaiting_judge', 'running', 'grading'].includes(exam.status)) return { regraded: 0, stillPending: 0, status: exam.status };
    const rows = await itemsWithQuestions(examId);
    let regraded = 0, stillPending = 0;
    for (const r of rows.filter((x) => x.item.status === 'awaiting_judge')) {
      const g = await gradeItem(exam, r.item, r.q);
      if (g.status === 'graded') regraded++; else stillPending++;
    }
    let status = exam.status;
    if (exam.status !== 'running' && stillPending === 0) {
      await db().update(schema.proExams).set({ status: 'grading', updatedAt: new Date() }).where(and(eq(schema.proExams.id, examId), inArray(schema.proExams.status, ['awaiting_judge', 'grading'])));
      const fin = await finalizeExam(examId, (rep(exam).stopReason as string) ?? 'regraded');
      status = fin?.status ?? (await loadExam(examId))?.status ?? 'unknown';
    } else if (exam.status === 'running') {
      await enqueue(PRO_EXAM_STEP_JOB, { examId }, { maxAttempts: 3 });
    }
    publish(channelOf(examId), 'regraded', { examId, regraded, stillPending, status });
    return { regraded, stillPending, status };
  });
}

/** POST /:id/regrade (admin or owner): same as finalizeExamIfReady, but refuses exams with nothing to regrade. */
export async function regradeExam(examId: string) {
  const exam = await loadExam(examId);
  if (!exam) throw new AppError(404, 'not_found', 'Exam not found');
  if (!['awaiting_judge', 'running', 'grading'].includes(exam.status)) throw new AppError(409, 'not_regradable', `Exam is ${exam.status}; only exams with answers awaiting the judge can be regraded.`);
  if (!proJudgeAvailable()) throw new AppError(409, 'no_judge', 'No judge is available right now.');
  return finalizeExamIfReady(examId);
}

/* ───────────── read model ───────────── */

/** Client view of an exam. Owners never get rubric, reference, red-flag texts, check specs, seeds or question ids. */
export async function examView(exam: Exam, opts: { admin: boolean }) {
  const rows = await itemsWithQuestions(exam.id);
  const [agent] = await db().select({ id: schema.agents.id, name: schema.agents.name }).from(schema.agents).where(eq(schema.agents.id, exam.agentId)).limit(1);
  const report = { ...rep(exam) };
  delete report.pool; // internal counts, harmless but not needed by clients
  const finished = rows.filter((r) => FINAL_ITEM.includes(r.item.status)).length;
  const items = rows.map(({ item, q }) => {
    const j = (item.judgement ?? {}) as { status?: string; rationale?: string; redFlagsFired?: string[]; agreement?: { agreed?: boolean; runs?: number[] }; reason?: string; confidence?: number; tier?: string };
    const c = (item.checks ?? {}) as { results?: CheckResult[] };
    const base = {
      id: item.id, position: item.position, status: item.status, domainSlug: q.domainSlug, difficulty: q.difficulty, taskType: q.taskType, subtopic: q.subtopic,
      twist: item.twist, prompt: item.renderedPrompt, answer: item.answer, answeredAt: item.answeredAt, score: item.score,
      rationale: j.status === 'done' ? j.rationale ?? '' : null,
      judgeStatus: j.status ?? null, judgeNote: j.status === 'done' ? null : j.reason ?? null,
      judgeTier: j.tier ?? null, judgeConfidence: typeof j.confidence === 'number' ? j.confidence : null,
      redFlagCount: j.redFlagsFired?.length ?? 0,
      judgeAgreement: j.agreement ? { agreed: !!j.agreement.agreed, runs: j.agreement.runs ?? [] } : null,
      checks: (c.results ?? []).map((r) => ({ type: r.type, status: r.status })),
    };
    if (!opts.admin) return base;
    return { ...base, admin: { questionId: q.id, externalId: q.externalId, source: q.source, visibility: q.visibility, judgement: item.judgement, checks: item.checks } };
  });
  const sDomains = ((report.screening ?? {}) as { domains?: string[] }).domains;
  return {
    id: exam.id, agentId: exam.agentId, agent: agent ?? { id: exam.agentId, name: 'Deleted agent' }, orgId: exam.orgId, domainSlug: exam.domainSlug,
    domainName: exam.mode === 'screening' ? 'Screening' : domainName(exam.domainSlug),
    mode: exam.mode, status: exam.status, targetItems: exam.targetItems, ability: exam.ability, abilitySe: exam.abilitySe,
    score: exam.score, axes: exam.axes, confidence: exam.confidence, judgeModel: exam.judgeModel, failureReason: exam.failureReason,
    startedAt: exam.startedAt, completedAt: exam.completedAt, createdAt: exam.createdAt,
    progress: {
      finished, target: exam.targetItems, currentTier: (report.currentTier as string) ?? START_TIER,
      waitingForAgent: rows.some((r) => r.item.status === 'sent'), delivery: (report.delivery as string) ?? 'sync',
    },
    screening: exam.mode === 'screening' && sDomains ? screeningResults(rows, sDomains) : null,
    report, items, judgeAvailable: proJudgeAvailable(),
  };
}

/** Latest screening exam of an agent (any status), or null. */
export async function latestScreening(agentId: string) {
  const [e] = await db().select().from(schema.proExams).where(and(eq(schema.proExams.agentId, agentId), eq(schema.proExams.mode, 'screening')))
    .orderBy(desc(schema.proExams.createdAt)).limit(1);
  return e ?? null;
}
