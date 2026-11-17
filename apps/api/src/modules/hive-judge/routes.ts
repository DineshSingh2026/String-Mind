/** Hive Judge module: status (public-safe), settings, training, metrics, review queue, playground (admin). */
import type { FastifyInstance } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db/client.js';
import { enqueue, registerJob } from '../../jobs/queue.js';
import { requireAdmin } from '../../lib/auth.js';
import { audit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { parse } from '../../lib/http.js';
import { hiveJudge, ensureModel, trainAndSave } from '../../engine/hive-judge/index.js';
import { llmConfigured, llmModelName } from '../../engine/hive-judge/llm.js';
import { getReview, listReviews, resolutionsCount, resolveReview } from '../../engine/hive-judge/review.js';
import { cachedModel, getSettings, loadModel, putSettings } from '../../engine/hive-judge/store.js';
import { normaliseRubric } from '../../engine/pro-judge.js';

const RETRAIN_JOB = 'hive_judge.retrain';
const DAY_MS = 24 * 3600_000;

export default async function routes(app: FastifyInstance) {
  app.get('/status', async () => {
    const m = cachedModel() ?? await loadModel().catch(() => null);
    const s = await getSettings();
    return {
      available: true, tiers: { deterministic: true, localScorer: true, localLlm: llmConfigured() && s.llmEnabled, adminReview: s.reviewEnabled },
      model: m ? { version: m.version, trainedAt: m.trainedAt, answers: (m.data as { answers?: number }).answers ?? null } : null,
      llmModel: llmConfigured() ? llmModelName() : null,
    };
  });

  app.get('/settings', async (req) => { requireAdmin(req); return getSettings(); });
  app.put('/settings', async (req) => {
    const a = requireAdmin(req);
    let v;
    try { v = await putSettings(req.body ?? {}, a.user.id); } catch (e) { throw badRequest('Invalid Hive Judge settings', e instanceof z.ZodError ? e.flatten() : String(e)); }
    await audit({ action: 'admin.hive_judge.settings', actorType: 'admin', targetType: 'system_setting', targetId: 'hive_judge', metadata: v }, req);
    return v;
  });

  app.post('/train', async (req) => {
    requireAdmin(req);
    const m = await trainAndSave();
    await audit({ action: 'admin.hive_judge.train', actorType: 'admin', targetType: 'system_setting', targetId: 'hive_judge_model', metadata: { version: m.version } }, req);
    return { version: m.version, trainedAt: m.trainedAt, trainMs: m.trainMs, data: m.data };
  });

  app.get('/metrics', async (req) => {
    requireAdmin(req);
    const m = await ensureModel();
    const d = m.data as { synthetic?: number; humanVerified?: number };
    return {
      version: m.version, trainedAt: m.trainedAt, data: m.data, cv: m.cv, redFlagThreshold: m.rf.threshold,
      label: (d.humanVerified ?? 0) === 0 ? 'synthetic calibration — admin verification needed' : `${d.humanVerified} human-verified of ${(d.synthetic ?? 0) + (d.humanVerified ?? 0)} calibration answers`,
    };
  });

  app.get('/reviews', async (req) => {
    requireAdmin(req);
    const q = parse(z.object({ status: z.enum(['open', 'resolved']).optional(), domain: z.string().optional() }), req.query ?? {});
    return { reviews: listReviews(q).map(({ input, suggested, ...r }) => ({ ...r, task: input.task.slice(0, 300), suggestedTotal: suggested.total, confidence: suggested.confidence })) };
  });
  app.get('/reviews/:id', async (req) => {
    requireAdmin(req);
    const r = getReview((req.params as { id: string }).id);
    if (!r) throw notFound('Review');
    return r;
  });
  app.post('/reviews/:id/resolve', async (req) => {
    const a = requireAdmin(req);
    const id = (req.params as { id: string }).id;
    const body = parse(z.object({ scores: z.record(z.number().min(0)), redFlagsFired: z.array(z.string().max(500)).max(20).optional(), note: z.string().max(4000).optional() }), req.body ?? {});
    if (!getReview(id)) throw notFound('Review');
    let r;
    try { r = await resolveReview(id, body, a.user.id); } catch (e) { throw badRequest(e instanceof Error ? e.message : String(e)); }
    await audit({ action: 'admin.hive_judge.review_resolve', actorType: 'admin', targetType: 'hive_judge_review', targetId: id, metadata: { total: r.resolution?.total, refKind: r.refKind, refId: r.refId } }, req);
    const s = await getSettings();
    if (resolutionsCount() >= s.retrainEveryResolutions) await enqueue(RETRAIN_JOB, { reason: 'resolutions' }, { maxAttempts: 1 });
    return r;
  });

  app.post('/try', async (req) => {
    requireAdmin(req);
    const body = parse(z.object({ questionId: z.string().uuid(), answer: z.string().max(60_000) }), req.body ?? {});
    const [q] = await db().select().from(schema.proQuestions).where(eq(schema.proQuestions.id, body.questionId)).limit(1);
    if (!q) throw notFound('Question');
    const t0 = Date.now();
    const result = await hiveJudge({ domain: q.domainName, task: q.task, caseMaterial: q.caseMaterial, rubric: normaliseRubric(q.rubric), referenceSolution: q.referenceSolution, redFlags: q.redFlags, answer: body.answer, questionId: q.id });
    return { result, ms: Date.now() - t0 };
  });
}

async function ensureScheduled() {
  const [q] = await db().select({ id: schema.jobs.id }).from(schema.jobs).where(and(eq(schema.jobs.type, RETRAIN_JOB), inArray(schema.jobs.status, ['queued', 'running']))).limit(1);
  if (!q) await enqueue(RETRAIN_JOB, { reason: 'startup' }, { delayMs: 30_000, maxAttempts: 1 });
}

export function registerJobs() {
  registerJob(RETRAIN_JOB, async (payload) => {
    try {
      // startup: only train when no model exists; daily / after resolutions: always retrain
      if (payload.reason !== 'startup' || !(await loadModel())) await trainAndSave();
    } finally {
      if (payload.reason !== 'resolutions') await enqueue(RETRAIN_JOB, { reason: 'daily' }, { delayMs: DAY_MS, maxAttempts: 1 });
    }
  });
  setTimeout(() => { void ensureScheduled().catch(() => undefined); }, 1000).unref();
}
