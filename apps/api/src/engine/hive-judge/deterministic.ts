/**
 * Hive Judge tier 1 — deterministic checks (pure, instant, never executes agent code).
 *
 *   numeric      spec.expected (number | number[]), spec.tolerance (absolute; relative: true → fraction of |expected|).
 *                Numbers are extracted robustly: 1,234.5 · 12% (≙ 0.12) · $3.2M · 45k · −3 · 1e-3. The "Final answer:" line
 *                wins, else the last number; array expectations need every value somewhere in the answer.
 *   keyword      all_of / all / must_include · any_of / any · none_of / none / must_not_include (case/diacritics-insensitive)
 *   json_schema  first JSON object/array in the answer validated against a small JSON-schema subset
 *   unit_test    → 'requires_sandbox' (agent code is untrusted and is never run here)
 */
import { extractNumbers, numbersAgree, type NumberHit } from './text.js';

export type DetStatus = 'passed' | 'failed' | 'requires_sandbox' | 'invalid_spec';
export interface DetResult { type: string; status: DetStatus; binding: boolean; checkpoints: string[]; detail: string }

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' || typeof x === 'number').map(String) : typeof v === 'string' || typeof v === 'number' ? [String(v)] : []);
const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();

/** Numbers that count as the result: the last "final answer / answer:" line, else the last number in the answer. */
export function resultNumbers(answer: string): { values: NumberHit[]; source: 'final_line' | 'last_number' | 'none' } {
  const lines = answer.split(/\r?\n/);
  const final = [...lines].reverse().find((l) => /final answer|\banswer\s*[:=]|\bresult\s*[:=]/i.test(l));
  if (final) {
    const after = final.replace(/^.*?(?:final answer|answer|result)\s*(?:is)?\s*[:=]?\s*/i, '');
    const v = extractNumbers(after);
    if (v.length) return { values: v, source: 'final_line' };
  }
  const all = extractNumbers(answer);
  return all.length ? { values: [all[all.length - 1]!], source: 'last_number' } : { values: [], source: 'none' };
}

function numeric(specRaw: unknown, answer: string): Pick<DetResult, 'status' | 'detail'> {
  const spec = typeof specRaw === 'number' ? { expected: specRaw } : rec(specRaw);
  const exp = spec.expected ?? spec.value ?? spec.answer ?? spec.ground_truth ?? spec.groundTruth;
  const expected = (Array.isArray(exp) ? exp : [exp])
    .map((x) => (typeof x === 'string' ? Number(x.replace(/[,\s%]/g, '')) : x))
    .filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  if (!expected.length) return { status: 'invalid_spec', detail: 'numeric check has no expected value' };
  const tolRaw = Number(spec.tolerance ?? spec.tol ?? 0);
  const tol = Number.isFinite(tolRaw) && tolRaw >= 0 ? tolRaw : 0;
  const relative = spec.relative === true || spec.tolerance_type === 'relative';
  const within = (got: NumberHit, want: number) => {
    const t = (relative ? tol * Math.abs(want) : tol) + 1e-9 * Math.max(1, Math.abs(want));
    if (Math.abs(got.value - want) <= t) return true;
    // "12%" written for an expected fraction 0.12 (or vice versa) — only when tolerance is tight enough to be unambiguous
    if (got.pct && Math.abs(got.value / 100 - want) <= t) return true;
    return tol === 0 && numbersAgree(got, want, 1e-9);
  };
  if (expected.length > 1) {
    const all = extractNumbers(answer);
    const ok = expected.every((w) => all.some((g) => within(g, w)));
    return { status: ok ? 'passed' : 'failed', detail: `expected all of [${expected.join(', ')}] (tolerance ${tol}${relative ? ' relative' : ''})` };
  }
  const got = resultNumbers(answer);
  const ok = got.values.some((g) => within(g, expected[0]!));
  return { status: ok ? 'passed' : 'failed', detail: `expected ${expected[0]} (tolerance ${tol}${relative ? ' relative' : ''}); found ${got.values.map((v) => v.raw).join(', ') || 'no number'} (${got.source})` };
}

function keyword(specRaw: unknown, answer: string): Pick<DetResult, 'status' | 'detail'> {
  const spec = Array.isArray(specRaw) || typeof specRaw === 'string' ? { all: specRaw } : rec(specRaw);
  const all = [...strs(spec.all_of), ...strs(spec.all), ...strs(spec.must_include), ...strs(spec.keywords)];
  const any = [...strs(spec.any_of), ...strs(spec.any)];
  const none = [...strs(spec.none_of), ...strs(spec.none), ...strs(spec.must_not_include), ...strs(spec.forbidden)];
  if (!all.length && !any.length && !none.length) return { status: 'invalid_spec', detail: 'keyword check has no terms' };
  const t = norm(answer);
  const has = (k: string) => t.includes(norm(k));
  const missing = all.filter((k) => !has(k));
  const anyOk = !any.length || any.some(has);
  const bad = none.filter(has);
  const ok = !missing.length && anyOk && !bad.length;
  return {
    status: ok ? 'passed' : 'failed',
    detail: ok ? 'all keyword conditions met' : [missing.length ? `missing: ${missing.join(', ')}` : '', anyOk ? '' : `none of: ${any.join(', ')}`, bad.length ? `forbidden present: ${bad.join(', ')}` : ''].filter(Boolean).join('; '),
  };
}

/** Minimal JSON-schema subset: type, enum, required, properties, items. */
export function schemaProblems(value: unknown, schema: Record<string, unknown>, path = '$', depth = 0): string[] {
  if (depth > 12) return [];
  const typeOf = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' && Number.isInteger(v) ? 'integer' : typeof v);
  const type = schema.type;
  if (typeof type === 'string' || Array.isArray(type)) {
    const allowed = (Array.isArray(type) ? type : [type]).map(String);
    const t = typeOf(value);
    if (!(allowed.includes(t) || (t === 'integer' && allowed.includes('number')))) return [`${path}: expected ${allowed.join('|')}, got ${t}`];
  }
  const out: string[] = [];
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) out.push(`${path}: not an allowed value`);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    for (const r of strs(schema.required)) if (!(r in o)) out.push(`${path}.${r}: required`);
    for (const [k, s] of Object.entries(rec(schema.properties))) if (k in o) out.push(...schemaProblems(o[k], rec(s), `${path}.${k}`, depth + 1));
  }
  if (Array.isArray(value) && schema.items && typeof schema.items === 'object') value.slice(0, 200).forEach((v, i) => out.push(...schemaProblems(v, rec(schema.items), `${path}[${i}]`, depth + 1)));
  return out;
}

function firstJson(answer: string): unknown {
  const t = answer.replace(/```(?:json)?/gi, '');
  for (const open of ['{', '[']) {
    const close = open === '{' ? '}' : ']';
    const start = t.indexOf(open);
    if (start < 0) continue;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < t.length; i++) {
      const ch = t[i]!;
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close && --depth === 0) { try { return JSON.parse(t.slice(start, i + 1)); } catch { break; } }
    }
  }
  return undefined;
}

function jsonSchema(specRaw: unknown, answer: string): Pick<DetResult, 'status' | 'detail'> {
  const spec = rec(specRaw);
  const schema = rec(spec.schema ?? specRaw);
  if (!Object.keys(schema).length) return { status: 'invalid_spec', detail: 'json_schema check has no schema' };
  const value = firstJson(answer);
  if (value === undefined) return { status: 'failed', detail: 'no JSON found in the answer' };
  const p = schemaProblems(value, schema);
  return { status: p.length ? 'failed' : 'passed', detail: p.length ? p.slice(0, 5).join('; ') : 'valid' };
}

export function runChecks(checks: Record<string, unknown>[] | undefined, answer: string): DetResult[] {
  return (checks ?? []).map((c) => {
    const type = String(c.type ?? '').toLowerCase();
    const spec = c.spec ?? c;
    const sr = rec(spec);
    const checkpoints = [...strs(c.checkpoints), ...strs(c.checkpoint), ...strs(c.rubric_id), ...strs(sr.checkpoints), ...strs(sr.checkpoint), ...strs(sr.rubric_id)];
    const explicit = (c.binding ?? sr.binding) as unknown;
    if (['unit_test', 'unittest', 'code', 'test'].includes(type)) {
      return { type: 'unit_test', status: 'requires_sandbox' as const, binding: false, checkpoints, detail: 'unit tests are never executed by the judge (untrusted code) — needs a sandboxed runner or an expert' };
    }
    if (type === 'numeric' || type === 'number') return { type: 'numeric', binding: explicit !== false, checkpoints, ...numeric(spec, answer) };
    if (type === 'keyword' || type === 'keywords') return { type: 'keyword', binding: explicit === true, checkpoints, ...keyword(spec, answer) };
    if (type === 'json_schema' || type === 'json') return { type: 'json_schema', binding: explicit !== false, checkpoints, ...jsonSchema(spec, answer) };
    return { type: type || 'unknown', status: 'invalid_spec' as const, binding: false, checkpoints, detail: `unsupported check type "${type}"` };
  });
}
