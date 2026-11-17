/**
 * Optional domain-specific proof guidance from the question bank (`engine/pro-bank/proof-guidance.ts`,
 * `getProofGuidance(domainSlug)`). Loaded lazily and normalised defensively: the module may not exist yet, may return
 * null, or may use snake_case or camelCase keys. When nothing usable comes back, callers fall back to the
 * domain-agnostic defaults in rubric.ts.
 *
 * Trust weights in guidance are shown as hints only — the platform scoring table (scoring.ts) is authoritative so
 * every domain is scored by the same documented rules.
 */
import type { RubricCheckpoint } from '../pro-judge.js';

export interface LiveSkillCheckGuide { task: string; rubric: RubricCheckpoint[]; kind?: string; referenceSolution?: string; redFlags?: string[] }

export interface NormalisedGuidance {
  proofTypes: { kind?: string; label: string; description?: string }[];
  authenticityChecks: string[];
  trustHints: Record<string, unknown>;
  rubric: RubricCheckpoint[];
  rubricsByKind: Record<string, RubricCheckpoint[]>;
  liveSkillChecks: LiveSkillCheckGuide[];
  redFlags: string[];
}

type Loader = (slug: string) => unknown | Promise<unknown>;
let override: Loader | null | undefined;
/** Tests: replace the guidance source (null = no guidance). */
export function setGuidanceLoader(l: Loader | null | undefined) { override = l; }

let cached: Loader | null | undefined;
async function loader(): Promise<Loader | null> {
  if (override !== undefined) return override;
  if (cached !== undefined) return cached;
  try {
    const spec = '../pro-bank/proof-guidance.js';
    const mod = await import(/* @vite-ignore */ spec) as { getProofGuidance?: Loader };
    cached = typeof mod.getProofGuidance === 'function' ? mod.getProofGuidance : null;
  } catch {
    cached = null;
  }
  return cached;
}

const pick = (o: Record<string, unknown>, ...keys: string[]) => {
  for (const k of keys) if (o[k] !== undefined) return o[k];
  return undefined;
};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

function toRubric(v: unknown): RubricCheckpoint[] {
  const out: RubricCheckpoint[] = [];
  arr(v).forEach((x, i) => {
    if (typeof x === 'string') { out.push({ id: `g${i + 1}`, criterion: x, type: 'quality', points: 1 }); return; }
    if (!x || typeof x !== 'object') return;
    const o = x as Record<string, unknown>;
    const criterion = str(pick(o, 'criterion', 'description', 'check', 'text', 'name'));
    if (!criterion) return;
    const pts = Number(pick(o, 'points', 'weight', 'score'));
    out.push({
      id: str(o.id) ?? `g${i + 1}`, criterion, type: str(o.type) ?? 'quality', points: Number.isFinite(pts) && pts > 0 ? pts : 1,
      evidence_of_success: str(pick(o, 'evidence_of_success', 'evidenceOfSuccess')),
      partial_credit: str(pick(o, 'partial_credit', 'partialCredit')),
    });
  });
  return out;
}

export function normaliseGuidance(raw: unknown): NormalisedGuidance | null {
  if (!raw || typeof raw !== 'object') return null;
  const g = raw as Record<string, unknown>;
  const rubricsRaw = pick(g, 'rubrics', 'rubric');
  let rubric: RubricCheckpoint[] = [];
  const rubricsByKind: Record<string, RubricCheckpoint[]> = {};
  if (Array.isArray(rubricsRaw)) {
    // either a flat list of checkpoints, or a list of { kind/proof_type, checkpoints }
    const first = rubricsRaw[0] as Record<string, unknown> | undefined;
    if (first && typeof first === 'object' && (first.checkpoints || first.rubric)) {
      for (const r of rubricsRaw as Record<string, unknown>[]) {
        const cps = toRubric(r.checkpoints ?? r.rubric);
        const kind = str(pick(r, 'kind', 'proof_type', 'proofType', 'type'));
        if (kind) rubricsByKind[kind] = cps;
        if (!rubric.length) rubric = cps;
      }
    } else rubric = toRubric(rubricsRaw);
  } else if (rubricsRaw && typeof rubricsRaw === 'object') {
    for (const [k, v] of Object.entries(rubricsRaw as Record<string, unknown>)) {
      const cps = toRubric(v);
      rubricsByKind[k] = cps;
      if (!rubric.length) rubric = cps;
    }
  }
  const liveSkillChecks: LiveSkillCheckGuide[] = [];
  for (const x of arr(pick(g, 'live_skill_checks', 'liveSkillChecks', 'liveChecks'))) {
    if (typeof x === 'string') { liveSkillChecks.push({ task: x, rubric: [] }); continue; }
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    const task = str(pick(o, 'task', 'prompt', 'description'));
    if (!task) continue;
    liveSkillChecks.push({
      task, rubric: toRubric(pick(o, 'rubric', 'checkpoints')), kind: str(pick(o, 'kind', 'proof_type', 'proofType')),
      referenceSolution: str(pick(o, 'reference_solution', 'referenceSolution')),
      redFlags: arr(pick(o, 'red_flags', 'redFlags')).map(String),
    });
  }
  const proofTypes = arr(pick(g, 'proof_types', 'proofTypes')).map((x) => {
    if (typeof x === 'string') return { label: x };
    const o = (x ?? {}) as Record<string, unknown>;
    return { kind: str(o.kind), label: str(pick(o, 'label', 'name', 'title')) ?? 'Proof', description: str(o.description) };
  });
  const authenticityChecks = arr(pick(g, 'authenticity_checks', 'authenticityChecks')).map((x) =>
    typeof x === 'string' ? x : str((x as Record<string, unknown>)?.description) ?? str((x as Record<string, unknown>)?.check) ?? '').filter(Boolean);
  const trustHints = (pick(g, 'trust_weights', 'trustWeights') ?? {}) as Record<string, unknown>;
  const redFlags = arr(pick(g, 'red_flags', 'redFlags')).map(String);
  if (!rubric.length && !liveSkillChecks.length && !proofTypes.length) return null;
  return { proofTypes, authenticityChecks, trustHints, rubric, rubricsByKind, liveSkillChecks, redFlags };
}

export async function loadGuidance(domainSlug: string): Promise<NormalisedGuidance | null> {
  const l = await loader();
  if (!l) return null;
  try { return normaliseGuidance(await l(domainSlug)); } catch { return null; }
}
