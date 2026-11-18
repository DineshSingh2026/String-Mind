/**
 * Automatic topic discovery. After an agent's memory is connected (or on demand) Hive Mind
 *   1. sorts untagged cases into domains when they clearly match the agent's own tagged cases (engine/experience/domains.ts),
 *   2. starts a self replay in every domain with enough real cases (plus one across all domains),
 * so the owner sees "you can train in X, Y" without tagging, importing or replaying by hand.
 * Replays are not repeated while one is running or finished recently (cooldown) — no duplicate work for prompt agents.
 */
import { and, eq, inArray, gt, or } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { enqueue } from '../../jobs/queue.js';
import { classifyUntagged } from './domains.js';
import { REPLAY_JOB, REPLAY_MIN_ITEMS, createReplay, gradableCases } from './replay.js';

export const DISCOVERY_COOLDOWN_MS = 6 * 3_600_000;
/** Domains replayed per discovery run (the ones with the most real cases), in addition to the all-domain replay. */
export const MAX_DOMAIN_REPLAYS = 5;

export interface DiscoveryResult {
  classified: { tagged: number; untagged: number; byDomain: Record<string, number> };
  replays: { domain: string; id: string }[];
  skipped: { domain: string; reason: string }[];
}

export async function discoverExperience(agentId: string, opts: { requestedBy?: string | null } = {}): Promise<DiscoveryResult> {
  const classified = await classifyUntagged(agentId);
  const domains = await db().select({ id: schema.capabilityDomains.id, slug: schema.capabilityDomains.slug }).from(schema.capabilityDomains);
  const slugOf = new Map(domains.map((d) => [d.id, d.slug]));

  const cases = await gradableCases(agentId, 'all');
  const perDomain = new Map<string, number>();
  for (const c of cases) {
    const slug = c.domainId ? slugOf.get(c.domainId) : null;
    if (slug) perDomain.set(slug, (perDomain.get(slug) ?? 0) + 1);
  }
  const candidates = [...perDomain.entries()].filter(([, n]) => n >= REPLAY_MIN_ITEMS).sort((a, b) => b[1] - a[1]).slice(0, MAX_DOMAIN_REPLAYS).map(([s]) => s);
  if (cases.length >= REPLAY_MIN_ITEMS) candidates.push('all');

  const since = new Date(Date.now() - DISCOVERY_COOLDOWN_MS);
  const recent = await db().select({ slug: schema.experienceReplays.domainSlug }).from(schema.experienceReplays).where(and(
    eq(schema.experienceReplays.agentId, agentId), eq(schema.experienceReplays.sourceAgentId, agentId), eq(schema.experienceReplays.purpose, 'self'),
    or(inArray(schema.experienceReplays.status, ['queued', 'running']), and(eq(schema.experienceReplays.status, 'completed'), gt(schema.experienceReplays.completedAt, since))),
  ));
  const busy = new Set(recent.map((r) => r.slug));

  const out: DiscoveryResult = { classified, replays: [], skipped: [] };
  for (const slug of candidates) {
    if (busy.has(slug)) { out.skipped.push({ domain: slug, reason: 'a replay is running or finished recently' }); continue; }
    try {
      const r = await createReplay({ agentId, domainSlug: slug, purpose: 'self', requestedBy: opts.requestedBy ?? null });
      await enqueue(REPLAY_JOB, { replayId: r.id }, { maxAttempts: 1 });
      out.replays.push({ domain: slug, id: r.id });
    } catch (e) {
      out.skipped.push({ domain: slug, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  for (const [slug, n] of perDomain) if (n < REPLAY_MIN_ITEMS) out.skipped.push({ domain: slug, reason: `only ${n} usable case(s); needs ${REPLAY_MIN_ITEMS}` });
  return out;
}
