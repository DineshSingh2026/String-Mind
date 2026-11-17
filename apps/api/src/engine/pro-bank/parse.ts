/**
 * Source-file parsers: turn each knowledge-library inbox file into normalised BankItems (+ calibrations, twists,
 * proof guidance). File contents are untrusted DATA — they are parsed as JSON and never executed or interpreted.
 *
 *   questions_7000.jsonl                         → template_rubric · private (self-claim sentences stripped)
 *   evaluation_items.jsonl                       → numeric (re-verified) | template_rubric deliverables · private
 *   hive_mind_original_example_questions.json    → case_rubric with reference answers · public_example (published examples)
 *   work_product_blueprints.json                 → template_rubric · private
 *   **∕scenarios_*.jsonl                         → case_rubric · private (+ calibration, twists, proof_evaluation)
 *
 * The owner's files are private data → 'private' (except the published original examples). Status: clean → 'active'
 * immediately (owner decision: admins review after activation); validation issues → 'review'.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { lookupDomain } from './domain-map.js';
import { recomputeEvaluationItem } from './numeric.js';
import {
  stripSelfClaims, validateBankItem, validateCalibration, validateCalibrationSet, validateScenario,
} from './validate.js';
import {
  CALCULATION, DIFFICULTIES, TASK_TYPES, arr, isObj, num, str,
  type BankCalibration, type BankItem, type BankTwist, type Json, type ProofGuidanceRecord,
} from './types.js';

export type SourceKind = 'questions_7000' | 'evaluation_items' | 'original_examples' | 'blueprints' | 'scenarios';

export interface ParsedSource {
  source: string;
  kind: SourceKind;
  file: string;
  /** records read from the file (lines / array entries, incl. non-question records) */
  read: number;
  items: BankItem[];
  calibrations: BankCalibration[];
  twists: BankTwist[];
  proof: ProofGuidanceRecord[];
  /** exact duplicate prompts dropped inside this file */
  duplicates: number;
  /** lines that were not valid JSON or had no usable record type */
  parseErrors: string[];
  /** records skipped on purpose (e.g. 'continue' markers) */
  skipped: number;
}

/** Which parser handles a file (null = not a bank source). */
export function detectKind(file: string): SourceKind | null {
  const b = basename(file).toLowerCase();
  if (b === 'questions_7000.jsonl') return 'questions_7000';
  if (b === 'evaluation_items.jsonl') return 'evaluation_items';
  if (b === 'hive_mind_original_example_questions.json') return 'original_examples';
  if (b === 'work_product_blueprints.json') return 'blueprints';
  if (/^scenarios_.*\.jsonl$/.test(b)) return 'scenarios';
  return null;
}

const SOURCE_NAME: Record<Exclude<SourceKind, 'scenarios'>, string> = {
  questions_7000: 'questions_7000', evaluation_items: 'evaluation_items', original_examples: 'original_examples', blueprints: 'blueprints',
};

export const normPrompt = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

function readJsonl(file: string, errors: string[]): Json[] {
  const out: Json[] = [];
  readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const v = JSON.parse(line);
      if (isObj(v)) out.push(v); else errors.push(`line ${i + 1}: not a JSON object`);
    } catch { errors.push(`line ${i + 1}: invalid JSON`); }
  });
  return out;
}

function readJsonArray(file: string, errors: string[]): Json[] {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'));
    const a = Array.isArray(v) ? v : isObj(v) ? (Object.values(v).find(Array.isArray) ?? []) : [];
    return (a as unknown[]).filter(isObj);
  } catch { errors.push('file is not valid JSON'); return []; }
}

/** First of the 4 tiers mentioned in a free-text label ("professional-to-expert" → professional). */
function firstTier(label: string, fallback: string): string {
  const l = label.toLowerCase();
  let best: { t: string; i: number } | null = null;
  for (const t of DIFFICULTIES) { const i = l.indexOf(t); if (i >= 0 && (!best || i < best.i)) best = { t, i }; }
  return best?.t ?? fallback;
}

/** Spread 100 points over n criteria (2-decimal, remainder on the last). */
function evenPoints(n: number) {
  const each = Math.floor((100 / n) * 100) / 100;
  return Array.from({ length: n }, (_, i) => (i === n - 1 ? +(100 - each * (n - 1)).toFixed(2) : each));
}

const slugId = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'criterion';
function uniqueIds(names: string[]) {
  const seen = new Map<string, number>();
  return names.map((n) => { const b = slugId(n); const k = (seen.get(b) ?? 0) + 1; seen.set(b, k); return k > 1 ? `${b}_${k}` : b; });
}

function finish(item: Omit<BankItem, 'validationIssues' | 'status'> & { validationIssues?: string[]; status?: BankItem['status'] }): BankItem {
  // Owner decision: clean items go live immediately ('active'); anything with validation issues waits in 'review'.
  const full: BankItem = { ...item, validationIssues: item.validationIssues ?? [], status: item.status ?? 'active' };
  const extra = validateBankItem(full);
  full.validationIssues = [...new Set([...full.validationIssues, ...extra])];
  if (full.validationIssues.length) full.status = 'review';
  return full;
}

function domainOf(name: string) {
  return { domainName: name, domainSlug: lookupDomain(name)?.slug ?? null };
}

/* ───────── questions_7000 ───────── */

function parseQuestions7000(rows: Json[]): BankItem[] {
  return rows.map((r) => {
    const { text, removed } = stripSelfClaims(str(r.question));
    const rub = isObj(r.rubric) ? r.rubric : {};
    const criteria = arr(rub.criteria).filter(isObj);
    const ids = uniqueIds(criteria.map((c) => str(c.criterion)));
    const d = domainOf(str(r.domain));
    return finish({
      externalId: str(r.id), source: 'questions_7000', ...d,
      subtopic: str(r.subtopic), taskType: str(r.task_type), difficulty: str(r.difficulty),
      caseMaterial: '', task: text,
      rubric: criteria.map((c, i) => ({ id: ids[i]!, criterion: str(c.criterion), type: 'quality', points: num(c.points) ?? 0 })),
      referenceSolution: '', redFlags: [], deterministicChecks: [], variations: [],
      gradingMode: 'template_rubric', visibility: 'private', expertReviewRequired: false,
      license: str(r.license),
      meta: {
        difficultyMethod: str(r.difficulty_method) || 'author-assigned; not empirical',
        difficultyNote: 'author-assigned difficulty, not calibrated',
        experienceTargetYears: r.experience_target_years ?? null,
        deliverableType: r.deliverable_type ?? null,
        expectedAnswerElements: r.expected_answer_elements ?? [],
        scoringGuidance: rub.scoring_guidance ?? null,
        validation: r.validation ?? null,
        referenceAnswerType: r.reference_answer_type ?? null,
        antiLeakage: r.anti_leakage ?? null,
        tags: r.tags ?? [],
        templateNote: 'Generic template: no concrete scenario ("for the stated project context"); rubric is generic.',
        strippedSelfClaimSentences: removed.length,
      },
    });
  });
}

/* ───────── evaluation_items ───────── */

function parseEvaluationItems(rows: Json[]): BankItem[] {
  return rows.map((r) => {
    const d = domainOf(str(r.domain));
    const common = {
      externalId: str(r.id), source: 'evaluation_items', ...d, subtopic: str(r.subtopic), caseMaterial: '', redFlags: [] as string[],
      variations: [] as Json[], visibility: 'private' as const, license: str(r.license),
    };
    const baseMeta = {
      sourceDifficultyLabel: r.difficulty_label ?? null, difficultyMethod: r.difficulty_method ?? null,
      explanation: r.explanation ?? null, contaminationRisk: r.contamination_risk ?? null, generatedFromSeed: r.generated_from_seed ?? null,
    };
    if (str(r.answer_type).startsWith('numeric')) {
      const prompt = str(r.prompt);
      const tolerance = num(r.tolerance) ?? 0;
      const v = recomputeEvaluationItem(str(r.subtopic), prompt, r.ground_truth, tolerance);
      const issues = v.status === 'mismatch' ? [`ground truth failed re-verification: ${v.note}`] : [];
      return finish({
        ...common, taskType: CALCULATION, difficulty: 'beginner', task: prompt,
        rubric: [{ id: 'correct_result', criterion: 'Final numeric answer matches the verified ground truth', type: 'must_find', points: 100 }],
        referenceSolution: String(r.ground_truth),
        deterministicChecks: [{ type: 'numeric', spec: { expected: num(r.ground_truth), tolerance, answerType: str(r.answer_type) } }],
        gradingMode: 'numeric', expertReviewRequired: false,
        validationIssues: issues, 
        meta: {
          ...baseMeta,
          difficultyNote: `relabelled beginner: school-level parametric arithmetic (source label '${str(r.difficulty_label)}', not calibrated)`,
          verification: v,
        },
      });
    }
    // expert_rubric: professional deliverables (70 blueprints × 6 twists) and the 20 curated baseline examples
    const weights = isObj(r.rubric) ? Object.entries(r.rubric) : [];
    const ids = uniqueIds(weights.map(([k]) => k));
    const gt = isObj(r.ground_truth) ? r.ground_truth : null;
    const twist = /Additional scenario:\s*(.*?)\.\s*Submit/i.exec(str(r.prompt))?.[1] ?? null;
    const deliverable = str(r.subtopic) === 'professional deliverable';
    return finish({
      ...common, taskType: deliverable ? 'work_product' : inferTaskType(str(r.prompt)),
      difficulty: firstTier(str(r.difficulty_label), 'professional'), task: str(r.prompt),
      rubric: weights.map(([k, w], i) => ({ id: ids[i]!, criterion: k.replace(/_/g, ' '), type: 'quality', points: +((num(w) ?? 0) * 100).toFixed(2) })),
      referenceSolution: typeof r.ground_truth === 'string' ? r.ground_truth : '',
      deterministicChecks: [], gradingMode: 'template_rubric', expertReviewRequired: true,
      meta: {
        ...baseMeta,
        difficultyNote: 'author-assigned difficulty, not calibrated (lower bound of the source label)',
        acceptanceCriteria: gt?.acceptance_criteria ?? null, mustInclude: gt?.must_include ?? null, review: gt?.review ?? null,
        scenarioTwist: twist, taskTypeInferred: !deliverable,
      },
    });
  });
}

/* ───────── original examples ───────── */

/** Heuristic task type for items that don't declare one (flagged in meta.taskTypeInferred). */
export function inferTaskType(q: string): string {
  const s = q.toLowerCase();
  if (/\b(rewrite|draft|write|design a|describe minimum acceptance tests)\b/.test(s)) return 'work_product';
  if (/\b(compute|calculate|find acceleration|prove)\b/.test(s)) return 'quant_reasoning';
  if (/\b(safe|escalat|refund|authori[sz])/.test(s)) return 'safety_and_governance';
  if (/\b(identify|diagnos|explain why|misconception|inaccurate)\b/.test(s)) return 'error_analysis';
  return 'case_decision';
}

function parseOriginals(rows: Json[]): BankItem[] {
  return rows.map((r) => {
    const parts = str(r.rubric_weights).split(',').map((p) => p.trim()).filter(Boolean).map((p) => {
      const i = p.lastIndexOf(':');
      return i < 0 ? { name: p, pts: NaN } : { name: p.slice(0, i).trim(), pts: Number(p.slice(i + 1)) };
    });
    const ids = uniqueIds(parts.map((p) => p.name));
    const d = domainOf(str(r.domain));
    return finish({
      externalId: str(r.id), source: 'original_examples', ...d, subtopic: '', taskType: inferTaskType(str(r.question)),
      difficulty: firstTier(str(r.difficulty), 'intermediate'), caseMaterial: '', task: str(r.question),
      rubric: parts.map((p, i) => ({ id: ids[i]!, criterion: p.name, type: 'quality', points: Number.isFinite(p.pts) ? p.pts : 0 })),
      referenceSolution: str(r.reference_answer), redFlags: [], deterministicChecks: [], variations: [],
      gradingMode: 'case_rubric', visibility: 'public_example', expertReviewRequired: true, license: str(r.rights),
      meta: {
        sourceDifficultyLabel: r.difficulty ?? null, difficultyNote: 'author-assigned difficulty, not calibrated',
        gradingMethod: r.grading_method ?? null, contaminationNote: r.contamination_note ?? null, taskTypeInferred: true,
      },
    });
  });
}

/* ───────── blueprints ───────── */

function parseBlueprints(rows: Json[]): BankItem[] {
  const perDomain = new Map<string, number>();
  return rows.map((r) => {
    const domain = str(r.domain);
    const k = (perDomain.get(domain) ?? 0) + 1;
    perDomain.set(domain, k);
    const dims = arr(r.rubric_dimensions).map(str).filter(Boolean);
    const ids = uniqueIds(dims);
    const pts = dims.length ? evenPoints(dims.length) : [];
    const d = domainOf(domain);
    return finish({
      externalId: `BP-${slugId(domain)}-${k}`, source: 'blueprints', ...d, subtopic: 'work product blueprint', taskType: 'work_product',
      difficulty: 'professional', caseMaterial: '', task: str(r.task),
      rubric: dims.map((dim, i) => ({ id: ids[i]!, criterion: dim, type: 'quality', points: pts[i]! })),
      referenceSolution: '', redFlags: [], deterministicChecks: [], variations: [],
      gradingMode: 'template_rubric', visibility: 'private', expertReviewRequired: true, license: str(r.source),
      meta: {
        difficultyNote: 'author-assigned difficulty, not calibrated',
        externalDataNeededForGroundTruth: r.external_data_needed_for_ground_truth ?? null,
        rubricNote: 'Rubric dimensions weighted equally by the importer (source gives no weights).',
      },
    });
  });
}

/* ───────── generated scenarios ───────── */

const SCENARIO_META_KEYS = [
  'difficulty_justification', 'target_experience_years', 'expert_minutes', 'tools_allowed', 'hidden_traps', 'standards',
  'jurisdiction', 'knowledge_date', 'injection_test', 'uncertain_facts', 'self_check',
] as const;

function parseScenarioFile(rows: Json[], source: string, parseErrors: string[]) {
  const scenarios = new Map<string, Json>();
  const cals: Json[] = [];
  const twists: BankTwist[] = [];
  const proof: ProofGuidanceRecord[] = [];
  let skipped = 0;
  rows.forEach((r, i) => {
    switch (str(r.record)) {
      case 'scenario': {
        const id = str(r.id);
        if (!id) { parseErrors.push(`record ${i + 1}: scenario without id`); return; }
        scenarios.set(id, r); return;
      }
      case 'calibration': cals.push(r); return;
      case 'twists':
        for (const t of arr(r.twists)) {
          if (!isObj(t) || !str(t.twist).trim()) continue;
          twists.push({ domainName: str(r.domain), domainSlug: lookupDomain(str(r.domain))?.slug ?? null, twist: str(t.twist), rubricEffect: str(t.rubric_effect) });
        }
        return;
      case 'proof_evaluation': {
        const { record: _r, ...rest } = r;
        proof.push({ domain: str(r.domain), domainSlug: lookupDomain(str(r.domain))?.slug ?? null, source, record: rest });
        return;
      }
      case 'continue': skipped++; return;
      default: parseErrors.push(`record ${i + 1}: unknown record type '${str(r.record)}'`);
    }
  });

  const calsBy = new Map<string, Json[]>();
  for (const c of cals) { const k = str(c.scenario_id); calsBy.set(k, [...(calsBy.get(k) ?? []), c]); }

  const items: BankItem[] = [];
  for (const [id, s] of scenarios) {
    const myCals = calsBy.get(id) ?? [];
    const issues = [...validateScenario(s), ...validateCalibrationSet(myCals), ...myCals.flatMap((c) => validateCalibration(c, s))];
    const d = domainOf(str(s.domain));
    const meta: Json = { calibrationCount: myCals.length, difficultyNote: 'generator-assigned difficulty, not calibrated' };
    for (const k of SCENARIO_META_KEYS) if (s[k] !== undefined) meta[k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = s[k];
    items.push(finish({
      externalId: id, source, ...d, subtopic: str(s.subtopic), taskType: str(s.task_type), difficulty: str(s.difficulty),
      caseMaterial: str(s.case_material), task: str(s.task),
      rubric: arr(s.rubric).filter(isObj).map((r) => ({ ...r, points: num(r.points) ?? 0 })),
      referenceSolution: str(s.reference_solution), redFlags: arr(s.red_flags).map(str).filter(Boolean),
      deterministicChecks: arr(s.deterministic_checks).filter(isObj), variations: arr(s.variations).filter(isObj),
      gradingMode: 'case_rubric', visibility: 'private', expertReviewRequired: s.expert_review_required === true,
      license: str(s.license), validationIssues: issues, meta,
    }));
  }

  const calibrations: BankCalibration[] = cals.map((c) => {
    const scen = scenarios.get(str(c.scenario_id)) ?? null;
    const issues = validateCalibration(c, scen);
    if (!scen) issues.push(`calibration for unknown scenario '${str(c.scenario_id)}'`);
    const scores: Record<string, number> = {};
    if (isObj(c.scores)) for (const [k, v] of Object.entries(c.scores)) { const n = num(v); if (n !== null) scores[k] = n; }
    return {
      scenarioExternalId: str(c.scenario_id), level: str(c.level) || 'other', answer: str(c.answer), scores,
      total: num(c.total) ?? Object.values(scores).reduce((a, b) => a + b, 0), redFlagsFired: arr(c.red_flags_fired).map(str),
      rationale: [str(c.rationale), str(c.label) ? `label: ${str(c.label)}` : ''].filter(Boolean).join('\n'), issues,
    };
  });
  return { items, calibrations, twists, proof, skipped };
}

/* ───────── entry point ───────── */

export function parseSourceFile(file: string): ParsedSource | null {
  const kind = detectKind(file);
  if (!kind) return null;
  const parseErrors: string[] = [];
  const source = kind === 'scenarios' ? basename(file).replace(/\.jsonl$/i, '') : SOURCE_NAME[kind];
  const rows = kind === 'original_examples' || kind === 'blueprints' ? readJsonArray(file, parseErrors) : readJsonl(file, parseErrors);
  const out: ParsedSource = { source, kind, file, read: rows.length, items: [], calibrations: [], twists: [], proof: [], duplicates: 0, parseErrors, skipped: 0 };
  if (kind === 'questions_7000') out.items = parseQuestions7000(rows);
  else if (kind === 'evaluation_items') out.items = parseEvaluationItems(rows);
  else if (kind === 'original_examples') out.items = parseOriginals(rows);
  else if (kind === 'blueprints') out.items = parseBlueprints(rows);
  else Object.assign(out, parseScenarioFile(rows, source, parseErrors));

  // drop items without an id, then exact duplicate prompts within the file (first occurrence wins)
  const seenId = new Set<string>();
  const seenPrompt = new Set<string>();
  out.items = out.items.filter((it) => {
    if (!it.externalId) { parseErrors.push('record without id skipped'); return false; }
    if (seenId.has(it.externalId)) { out.duplicates++; return false; }
    seenId.add(it.externalId);
    const k = normPrompt(`${it.caseMaterial}\n${it.task}`);
    if (seenPrompt.has(k)) { out.duplicates++; return false; }
    seenPrompt.add(k);
    return true;
  });
  return out;
}

export { TASK_TYPES };
