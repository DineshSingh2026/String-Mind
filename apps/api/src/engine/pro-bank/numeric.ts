/**
 * Numeric helpers for the question bank:
 *  - `evalExpression`: a tiny, safe arithmetic evaluator (no eval / Function). Supports + - * / % ^, parentheses,
 *    unary minus, ×/÷/− glyphs, named variables and a few functions (sqrt, abs, ln, log10, exp, min, max, round).
 *  - `recomputeEvaluationItem`: recomputes the ground truth of the 20 parametric templates in evaluation_items.jsonl
 *    straight from the prompt text, so a wrong key is caught before it reaches an agent.
 */

type Tok = { t: 'num'; v: number } | { t: 'id'; v: string } | { t: 'op'; v: string };

function tokenize(src: string): Tok[] {
  const s = src.replace(/[×·]/g, '*').replace(/÷/g, '/').replace(/[−–]/g, '-').replace(/\*\*/g, '^');
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s.slice(i));
      if (!m) throw new Error(`bad number at ${i}`);
      out.push({ t: 'num', v: Number(m[0]) }); i += m[0].length; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i))!;
      out.push({ t: 'id', v: m[0] }); i += m[0].length; continue;
    }
    if ('+-*/%^(),'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    throw new Error(`unexpected character '${c}'`);
  }
  return out;
}

const FUNCS: Record<string, (...a: number[]) => number> = {
  sqrt: Math.sqrt, abs: Math.abs, ln: Math.log, log: Math.log10, log10: Math.log10, exp: Math.exp,
  min: Math.min, max: Math.max, round: (x, d = 0) => roundTo(x, d), floor: Math.floor, ceil: Math.ceil,
};
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };

/** Evaluates an arithmetic expression. Throws on syntax errors or unknown identifiers. */
export function evalExpression(src: string, vars: Record<string, number> = {}): number {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const eat = (v?: string) => {
    const t = toks[p];
    if (!t || (v !== undefined && !(t.t === 'op' && t.v === v))) throw new Error(`expected ${v ?? 'token'}`);
    p++; return t;
  };
  const isOp = (v: string) => { const t = peek(); return !!t && t.t === 'op' && t.v === v; };
  function expr(): number {
    let v = term();
    while (isOp('+') || isOp('-')) { const o = eat().v; const r = term(); v = o === '+' ? v + r : v - r; }
    return v;
  }
  function term(): number {
    let v = unary();
    while (isOp('*') || isOp('/') || isOp('%')) {
      const o = eat().v; const r = unary();
      v = o === '*' ? v * r : o === '/' ? v / r : v % r;
    }
    return v;
  }
  function unary(): number {
    if (isOp('-')) { eat(); return -unary(); }
    if (isOp('+')) { eat(); return unary(); }
    return power();
  }
  function power(): number {
    const b = atom();
    if (isOp('^')) { eat(); return Math.pow(b, unary()); }
    return b;
  }
  function atom(): number {
    const t = peek();
    if (!t) throw new Error('unexpected end');
    if (t.t === 'num') { p++; return t.v; }
    if (t.t === 'op' && t.v === '(') { eat('('); const v = expr(); eat(')'); return v; }
    if (t.t === 'id') {
      p++;
      if (isOp('(')) {
        const f = FUNCS[t.v.toLowerCase()];
        if (!f) throw new Error(`unknown function ${t.v}`);
        eat('(');
        const args = [expr()];
        while (isOp(',')) { eat(','); args.push(expr()); }
        eat(')');
        return f(...args);
      }
      if (t.v in vars) return vars[t.v]!;
      const c = CONSTS[t.v.toLowerCase()];
      if (c !== undefined) return c;
      throw new Error(`unknown identifier ${t.v}`);
    }
    throw new Error(`unexpected '${t.v}'`);
  }
  const v = expr();
  if (p !== toks.length) throw new Error('trailing input');
  return v;
}

export function roundTo(x: number, d: number) {
  const f = Math.pow(10, d);
  return Math.round((x + Math.sign(x) * Number.EPSILON * Math.abs(x)) * f) / f;
}

/** Number of decimals as written (e.g. 14081.58 → 2). */
export function decimalsOf(n: number) {
  const s = String(n);
  if (s.includes('e')) return 10;
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

/** Declared rounding in a prompt ("rounded to 5 decimals", "round to 4 decimals", "; 5 decimals", "2 decimals"). */
export function declaredDecimals(prompt: string): number | null {
  const m = /(?:round(?:ed)?\s+to\s+)?(\d+)\s+(?:decimal(?:s| places)?|places)/i.exec(prompt);
  if (!m) return null;
  // "before rounding to integer, 2 decimals" → 2 decimals still declared
  return Number(m[1]);
}

/** True if `expected` agrees with `computed` under the prompt's rounding rule (+ explicit tolerance). */
export function numericAgrees(prompt: string, computed: number, expected: number, tolerance = 0) {
  const d = declaredDecimals(prompt);
  if (d !== null) return Math.abs(roundTo(computed, d) - expected) <= tolerance + 1e-9 * Math.max(1, Math.abs(expected));
  // Monetary amounts are conventionally to the cent even when unstated.
  if (/currency units/i.test(prompt)) return Math.abs(roundTo(computed, 2) - expected) <= tolerance + 1e-9;
  return Math.abs(computed - expected) <= tolerance + 1e-9 * Math.max(1, Math.abs(expected));
}

const N = String.raw`(-?\d+(?:\.\d+)?)`;
const rx = (s: string, flags = 'i') => new RegExp(s.replace(/\{N\}/g, N), flags);
const nums = (m: RegExpExecArray | null) => (m ? m.slice(1).map(Number) : null);

/**
 * Templates we know how to recompute. Each returns the exact (unrounded) value or null when the prompt doesn't match.
 * Keyed by evaluation_items `subtopic`; matching is on the prompt text, so a template change is detected as
 * "unverifiable" rather than silently accepted.
 */
const TEMPLATES: Record<string, (p: string) => number | null> = {
  'integer arithmetic': (p) => {
    const m = /integer value of (.+?)\.?$/i.exec(p.trim());
    return m ? evalExpression(m[1]!) : null;
  },
  'modular arithmetic': (p) => {
    const v = nums(rx(String.raw`residue of {N} modulo {N}`).exec(p)); if (!v) return null;
    const [a, n] = v as [number, number]; return ((a % n) + n) % n;
  },
  'linear equations': (p) => {
    const v = nums(rx(String.raw`Solve for x:\s*{N}x\s*\+\s*\({N}\)\s*=\s*{N}`).exec(p)); if (!v) return null;
    const [a, b, c] = v as [number, number, number]; return (c - b) / a;
  },
  'quality engineering': (p) => {
    const v = nums(rx(String.raw`contains {N}% defect rate.*?reduced by {N}% relative`).exec(p)); if (!v) return null;
    const [r, red] = v as [number, number]; return r * (1 - red / 100);
  },
  interest: (p) => {
    const v = nums(rx(String.raw`principal of {N} earns {N}% simple annual interest for {N} years?`).exec(p)); if (!v) return null;
    const [P, r, t] = v as [number, number, number]; return (P * r * t) / 100;
  },
  'classification metrics': (p) => {
    const v = nums(rx(String.raw`TP={N},\s*FP={N},\s*FN={N}`).exec(p)); if (!v) return null;
    const [tp, fp, fn] = v as [number, number, number]; return (2 * tp) / (2 * tp + fp + fn);
  },
  'experiment design': (p) => {
    const v = nums(rx(String.raw`{N} successes in {N} control trials and {N} in {N} treatment trials`).exec(p)); if (!v) return null;
    const [cs, cn, ts, tn] = v as [number, number, number, number]; return (ts / tn - cs / cn) * 100;
  },
  'demand forecasting': (p) => {
    const v = nums(rx(String.raw`Beginning inventory is {N} units; demand changes by {N}%`).exec(p)); if (!v) return null;
    const [b, c] = v as [number, number]; return b * (1 + c / 100);
  },
  'descriptive statistics': (p) => {
    const v = nums(rx(String.raw`contains {N} observations with total sum {N}`).exec(p)); if (!v) return null;
    const [n, s] = v as [number, number]; return s / n;
  },
  'Ohm law': (p) => {
    const v = nums(rx(String.raw`{N}\s*V source drives resistance {N} ohms`).exec(p)); if (!v) return null;
    const [V, R] = v as [number, number]; return V / R;
  },
  'classical mechanics': (p) => {
    const v = nums(rx(String.raw`net force is {N} N and mass {N} kg`).exec(p)); if (!v) return null;
    const [F, m] = v as [number, number]; return F / m;
  },
  'fees and settlement': (p) => {
    const v = nums(rx(String.raw`processes {N} currency units and charges a {N}% fee`).exec(p)); if (!v) return null;
    const [a, f] = v as [number, number]; return a * (1 - f / 100);
  },
  'sensor sampling': (p) => {
    const v = nums(rx(String.raw`every {N} seconds over {N} minutes`).exec(p)); if (!v) return null;
    const [every, min] = v as [number, number]; return Math.floor((min * 60) / every) + 1;
  },
  'filter and recall accounting': (p) => {
    const v = nums(rx(String.raw`base count {N}, with {N}% of records filtered`).exec(p)); if (!v) return null;
    const [b, f] = v as [number, number]; return b * (1 - f / 100);
  },
  'API rate limits': (p) => {
    const v = nums(rx(String.raw`allows {N} requests/minute.*?for {N} full minutes`).exec(p)); if (!v) return null;
    const [r, m] = v as [number, number]; return r * m;
  },
  'network throughput': (p) => {
    const v = nums(rx(String.raw`sends {N} KiB in {N} milliseconds`).exec(p)); if (!v) return null;
    const [k, ms] = v as [number, number]; return k / (ms / 1000);
  },
  'retention modeling': (p) => {
    const v = nums(rx(String.raw`From {N} active customers, monthly churn is {N}%`).exec(p)); if (!v) return null;
    const [n, c] = v as [number, number]; return n * (1 - c / 100);
  },
  'critical path': (p) => {
    const m = /durations ([\d.,\s]+?) hours/i.exec(p); if (!m) return null;
    const parts = m[1]!.split(',').map((x) => Number(x.trim()));
    return parts.some((x) => !Number.isFinite(x)) ? null : parts.reduce((a, b) => a + b, 0);
  },
  'ranking evaluation': (p) => {
    const v = nums(rx(String.raw`Out of {N} retrieval queries, {N} have a relevant result`).exec(p)); if (!v) return null;
    const [n, k] = v as [number, number]; return k / n;
  },
  'service growth forecasting': (p) => {
    const v = nums(rx(String.raw`served {N} beneficiaries\. Next year it expands by {N}%`).exec(p)); if (!v) return null;
    const [n, g] = v as [number, number]; return n * (1 + g / 100);
  },
};

export type Verification = { status: 'verified' | 'mismatch' | 'unverifiable'; recomputed: number | null; note?: string };

/** Recompute an evaluation_items numeric ground truth from its prompt. */
export function recomputeEvaluationItem(subtopic: string, prompt: string, groundTruth: unknown, tolerance = 0): Verification {
  const expected = typeof groundTruth === 'number' ? groundTruth : Number(groundTruth);
  if (!Number.isFinite(expected)) return { status: 'unverifiable', recomputed: null, note: 'ground truth is not a number' };
  const fn = TEMPLATES[subtopic];
  if (!fn) return { status: 'unverifiable', recomputed: null, note: `no recompute template for subtopic '${subtopic}'` };
  let v: number | null;
  try { v = fn(prompt); } catch (e) { return { status: 'unverifiable', recomputed: null, note: `could not parse prompt: ${(e as Error).message}` }; }
  if (v === null || !Number.isFinite(v)) return { status: 'unverifiable', recomputed: null, note: 'prompt did not match the known template' };
  if (numericAgrees(prompt, v, expected, Number(tolerance) || 0)) return { status: 'verified', recomputed: v };
  const d = declaredDecimals(prompt);
  const tie = d !== null && Math.abs(Math.abs(v * Math.pow(10, d)) % 1 - 0.5) < 1e-6;
  return {
    status: 'mismatch', recomputed: v,
    note: `recomputed ${+v.toPrecision(12)} ≠ ground truth ${expected}`
      + (tie ? ` (exact rounding tie: half-up gives ${roundTo(v, d!)}, the key used round-half-to-even; with tolerance 0 the key is ambiguous)` : ''),
  };
}
