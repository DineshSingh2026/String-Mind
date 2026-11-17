/**
 * Proof-evaluation guidance per domain (from `record: 'proof_evaluation'` lines in generated scenario files),
 * stored as-is in system_settings under PROOF_GUIDANCE_KEY. Read by the evidence feature via getProofGuidance().
 */
import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import type { Json, ProofGuidanceRecord } from './types.js';

export const PROOF_GUIDANCE_KEY = 'pro_bank.proof_guidance';

type Stored = { records: Record<string, ProofGuidanceRecord> };

async function load(): Promise<Stored> {
  const [row] = await db().select().from(schema.systemSettings).where(eq(schema.systemSettings.key, PROOF_GUIDANCE_KEY)).limit(1);
  const v = row?.value as Stored | undefined;
  return v && typeof v === 'object' && v.records ? v : { records: {} };
}

/** Upsert records (keyed by source + domain name; a re-import replaces that entry). */
export async function saveProofGuidance(recs: ProofGuidanceRecord[]) {
  if (!recs.length) return;
  const cur = await load();
  for (const r of recs) cur.records[`${r.source}|${r.domain}`] = r; // (jsonb keys cannot contain NUL)
  await db().insert(schema.systemSettings).values({ key: PROOF_GUIDANCE_KEY, value: cur })
    .onConflictDoUpdate({ target: schema.systemSettings.key, set: { value: cur, updatedAt: new Date() } });
}

export interface ProofGuidance {
  domainSlug: string;
  /** the stored proof_evaluation records for this platform domain (source domain names may differ) */
  entries: { domain: string; source: string; proofTypes: unknown[]; liveSkillChecks: unknown[]; record: Json }[];
}

/** Proof guidance for a platform domain slug, or null when none has been imported. */
export async function getProofGuidance(domainSlug: string): Promise<ProofGuidance | null> {
  const { records } = await load();
  const entries = Object.values(records).filter((r) => r.domainSlug === domainSlug).map((r) => ({
    domain: r.domain, source: r.source,
    proofTypes: Array.isArray(r.record.proof_types) ? r.record.proof_types : [],
    liveSkillChecks: Array.isArray(r.record.live_skill_checks) ? r.record.live_skill_checks : [],
    record: r.record,
  }));
  return entries.length ? { domainSlug, entries } : null;
}
