/**
 * Question-bank importer: knowledge-library inbox → pro_questions / pro_calibration_answers / pro_twists (+ proof guidance).
 *
 * - Idempotent: upsert keyed on (source, external_id). Unchanged rows are skipped (content hash in meta.contentHash).
 *   Re-imports never overwrite admin decisions: status/visibility/review fields of reviewed rows are kept, canaries never change.
 * - Dedupe: exact duplicate prompts inside a file and across sources (first source in SOURCE_ORDER wins).
 * - Batch inserts (PGlite-friendly).
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, rowsOf, schema } from '../../db/client.js';
import { DOMAIN_TABLE } from './domain-map.js';
import { detectKind, normPrompt, parseSourceFile, type ParsedSource, type SourceKind } from './parse.js';
import { saveProofGuidance } from './proof-guidance.js';
import { DIFFICULTIES, GRADING_MODES, type BankItem } from './types.js';

/** Default inbox: <repo>/knowledge-library/_inbox (env PRO_BANK_INBOX_DIR overrides). */
export function defaultInboxDir() {
  return process.env.PRO_BANK_INBOX_DIR || resolve(import.meta.dirname, '../../../../../knowledge-library/_inbox');
}

export const newCanary = () => `HM-CANARY-${randomBytes(6).toString('hex').toUpperCase()}`;

const SOURCE_ORDER: SourceKind[] = ['original_examples', 'blueprints', 'questions_7000', 'evaluation_items', 'scenarios'];
const FIXED_FILES = ['hive_mind_original_example_questions.json', 'work_product_blueprints.json', 'questions_7000.jsonl', 'evaluation_items.jsonl'];

/** Source name a file will import under (same rule as parseSourceFile). */
export function sourceNameOf(file: string): string | null {
  const k = detectKind(file);
  if (!k) return null;
  return k === 'scenarios' ? basename(file).replace(/\.jsonl$/i, '') : k;
}

/** Bank source files in a directory: the 4 fixed files at the top level + any **∕scenarios_*.jsonl. */
export function findSourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const f of FIXED_FILES) if (existsSync(join(dir, f))) out.push(join(dir, f));
  const walk = (d: string, depth: number) => {
    if (depth > 6) return;
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { if (!e.startsWith('.') && e !== 'node_modules') walk(p, depth + 1); }
      else if (/^scenarios_.*\.jsonl$/i.test(e)) out.push(p);
    }
  };
  walk(dir, 0);
  return out;
}

export interface SourceSummary {
  source: string;
  file: string;
  read: number;
  imported: number;
  updated: number;
  unchanged: number;
  /** failed hard verification (e.g. numeric ground truth did not recompute) — imported as 'review', never auto-activated */
  failedVerification: number;
  /** imported as 'review' because validation found issues (clean items go straight to 'active') */
  flagged: number;
  duplicates: number;
  parseErrors: number;
  calibrations: { read: number; imported: number; updated: number; keptVerified: number; orphaned: number };
  twists: { read: number; imported: number };
  proofGuidance: number;
}

export interface DomainCount { slug: string; total: number; byDifficulty: Record<string, number>; byMode: Record<string, number> }

export interface ImportSummary {
  dir: string;
  dryRun: boolean;
  durationMs: number;
  sources: SourceSummary[];
  domains: DomainCount[];
  /** source domain names that mapped to no platform domain */
  unmappedDomains: string[];
  /** sample of validation issues (first 25) */
  sampleIssues: { source: string; externalId: string; issues: string[] }[];
}

const hashItem = (it: BankItem) => createHash('sha256').update(JSON.stringify([
  it.domainName, it.domainSlug, it.subtopic, it.taskType, it.difficulty, it.caseMaterial, it.task, it.rubric, it.referenceSolution,
  it.redFlags, it.deterministicChecks, it.variations, it.gradingMode, it.visibility, it.status, it.expertReviewRequired,
  it.validationIssues, it.license, it.meta,
])).digest('hex').slice(0, 32);

const chunk = <T>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

function toRow(it: BankItem, hash: string) {
  return {
    externalId: it.externalId, source: it.source, domainName: it.domainName, domainSlug: it.domainSlug, subtopic: it.subtopic,
    taskType: it.taskType, difficulty: it.difficulty, caseMaterial: it.caseMaterial, task: it.task, rubric: it.rubric,
    referenceSolution: it.referenceSolution, redFlags: it.redFlags, deterministicChecks: it.deterministicChecks, variations: it.variations,
    gradingMode: it.gradingMode, visibility: it.visibility, status: it.status, expertReviewRequired: it.expertReviewRequired,
    validationIssues: it.validationIssues, license: it.license, canary: newCanary(), meta: { ...it.meta, contentHash: hash },
  };
}

const ex = (col: string) => sql.raw(`excluded.${col}`);
/** Content columns refreshed on re-import. Admin-owned fields only change while a row is unreviewed. */
const UPDATE_SET = {
  domainName: ex('domain_name'), domainSlug: ex('domain_slug'), subtopic: ex('subtopic'), taskType: ex('task_type'),
  difficulty: ex('difficulty'), caseMaterial: ex('case_material'), task: ex('task'), rubric: ex('rubric'),
  referenceSolution: ex('reference_solution'), redFlags: ex('red_flags'), deterministicChecks: ex('deterministic_checks'),
  variations: ex('variations'), gradingMode: ex('grading_mode'), expertReviewRequired: ex('expert_review_required'),
  validationIssues: ex('validation_issues'), license: ex('license'), meta: ex('meta'),
  status: sql.raw(`case when pro_questions.reviewed_at is null then excluded.status else pro_questions.status end`),
  visibility: sql.raw(`case when pro_questions.reviewed_at is null then excluded.visibility else pro_questions.visibility end`),
  updatedAt: sql`now()`,
};

async function writeSource(p: ParsedSource, items: BankItem[], dryRun: boolean, s: SourceSummary) {
  const d = db();
  const existing = await d.select({ id: schema.proQuestions.id, externalId: schema.proQuestions.externalId, hash: sql<string | null>`${schema.proQuestions.meta}->>'contentHash'` })
    .from(schema.proQuestions).where(eq(schema.proQuestions.source, p.source));
  const byExt = new Map(existing.map((r) => [r.externalId, r]));
  const inserts: ReturnType<typeof toRow>[] = [];
  const updates: ReturnType<typeof toRow>[] = [];
  for (const it of items) {
    const h = hashItem(it);
    const cur = byExt.get(it.externalId);
    if (!cur) inserts.push(toRow(it, h));
    else if (cur.hash !== h) updates.push(toRow(it, h));
    else s.unchanged++;
  }
  s.imported = inserts.length;
  s.updated = updates.length;

  // calibrations / twists are computed against current DB state
  const calByExt = new Map<string, typeof p.calibrations>();
  for (const c of p.calibrations) calByExt.set(c.scenarioExternalId, [...(calByExt.get(c.scenarioExternalId) ?? []), c]);
  s.calibrations.read = p.calibrations.length;
  s.twists.read = p.twists.length;
  s.proofGuidance = p.proof.length;
  const knownExt = new Set(items.map((i) => i.externalId));
  s.calibrations.orphaned = p.calibrations.filter((c) => !knownExt.has(c.scenarioExternalId)).length;

  const existingTwists = p.twists.length
    ? await d.select({ domainName: schema.proTwists.domainName, twist: schema.proTwists.twist }).from(schema.proTwists).where(eq(schema.proTwists.source, p.source))
    : [];
  const twistKey = (a: { domainName: string; twist: string }) => `${a.domainName}\u0000${a.twist}`;
  const haveTwist = new Set(existingTwists.map(twistKey));
  const newTwists = p.twists.filter((t) => { const k = twistKey(t); if (haveTwist.has(k)) return false; haveTwist.add(k); return true; });
  s.twists.imported = newTwists.length;

  if (dryRun) {
    s.calibrations.imported = p.calibrations.length - s.calibrations.orphaned; // upper bound: new scenarios
    return;
  }

  await d.transaction(async (tx) => {
    for (const c of chunk(inserts, 200)) await tx.insert(schema.proQuestions).values(c);
    for (const c of chunk(updates, 200)) {
      await tx.insert(schema.proQuestions).values(c).onConflictDoUpdate({ target: [schema.proQuestions.source, schema.proQuestions.externalId], set: UPDATE_SET });
    }
    for (const c of chunk(newTwists, 300)) {
      await tx.insert(schema.proTwists).values(c.map((t) => ({ domainName: t.domainName, domainSlug: t.domainSlug, twist: t.twist, rubricEffect: t.rubricEffect, source: p.source })));
    }

    if (p.calibrations.length) {
      const exts = [...calByExt.keys()].filter((k) => knownExt.has(k));
      const qrows = exts.length
        ? await tx.select({ id: schema.proQuestions.id, externalId: schema.proQuestions.externalId }).from(schema.proQuestions)
          .where(and(eq(schema.proQuestions.source, p.source), inArray(schema.proQuestions.externalId, exts)))
        : [];
      const qid = new Map(qrows.map((r) => [r.externalId, r.id]));
      const ids = [...qid.values()];
      const curCals = ids.length ? await tx.select().from(schema.proCalibrationAnswers).where(inArray(schema.proCalibrationAnswers.questionId, ids)) : [];
      const calKey = (questionId: string, level: string) => `${questionId}\u0000${level}`;
      const curBy = new Map(curCals.map((c) => [calKey(c.questionId, c.level), c]));
      const toInsert: (typeof schema.proCalibrationAnswers.$inferInsert)[] = [];
      for (const [ext, list] of calByExt) {
        const questionId = qid.get(ext);
        if (!questionId) continue;
        for (const c of list) {
          const cur = curBy.get(calKey(questionId, c.level));
          const vals = { answer: c.answer, scores: c.scores, total: c.total, redFlagsFired: c.redFlagsFired, rationale: c.rationale };
          if (!cur) { toInsert.push({ questionId, level: c.level, provenance: 'synthetic', ...vals }); curBy.set(calKey(questionId, c.level), { id: '', questionId, level: c.level } as never); continue; }
          if (!cur.id) continue; // same level twice in one file: first wins
          if (cur.provenance !== 'synthetic') { s.calibrations.keptVerified++; continue; }
          if (cur.answer !== c.answer || cur.total !== c.total || JSON.stringify(cur.scores) !== JSON.stringify(c.scores) || cur.rationale !== c.rationale) {
            await tx.update(schema.proCalibrationAnswers).set(vals).where(eq(schema.proCalibrationAnswers.id, cur.id));
            s.calibrations.updated++;
          }
        }
      }
      for (const c of chunk(toInsert, 200)) await tx.insert(schema.proCalibrationAnswers).values(c);
      s.calibrations.imported = toInsert.length;
    }
  });
  if (p.proof.length) await saveProofGuidance(p.proof);
}

export interface ImportOptions { dir?: string; files?: string[]; dryRun?: boolean; log?: (line: string) => void }

let running = false;
/** True while an import (manual or bootstrap) is in progress in this process. */
export const isImportRunning = () => running;
export class ImportBusyError extends Error { constructor() { super('An import is already running'); } }

/** Runs one import at a time per process (throws ImportBusyError otherwise). */
export async function runImport(opts: ImportOptions = {}): Promise<ImportSummary> {
  if (running) throw new ImportBusyError();
  running = true;
  try { return await runImportUnlocked(opts); } finally { running = false; }
}

async function runImportUnlocked(opts: ImportOptions): Promise<ImportSummary> {
  const t0 = Date.now();
  const dir = resolve(opts.dir ?? defaultInboxDir());
  const files = opts.files ?? findSourceFiles(dir);
  const parsed = files.map((f) => parseSourceFile(f)).filter((p): p is ParsedSource => !!p)
    .sort((a, b) => SOURCE_ORDER.indexOf(a.kind) - SOURCE_ORDER.indexOf(b.kind) || a.source.localeCompare(b.source));

  const seen = new Set<string>();
  const sources: SourceSummary[] = [];
  const sampleIssues: ImportSummary['sampleIssues'] = [];
  const unmapped = new Set<string>();
  for (const p of parsed) {
    opts.log?.(`· ${p.source}: ${p.read} records`);
    const s: SourceSummary = {
      source: p.source, file: p.file, read: p.read, imported: 0, updated: 0, unchanged: 0, failedVerification: 0, flagged: 0, duplicates: p.duplicates,
      parseErrors: p.parseErrors.length, calibrations: { read: 0, imported: 0, updated: 0, keptVerified: 0, orphaned: 0 }, twists: { read: 0, imported: 0 }, proofGuidance: 0,
    };
    // cross-source exact-duplicate prompts (e.g. the 20 curated baseline items repeat the original examples)
    const items = p.items.filter((it) => {
      const k = normPrompt(`${it.caseMaterial}\n${it.task}`);
      if (seen.has(k)) { s.duplicates++; return false; }
      seen.add(k);
      return true;
    });
    for (const it of items) {
      const ver = it.meta.verification as { status?: string } | undefined;
      if (ver?.status === 'mismatch') s.failedVerification++;
      if (it.validationIssues.length) s.flagged++;
      if (!it.domainSlug) unmapped.add(it.domainName);
      if (it.validationIssues.length && sampleIssues.length < 25) sampleIssues.push({ source: it.source, externalId: it.externalId, issues: it.validationIssues });
    }
    await writeSource(p, items, !!opts.dryRun, s);
    sources.push(s);
  }

  // per platform domain counts (whole bank, after this run)
  const res = rowsOf<{ slug: string | null; difficulty: string; mode: string; n: number }>(await db().execute(sql`
    select domain_slug as slug, difficulty, grading_mode as mode, count(*)::int as n from pro_questions group by 1, 2, 3`));
  const dm = new Map<string, DomainCount>();
  for (const r of res) {
    const slug = r.slug ?? '(unmapped)';
    const d = dm.get(slug) ?? { slug, total: 0, byDifficulty: Object.fromEntries(DIFFICULTIES.map((x) => [x, 0])), byMode: Object.fromEntries(GRADING_MODES.map((x) => [x, 0])) };
    const n = Number(r.n);
    d.total += n;
    d.byDifficulty[r.difficulty] = (d.byDifficulty[r.difficulty] ?? 0) + n;
    d.byMode[r.mode] = (d.byMode[r.mode] ?? 0) + n;
    dm.set(slug, d);
  }
  return {
    dir, dryRun: !!opts.dryRun, durationMs: Date.now() - t0, sources,
    domains: [...dm.values()].sort((a, b) => a.slug.localeCompare(b.slug)),
    unmappedDomains: [...unmapped].sort(), sampleIssues,
  };
}

/* ───────── text summary ───────── */

function table(head: string[], rows: (string | number)[][]) {
  const cells = [head, ...rows.map((r) => r.map(String))];
  const w = head.map((_, i) => Math.max(...cells.map((r) => (r[i] ?? '').length)));
  const line = (r: string[]) => r.map((c, i) => (i === 0 ? c.padEnd(w[i]!) : c.padStart(w[i]!))).join('  ');
  return [line(head), w.map((n) => '-'.repeat(n)).join('  '), ...cells.slice(1).map(line)].join('\n');
}

export function formatSummary(s: ImportSummary): string {
  const out: string[] = [];
  out.push(`Question bank import ${s.dryRun ? '(DRY RUN — nothing written)' : ''} · ${s.dir} · ${(s.durationMs / 1000).toFixed(1)}s`);
  out.push('');
  out.push(table(
    ['source', 'read', 'imported', 'updated', 'unchanged', 'failed verif', 'flagged', 'duplicates', 'parse errs', 'calib +', 'twists +', 'proof'],
    s.sources.map((x) => [x.source, x.read, x.imported, x.updated, x.unchanged, x.failedVerification, x.flagged, x.duplicates, x.parseErrors, x.calibrations.imported, x.twists.imported, x.proofGuidance]),
  ));
  out.push('');
  out.push(table(
    ['platform domain', ...DIFFICULTIES, ...GRADING_MODES, 'total'],
    s.domains.map((d) => [d.slug, ...DIFFICULTIES.map((x) => d.byDifficulty[x] ?? 0), ...GRADING_MODES.map((x) => d.byMode[x] ?? 0), d.total]),
  ));
  out.push('');
  out.push(`Platform domains: ${DOMAIN_TABLE.length}. Unmapped in this run: ${s.unmappedDomains.length ? s.unmappedDomains.join(', ') : 'none'}`);
  out.push('failed verif = ground truth did not recompute · flagged = imported as review (validation issues); everything else is active');
  return out.join('\n');
}

/**
 * First-start bootstrap: if the bank is empty and the inbox folder exists, import once (background, non-blocking).
 * Disabled in tests and with PRO_BANK_AUTO_IMPORT=false.
 */
let bootstrapStarted = false;
export function scheduleBootstrapImport(log: (msg: string) => void = (m) => console.log(m)) {
  if (bootstrapStarted || process.env.NODE_ENV === 'test' || process.env.PRO_BANK_AUTO_IMPORT === 'false') return;
  bootstrapStarted = true;
  setTimeout(() => {
    void (async () => {
      const dir = defaultInboxDir();
      if (!existsSync(dir) || !findSourceFiles(dir).length) return;
      // run when the bank is empty or a source file has never landed (e.g. a previous bootstrap was interrupted)
      const have = new Set(rowsOf<{ source: string }>(await db().execute(sql`select distinct source from pro_questions`)).map((r) => r.source));
      const missing = findSourceFiles(dir).map(sourceNameOf).filter((s): s is string => !!s && !have.has(s));
      if (!missing.length) return;
      log(`[pro-bank] importing missing sources (${missing.join(', ')}) from ${dir} …`);
      const s = await runImport({ dir });
      log('[pro-bank] bootstrap import done\n' + formatSummary(s));
    })().catch((e) => log(`[pro-bank] bootstrap import failed: ${(e as Error).message}`));
  }, 1500);
}
