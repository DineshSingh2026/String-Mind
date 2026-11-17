/**
 * Hive Judge — data loading: pro_questions → JudgeItem, pro_calibration_answers → CalExample, scenario JSONL files
 * (knowledge-library format, parsed by the bank's own parser — DATA only, nothing is executed), and the bundled
 * seed set (synthetic, written for bootstrapping; always labelled as such).
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, inArray, ne } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { normaliseRubric, type JudgeInput } from '../pro-judge.js';
import { parseSourceFile } from '../pro-bank/parse.js';
import type { BankItem } from '../pro-bank/types.js';
import type { CalExample, JudgeItem } from './types.js';

type Q = typeof schema.proQuestions.$inferSelect;

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : x && typeof x === 'object' ? String((x as Record<string, unknown>).description ?? (x as Record<string, unknown>).trap ?? (x as Record<string, unknown>).text ?? (x as Record<string, unknown>).name ?? '') : '')).filter((s) => s.trim()) : []);

function injectionTextOf(v: unknown): string {
  if (typeof v === 'string') return /^(|none|no|false|n\/a|null|true|yes)$/i.test(v.trim()) ? '' : v;
  const o = rec(v);
  return String(o.text ?? o.injected_text ?? o.payload ?? o.instruction ?? '');
}

/** pro_questions row (or importer BankItem) → JudgeItem. */
export function itemFromQuestion(q: Pick<Q, 'domainName' | 'domainSlug' | 'subtopic' | 'taskType' | 'gradingMode' | 'caseMaterial' | 'task' | 'rubric' | 'referenceSolution' | 'redFlags' | 'deterministicChecks' | 'meta' | 'source' | 'externalId'> & { id?: string }): JudgeItem {
  const meta = rec(q.meta);
  const expected = [...strList(meta.expectedAnswerElements), ...strList(meta.acceptanceCriteria), ...strList(meta.mustInclude)];
  return {
    key: q.id ?? `${q.source}:${q.externalId}`, questionId: q.id ?? null, source: q.source, domain: q.domainName, domainSlug: q.domainSlug ?? null,
    subtopic: q.subtopic ?? '', taskType: q.taskType, gradingMode: q.gradingMode, caseMaterial: q.caseMaterial ?? '', task: q.task,
    rubric: normaliseRubric(q.rubric), referenceSolution: q.referenceSolution ?? '', redFlags: (q.redFlags ?? []).filter(Boolean),
    traps: strList(meta.hiddenTraps), injectionText: injectionTextOf(meta.injectionTest), expectedElements: [...new Set(expected)],
    deterministicChecks: (q.deterministicChecks ?? []) as Record<string, unknown>[],
  };
}

export function itemFromBank(b: BankItem): JudgeItem {
  return itemFromQuestion({ ...b, id: undefined, deterministicChecks: b.deterministicChecks, meta: b.meta, redFlags: b.redFlags, rubric: b.rubric } as never);
}

/** JudgeInput (exam item / evidence / live check) → JudgeItem; question row fields win when available. */
export function itemFromInput(input: JudgeInput, q?: Q | null): JudgeItem {
  const base = q ? itemFromQuestion(q) : null;
  const ext = input as JudgeInput & { domainSlug?: string; deterministicChecks?: Record<string, unknown>[]; expectedElements?: string[]; questionId?: string };
  const rubric = input.rubric?.length ? input.rubric : base?.rubric ?? [];
  return {
    key: base?.key ?? `adhoc:${hashKey(input.task + JSON.stringify(rubric))}`,
    questionId: base?.questionId ?? ext.questionId ?? null,
    source: base?.source ?? 'adhoc',
    domain: input.domain || base?.domain || '',
    domainSlug: ext.domainSlug ?? base?.domainSlug ?? null,
    subtopic: base?.subtopic ?? '',
    taskType: base?.taskType ?? 'case_decision',
    gradingMode: base?.gradingMode ?? (input.referenceSolution?.trim() || input.caseMaterial?.trim() ? 'case_rubric' : 'adhoc'),
    // the exam renders case + twist into the task; prefer the question's raw case material when known
    caseMaterial: base?.caseMaterial || input.caseMaterial || '',
    task: input.task || base?.task || '',
    rubric,
    referenceSolution: input.referenceSolution ?? base?.referenceSolution ?? '',
    redFlags: input.redFlags?.length ? input.redFlags : base?.redFlags ?? [],
    traps: base?.traps ?? [],
    injectionText: base?.injectionText ?? '',
    expectedElements: ext.expectedElements?.length ? ext.expectedElements : base?.expectedElements ?? [],
    deterministicChecks: ext.deterministicChecks ?? base?.deterministicChecks ?? [],
  };
}

function hashKey(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

/* ───────────── DB ───────────── */

export async function loadQuestion(id: string): Promise<Q | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [q] = await db().select().from(schema.proQuestions).where(eq(schema.proQuestions.id, id)).limit(1);
  return q ?? null;
}

/** All calibration answers in the DB with their questions (rubric must be non-empty). */
export async function loadCalibrationExamples(): Promise<CalExample[]> {
  const rows = await db().select({ c: schema.proCalibrationAnswers, q: schema.proQuestions })
    .from(schema.proCalibrationAnswers)
    .innerJoin(schema.proQuestions, eq(schema.proCalibrationAnswers.questionId, schema.proQuestions.id));
  const items = new Map<string, JudgeItem>();
  const out: CalExample[] = [];
  for (const { c, q } of rows) {
    if (q.status === 'rejected') continue;
    let it = items.get(q.id);
    if (!it) { it = itemFromQuestion(q); items.set(q.id, it); }
    if (!it.rubric.length || !c.answer.trim()) continue;
    out.push({ id: c.id, item: it, level: c.level, answer: c.answer, scores: c.scores ?? {}, total: c.total, redFlagsFired: c.redFlagsFired ?? [], provenance: c.provenance });
  }
  return out;
}

export async function loadExemplars(questionId: string) {
  return db().select().from(schema.proCalibrationAnswers).where(eq(schema.proCalibrationAnswers.questionId, questionId));
}

/** Question-side corpus for the lexicon (idf + domain vocabulary). Numeric items carry no vocabulary → skipped. */
export async function loadCorpus(limit = 12000): Promise<JudgeItem[]> {
  // Page through the bank: one big result set of ~7,600 rows with jsonb rubrics overflows the embedded
  // PGlite (wasm) memory ("memory access out of bounds"), which takes the whole database down.
  const PAGE = 500;
  const out: JudgeItem[] = [];
  for (let offset = 0; offset < limit; offset += PAGE) {
    const rows = await db().select().from(schema.proQuestions).where(ne(schema.proQuestions.gradingMode, 'numeric'))
      .orderBy(schema.proQuestions.id).limit(Math.min(PAGE, limit - offset)).offset(offset);
    out.push(...rows.map(itemFromQuestion));
    if (rows.length < PAGE) break;
  }
  return out;
}

export async function questionsByIds(ids: string[]) {
  if (!ids.length) return [];
  return db().select().from(schema.proQuestions).where(inArray(schema.proQuestions.id, ids));
}

/* ───────────── files ───────────── */

/** Scenario JSONL (knowledge-library format) → items + calibration examples. */
export function examplesFromScenarioFile(file: string, provenance = 'synthetic'): { items: JudgeItem[]; examples: CalExample[] } {
  const p = parseSourceFile(file);
  if (!p) return { items: [], examples: [] };
  const byExt = new Map<string, JudgeItem>();
  for (const b of p.items) byExt.set(b.externalId, { ...itemFromBank(b), key: `${p.source}:${b.externalId}` });
  const examples: CalExample[] = [];
  p.calibrations.forEach((c, i) => {
    const it = byExt.get(c.scenarioExternalId);
    if (!it || !c.answer.trim()) return;
    examples.push({ id: `${it.key}#${i}`, item: it, level: c.level, answer: c.answer, scores: c.scores, total: c.total, redFlagsFired: c.redFlagsFired, provenance });
  });
  return { items: [...byExt.values()], examples };
}

interface TemplateSeed {
  id: string; domain: string; domainSlug?: string | null; subtopic: string; taskType: string; task: string;
  rubric: { id?: string; criterion: string; points: number }[]; expectedElements?: string[];
  answers: { level: string; answer: string; scores: Record<string, number>; total?: number }[];
}

/** Template-question seed/fixture file (JSON array) → items + examples. */
export function examplesFromTemplateFile(file: string, provenance = 'synthetic'): { items: JudgeItem[]; examples: CalExample[] } {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as TemplateSeed[];
  const items: JudgeItem[] = [];
  const examples: CalExample[] = [];
  for (const t of raw) {
    const rubric = t.rubric.map((r, i) => ({ id: r.id ?? `c${i + 1}`, criterion: r.criterion, points: r.points, type: 'quality' }));
    const it: JudgeItem = {
      key: `template_seed:${t.id}`, questionId: null, source: 'template_seed', domain: t.domain, domainSlug: t.domainSlug ?? null, subtopic: t.subtopic,
      taskType: t.taskType, gradingMode: 'template_rubric', caseMaterial: '', task: t.task, rubric, referenceSolution: '', redFlags: [], traps: [],
      injectionText: '', expectedElements: t.expectedElements ?? rubric.map((r) => r.criterion), deterministicChecks: [],
    };
    items.push(it);
    t.answers.forEach((a, i) => {
      const total = a.total ?? Object.values(a.scores).reduce((s, x) => s + x, 0);
      examples.push({ id: `${it.key}#${i}`, item: it, level: a.level, answer: a.answer, scores: a.scores, total, redFlagsFired: [], provenance });
    });
  }
  return { items, examples };
}

const HERE = dirname(fileURLToPath(import.meta.url));
export const SEED_DIR = join(HERE, 'seed');

/** The bundled seed calibration set (synthetic; used so the judge works before any scenario file is imported). */
export function loadSeed(): { items: JudgeItem[]; examples: CalExample[] } {
  const items: JudgeItem[] = [];
  const examples: CalExample[] = [];
  if (!existsSync(SEED_DIR)) return { items, examples };
  for (const f of readdirSync(SEED_DIR).sort()) {
    const path = join(SEED_DIR, f);
    const r = /^scenarios_.*\.jsonl$/.test(f) ? examplesFromScenarioFile(path, 'synthetic') : /^templates_.*\.json$/.test(f) ? examplesFromTemplateFile(path, 'synthetic') : null;
    if (!r) continue;
    items.push(...r.items);
    examples.push(...r.examples.map((e) => ({ ...e, item: { ...e.item, source: `seed:${e.item.source}` } })));
  }
  // keep item identity consistent after the source rename
  const byKey = new Map<string, JudgeItem>();
  for (const e of examples) { const it = byKey.get(e.item.key) ?? e.item; byKey.set(e.item.key, it); e.item = it; }
  return { items: [...byKey.values()], examples };
}
