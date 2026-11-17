/**
 * Knowledge exchange: verified, licensed knowledge packs contributed by orgs.
 * Public listings = moderation 'visible' AND verificationStatus 'verified' AND status 'active'.
 * New listings start as verificationStatus 'pending' / moderation 'under_review' until an admin approves them.
 * Purchases go through the wallet ledger service (the only code allowed to move IDLE Tokens).
 */
import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db/client.js';
import { audit } from '../../lib/audit.js';
import { requirePerm } from '../../lib/auth.js';
import { conflict, notFound, unprocessable } from '../../lib/errors.js';
import { PageQuery, offset, parse } from '../../lib/http.js';
import { getOwnedAgent } from '../../lib/tenancy.js';

const KL = schema.knowledgeListings;
const IdParam = z.object({ id: z.string().uuid() });

const publicListingWhere = (): SQL => and(eq(KL.moderation, 'visible'), eq(KL.verificationStatus, 'verified'), eq(KL.status, 'active'))!;

async function present(rows: (typeof KL.$inferSelect)[], viewerOrgId: string | null) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const orgIds = [...new Set(rows.map((r) => r.orgId))];
  const sourceIds = [...new Set(rows.map((r) => r.sourceId))];
  const domainIds = [...new Set(rows.map((r) => r.domainId).filter((x): x is string => !!x))];
  const [orgs, domains, docCounts, sales, owned] = await Promise.all([
    db().select({ id: schema.organisations.id, name: schema.organisations.name }).from(schema.organisations).where(inArray(schema.organisations.id, orgIds)),
    domainIds.length ? db().select().from(schema.capabilityDomains).where(inArray(schema.capabilityDomains.id, domainIds)) : [],
    db().select({ sourceId: schema.knowledgeDocuments.sourceId, n: sql<number>`count(*)::int` }).from(schema.knowledgeDocuments)
      .where(and(inArray(schema.knowledgeDocuments.sourceId, sourceIds), eq(schema.knowledgeDocuments.status, 'ready'))).groupBy(schema.knowledgeDocuments.sourceId),
    db().select({ listingId: schema.knowledgeLicences.listingId, n: sql<number>`count(*)::int` }).from(schema.knowledgeLicences)
      .where(inArray(schema.knowledgeLicences.listingId, ids)).groupBy(schema.knowledgeLicences.listingId),
    viewerOrgId ? db().select({ listingId: schema.knowledgeLicences.listingId }).from(schema.knowledgeLicences)
      .where(and(inArray(schema.knowledgeLicences.listingId, ids), eq(schema.knowledgeLicences.buyerOrgId, viewerOrgId))) : [],
  ]);
  const o = new Map(orgs.map((x) => [x.id, x.name]));
  const d = new Map(domains.map((x) => [x.id, x]));
  const dc = new Map(docCounts.map((x) => [x.sourceId, Number(x.n)]));
  const sc = new Map(sales.map((x) => [x.listingId, Number(x.n)]));
  const own = new Set(owned.map((x) => x.listingId));
  return rows.map((r) => ({
    id: r.id, title: r.title, description: r.description, category: r.category,
    domain: r.domainId && d.get(r.domainId) ? { slug: d.get(r.domainId)!.slug, name: d.get(r.domainId)!.name } : null,
    licence: r.licence, usageRestrictions: r.usageRestrictions, priceCredits: r.priceCredits, qualityScore: r.qualityScore,
    verificationStatus: r.verificationStatus, moderation: r.moderation, status: r.status, version: r.version,
    contributor: { orgName: o.get(r.orgId) ?? '' }, documentCount: dc.get(r.sourceId) ?? 0, licencesSold: sc.get(r.id) ?? 0,
    purchased: own.has(r.id), isOwn: viewerOrgId === r.orgId,
    createdAt: r.createdAt, updatedAt: r.updatedAt,
  }));
}

export default async function routes(app: FastifyInstance) {
  app.get('/listings', async (req) => {
    const q = parse(PageQuery.extend({ q: z.string().trim().max(200).optional(), category: z.string().optional(), domain: z.string().optional() }), req.query);
    const conds: SQL[] = [publicListingWhere()];
    if (q.q) conds.push(or(ilike(KL.title, `%${q.q}%`), ilike(KL.description, `%${q.q}%`))!);
    if (q.category) conds.push(eq(KL.category, q.category));
    if (q.domain) {
      const [d] = await db().select().from(schema.capabilityDomains).where(eq(schema.capabilityDomains.slug, q.domain)).limit(1);
      if (!d) return { items: [], total: 0, page: q.page, pageSize: q.pageSize };
      conds.push(eq(KL.domainId, d.id));
    }
    const where = and(...conds);
    const [{ n }] = await db().select({ n: count() }).from(KL).where(where);
    const rows = await db().select().from(KL).where(where)
      .orderBy(sql`${KL.qualityScore} desc nulls last`, desc(KL.createdAt)).limit(q.pageSize).offset(offset(q));
    return { items: await present(rows, req.auth?.orgId ?? null), total: Number(n), page: q.page, pageSize: q.pageSize };
  });

  app.get('/listings/:id', async (req) => {
    const { id } = parse(IdParam, req.params);
    const orgId = req.auth?.orgId ?? null;
    const [row] = await db().select().from(KL)
      .where(and(eq(KL.id, id), orgId ? or(publicListingWhere(), eq(KL.orgId, orgId)) : publicListingWhere())).limit(1);
    if (!row) throw notFound('Knowledge listing');
    const [item] = await present([row], orgId);
    return { ...item!, provenance: row.provenance };
  });

  app.post('/listings', async (req, reply) => {
    const a = requirePerm(req, 'knowledge.publish');
    const body = parse(z.object({
      sourceId: z.string().uuid(),
      title: z.string().trim().min(3).max(140),
      description: z.string().max(5000).default(''),
      category: z.string().trim().min(1).max(64),
      licence: z.string().trim().min(1, 'A licence is required').max(200),
      ownershipAttested: z.literal(true, { errorMap: () => ({ message: 'You must attest that you own or have the right to license this knowledge' }) }),
      priceCredits: z.number().int().min(0).max(1_000_000).default(0),
      usageRestrictions: z.string().max(2000).default(''),
    }), req.body);
    const [source] = await db().select().from(schema.knowledgeSources)
      .where(and(eq(schema.knowledgeSources.id, body.sourceId), eq(schema.knowledgeSources.orgId, a.orgId))).limit(1);
    if (!source) throw notFound('Knowledge source');
    if (source.type === 'licensed') throw unprocessable('Licensed (purchased) knowledge cannot be re-listed.');
    const [{ docs }] = await db().select({ docs: count() }).from(schema.knowledgeDocuments)
      .where(and(eq(schema.knowledgeDocuments.sourceId, source.id), inArray(schema.knowledgeDocuments.status, ['ready', 'processing'])));
    if (!Number(docs)) throw unprocessable('The knowledge source has no documents yet. Upload content before listing it.');
    const [existing] = await db().select({ id: KL.id }).from(KL).where(and(eq(KL.sourceId, source.id), eq(KL.status, 'active'))).limit(1);
    if (existing) throw conflict('This knowledge source already has an active listing.');
    const [row] = await db().insert(KL).values({
      sourceId: source.id, orgId: a.orgId, contributorId: a.user.id, title: body.title, description: body.description,
      category: body.category, domainId: source.domainId, licence: body.licence, ownershipAttested: true, priceCredits: body.priceCredits,
      usageRestrictions: body.usageRestrictions, verificationStatus: 'pending', moderation: 'under_review', status: 'active',
      provenance: { sourceId: source.id, sourceName: source.name, attestedBy: a.user.id, attestedAt: new Date().toISOString(), documents: Number(docs) },
    }).returning();
    await audit({ action: 'knowledge_exchange.listing.create', targetType: 'knowledge_listing', targetId: row!.id, metadata: { sourceId: source.id, priceCredits: body.priceCredits, licence: body.licence } }, req);
    const [item] = await present([row!], a.orgId);
    return reply.status(201).send(item);
  });

  app.post('/listings/:id/purchase', async (req, reply) => {
    const a = requirePerm(req, 'wallet.purchase');
    const { id } = parse(IdParam, req.params);
    const body = parse(z.object({ agentId: z.string().uuid().optional() }), req.body);
    const [listing] = await db().select().from(KL).where(and(eq(KL.id, id), publicListingWhere())).limit(1);
    if (!listing) throw notFound('Knowledge listing');
    if (listing.orgId === a.orgId) throw unprocessable('You cannot purchase your own knowledge listing.');
    const [already] = await db().select().from(schema.knowledgeLicences)
      .where(and(eq(schema.knowledgeLicences.listingId, id), eq(schema.knowledgeLicences.buyerOrgId, a.orgId))).limit(1);
    if (already) throw conflict('Your organisation already holds a licence for this listing.');
    if (body.agentId) await getOwnedAgent(body.agentId, a.orgId);
    const { purchaseKnowledge } = await import('../wallet/ledger.js');
    const res = await purchaseKnowledge({ listingId: id, buyerOrgId: a.orgId, buyerUserId: a.user.id, agentId: body.agentId });
    const [licence] = await db().select().from(schema.knowledgeLicences).where(eq(schema.knowledgeLicences.id, res.licenceId)).limit(1);
    await audit({ action: 'knowledge_exchange.purchase', targetType: 'knowledge_listing', targetId: id, metadata: { licenceId: res.licenceId, transactionId: res.transactionId, priceCredits: listing.priceCredits } }, req);
    return reply.status(201).send({ ...(licence ?? { id: res.licenceId }), transactionId: res.transactionId, listing: { id: listing.id, title: listing.title, sourceId: listing.sourceId } });
  });

  app.get('/licences', async (req) => {
    const a = requirePerm(req, 'knowledge.read');
    const rows = await db().select({ lic: schema.knowledgeLicences, l: KL, agentName: schema.agents.name }).from(schema.knowledgeLicences)
      .innerJoin(KL, eq(KL.id, schema.knowledgeLicences.listingId))
      .leftJoin(schema.agents, eq(schema.agents.id, schema.knowledgeLicences.agentId))
      .where(eq(schema.knowledgeLicences.buyerOrgId, a.orgId)).orderBy(desc(schema.knowledgeLicences.createdAt));
    return {
      items: rows.map(({ lic, l, agentName }) => ({
        id: lic.id, createdAt: lic.createdAt, transactionId: lic.transactionId,
        agent: lic.agentId ? { id: lic.agentId, name: agentName } : null,
        listing: { id: l.id, title: l.title, category: l.category, licence: l.licence, usageRestrictions: l.usageRestrictions, sourceId: l.sourceId, priceCredits: l.priceCredits, status: l.status },
      })),
    };
  });

  app.get('/mine', async (req) => {
    const a = requirePerm(req, 'knowledge.read');
    const rows = await db().select().from(KL).where(eq(KL.orgId, a.orgId)).orderBy(desc(KL.createdAt));
    const items = await present(rows, a.orgId);
    // Earnings = net credit to this org's wallet(s) on transactions that reference the listing or its licences.
    const ids = rows.map((r) => r.id);
    const earningsBy = new Map<string, number>();
    if (ids.length) {
      const lics = await db().select({ id: schema.knowledgeLicences.id, listingId: schema.knowledgeLicences.listingId, tx: schema.knowledgeLicences.transactionId })
        .from(schema.knowledgeLicences).where(inArray(schema.knowledgeLicences.listingId, ids));
      const refToListing = new Map<string, string>([...ids.map((x) => [x, x] as [string, string]), ...lics.map((l) => [l.id, l.listingId] as [string, string])]);
      const txToListing = new Map<string, string>(lics.filter((l) => l.tx).map((l) => [l.tx!, l.listingId]));
      const txs = await db().select({ id: schema.transactions.id, referenceId: schema.transactions.referenceId }).from(schema.transactions)
        .where(or(inArray(schema.transactions.referenceId, [...refToListing.keys()]), txToListing.size ? inArray(schema.transactions.id, [...txToListing.keys()]) : sql`false`));
      const txListing = new Map<string, string>();
      for (const t of txs) {
        const lid = txToListing.get(t.id) ?? (t.referenceId ? refToListing.get(t.referenceId) : undefined);
        if (lid) txListing.set(t.id, lid);
      }
      if (txListing.size) {
        const nets = await db().select({ tx: schema.ledgerEntries.transactionId, net: sql<string>`sum(${schema.ledgerEntries.amount})` }).from(schema.ledgerEntries)
          .innerJoin(schema.wallets, eq(schema.wallets.id, schema.ledgerEntries.walletId))
          .where(and(inArray(schema.ledgerEntries.transactionId, [...txListing.keys()]), eq(schema.wallets.orgId, a.orgId), eq(schema.wallets.kind, 'org')))
          .groupBy(schema.ledgerEntries.transactionId);
        for (const n of nets) {
          const v = Number(n.net);
          if (v > 0) { const lid = txListing.get(n.tx)!; earningsBy.set(lid, (earningsBy.get(lid) ?? 0) + v); }
        }
      }
    }
    const withEarnings = items.map((i) => ({ ...i, earnings: earningsBy.get(i.id) ?? 0 }));
    return {
      items: withEarnings,
      totals: { listings: rows.length, licencesSold: withEarnings.reduce((s, i) => s + i.licencesSold, 0), earnings: withEarnings.reduce((s, i) => s + i.earnings, 0) },
    };
  });
}

/** Register background job handlers for this module (called once at startup). */
export function registerJobs() {}
