/**
 * Rubric / JSON helpers used by the exam engine. Kept local so the engine depends only on the judge CONTRACT
 * (proJudgeAvailable, judgeAgainstRubric, JudgeInput/JudgeResult/RubricCheckpoint) and not on judge internals.
 */
import type { RubricCheckpoint } from '../pro-judge.js';

/** Normalise a stored rubric (jsonb array, or { criteria: [...] }) into checkpoints with ids and positive points. */
export function normaliseRubric(raw: unknown): RubricCheckpoint[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { criteria?: unknown }).criteria) ? (raw as { criteria: unknown[] }).criteria : [];
  const out: RubricCheckpoint[] = [];
  list.forEach((x, i) => {
    if (!x || typeof x !== 'object') return;
    const o = x as Record<string, unknown>;
    const criterion = String(o.criterion ?? o.name ?? o.description ?? '').trim();
    const points = Number(o.points ?? o.weight ?? 0);
    if (!criterion || !Number.isFinite(points) || points <= 0) return;
    out.push({
      id: String(o.id ?? `c${i + 1}`), criterion, points, type: typeof o.type === 'string' ? o.type : undefined,
      evidence_of_success: typeof o.evidence_of_success === 'string' ? o.evidence_of_success : undefined,
      partial_credit: typeof o.partial_credit === 'string' ? o.partial_credit : undefined,
    });
  });
  return out;
}

/** Extract the first JSON object from text (tolerates ```json fences and surrounding prose). */
export function extractJson(text: string): unknown {
  const t = text.replace(/```(?:json)?/gi, '');
  const start = t.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i]!;
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(t.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}
