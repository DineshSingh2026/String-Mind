/**
 * Automatic topic sorting: an untagged case joins a domain only when it clearly resembles the agent's OWN already-tagged
 * cases (nearest neighbours by meaning). No keyword guessing — a case that does not clearly match stays untagged and the
 * owner tags it with one click. Cases tagged this way are marked `domainAuto`; the replay then tests the agent on them,
 * so a wrong tag can only lower its own score, never inflate it.
 *
 * The primary route to a domain tag is the agent itself: the memory-sync prompt requires a domain slug on every case.
 */
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { cosine } from '../embeddings.js';

/** Nearest tagged case must be at least this similar... */
export const AUTO_MIN_SIM = 0.45;
/** ...and, among the 3 nearest, this many must agree on the domain (or a single neighbour must be near-identical). */
export const AUTO_AGREE = 2;
export const AUTO_SINGLE_SIM = 0.7;
const MAX_REFERENCE = 3000;

export interface TaggedRef { domainId: string; vec: number[] }

/** Best domain for an embedding among tagged reference cases, or null when there is no clear match. */
export function classifyAgainstTagged(vec: number[], refs: TaggedRef[]): string | null {
  const top = refs.map((r) => ({ d: r.domainId, s: cosine(vec, r.vec) })).filter((x) => x.s >= AUTO_MIN_SIM).sort((a, b) => b.s - a.s).slice(0, 3);
  if (!top.length) return null;
  const votes = new Map<string, number>();
  for (const t of top) votes.set(t.d, (votes.get(t.d) ?? 0) + 1);
  const [winner, n] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]!;
  if (n >= AUTO_AGREE || (top.length === 1 && top[0]!.s >= AUTO_SINGLE_SIM)) return winner;
  return null;
}

export async function loadTaggedRefs(agentId: string): Promise<TaggedRef[]> {
  const rows = await db().select({ domainId: schema.agentExperiences.domainId, embedding: schema.agentExperiences.embedding }).from(schema.agentExperiences)
    .where(and(eq(schema.agentExperiences.agentId, agentId), isNotNull(schema.agentExperiences.domainId)))
    .orderBy(desc(schema.agentExperiences.occurredAt)).limit(MAX_REFERENCE);
  return rows.map((r) => ({ domainId: r.domainId!, vec: r.embedding }));
}

/** Auto-tag the agent's untagged cases against its own tagged cases. */
export async function classifyUntagged(agentId: string): Promise<{ tagged: number; untagged: number; byDomain: Record<string, number> }> {
  const rows = await db().select({ id: schema.agentExperiences.id, embedding: schema.agentExperiences.embedding }).from(schema.agentExperiences)
    .where(and(eq(schema.agentExperiences.agentId, agentId), isNull(schema.agentExperiences.domainId)));
  if (!rows.length) return { tagged: 0, untagged: 0, byDomain: {} };
  const refs = await loadTaggedRefs(agentId);
  const slugs = new Map((await db().select({ id: schema.capabilityDomains.id, slug: schema.capabilityDomains.slug }).from(schema.capabilityDomains)).map((d) => [d.id, d.slug]));
  const byDomain: Record<string, number> = {};
  let tagged = 0;
  for (const r of rows) {
    const d = classifyAgainstTagged(r.embedding, refs);
    if (!d) continue;
    await db().update(schema.agentExperiences).set({ domainId: d, domainAuto: true, updatedAt: new Date() }).where(eq(schema.agentExperiences.id, r.id));
    const slug = slugs.get(d) ?? d;
    byDomain[slug] = (byDomain[slug] ?? 0) + 1;
    tagged++;
  }
  return { tagged, untagged: rows.length - tagged, byDomain };
}
