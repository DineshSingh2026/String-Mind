/**
 * Shared helpers for presenting public agents (marketplace, public pages, leaderboards, analytics).
 *
 * Public visibility = isPublic AND status 'active' AND not deleted AND owning org active AND NOT in a private network.
 * Ranking signals come ONLY from verified agent_capabilities + agent_reputation. claimedDomains are returned
 * separately and labelled as claimed; they are never used for filtering or ranking.
 */
import { and, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { activeCertifications } from '../certification/service.js';

export type AgentRow = typeof schema.agents.$inferSelect;

/** Conditions for publicly visible agents. Must be used with a join to organisations. */
export function publicAgentWhere(): SQL {
  return and(
    eq(schema.agents.isPublic, true),
    eq(schema.agents.status, 'active'),
    isNull(schema.agents.deletedAt),
    eq(schema.organisations.privateNetwork, false),
    eq(schema.organisations.status, 'active'),
  )!;
}

/** Fetch publicly visible agents (optionally with extra conditions on agents/organisations). */
export async function selectPublicAgents(extra?: SQL | undefined): Promise<AgentRow[]> {
  const rows = await db().select({ a: schema.agents }).from(schema.agents)
    .innerJoin(schema.organisations, eq(schema.organisations.id, schema.agents.orgId))
    .where(extra ? and(publicAgentWhere(), extra) : publicAgentWhere());
  return rows.map((r) => r.a);
}

export async function isPubliclyVisible(agentId: string): Promise<boolean> {
  const rows = await db().select({ id: schema.agents.id }).from(schema.agents)
    .innerJoin(schema.organisations, eq(schema.organisations.id, schema.agents.orgId))
    .where(and(publicAgentWhere(), eq(schema.agents.id, agentId))).limit(1);
  return rows.length > 0;
}

export interface CapView { domainId: string; slug: string; name: string; score: number; accuracy: number; confidence: number; sampleSize: number; verified: boolean; skillScores: Record<string, number>; assessedAt: Date }

export interface AgentCard {
  id: string; slug: string; name: string; avatar: string | null; description: string;
  provider: { slug: string; name: string } | null; modelName: string;
  owner: { name: string };
  verifiedDomains: { slug: string; name: string; score: number }[];
  claimedDomains: { slug: string; name: string; claimed: true }[];
  overallScore: number | null;
  rating: number | null; ratingCount: number; sessionsCompleted: number;
  reputationScore: number; reputationLevel: string;
  listings: { id: string; title: string; priceCredits: number; pricingModel: string; domainSlug: string }[];
  /** Active Hive Mind certifications (Professional Evaluation), e.g. "Certified Professional · Cybersecurity". */
  certifications: { domainSlug: string; domainName: string; level: string; score: number; expiresAt: Date | null }[];
  /**
   * Experience (the agent's own track record — see engine/experience/score.ts). null = no recorded experience.
   * qualifiedDomains = domains where it may train others.
   */
  experience: {
    score: number; resolvedCount: number; witnessedCount: number; spanDays: number; successRate: number | null; replayScore: number | null;
    domains: { slug: string; name: string; score: number; resolvedCount: number; qualified: boolean }[];
    qualifiedDomains: string[];
  } | null;
  languages: string[]; verificationStatus: string; health: string; createdAt: Date;
}

export interface CardContext {
  caps: Map<string, CapView[]>;
  rep: Map<string, typeof schema.agentReputation.$inferSelect>;
}

export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
export const round1 = (n: number | null) => (n == null ? null : Math.round(n * 10) / 10);

/** Mean of VERIFIED capability scores (null when the agent has no verified capability). */
export function verifiedScore(caps: CapView[] | undefined, domainSlug?: string): number | null {
  const v = (caps ?? []).filter((c) => c.verified && (!domainSlug || c.slug === domainSlug));
  return round1(mean(v.map((c) => c.score)));
}

export async function loadCapabilities(agentIds: string[]): Promise<Map<string, CapView[]>> {
  const out = new Map<string, CapView[]>();
  if (!agentIds.length) return out;
  const rows = await db().select({ c: schema.agentCapabilities, d: schema.capabilityDomains }).from(schema.agentCapabilities)
    .innerJoin(schema.capabilityDomains, eq(schema.capabilityDomains.id, schema.agentCapabilities.domainId))
    .where(inArray(schema.agentCapabilities.agentId, agentIds));
  for (const { c, d } of rows) {
    const list = out.get(c.agentId) ?? [];
    list.push({ domainId: d.id, slug: d.slug, name: d.name, score: c.score, accuracy: c.accuracy, confidence: c.confidence, sampleSize: c.sampleSize, verified: c.verified, skillScores: c.skillScores, assessedAt: c.assessedAt });
    out.set(c.agentId, list);
  }
  return out;
}

export async function loadReputation(agentIds: string[]) {
  const out = new Map<string, typeof schema.agentReputation.$inferSelect>();
  if (!agentIds.length) return out;
  const rows = await db().select().from(schema.agentReputation).where(inArray(schema.agentReputation.agentId, agentIds));
  for (const r of rows) out.set(r.agentId, r);
  return out;
}

/** Active, moderation-visible listings for the agents. */
export async function loadActiveListings(agentIds: string[]) {
  const out = new Map<string, AgentCard['listings']>();
  if (!agentIds.length) return out;
  const rows = await db().select({ l: schema.marketplaceListings, slug: schema.capabilityDomains.slug }).from(schema.marketplaceListings)
    .innerJoin(schema.capabilityDomains, eq(schema.capabilityDomains.id, schema.marketplaceListings.domainId))
    .where(and(inArray(schema.marketplaceListings.agentId, agentIds), eq(schema.marketplaceListings.status, 'active'), eq(schema.marketplaceListings.moderation, 'visible')));
  for (const { l, slug } of rows) {
    const list = out.get(l.agentId) ?? [];
    list.push({ id: l.id, title: l.title, priceCredits: l.priceCredits, pricingModel: l.pricingModel, domainSlug: slug });
    out.set(l.agentId, list);
  }
  return out;
}

export async function loadExperience(agentIds: string[]) {
  const out = new Map<string, (typeof schema.agentExperienceScores.$inferSelect)[]>();
  if (!agentIds.length) return out;
  const rows = await db().select().from(schema.agentExperienceScores).where(inArray(schema.agentExperienceScores.agentId, agentIds));
  for (const r of rows) out.set(r.agentId, [...(out.get(r.agentId) ?? []), r]);
  return out;
}

/** Build public agent cards (marketplace shape) for the given agent rows, preserving order. */
export async function buildCards(agents: AgentRow[]): Promise<{ cards: AgentCard[]; ctx: CardContext }> {
  const ids = agents.map((a) => a.id);
  const [caps, rep, listings, certRows, exp] = await Promise.all([loadCapabilities(ids), loadReputation(ids), loadActiveListings(ids), activeCertifications(ids), loadExperience(ids)]);
  const providerIds = [...new Set(agents.map((a) => a.providerId))];
  const orgIds = [...new Set(agents.map((a) => a.orgId))];
  const [providers, orgs, domains] = await Promise.all([
    providerIds.length ? db().select().from(schema.agentProviders).where(inArray(schema.agentProviders.id, providerIds)) : [],
    orgIds.length ? db().select({ id: schema.organisations.id, name: schema.organisations.name }).from(schema.organisations).where(inArray(schema.organisations.id, orgIds)) : [],
    db().select({ slug: schema.capabilityDomains.slug, name: schema.capabilityDomains.name }).from(schema.capabilityDomains),
  ]);
  const pMap = new Map(providers.map((p) => [p.id, p]));
  const oMap = new Map(orgs.map((o) => [o.id, o.name]));
  const dMap = new Map(domains.map((d) => [d.slug, d.name]));
  const cards = agents.map((a): AgentCard => {
    const c = caps.get(a.id) ?? [];
    const r = rep.get(a.id);
    const p = pMap.get(a.providerId);
    const xs = exp.get(a.id) ?? [];
    const all = xs.find((x) => x.domainSlug === 'all');
    const domainRows = xs.filter((x) => x.domainSlug !== 'all' && x.domainSlug !== 'general').sort((x, y) => y.score - x.score);
    return {
      id: a.id, slug: a.slug, name: a.name, avatar: a.avatar, description: a.description,
      provider: p ? { slug: p.slug, name: p.name } : null, modelName: a.modelName,
      owner: { name: oMap.get(a.orgId) ?? '' },
      verifiedDomains: c.filter((x) => x.verified).sort((x, y) => y.score - x.score).map((x) => ({ slug: x.slug, name: x.name, score: round1(x.score)! })),
      claimedDomains: (a.claimedDomains ?? []).map((s) => ({ slug: s, name: dMap.get(s) ?? s, claimed: true as const })),
      overallScore: verifiedScore(c),
      rating: r?.avgRating ?? null, ratingCount: r?.ratingCount ?? 0, sessionsCompleted: r?.sessionsCompleted ?? 0,
      reputationScore: r?.score ?? 0, reputationLevel: r?.level ?? 'new_contributor',
      listings: listings.get(a.id) ?? [],
      certifications: certRows.filter((x) => x.agentId === a.id).sort((x, y) => y.score - x.score)
        .map((x) => ({ domainSlug: x.domainSlug, domainName: dMap.get(x.domainSlug) ?? x.domainSlug, level: x.level, score: x.score, expiresAt: x.expiresAt })),
      experience: all && all.totalCount > 0 ? {
        score: all.score, resolvedCount: all.resolvedCount, witnessedCount: all.witnessedCount, spanDays: all.spanDays, successRate: all.successRate, replayScore: all.replayScore,
        domains: domainRows.map((x) => ({ slug: x.domainSlug, name: dMap.get(x.domainSlug) ?? x.domainSlug, score: x.score, resolvedCount: x.resolvedCount, qualified: x.qualified })),
        qualifiedDomains: domainRows.filter((x) => x.qualified).map((x) => x.domainSlug),
      } : null,
      languages: a.languages, verificationStatus: a.verificationStatus, health: a.health, createdAt: a.createdAt,
    };
  });
  return { cards, ctx: { caps, rep } };
}
