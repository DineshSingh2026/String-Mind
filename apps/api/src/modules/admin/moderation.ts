import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db/client.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { PageQuery, offset, parse } from '../../lib/http.js';
import { notify } from '../../lib/notify.js';
import { recomputeReputation } from '../reputation/service.js';
import { IdParam, actor, adminAudit } from './common.js';
import { suspendAgent } from './core.js';

export default async function moderation(app: FastifyInstance) {
  /* ───────────── Reports ───────────── */
  app.get('/reports', async (req) => {
    const q = parse(PageQuery.extend({ status: z.enum(['open', 'actioned', 'dismissed']).optional() }), req.query);
    const where = q.status ? eq(schema.reports.status, q.status) : undefined;
    const [{ total }] = await db().select({ total: count() }).from(schema.reports).where(where);
    const rows = await db().select({ r: schema.reports, reporter: schema.users.email }).from(schema.reports)
      .innerJoin(schema.users, eq(schema.users.id, schema.reports.reporterId))
      .where(where).orderBy(desc(schema.reports.createdAt)).limit(q.pageSize).offset(offset(q));
    return { items: rows.map(({ r, reporter }) => ({ ...r, reporterEmail: reporter })), total: Number(total), page: q.page, pageSize: q.pageSize };
  });

  app.post('/reports/:id/resolve', async (req) => {
    const me = actor(req);
    const { id } = parse(IdParam, req.params);
    const { action, note } = parse(z.object({ action: z.enum(['dismiss', 'hide_target', 'suspend_agent']), note: z.string().max(1000).optional() }), req.body);
    const [r] = await db().select().from(schema.reports).where(eq(schema.reports.id, id)).limit(1);
    if (!r) throw notFound('Report');
    if (action === 'hide_target') {
      switch (r.targetType) {
        case 'agent': await db().update(schema.agents).set({ isPublic: false, updatedAt: new Date() }).where(eq(schema.agents.id, r.targetId)); break;
        case 'listing': await db().update(schema.marketplaceListings).set({ moderation: 'hidden', updatedAt: new Date() }).where(eq(schema.marketplaceListings.id, r.targetId)); break;
        case 'knowledge': await db().update(schema.knowledgeListings).set({ moderation: 'hidden', updatedAt: new Date() }).where(eq(schema.knowledgeListings.id, r.targetId)); break;
        case 'review': {
          const [rv] = await db().update(schema.reviews).set({ status: 'hidden' }).where(eq(schema.reviews.id, r.targetId)).returning();
          if (rv) await recomputeReputation(rv.agentId);
          break;
        }
        default: throw badRequest(`Cannot hide a ${r.targetType}; suspend the user via /admin/users instead.`);
      }
    } else if (action === 'suspend_agent') {
      let agentId: string | null = null;
      if (r.targetType === 'agent') agentId = r.targetId;
      else if (r.targetType === 'listing') agentId = (await db().select().from(schema.marketplaceListings).where(eq(schema.marketplaceListings.id, r.targetId)).limit(1))[0]?.agentId ?? null;
      else if (r.targetType === 'review') agentId = (await db().select().from(schema.reviews).where(eq(schema.reviews.id, r.targetId)).limit(1))[0]?.agentId ?? null;
      if (!agentId) throw badRequest('This report does not reference an agent.');
      await suspendAgent(agentId, `Report: ${r.reason}`);
    }
    const [upd] = await db().update(schema.reports).set({ status: action === 'dismiss' ? 'dismissed' : 'actioned', resolvedBy: me.user.id }).where(eq(schema.reports.id, id)).returning();
    await adminAudit(req, 'report.resolve', 'report', id, { action, note, targetType: r.targetType, targetId: r.targetId });
    return upd;
  });

  /* ───────────── Knowledge listings ───────────── */
  app.get('/knowledge-listings', async (req) => {
    const q = parse(PageQuery.extend({ moderation: z.enum(['visible', 'hidden', 'under_review']).optional() }), req.query);
    const where = q.moderation ? eq(schema.knowledgeListings.moderation, q.moderation) : undefined;
    const [{ total }] = await db().select({ total: count() }).from(schema.knowledgeListings).where(where);
    const rows = await db().select({ l: schema.knowledgeListings, orgName: schema.organisations.name, sourceName: schema.knowledgeSources.name })
      .from(schema.knowledgeListings)
      .innerJoin(schema.organisations, eq(schema.organisations.id, schema.knowledgeListings.orgId))
      .innerJoin(schema.knowledgeSources, eq(schema.knowledgeSources.id, schema.knowledgeListings.sourceId))
      .where(where).orderBy(desc(schema.knowledgeListings.createdAt)).limit(q.pageSize).offset(offset(q));
    return { items: rows.map(({ l, orgName, sourceName }) => ({ ...l, orgName, sourceName })), total: Number(total), page: q.page, pageSize: q.pageSize };
  });

  app.post('/knowledge-listings/:id/moderate', async (req) => {
    const { id } = parse(IdParam, req.params);
    const body = parse(z.object({ decision: z.enum(['approve', 'reject']), qualityScore: z.number().min(0).max(100).optional(), note: z.string().max(1000).optional() }), req.body);
    const [l] = await db().select().from(schema.knowledgeListings).where(eq(schema.knowledgeListings.id, id)).limit(1);
    if (!l) throw notFound('Knowledge listing');
    if (body.decision === 'approve' && body.qualityScore == null && l.qualityScore == null) throw badRequest('qualityScore is required when approving');
    const [upd] = await db().update(schema.knowledgeListings).set(body.decision === 'approve'
      ? { verificationStatus: 'verified', moderation: 'visible', qualityScore: body.qualityScore ?? l.qualityScore, updatedAt: new Date() }
      : { verificationStatus: 'rejected', moderation: 'hidden', updatedAt: new Date() }).where(eq(schema.knowledgeListings.id, id)).returning();
    const [src] = await db().select().from(schema.knowledgeSources).where(eq(schema.knowledgeSources.id, l.sourceId)).limit(1);
    if (src?.agentId) await recomputeReputation(src.agentId);
    await notify(l.contributorId, 'system', `Knowledge listing ${body.decision === 'approve' ? 'approved' : 'rejected'}: ${l.title}`, body.note ?? '', '/knowledge-exchange/mine');
    await adminAudit(req, 'knowledge_listing.moderate', 'knowledge_listing', id, body, l.orgId);
    return upd;
  });

  /* ───────────── Training listings ───────────── */
  app.get('/listings', async (req) => {
    const q = parse(PageQuery.extend({ moderation: z.enum(['visible', 'hidden', 'under_review']).optional(), status: z.string().optional() }), req.query);
    const conds: SQL[] = [];
    if (q.moderation) conds.push(eq(schema.marketplaceListings.moderation, q.moderation));
    if (q.status) conds.push(eq(schema.marketplaceListings.status, q.status));
    const where = conds.length ? and(...conds) : undefined;
    const [{ total }] = await db().select({ total: count() }).from(schema.marketplaceListings).where(where);
    const items = await db().select().from(schema.marketplaceListings).where(where).orderBy(desc(schema.marketplaceListings.createdAt)).limit(q.pageSize).offset(offset(q));
    return { items, total: Number(total), page: q.page, pageSize: q.pageSize };
  });

  app.post('/listings/:id/moderate', async (req) => {
    const { id } = parse(IdParam, req.params);
    const raw = parse(z.object({ decision: z.enum(['visible', 'hidden', 'under_review', 'approve', 'reject']), note: z.string().max(1000).optional() }), req.body);
    const moderationState = raw.decision === 'approve' ? 'visible' : raw.decision === 'reject' ? 'hidden' : raw.decision;
    const [l] = await db().update(schema.marketplaceListings).set({ moderation: moderationState, updatedAt: new Date() }).where(eq(schema.marketplaceListings.id, id)).returning();
    if (!l) throw notFound('Listing');
    await adminAudit(req, 'listing.moderate', 'marketplace_listing', id, { moderation: moderationState, note: raw.note }, l.orgId);
    return l;
  });
}
