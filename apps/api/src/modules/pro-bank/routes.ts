/**
 * pro-bank module, mounted at /pro-bank — professional question bank administration (platform admins only).
 *   GET   /stats                         counts by domain / difficulty / mode / visibility / status / source, issues, calibrations
 *   GET   /questions                     filters + paging (rubric & reference included: admin only)
 *   GET   /questions/:id                 one question + its calibration answers
 *   PATCH /questions/:id                 status (active|retired|rejected|review), visibility, reviewNote, approve
 *   POST  /questions/bulk-status         same for explicit ids or a filter
 *   POST  /import                        run the importer on the server's inbox dir → summary
 *   POST  /calibration/:id/verify        mark a calibration answer human_verified (optionally corrected scores/total)
 * Also schedules the one-time bootstrap import on first start when the bank is empty (engine/pro-bank/import.ts).
 */
import type { FastifyInstance } from 'fastify';
import { and, asc, count, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { db, rowsOf, schema } from '../../db/client.js';
import { requireAdmin } from '../../lib/auth.js';
import { audit } from '../../lib/audit.js';
import { conflict, notFound, unprocessable } from '../../lib/errors.js';
import { parse } from '../../lib/http.js';
import { ImportBusyError, defaultInboxDir, isImportRunning, runImport, scheduleBootstrapImport } from '../../engine/pro-bank/import.js';
import { PROOF_GUIDANCE_KEY } from '../../engine/pro-bank/proof-guidance.js';

const q = schema.proQuestions;
const Id = z.object({ id: z.string().uuid() });
const boolish = z.union([z.boolean(), z.enum(['true', 'false', '1', '0'])]).transform((v) => v === true || v === 'true' || v === '1');

const Filter = z.object({
  domain: z.string().max(80).optional(),
  domainName: z.string().max(120).optional(),
  subtopic: z.string().max(200).optional(),
  difficulty: z.string().max(40).optional(),
  taskType: z.string().max(60).optional(),
  gradingMode: z.string().max(40).optional(),
  visibility: z.string().max(40).optional(),
  status: z.string().max(40).optional(),
  source: z.string().max(120).optional(),
  hasIssues: boolish.optional(),
  needsExpertReview: boolish.optional(),
  q: z.string().max(200).optional(),
});
type FilterT = z.infer<typeof Filter>;

const ListQuery = Filter.extend({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.enum(['recent', 'domain', 'difficulty']).default('domain'),
});

function whereOf(f: FilterT): SQL | undefined {
  const w: SQL[] = [];
  if (f.domain) w.push(f.domain === '(unmapped)' ? isNull(q.domainSlug) : eq(q.domainSlug, f.domain));
  if (f.domainName) w.push(eq(q.domainName, f.domainName));
  if (f.subtopic) w.push(ilike(q.subtopic, `%${f.subtopic}%`));
  if (f.difficulty) w.push(eq(q.difficulty, f.difficulty));
  if (f.taskType) w.push(eq(q.taskType, f.taskType));
  if (f.gradingMode) w.push(eq(q.gradingMode, f.gradingMode));
  if (f.visibility) w.push(eq(q.visibility, f.visibility));
  if (f.status) w.push(eq(q.status, f.status));
  if (f.source) w.push(eq(q.source, f.source));
  if (f.hasIssues === true) w.push(sql`jsonb_array_length(${q.validationIssues}) > 0`);
  if (f.hasIssues === false) w.push(sql`jsonb_array_length(${q.validationIssues}) = 0`);
  if (f.needsExpertReview) w.push(and(eq(q.status, 'active'), eq(q.expertReviewRequired, true), isNull(q.reviewedAt))!);
  if (f.q) w.push(or(ilike(q.task, `%${f.q}%`), ilike(q.externalId, `%${f.q}%`), ilike(q.caseMaterial, `%${f.q}%`))!);
  return w.length ? and(...w) : undefined;
}

const AdminStatus = z.enum(['active', 'retired', 'rejected', 'review']);
const PatchBody = z.object({
  status: AdminStatus.optional(),
  visibility: z.enum(['public_example', 'private']).optional(),
  reviewNote: z.string().max(2000).optional(),
  /** mark as expert-reviewed without changing status */
  approve: z.boolean().optional(),
}).refine((b) => b.status || b.visibility || b.reviewNote !== undefined || b.approve, { message: 'Nothing to change' });

const BulkBody = z.object({
  ids: z.array(z.string().uuid()).max(5000).optional(),
  filter: Filter.optional(),
  status: AdminStatus.optional(),
  approve: z.boolean().optional(),
  reviewNote: z.string().max(2000).optional(),
  /** with a filter, items that have validation issues are skipped unless this is true */
  includeIssues: z.boolean().default(false),
}).refine((b) => b.ids?.length || b.filter, { message: 'Provide ids or a filter' })
  .refine((b) => b.status || b.approve, { message: 'Provide status or approve' });

const VerifyBody = z.object({
  scores: z.record(z.string().max(80), z.number().min(0).max(100)).optional(),
  total: z.number().min(0).max(100).optional(),
  rationale: z.string().max(4000).optional(),
});


const groupCount = async (col: SQL | AnyPgColumn) => {
  const rows = await db().select({ k: sql<string | null>`${col}`, n: count() }).from(q).groupBy(sql`1`);
  return Object.fromEntries(rows.map((r) => [r.k ?? '(unmapped)', Number(r.n)]));
};

export default async function routes(app: FastifyInstance) {
  app.addHook('preHandler', async (req) => { requireAdmin(req); });
  app.addHook('onReady', async () => { scheduleBootstrapImport((m) => app.log.info(m)); });

  app.get('/stats', async () => {
    const d = db();
    const [totals] = await d.select({
      total: count(),
      withIssues: sql<number>`count(*) filter (where jsonb_array_length(${q.validationIssues}) > 0)::int`,
      needsExpertReview: sql<number>`count(*) filter (where ${q.status} = 'active' and ${q.expertReviewRequired} and ${q.reviewedAt} is null)::int`,
      reviewed: sql<number>`count(*) filter (where ${q.reviewedAt} is not null)::int`,
    }).from(q);
    const byDomainRows = await d.select({
      slug: q.domainSlug, total: count(),
      active: sql<number>`count(*) filter (where ${q.status} = 'active')::int`,
      review: sql<number>`count(*) filter (where ${q.status} = 'review')::int`,
      private: sql<number>`count(*) filter (where ${q.visibility} = 'private' and ${q.status} = 'active')::int`,
      caseRubric: sql<number>`count(*) filter (where ${q.gradingMode} = 'case_rubric')::int`,
      templateRubric: sql<number>`count(*) filter (where ${q.gradingMode} = 'template_rubric')::int`,
      numeric: sql<number>`count(*) filter (where ${q.gradingMode} = 'numeric')::int`,
      beginner: sql<number>`count(*) filter (where ${q.difficulty} = 'beginner')::int`,
      intermediate: sql<number>`count(*) filter (where ${q.difficulty} = 'intermediate')::int`,
      professional: sql<number>`count(*) filter (where ${q.difficulty} = 'professional')::int`,
      expert: sql<number>`count(*) filter (where ${q.difficulty} = 'expert')::int`,
    }).from(q).groupBy(q.domainSlug).orderBy(asc(q.domainSlug));
    const cal = schema.proCalibrationAnswers;
    const calRows = await d.select({ provenance: cal.provenance, level: cal.level, n: count() }).from(cal).groupBy(cal.provenance, cal.level);
    const [tw] = await d.select({ n: count() }).from(schema.proTwists);
    const [pg] = await d.select().from(schema.systemSettings).where(eq(schema.systemSettings.key, PROOF_GUIDANCE_KEY));
    const issueRows = await d.execute(sql`
      select regexp_replace(regexp_replace(issue, '''[^'']*''', '''…''', 'g'), '-?[0-9]+(\.[0-9]+)?', '#', 'g') as kind, count(*)::int as n
      from pro_questions, jsonb_array_elements_text(validation_issues) as issue group by 1 order by 2 desc limit 20`);
    return {
      total: Number(totals?.total ?? 0),
      withIssues: Number(totals?.withIssues ?? 0),
      needsExpertReview: Number(totals?.needsExpertReview ?? 0),
      reviewed: Number(totals?.reviewed ?? 0),
      byStatus: await groupCount(q.status),
      byVisibility: await groupCount(q.visibility),
      byDifficulty: await groupCount(q.difficulty),
      byMode: await groupCount(q.gradingMode),
      bySource: await groupCount(q.source),
      byTaskType: await groupCount(q.taskType),
      byDomain: byDomainRows.map((r) => ({ ...r, slug: r.slug ?? '(unmapped)', total: Number(r.total) })),
      issueKinds: rowsOf<{ kind: string; n: number }>(issueRows).map((r) => ({ kind: r.kind, n: Number(r.n) })),
      calibration: {
        total: calRows.reduce((a, r) => a + Number(r.n), 0),
        byProvenance: calRows.reduce<Record<string, number>>((a, r) => ({ ...a, [r.provenance]: (a[r.provenance] ?? 0) + Number(r.n) }), {}),
        byLevel: calRows.reduce<Record<string, number>>((a, r) => ({ ...a, [r.level]: (a[r.level] ?? 0) + Number(r.n) }), {}),
      },
      twists: Number(tw?.n ?? 0),
      proofGuidanceDomains: pg ? Object.keys((pg.value as { records?: object }).records ?? {}).length : 0,
      inboxDir: defaultInboxDir(),
      importRunning: isImportRunning(),
    };
  });

  app.get('/questions', async (req) => {
    const f = parse(ListQuery, req.query);
    const where = whereOf(f);
    const order = f.sort === 'recent' ? [desc(q.updatedAt)] : f.sort === 'difficulty' ? [asc(q.difficulty), asc(q.externalId)] : [asc(q.domainSlug), asc(q.domainName), asc(q.externalId)];
    const [items, [tot]] = await Promise.all([
      db().select().from(q).where(where).orderBy(...order).limit(f.pageSize).offset((f.page - 1) * f.pageSize),
      db().select({ n: count() }).from(q).where(where),
    ]);
    return { items, total: Number(tot?.n ?? 0), page: f.page, pageSize: f.pageSize };
  });

  app.get('/questions/:id', async (req) => {
    const { id } = parse(Id, req.params);
    const [question] = await db().select().from(q).where(eq(q.id, id));
    if (!question) throw notFound('Question');
    const calibrations = await db().select().from(schema.proCalibrationAnswers).where(eq(schema.proCalibrationAnswers.questionId, id)).orderBy(desc(schema.proCalibrationAnswers.total));
    let reviewer: { id: string; name: string; email: string } | null = null;
    if (question.reviewedBy) {
      const [u] = await db().select({ id: schema.users.id, name: schema.users.name, email: schema.users.email }).from(schema.users).where(eq(schema.users.id, question.reviewedBy));
      reviewer = u ?? null;
    }
    return { question, calibrations, reviewer };
  });

  app.patch('/questions/:id', async (req) => {
    const a = requireAdmin(req);
    const { id } = parse(Id, req.params);
    const b = parse(PatchBody, req.body);
    const [cur] = await db().select().from(q).where(eq(q.id, id));
    if (!cur) throw notFound('Question');
    const set: Partial<typeof q.$inferInsert> = { updatedAt: new Date() };
    if (b.status) set.status = b.status;
    if (b.visibility) set.visibility = b.visibility;
    if (b.reviewNote !== undefined) set.reviewNote = b.reviewNote;
    // any admin decision on status (or explicit approve) records the reviewer; re-imports then keep the decision
    if (b.status || b.approve) { set.reviewedBy = a.user.id; set.reviewedAt = new Date(); }
    const [row] = await db().update(q).set(set).where(eq(q.id, id)).returning();
    await audit({
      action: 'pro_bank.question.update', actorType: 'admin', targetType: 'pro_question', targetId: id,
      metadata: { externalId: cur.externalId, source: cur.source, from: { status: cur.status, visibility: cur.visibility }, to: b },
    }, req);
    return row;
  });

  app.post('/questions/bulk-status', async (req) => {
    const a = requireAdmin(req);
    const b = parse(BulkBody, req.body);
    const conds: SQL[] = [];
    if (b.ids?.length) conds.push(inArray(q.id, b.ids));
    if (b.filter) {
      const w = whereOf(b.filter);
      if (w) conds.push(w);
      if (!b.includeIssues) conds.push(sql`jsonb_array_length(${q.validationIssues}) = 0`);
    }
    const set: Partial<typeof q.$inferInsert> = { updatedAt: new Date(), reviewedBy: a.user.id, reviewedAt: new Date() };
    if (b.status) set.status = b.status;
    if (b.reviewNote !== undefined) set.reviewNote = b.reviewNote;
    const rows = await db().update(q).set(set).where(and(...conds)).returning({ id: q.id });
    await audit({
      action: 'pro_bank.question.bulk_update', actorType: 'admin', targetType: 'pro_question', targetId: null,
      metadata: { count: rows.length, status: b.status ?? null, approve: !!b.approve, filter: b.filter ?? null, ids: b.ids?.length ?? 0, includeIssues: b.includeIssues },
    }, req);
    return { updated: rows.length };
  });

  app.post('/import', async (req) => {
    requireAdmin(req);
    const b = parse(z.object({ dryRun: z.boolean().default(false) }), req.body ?? {});
    if (isImportRunning()) throw conflict('An import is already running');
    try {
      const summary = await runImport({ dryRun: b.dryRun });
      await audit({
        action: 'pro_bank.import', actorType: 'admin', targetType: 'pro_bank', targetId: null,
        metadata: { dryRun: b.dryRun, dir: summary.dir, sources: summary.sources.map((s) => ({ source: s.source, imported: s.imported, updated: s.updated, flagged: s.flagged, duplicates: s.duplicates })) },
      }, req);
      return summary;
    } catch (e) {
      if (e instanceof ImportBusyError) throw conflict(e.message);
      throw e;
    }
  });

  app.post('/calibration/:id/verify', async (req) => {
    const a = requireAdmin(req);
    const { id } = parse(Id, req.params);
    const b = parse(VerifyBody, req.body ?? {});
    const cal = schema.proCalibrationAnswers;
    const [cur] = await db().select().from(cal).where(eq(cal.id, id));
    if (!cur) throw notFound('Calibration answer');
    const scores = b.scores ?? cur.scores;
    const sum = Object.values(scores).reduce((x, y) => x + y, 0);
    const total = b.total ?? (b.scores ? sum : cur.total);
    if (Math.abs(sum - total) > 0.5 && Object.keys(scores).length) throw unprocessable(`Total ${total} does not equal the sum of scores (${+sum.toFixed(2)})`);
    if (b.scores) {
      const [question] = await db().select({ rubric: q.rubric }).from(q).where(eq(q.id, cur.questionId));
      const points = new Map((question?.rubric ?? []).map((r) => [String(r.id), Number(r.points)]));
      for (const [k, v] of Object.entries(b.scores)) {
        if (!points.has(k)) throw unprocessable(`Unknown rubric id '${k}'`);
        if (v > points.get(k)! + 1e-9) throw unprocessable(`Score ${v} for '${k}' exceeds its ${points.get(k)} points`);
      }
    }
    const [row] = await db().update(cal).set({
      provenance: 'human_verified', verifiedBy: a.user.id, scores, total, ...(b.rationale !== undefined ? { rationale: b.rationale } : {}),
    }).where(eq(cal.id, id)).returning();
    await audit({
      action: 'pro_bank.calibration.verify', actorType: 'admin', targetType: 'pro_calibration_answer', targetId: id,
      metadata: { questionId: cur.questionId, level: cur.level, corrected: !!(b.scores || b.total !== undefined), from: { total: cur.total }, to: { total } },
    }, req);
    return row;
  });
}
