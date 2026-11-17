/**
 * Marketplace: public agent discovery, profiles, comparison, favourites, training listings, reviews, reports.
 * Ranking/filtering by score uses ONLY verified agent_capabilities + reputation. claimedDomains are shown labelled
 * as "claimed" and never influence ranking or filters.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, count, desc, eq, ilike, inArray, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db/client.js';
import { audit } from '../../lib/audit.js';
import { requireAuth, requirePerm } from '../../lib/auth.js';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { PageQuery, offset, parse } from '../../lib/http.js';
import { notifyOrg } from '../../lib/notify.js';
import { getOwnedAgent } from '../../lib/tenancy.js';
import { recomputeReputation } from '../reputation/service.js';
import { buildCards, isPubliclyVisible, publicAgentWhere, round1, selectPublicAgents, verifiedScore, type AgentCard, type AgentRow } from './cards.js';

export const MIN_LISTING_SCORE = 70;

const SearchQuery = PageQuery.extend({
  q: z.string().trim().max(200).optional(),
  domain: z.string().optional(),
  skill: z.string().optional(),
  provider: z.string().optional(),
  language: z.string().optional(),
  minScore: z.coerce.number().min(0).max(100).optional(),
  maxPrice: z.coerce.number().int().min(0).optional(),
  free: z.enum(['true', 'false']).optional(),
  verified: z.enum(['true', 'false']).optional(),
  sort: z.enum(['popular', 'score', 'price_asc', 'price_desc', 'rating', 'newest']).default('popular'),
});

const ListingBody = z.object({
  agentId: z.string().uuid(),
  title: z.string().trim().min(3).max(140),
  description: z.string().max(5000).default(''),
  domainSlug: z.string(),
  skills: z.array(z.string().max(64)).max(20).default([]),
  priceCredits: z.number().int().min(0).max(1_000_000).default(0),
  pricingModel: z.enum(['per_session', 'free']).default('per_session'),
  settlementMode: z.enum(['on_completion', 'on_improvement']).default('on_completion'),
  minImprovement: z.number().min(0).max(100).nullable().optional(),
  durationMinutes: z.number().int().min(5).max(24 * 60).default(30),
});
const ListingPatch = ListingBody.omit({ agentId: true }).partial().extend({ status: z.enum(['active', 'paused', 'draft']).optional() });

const IdParam = z.object({ id: z.string().uuid() });
const isUuid = (s: string) => z.string().uuid().safeParse(s).success;

async function domainBySlug(slug: string) {
  const [d] = await db().select().from(schema.capabilityDomains).where(eq(schema.capabilityDomains.slug, slug)).limit(1);
  return d ?? null;
}

/** Throws 422 with an explanation unless the agent may list training in this domain. */
async function assertCanList(agent: AgentRow, domainId: string, domainSlug: string) {
  if (agent.status === 'suspended') throw unprocessable('This agent is suspended and cannot publish listings.');
  if ((agent.permissions as { allowTraining?: boolean }).allowTraining !== true) {
    throw unprocessable('Training is not enabled for this agent. Turn on "Allow training (be a trainer)" in the agent permissions first.', { reason: 'allow_training_disabled' });
  }
  const [cap] = await db().select().from(schema.agentCapabilities)
    .where(and(eq(schema.agentCapabilities.agentId, agent.id), eq(schema.agentCapabilities.domainId, domainId))).limit(1);
  if (!cap || !cap.verified || cap.score < MIN_LISTING_SCORE) {
    throw unprocessable(
      `A verified capability score of at least ${MIN_LISTING_SCORE} in "${domainSlug}" is required to offer training. ` +
      (!cap ? 'This agent has not been assessed in this domain yet — run an assessment first.'
        : !cap.verified ? `The current score (${round1(cap.score)}) is not verified yet (needs a larger sample / higher confidence). Run a fuller assessment.`
        : `The current verified score is ${round1(cap.score)}.`),
      { reason: !cap ? 'not_assessed' : !cap.verified ? 'not_verified' : 'score_below_threshold', required: MIN_LISTING_SCORE, score: cap ? round1(cap.score) : null, verified: cap?.verified ?? false },
    );
  }
}

/** Agent addressable by slug or id that the caller may view: public, or owned by the caller's org. */
async function findViewableAgent(req: FastifyRequest, slugOrId: string): Promise<AgentRow> {
  const cond = isUuid(slugOrId) ? eq(schema.agents.id, slugOrId) : eq(schema.agents.slug, slugOrId);
  const [pub] = await db().select({ a: schema.agents }).from(schema.agents)
    .innerJoin(schema.organisations, eq(schema.organisations.id, schema.agents.orgId))
    .where(and(publicAgentWhere(), cond)).limit(1);
  if (pub) return pub.a;
  const orgId = req.auth?.orgId;
  if (orgId) {
    const [own] = await db().select().from(schema.agents).where(and(cond, eq(schema.agents.orgId, orgId), sql`${schema.agents.deletedAt} is null`)).limit(1);
    if (own) return own;
  }
  throw notFound('Agent');
}

function sortCards(cards: (AgentCard & { _score: number | null; _minPrice: number | null })[], sort: string) {
  const nullsLast = (a: number | null, b: number | null, dir: 1 | -1) => (a == null && b == null ? 0 : a == null ? 1 : b == null ? -1 : dir * (a - b));
  // Tie-breakers always favour verified evidence then reputation.
  const tie = (a: typeof cards[number], b: typeof cards[number]) => nullsLast(a._score, b._score, -1) || b.reputationScore - a.reputationScore || a.name.localeCompare(b.name);
  const cmp: Record<string, (a: typeof cards[number], b: typeof cards[number]) => number> = {
    popular: (a, b) => b.sessionsCompleted - a.sessionsCompleted || b.reputationScore - a.reputationScore || tie(a, b),
    score: (a, b) => nullsLast(a._score, b._score, -1) || b.reputationScore - a.reputationScore || tie(a, b),
    price_asc: (a, b) => nullsLast(a._minPrice, b._minPrice, 1) || tie(a, b),
    price_desc: (a, b) => nullsLast(a._minPrice, b._minPrice, -1) || tie(a, b),
    rating: (a, b) => nullsLast(a.rating, b.rating, -1) || b.ratingCount - a.ratingCount || tie(a, b),
    newest: (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || tie(a, b),
  };
  return cards.sort(cmp[sort] ?? cmp.popular!);
}

export default async function routes(app: FastifyInstance) {
  /* ───────────── Search ───────────── */
  app.get('/agents', async (req) => {
    const q = parse(SearchQuery, req.query);
    const extra = [];
    if (q.q) extra.push(or(ilike(schema.agents.name, `%${q.q}%`), ilike(schema.agents.description, `%${q.q}%`), ilike(schema.agents.modelName, `%${q.q}%`)));
    if (q.language) extra.push(sql`${schema.agents.languages} @> ${JSON.stringify([q.language])}::jsonb`);
    if (q.provider) {
      const [p] = await db().select().from(schema.agentProviders).where(eq(schema.agentProviders.slug, q.provider)).limit(1);
      if (!p) return { items: [], total: 0, page: q.page, pageSize: q.pageSize };
      extra.push(eq(schema.agents.providerId, p.id));
    }
    const agents = await selectPublicAgents(extra.length ? and(...extra) : undefined);
    const { cards, ctx } = await buildCards(agents);

    let rows = cards.map((c) => {
      const caps = ctx.caps.get(c.id) ?? [];
      const listingPrices = c.listings.filter((l) => !q.domain || l.domainSlug === q.domain).map((l) => (l.pricingModel === 'free' ? 0 : l.priceCredits));
      return { ...c, _caps: caps, _score: verifiedScore(caps, q.domain), _minPrice: listingPrices.length ? Math.min(...listingPrices) : null };
    });
    if (q.domain) rows = rows.filter((r) => r._caps.some((c) => c.verified && c.slug === q.domain));
    if (q.skill) {
      // Skill match: a verified capability with an assessed score for the skill, or an active listing tagged with the
      // skill in a domain where the agent holds a VERIFIED capability (listing tags alone never qualify).
      const skill = q.skill;
      const ids = rows.map((r) => r.id);
      const tagged = ids.length ? await db().select({ agentId: schema.marketplaceListings.agentId, domainId: schema.marketplaceListings.domainId }).from(schema.marketplaceListings)
        .where(and(inArray(schema.marketplaceListings.agentId, ids), eq(schema.marketplaceListings.status, 'active'), eq(schema.marketplaceListings.moderation, 'visible'),
          sql`${schema.marketplaceListings.skills} @> ${JSON.stringify([skill])}::jsonb`)) : [];
      rows = rows.filter((r) => r._caps.some((c) => c.verified && (!q.domain || c.slug === q.domain)
        && (skill in (c.skillScores ?? {}) || tagged.some((t) => t.agentId === r.id && t.domainId === c.domainId))));
    }
    if (q.verified === 'true') rows = rows.filter((r) => r._caps.some((c) => c.verified));
    if (q.verified === 'false') rows = rows.filter((r) => !r._caps.some((c) => c.verified));
    if (q.minScore != null) rows = rows.filter((r) => r._score != null && r._score >= q.minScore!);
    if (q.maxPrice != null) rows = rows.filter((r) => r._minPrice != null && r._minPrice <= q.maxPrice!);
    if (q.free === 'true') rows = rows.filter((r) => r._minPrice === 0);

    sortCards(rows, q.sort);
    const total = rows.length;
    const items = rows.slice(offset(q), offset(q) + q.pageSize).map(({ _caps, _score, _minPrice, ...card }) => ({ ...card, matchScore: _score }));
    return { items, total, page: q.page, pageSize: q.pageSize };
  });

  /* ───────────── Categories ───────────── */
  app.get('/categories', async () => {
    const domains = await db().select().from(schema.capabilityDomains).where(eq(schema.capabilityDomains.active, true)).orderBy(schema.capabilityDomains.sortOrder);
    const agentCounts = await db().select({ domainId: schema.agentCapabilities.domainId, n: sql<number>`count(distinct ${schema.agents.id})::int` })
      .from(schema.agentCapabilities)
      .innerJoin(schema.agents, eq(schema.agents.id, schema.agentCapabilities.agentId))
      .innerJoin(schema.organisations, eq(schema.organisations.id, schema.agents.orgId))
      .where(and(publicAgentWhere(), eq(schema.agentCapabilities.verified, true)))
      .groupBy(schema.agentCapabilities.domainId);
    const listingCounts = await db().select({ domainId: schema.marketplaceListings.domainId, n: sql<number>`count(*)::int` })
      .from(schema.marketplaceListings)
      .innerJoin(schema.agents, eq(schema.agents.id, schema.marketplaceListings.agentId))
      .innerJoin(schema.organisations, eq(schema.organisations.id, schema.agents.orgId))
      .where(and(publicAgentWhere(), eq(schema.marketplaceListings.status, 'active'), eq(schema.marketplaceListings.moderation, 'visible')))
      .groupBy(schema.marketplaceListings.domainId);
    const ac = new Map(agentCounts.map((r) => [r.domainId, Number(r.n)]));
    const lc = new Map(listingCounts.map((r) => [r.domainId, Number(r.n)]));
    return domains.map((d) => ({ id: d.id, slug: d.slug, name: d.name, icon: d.icon, highImpact: d.highImpact, agentCount: ac.get(d.id) ?? 0, listingCount: lc.get(d.id) ?? 0 }));
  });

  /* ───────────── Profile ───────────── */
  app.get('/agents/:slug', async (req) => {
    const { slug } = parse(z.object({ slug: z.string().min(1) }), req.params);
    const agent = await findViewableAgent(req, slug);
    const { cards, ctx } = await buildCards([agent]);
    const card = cards[0]!;
    const caps = ctx.caps.get(agent.id) ?? [];
    const rep = ctx.rep.get(agent.id);
    const reviews = await db().select({ r: schema.reviews, reviewer: schema.users.name }).from(schema.reviews)
      .innerJoin(schema.users, eq(schema.users.id, schema.reviews.reviewerId))
      .where(and(eq(schema.reviews.agentId, agent.id), eq(schema.reviews.status, 'published')))
      .orderBy(desc(schema.reviews.createdAt)).limit(10);
    const fullListings = await db().select({ l: schema.marketplaceListings, d: schema.capabilityDomains }).from(schema.marketplaceListings)
      .innerJoin(schema.capabilityDomains, eq(schema.capabilityDomains.id, schema.marketplaceListings.domainId))
      .where(and(eq(schema.marketplaceListings.agentId, agent.id), eq(schema.marketplaceListings.status, 'active'), eq(schema.marketplaceListings.moderation, 'visible')));
    const perms = agent.permissions as { allowTraining?: boolean; allowLearning?: boolean };
    let favourite: string[] = [];
    if (req.auth) {
      const favs = await db().select().from(schema.favourites).where(and(eq(schema.favourites.userId, req.auth.user.id), eq(schema.favourites.agentId, agent.id)));
      favourite = favs.map((f) => f.list);
    }
    return {
      ...card,
      modelVersion: agent.modelVersion,
      role: agent.role,
      tools: agent.tools.map((t) => ({ name: t.name, description: t.description ?? '' })),
      inputFormats: agent.inputFormats, outputFormats: agent.outputFormats,
      isPublic: agent.isPublic, status: agent.status,
      scorecard: {
        overallScore: card.overallScore,
        verifiedDomainCount: caps.filter((c) => c.verified).length,
        lastAssessedAt: caps.length ? new Date(Math.max(...caps.map((c) => c.assessedAt.getTime()))).toISOString() : null,
        domains: caps.sort((a, b) => b.score - a.score).map((c) => ({ slug: c.slug, name: c.name, score: round1(c.score), accuracy: round1(c.accuracy), confidence: c.confidence, sampleSize: c.sampleSize, verified: c.verified, assessedAt: c.assessedAt })),
      },
      listings: fullListings.map(({ l, d }) => ({ id: l.id, title: l.title, description: l.description, domainSlug: d.slug, domainName: d.name, skills: l.skills, priceCredits: l.priceCredits, pricingModel: l.pricingModel, settlementMode: l.settlementMode, minImprovement: l.minImprovement, durationMinutes: l.durationMinutes })),
      reviews: reviews.map(({ r, reviewer }) => ({ id: r.id, rating: r.rating, body: r.body, reviewer: { name: reviewer }, createdAt: r.createdAt })),
      availability: { status: agent.status, health: agent.health, acceptsTraining: perms.allowTraining === true && fullListings.length > 0, acceptsLearning: perms.allowLearning === true, lastHealthCheckAt: agent.lastHealthCheckAt },
      reputation: {
        score: rep?.score ?? 0, level: rep?.level ?? 'new_contributor', sessionsCompleted: rep?.sessionsCompleted ?? 0, sessionsFailed: rep?.sessionsFailed ?? 0,
        trainingSuccessRate: rep?.trainingSuccessRate ?? null, avgLearnerImprovement: rep?.avgLearnerImprovement ?? null,
        avgRating: rep?.avgRating ?? null, ratingCount: rep?.ratingCount ?? 0, updatedAt: rep?.updatedAt ?? null,
      },
      viewer: { favourite: favourite.includes('favourite'), shortlisted: favourite.includes('shortlist'), isOwner: req.auth?.orgId === agent.orgId },
    };
  });

  app.get('/agents/:slug/reviews', async (req) => {
    const { slug } = parse(z.object({ slug: z.string().min(1) }), req.params);
    const q = parse(PageQuery, req.query);
    const agent = await findViewableAgent(req, slug);
    const where = and(eq(schema.reviews.agentId, agent.id), eq(schema.reviews.status, 'published'));
    const [{ n }] = await db().select({ n: count() }).from(schema.reviews).where(where);
    const rows = await db().select({ r: schema.reviews, reviewer: schema.users.name, domain: schema.capabilityDomains.slug }).from(schema.reviews)
      .innerJoin(schema.users, eq(schema.users.id, schema.reviews.reviewerId))
      .innerJoin(schema.trainingSessions, eq(schema.trainingSessions.id, schema.reviews.sessionId))
      .innerJoin(schema.capabilityDomains, eq(schema.capabilityDomains.id, schema.trainingSessions.domainId))
      .where(where).orderBy(desc(schema.reviews.createdAt)).limit(q.pageSize).offset(offset(q));
    return {
      items: rows.map(({ r, reviewer, domain }) => ({ id: r.id, rating: r.rating, body: r.body, reviewer: { name: reviewer }, sessionId: r.sessionId, domainSlug: domain, createdAt: r.createdAt })),
      total: Number(n), page: q.page, pageSize: q.pageSize,
    };
  });

  /* ───────────── Compare ───────────── */
  app.get('/compare', async (req) => {
    const { ids } = parse(z.object({ ids: z.string().min(1) }), req.query);
    const list = [...new Set(ids.split(',').map((s) => s.trim()).filter(Boolean))].slice(0, 4);
    const agents: AgentRow[] = [];
    for (const s of list) agents.push(await findViewableAgent(req, s));
    const { cards, ctx } = await buildCards(agents);
    const domainSet = new Map<string, string>();
    for (const a of agents) for (const c of ctx.caps.get(a.id) ?? []) domainSet.set(c.slug, c.name);
    const domains = [...domainSet.entries()].map(([slug, name]) => ({ slug, name }));
    return {
      domains,
      items: cards.map((c) => {
        const caps = ctx.caps.get(c.id) ?? [];
        return {
          ...c,
          scores: Object.fromEntries(domains.map((d) => {
            const cap = caps.find((x) => x.slug === d.slug);
            return [d.slug, cap ? { score: round1(cap.score), verified: cap.verified, sampleSize: cap.sampleSize, confidence: cap.confidence } : null];
          })),
          minPrice: c.listings.length ? Math.min(...c.listings.map((l) => (l.pricingModel === 'free' ? 0 : l.priceCredits))) : null,
        };
      }),
    };
  });

  /* ───────────── Favourites / shortlist ───────────── */
  const FavBody = z.object({ agentId: z.string().uuid(), list: z.enum(['favourite', 'shortlist']).default('favourite') });

  app.get('/favourites', async (req) => {
    const a = requireAuth(req);
    const { list } = parse(z.object({ list: z.enum(['favourite', 'shortlist']).optional() }), req.query);
    const favs = await db().select().from(schema.favourites)
      .where(list ? and(eq(schema.favourites.userId, a.user.id), eq(schema.favourites.list, list)) : eq(schema.favourites.userId, a.user.id))
      .orderBy(desc(schema.favourites.createdAt));
    if (!favs.length) return { items: [] };
    const agentIds = [...new Set(favs.map((f) => f.agentId))];
    // Only agents still visible to the user (public, or own org)
    const visible = await db().select({ a: schema.agents }).from(schema.agents)
      .innerJoin(schema.organisations, eq(schema.organisations.id, schema.agents.orgId))
      .where(and(inArray(schema.agents.id, agentIds), a.orgId ? or(publicAgentWhere(), and(eq(schema.agents.orgId, a.orgId), sql`${schema.agents.deletedAt} is null`)) : publicAgentWhere()));
    const { cards } = await buildCards(visible.map((v) => v.a));
    const byId = new Map(cards.map((c) => [c.id, c]));
    return { items: favs.filter((f) => byId.has(f.agentId)).map((f) => ({ list: f.list, createdAt: f.createdAt, agent: byId.get(f.agentId)! })) };
  });

  app.post('/favourites', async (req, reply) => {
    const a = requireAuth(req);
    const body = parse(FavBody, req.body);
    const ok = (await isPubliclyVisible(body.agentId)) || (a.orgId ? (await db().select({ id: schema.agents.id }).from(schema.agents).where(and(eq(schema.agents.id, body.agentId), eq(schema.agents.orgId, a.orgId))).limit(1)).length > 0 : false);
    if (!ok) throw notFound('Agent');
    await db().insert(schema.favourites).values({ userId: a.user.id, agentId: body.agentId, list: body.list }).onConflictDoNothing();
    return reply.status(201).send({ agentId: body.agentId, list: body.list });
  });

  app.delete('/favourites', async (req, reply) => {
    const a = requireAuth(req);
    const body = parse(FavBody, { ...(req.query as object), ...((req.body as object) ?? {}) });
    await db().delete(schema.favourites).where(and(eq(schema.favourites.userId, a.user.id), eq(schema.favourites.agentId, body.agentId), eq(schema.favourites.list, body.list)));
    return reply.status(204).send();
  });

  /* ───────────── Listings (mine) ───────────── */
  app.get('/listings', async (req) => {
    const a = requirePerm(req, 'agents.read');
    const rows = await db().select({ l: schema.marketplaceListings, d: schema.capabilityDomains, agentName: schema.agents.name, agentSlug: schema.agents.slug })
      .from(schema.marketplaceListings)
      .innerJoin(schema.capabilityDomains, eq(schema.capabilityDomains.id, schema.marketplaceListings.domainId))
      .innerJoin(schema.agents, eq(schema.agents.id, schema.marketplaceListings.agentId))
      .where(and(eq(schema.marketplaceListings.orgId, a.orgId), ne(schema.marketplaceListings.status, 'removed')))
      .orderBy(desc(schema.marketplaceListings.createdAt));
    const ids = rows.map((r) => r.l.id);
    const reqCounts = ids.length ? await db().select({ listingId: schema.trainingRequests.listingId, n: sql<number>`count(*)::int` }).from(schema.trainingRequests)
      .where(inArray(schema.trainingRequests.listingId, ids)).groupBy(schema.trainingRequests.listingId) : [];
    const rc = new Map(reqCounts.map((r) => [r.listingId, Number(r.n)]));
    return { items: rows.map(({ l, d, agentName, agentSlug }) => ({ ...l, domainSlug: d.slug, domainName: d.name, agent: { id: l.agentId, name: agentName, slug: agentSlug }, requestCount: rc.get(l.id) ?? 0 })) };
  });

  app.post('/listings', async (req, reply) => {
    const a = requirePerm(req, 'marketplace.publish');
    const body = parse(ListingBody, req.body);
    const agent = await getOwnedAgent(body.agentId, a.orgId);
    const domain = await domainBySlug(body.domainSlug);
    if (!domain) throw unprocessable(`Unknown domain "${body.domainSlug}"`);
    await assertCanList(agent, domain.id, domain.slug);
    if (body.settlementMode === 'on_improvement' && body.minImprovement == null) throw unprocessable('minImprovement is required when settlementMode is on_improvement');
    const priceCredits = body.pricingModel === 'free' ? 0 : body.priceCredits;
    const [row] = await db().insert(schema.marketplaceListings).values({
      agentId: agent.id, orgId: a.orgId, title: body.title, description: body.description, domainId: domain.id, skills: body.skills,
      priceCredits, pricingModel: body.pricingModel, settlementMode: body.settlementMode, minImprovement: body.minImprovement ?? null,
      durationMinutes: body.durationMinutes, status: 'active', moderation: 'visible',
    }).returning();
    await audit({ action: 'marketplace.listing.create', targetType: 'marketplace_listing', targetId: row!.id, metadata: { agentId: agent.id, domain: domain.slug, priceCredits } }, req);
    return reply.status(201).send({ ...row, domainSlug: domain.slug });
  });

  app.patch('/listings/:id', async (req) => {
    const a = requirePerm(req, 'marketplace.publish');
    const { id } = parse(IdParam, req.params);
    const body = parse(ListingPatch, req.body);
    const [l] = await db().select().from(schema.marketplaceListings).where(and(eq(schema.marketplaceListings.id, id), eq(schema.marketplaceListings.orgId, a.orgId))).limit(1);
    if (!l || l.status === 'removed') throw notFound('Listing');
    const agent = await getOwnedAgent(l.agentId, a.orgId);
    let domainId = l.domainId;
    let domainSlug: string | undefined;
    if (body.domainSlug) {
      const d = await domainBySlug(body.domainSlug);
      if (!d) throw unprocessable(`Unknown domain "${body.domainSlug}"`);
      domainId = d.id; domainSlug = d.slug;
    }
    const becomesActive = (body.status ?? l.status) === 'active';
    if (becomesActive) {
      if (l.moderation === 'hidden') throw forbidden('This listing was hidden by moderation and cannot be re-activated.');
      if (!domainSlug) domainSlug = (await db().select().from(schema.capabilityDomains).where(eq(schema.capabilityDomains.id, domainId)).limit(1))[0]?.slug ?? '';
      await assertCanList(agent, domainId, domainSlug);
    }
    const pricingModel = body.pricingModel ?? l.pricingModel;
    const [row] = await db().update(schema.marketplaceListings).set({
      ...(body.title !== undefined && { title: body.title }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.skills !== undefined && { skills: body.skills }),
      ...(body.settlementMode !== undefined && { settlementMode: body.settlementMode }),
      ...(body.minImprovement !== undefined && { minImprovement: body.minImprovement }),
      ...(body.durationMinutes !== undefined && { durationMinutes: body.durationMinutes }),
      ...(body.status !== undefined && { status: body.status }),
      pricingModel, domainId,
      priceCredits: pricingModel === 'free' ? 0 : (body.priceCredits ?? l.priceCredits),
      updatedAt: new Date(),
    }).where(eq(schema.marketplaceListings.id, id)).returning();
    await audit({ action: 'marketplace.listing.update', targetType: 'marketplace_listing', targetId: id, metadata: { changes: Object.keys(body) } }, req);
    return row;
  });

  app.delete('/listings/:id', async (req, reply) => {
    const a = requirePerm(req, 'marketplace.publish');
    const { id } = parse(IdParam, req.params);
    const [l] = await db().update(schema.marketplaceListings).set({ status: 'removed', updatedAt: new Date() })
      .where(and(eq(schema.marketplaceListings.id, id), eq(schema.marketplaceListings.orgId, a.orgId))).returning();
    if (!l) throw notFound('Listing');
    await audit({ action: 'marketplace.listing.delete', targetType: 'marketplace_listing', targetId: id }, req);
    return reply.status(204).send();
  });

  /* ───────────── Reviews ───────────── */
  app.post('/reviews', async (req, reply) => {
    const a = requireAuth(req);
    if (!a.orgId) throw forbidden('No active organisation');
    const body = parse(z.object({ sessionId: z.string().uuid(), rating: z.number().int().min(1).max(5), body: z.string().trim().max(4000).default('') }), req.body);
    const [s] = await db().select().from(schema.trainingSessions).where(eq(schema.trainingSessions.id, body.sessionId)).limit(1);
    if (!s || (s.learnerOrgId !== a.orgId && s.trainerOrgId !== a.orgId)) throw notFound('Training session');
    if (s.learnerOrgId !== a.orgId) throw forbidden('Only the learner organisation can review a training session.');
    if (s.status !== 'completed') throw unprocessable('Reviews can only be left after the training session has completed.');
    const [existing] = await db().select({ id: schema.reviews.id }).from(schema.reviews).where(eq(schema.reviews.sessionId, s.id)).limit(1);
    if (existing) throw conflict('This session has already been reviewed.');
    const [row] = await db().insert(schema.reviews).values({ sessionId: s.id, reviewerId: a.user.id, agentId: s.trainerAgentId, rating: body.rating, body: body.body })
      .onConflictDoNothing().returning();
    if (!row) throw conflict('This session has already been reviewed.');
    await recomputeReputation(s.trainerAgentId);
    const [trainer] = await db().select({ name: schema.agents.name, slug: schema.agents.slug }).from(schema.agents).where(eq(schema.agents.id, s.trainerAgentId)).limit(1);
    await notifyOrg(s.trainerOrgId, 'new_review', `New ${body.rating}★ review for ${trainer?.name ?? 'your agent'}`, body.body.slice(0, 200), trainer ? `/marketplace/agents/${trainer.slug}` : undefined);
    await audit({ action: 'marketplace.review.create', targetType: 'review', targetId: row.id, metadata: { sessionId: s.id, rating: body.rating } }, req);
    return reply.status(201).send(row);
  });

  /* ───────────── Reports ───────────── */
  app.post('/reports', async (req, reply) => {
    const a = requireAuth(req);
    const body = parse(z.object({
      targetType: z.enum(['agent', 'listing', 'knowledge', 'review', 'user']),
      targetId: z.string().uuid(),
      reason: z.string().trim().min(3).max(200),
      details: z.string().max(5000).default(''),
    }), req.body);
    const [dupe] = await db().select({ id: schema.reports.id }).from(schema.reports)
      .where(and(eq(schema.reports.reporterId, a.user.id), eq(schema.reports.targetType, body.targetType), eq(schema.reports.targetId, body.targetId), eq(schema.reports.status, 'open'))).limit(1);
    if (dupe) throw conflict('You have already reported this item; our moderators are reviewing it.');
    const [row] = await db().insert(schema.reports).values({ reporterId: a.user.id, ...body }).returning();
    await audit({ action: 'marketplace.report.create', targetType: body.targetType, targetId: body.targetId, metadata: { reportId: row!.id, reason: body.reason } }, req);
    return reply.status(201).send({ id: row!.id, status: row!.status, createdAt: row!.createdAt });
  });
}

/** Register background job handlers for this module (called once at startup). */
export function registerJobs() {}
