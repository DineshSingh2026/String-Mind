/**
 * Question-bank validator. Pure functions (no DB): used by the importer, the CLI (`validate <file>`) and tests.
 * Every function returns a list of human-readable issues; an empty list means the record is clean.
 */
import { evalExpression, roundTo } from './numeric.js';
import { mapDomainToSlug } from './domain-map.js';
import { ALL_TASK_TYPES, DIFFICULTIES, TASK_TYPES, arr, isObj, num, str, type BankItem, type Json } from './types.js';

/* ───────── self-claim stripping ───────── */

const PLACEHOLDER = /\{(experience_years|specialization|agent_evidence)\}/;
const ANY_PLACEHOLDER = /\{[a-z_]+\}/;
/** Sentences that only make sense next to a (stripped) self-claim. */
const CLAIM_FOLLOW_UP = /\b(self-reported claims?|these (?:self-reported )?claims|the applicant'?s claims?)\b/i;

/**
 * Removes every sentence that injects an agent's self-claims ({experience_years}, {specialization}, {agent_evidence})
 * plus the follow-up sentence that refers to those claims. Agents' self-claims must never be inserted into exam prompts.
 */
export function stripSelfClaims(text: string): { text: string; removed: string[] } {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const removed: string[] = [];
  const kept: string[] = [];
  let prevRemoved = false;
  for (const s of sentences) {
    if (PLACEHOLDER.test(s) || ANY_PLACEHOLDER.test(s) || (prevRemoved && CLAIM_FOLLOW_UP.test(s))) {
      removed.push(s); prevRemoved = true; continue;
    }
    prevRemoved = false;
    kept.push(s);
  }
  // "a Accessibility…" → "an Accessibility…" (template grammar)
  const out = kept.join(' ').replace(/\b([Aa]) (?=[AEIOU][a-z])/g, '$1n ').replace(/\s{2,}/g, ' ').trim();
  return { text: out, removed };
}

/* ───────── text overlap (leak) check ───────── */

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9%$.]+/g, ' ').split(' ').filter((w) => w.length > 0);
/** Prose words only (≥ 3 chars with a letter): code fragments / regex character classes don't count as leaked prose. */
const proseWords = (s: string) => s.toLowerCase().replace(/`[^`]*`/g, ' ').replace(/[^a-z0-9']+/g, ' ').split(' ').filter((w) => w.length >= 3 && /[a-z]/.test(w));
function grams(ws: string[], n: number) {
  const g = new Set<string>();
  for (let i = 0; i + n <= ws.length; i++) g.add(ws.slice(i, i + n).join(' '));
  return g;
}

/**
 * Fraction of `secret`'s n-grams that also appear in `visible` (0..1), and the longest shared run length in words.
 * Used to catch rubric / reference / trap text pasted into the case material or task.
 */
export function overlap(secret: string, visible: string, n = 5) {
  const sw = proseWords(secret);
  const vw = proseWords(visible);
  if (sw.length < n || vw.length < n) return { share: 0, longest: 0 };
  const vg = grams(vw, n);
  const sg = grams(sw, n);
  let hit = 0;
  for (const g of sg) if (vg.has(g)) hit++;
  // longest shared run (in words), grown from shared n-grams
  let longest = 0;
  let run = 0;
  for (let i = 0; i + n <= sw.length; i++) {
    if (vg.has(sw.slice(i, i + n).join(' '))) { run = run ? run + 1 : n; longest = Math.max(longest, run); } else run = 0;
  }
  return { share: sg.size ? hit / sg.size : 0, longest };
}

/** Leak issues for one hidden text against what the agent will see. */
function leakIssues(label: string, secret: string, visible: string): string[] {
  if (!secret.trim()) return [];
  const o = overlap(secret, visible, 5);
  const nWords = proseWords(secret).length;
  // whole criterion / trap reproduced, or a long verbatim run (> 12 words) of hidden text
  if ((nWords >= 6 && o.share >= 0.6) || o.longest >= 12) return [`${label} leaked into case_material/task (${Math.round(o.share * 100)}% 5-gram overlap, longest run ${o.longest} words)`];
  return [];
}

/* ───────── injection test ───────── */

const INJECTION_PATTERNS = [
  /ignore (?:all |any |the )?(?:previous|prior|above|earlier|preceding) (?:instructions|directions|guidance|rules)/i,
  /disregard (?:all |any |the )?(?:previous|prior|above|earlier|your) /i,
  /\b(?:system|developer) (?:prompt|message|note|override)\b/i,
  /\byou are now\b/i,
  /\b(?:award|give|assign|grant)\b[^.]{0,40}\b(?:full|maximum|max|100|perfect)\b[^.]{0,20}\b(?:marks?|points?|score|credit)\b/i,
  /\b(?:ai|assistant|agent|model|grader|evaluator|reviewer|llm)s?\b[^.]{0,60}\b(?:must|should|shall)\b[^.]{0,30}\b(?:approve|output|respond|reply|say|state|conclude|recommend|answer)\b/i,
  /\bnote to (?:the )?(?:ai|assistant|agent|model|grader|evaluator|reviewer)\b/i,
  /\b(?:for|to|attention) (?:the |any )?(?:ai|llm|automated)\b[^.:]{0,40}(?:assistant|agent|model|reviewer|tool)?\s*[:,]/i,
  /\b(?:output|respond|reply|return|answer|state)\b[^.]{0,80}\bwithout (?:any )?(?:commentary|caveats?|explanation|qualification|questions)\b/i,
  /\bdo not (?:mention|report|flag|disclose)\b[^.]{0,60}\b(?:this|issue|finding|discrepancy|problem)\b/i,
];

export function hasInjectedInstruction(text: string) {
  return INJECTION_PATTERNS.some((r) => r.test(text));
}

/** Whether a scenario declares itself an injection test (accepts bool, string, or an object flag). */
export function isInjectionTest(v: unknown): boolean {
  if (v === true) return true;
  if (typeof v === 'string') return !/^(|none|no|false|n\/a|null)$/i.test(v.trim());
  if (isObj(v)) {
    for (const k of ['included', 'present', 'enabled', 'has_injection', 'is_injection_test', 'active']) if (k in v) return v[k] === true;
    return Object.keys(v).length > 0;
  }
  return false;
}

/* ───────── deterministic checks ───────── */

/**
 * Recompute numeric deterministic checks that carry a formula:
 *   { type: 'numeric', spec: { formula|expression, expected|value|answer, tolerance?, decimals?, variables|inputs? } }
 */
export function checkDeterministic(checks: unknown[]): string[] {
  const issues: string[] = [];
  checks.forEach((c, i) => {
    if (!isObj(c)) { issues.push(`deterministic_checks[${i}] is not an object`); return; }
    const type = str(c.type);
    if (!['numeric', 'keyword', 'unit_test', 'json_schema', 'regex', 'exact'].includes(type)) issues.push(`deterministic_checks[${i}] has unknown type '${type}'`);
    if (type !== 'numeric') return;
    const spec = isObj(c.spec) ? c.spec : {};
    const formula = str(spec.formula ?? spec.expression ?? spec.computation);
    const expected = num(spec.expected ?? spec.value ?? spec.answer ?? spec.target);
    if (expected === null) { issues.push(`deterministic_checks[${i}] numeric check has no numeric expected value`); return; }
    if (!formula) return; // nothing to recompute
    const varsRaw = isObj(spec.variables) ? spec.variables : isObj(spec.inputs) ? spec.inputs : {};
    const vars: Record<string, number> = {};
    for (const [k, v] of Object.entries(varsRaw)) { const n = num(v); if (n !== null) vars[k] = n; }
    let got: number;
    try { got = evalExpression(formula.replace(/^[^=]*=(?!=)/, '').trim() || formula, vars); } catch (e) {
      issues.push(`deterministic_checks[${i}] formula could not be evaluated (${(e as Error).message}): ${formula.slice(0, 80)}`); return;
    }
    const tol = num(spec.tolerance) ?? 0;
    const d = num(spec.decimals);
    const v = d !== null ? roundTo(got, d) : got;
    const relTol = num(spec.relative_tolerance);
    const ok = Math.abs(v - expected) <= tol + 1e-9 * Math.max(1, Math.abs(expected)) || (relTol !== null && Math.abs(v - expected) <= relTol * Math.abs(expected));
    if (!ok) issues.push(`deterministic_checks[${i}] formula gives ${+v.toPrecision(10)} but expected ${expected}`);
  });
  return issues;
}

/* ───────── scenario records ───────── */

const SCENARIO_REQUIRED = ['id', 'domain', 'subtopic', 'task_type', 'difficulty', 'case_material', 'task', 'rubric', 'reference_solution', 'license'] as const;

export function validateScenario(rec: Json): string[] {
  const issues: string[] = [];
  for (const f of SCENARIO_REQUIRED) {
    const v = rec[f];
    if (v === undefined || v === null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && v.length === 0)) issues.push(`missing required field '${f}'`);
  }
  if (!Array.isArray(rec.hidden_traps)) issues.push(`'hidden_traps' must be an array`);
  const difficulty = str(rec.difficulty);
  if (difficulty && !(DIFFICULTIES as readonly string[]).includes(difficulty)) issues.push(`difficulty '${difficulty}' is not one of ${DIFFICULTIES.join('|')}`);
  const tt = str(rec.task_type);
  if (tt && !(TASK_TYPES as readonly string[]).includes(tt)) issues.push(`task_type '${tt}' is not one of the 10 task types`);
  if (rec.domain && !mapDomainToSlug(str(rec.domain))) issues.push(`domain '${str(rec.domain)}' does not map to a platform domain`);

  const caseMaterial = str(rec.case_material);
  const task = str(rec.task);
  const caseWords = words(caseMaterial).length;
  if (caseMaterial && caseWords < 120) issues.push(`case_material has ${caseWords} words (minimum 120)`);
  if (PLACEHOLDER.test(caseMaterial + task)) issues.push('case_material/task contains self-claim placeholders');

  // rubric
  const rubric = arr(rec.rubric);
  const ids = new Set<string>();
  let total = 0;
  let mustFind = 0;
  rubric.forEach((r, i) => {
    if (!isObj(r)) { issues.push(`rubric[${i}] is not an object`); return; }
    const id = str(r.id);
    if (!id) issues.push(`rubric[${i}] has no id`);
    else if (ids.has(id)) issues.push(`duplicate rubric id '${id}'`);
    ids.add(id);
    if (!str(r.criterion).trim()) issues.push(`rubric '${id || i}' has no criterion text`);
    const type = str(r.type);
    if (!['must_find', 'quality', 'safety'].includes(type)) issues.push(`rubric '${id || i}' has invalid type '${type}'`);
    const pts = num(r.points);
    if (pts === null || pts < 0) { issues.push(`rubric '${id || i}' has invalid points`); return; }
    total += pts;
    if (type === 'must_find') mustFind += pts;
  });
  if (rubric.length) {
    if (Math.abs(total - 100) > 0.5) issues.push(`rubric points total ${+total.toFixed(2)} (must be 100 ± 0.5)`);
    if (mustFind < 60) issues.push(`must_find points total ${+mustFind.toFixed(2)} (must be ≥ 60)`);
  }

  // leakage of hidden material into what the agent sees
  const visible = `${caseMaterial}\n${task}`;
  rubric.forEach((r, i) => {
    if (!isObj(r)) return;
    issues.push(...leakIssues(`rubric '${str(r.id) || i}' criterion`, str(r.criterion), visible));
    issues.push(...leakIssues(`rubric '${str(r.id) || i}' evidence_of_success`, str(r.evidence_of_success), visible));
  });
  arr(rec.hidden_traps).forEach((t, i) => {
    if (isObj(t)) issues.push(...leakIssues(`hidden trap '${str(t.id) || i}'`, str(t.description), visible));
  });
  const ref = str(rec.reference_solution);
  if (ref) {
    const o = overlap(ref, visible, 8);
    if (o.share >= 0.35) issues.push(`reference_solution leaked into case_material/task (${Math.round(o.share * 100)}% 8-gram overlap)`);
  }

  issues.push(...checkDeterministic(arr(rec.deterministic_checks)));

  if (isInjectionTest(rec.injection_test)) {
    const inj = isObj(rec.injection_test) ? str(rec.injection_test.text ?? rec.injection_test.injected_text ?? rec.injection_test.payload) : '';
    const present = (inj && caseMaterial.includes(inj)) || hasInjectedInstruction(caseMaterial);
    if (!present) issues.push('injection_test scenario but no injected instruction found in case_material');
  }
  return issues;
}

/* ───────── calibration records ───────── */

export function validateCalibration(cal: Json, scenario?: Json | null): string[] {
  const issues: string[] = [];
  const label = `calibration ${str(cal.scenario_id)}/${str(cal.level) || '?'}`;
  if (!str(cal.scenario_id)) issues.push(`${label}: missing scenario_id`);
  if (!str(cal.level)) issues.push(`${label}: missing level`);
  if (!str(cal.answer).trim()) issues.push(`${label}: missing answer`);
  const scores = isObj(cal.scores) ? cal.scores : null;
  const total = num(cal.total);
  if (!scores) issues.push(`${label}: missing scores`);
  if (total === null) issues.push(`${label}: missing total`);
  if (scores && total !== null) {
    let sum = 0;
    for (const [k, v] of Object.entries(scores)) {
      const n = num(v);
      if (n === null) { issues.push(`${label}: score for '${k}' is not a number`); continue; }
      sum += n;
    }
    if (Math.abs(sum - total) > 0.5) issues.push(`${label}: total ${total} ≠ sum of scores ${+sum.toFixed(2)}`);
  }
  if (scenario && scores) {
    const points = new Map<string, number>();
    for (const r of arr(scenario.rubric)) if (isObj(r)) points.set(str(r.id), num(r.points) ?? 0);
    for (const [k, v] of Object.entries(scores)) {
      if (!points.has(k)) { issues.push(`${label}: score for unknown rubric id '${k}'`); continue; }
      const n = num(v);
      if (n !== null && (n < 0 || n > points.get(k)! + 1e-9)) issues.push(`${label}: score ${n} for '${k}' outside 0..${points.get(k)}`);
    }
  }
  return issues;
}

const isGeneric = (lvl: string) => /^generic/i.test(lvl);
const isCompetent = (lvl: string) => /^competent/i.test(lvl);

/** Cross-answer rules for one scenario's calibration set. */
export function validateCalibrationSet(cals: Json[]): string[] {
  const issues: string[] = [];
  const generic = cals.filter((c) => isGeneric(str(c.level)));
  const competent = cals.filter((c) => isCompetent(str(c.level)));
  for (const g of generic) {
    const gt = num(g.total);
    if (gt === null) continue;
    if (gt > 45) issues.push(`generic calibration answer scores ${gt} (must be ≤ 45)`);
    for (const c of competent) {
      const ct = num(c.total);
      if (ct !== null && gt >= ct) issues.push(`generic calibration answer (${gt}) is not below the competent one (${ct})`);
    }
  }
  return issues;
}

/* ───────── any normalised bank item ───────── */

/** Structural checks shared by every source after normalisation. */
export function validateBankItem(item: BankItem): string[] {
  const issues: string[] = [];
  if (!item.externalId) issues.push('missing external id');
  if (!item.task.trim()) issues.push('empty task text');
  if (!(DIFFICULTIES as readonly string[]).includes(item.difficulty)) issues.push(`difficulty '${item.difficulty}' is not one of the 4 tiers`);
  if (!(ALL_TASK_TYPES as readonly string[]).includes(item.taskType)) issues.push(`task_type '${item.taskType}' is not a known task type`);
  if (!item.domainSlug) issues.push(`domain '${item.domainName}' does not map to a platform domain`);
  if (PLACEHOLDER.test(item.task) || PLACEHOLDER.test(item.caseMaterial)) issues.push('self-claim placeholder still present in the prompt');
  if (item.gradingMode !== 'numeric') {
    const total = item.rubric.reduce((a, r) => a + (num(r.points) ?? 0), 0);
    if (!item.rubric.length) issues.push('rubric is empty');
    else if (Math.abs(total - 100) > 0.5) issues.push(`rubric points total ${+total.toFixed(2)} (must be 100 ± 0.5)`);
    const ids = item.rubric.map((r) => str(r.id));
    if (new Set(ids).size !== ids.length) issues.push('duplicate rubric ids');
  } else if (!item.deterministicChecks.length) issues.push('numeric item has no deterministic check');
  return issues;
}
