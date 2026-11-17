import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, ilike, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db/client.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { requireFiat } from '../../lib/fiat.js';
import { PageQuery, offset, parse } from '../../lib/http.js';
import { approvePayout, markPayoutPaid, publicPayout, reconcile, refundPayment, rejectPayout } from '../wallet/ledger.js';
import { resolveDispute } from '../disputes/service.js';
import { recomputeReputation } from '../reputation/service.js';
import { IdParam, actor, adminAudit } from './common.js';

/** Fiat payment / payout admin endpoints answer 410 fiat_disabled unless FIAT_ENABLED. Wallet views + reconcile stay. */
const fiat = { preHandler: requireFiat }; // runs after the admin guard

export default async function finance(app: FastifyInstance) {
  /* ───────────── Wallets & payments ───────────── */
  app.get('/wallets', async (req) => {
    const q = parse(PageQuery.extend({ q: z.string().trim().optional() }), req.query);
    const where = q.q ? ilike(schema.organisations.name, `%${q.q}%`) : undefined;
    const base = db().select({ w: schema.wallets, orgName: schema.organisations.name }).from(schema.wallets).innerJoin(schema.organisations, eq(schema.organisations.id, schema.wallets.orgId));
    const [{ total }] = await db().select({ total: count() }).from(schema.wallets).innerJoin(schema.organisations, eq(schema.organisations.id, schema.wallets.orgId)).where(where);
    const rows = await base.where(where).orderBy(desc(schema.wallets.updatedAt)).limit(q.pageSize).offset(offset(q));
    return { items: rows.map(({ w, orgName }) => ({ ...w, orgName })), total: Number(total), page: q.page, pageSize: q.pageSize };
  });

  app.get('/wallets/:id/reconcile', async (req) => {
    const { id } = parse(IdParam, req.params);
    const [w] = await db().select().from(schema.wallets).where(eq(schema.wallets.id, id)).limit(1);
    if (!w) throw notFound('Wallet');
    return { walletId: id, ...(await reconcile(id)) };
  });

  app.get('/payments', fiat, async (req) => {
    const q = parse(PageQuery.extend({ status: z.string().optional() }), req.query);
    const where = q.status ? eq(schema.payments.status, q.status) : undefined;
    const [{ total }] = await db().select({ total: count() }).from(schema.payments).where(where);
    const items = await db().select().from(schema.payments).where(where).orderBy(desc(schema.payments.createdAt)).limit(q.pageSize).offset(offset(q));
    return { items, total: Number(total), page: q.page, pageSize: q.pageSize };
  });

  app.post('/payments/:id/refund', fiat, async (req) => {
    const me = actor(req);
    const { id } = parse(IdParam, req.params);
    const r = await refundPayment(id, me.user.id);
    await adminAudit(req, 'payment.refund', 'payment', id, r);
    return r;
  });

  /* ───────────── Payouts ───────────── */
  app.get('/payouts', fiat, async (req) => {
    const q = parse(PageQuery.extend({ status: z.enum(['requested', 'approved', 'paid', 'rejected']).optional() }), req.query);
    const where = q.status ? eq(schema.payouts.status, q.status) : undefined;
    const [{ total }] = await db().select({ total: count() }).from(schema.payouts).where(where);
    const rows = await db().select({ p: schema.payouts, orgName: schema.organisations.name }).from(schema.payouts)
      .innerJoin(schema.organisations, eq(schema.organisations.id, schema.payouts.orgId))
      .where(where).orderBy(desc(schema.payouts.createdAt)).limit(q.pageSize).offset(offset(q));
    return { items: rows.map(({ p, orgName }) => ({ ...publicPayout(p), orgName })), total: Number(total), page: q.page, pageSize: q.pageSize };
  });

  const Note = z.object({ note: z.string().max(1000).optional(), providerRef: z.string().max(200).optional() });
  app.post('/payouts/:id/:action', fiat, async (req) => {
    const me = actor(req);
    const { id, action } = parse(z.object({ id: z.string().uuid(), action: z.enum(['approve', 'pay', 'reject']) }), req.params);
    const body = parse(Note, req.body);
    const p = action === 'approve' ? await approvePayout(id, me.user.id, body.note)
      : action === 'pay' ? await markPayoutPaid(id, me.user.id, body.providerRef)
      : await rejectPayout(id, me.user.id, body.note);
    await adminAudit(req, `payout.${action}`, 'payout', id, body, p.orgId);
    return publicPayout(p);
  });

  /* ───────────── Commission rules ───────────── */
  app.get('/commissions', async () => db().select().from(schema.commissionRules).where(eq(schema.commissionRules.active, true)).orderBy(schema.commissionRules.scope, desc(schema.commissionRules.createdAt)));

  app.post('/commissions', async (req, reply) => {
    const me = actor(req);
    const body = parse(z.object({ scope: z.enum(['global', 'domain', 'org']), scopeId: z.string().uuid().optional().nullable(), rateBps: z.number().int().min(0).max(10_000) }), req.body);
    if (body.scope === 'global' && body.scopeId) throw badRequest('Global rules have no scopeId');
    if (body.scope !== 'global') {
      if (!body.scopeId) throw badRequest('scopeId is required for domain/org rules');
      const tbl = body.scope === 'domain' ? schema.capabilityDomains : schema.organisations;
      const [exists] = await db().select({ id: tbl.id }).from(tbl).where(eq(tbl.id, body.scopeId)).limit(1);
      if (!exists) throw notFound(body.scope === 'domain' ? 'Domain' : 'Organisation');
    }
    const row = await db().transaction(async (tx) => {
      // one active rule per scope target: supersede previous
      const same: SQL[] = [eq(schema.commissionRules.scope, body.scope), eq(schema.commissionRules.active, true)];
      if (body.scopeId) same.push(eq(schema.commissionRules.scopeId, body.scopeId));
      await tx.update(schema.commissionRules).set({ active: false }).where(and(...same));
      const [r] = await tx.insert(schema.commissionRules).values({ scope: body.scope, scopeId: body.scopeId ?? null, rateBps: body.rateBps, createdBy: me.user.id }).returning();
      return r!;
    });
    await adminAudit(req, 'commission.create', 'commission_rule', row.id, body);
    return reply.status(201).send(row);
  });

  app.delete('/commissions/:id', async (req, reply) => {
    const { id } = parse(IdParam, req.params);
    const [r] = await db().select().from(schema.commissionRules).where(eq(schema.commissionRules.id, id)).limit(1);
    if (!r) throw notFound('Commission rule');
    if (r.scope === 'global' && r.active) {
      const [{ c }] = await db().select({ c: count() }).from(schema.commissionRules).where(and(eq(schema.commissionRules.scope, 'global'), eq(schema.commissionRules.active, true)));
      if (Number(c) <= 1) throw badRequest('The last active global rule cannot be removed; create a replacement instead.');
    }
    await db().update(schema.commissionRules).set({ active: false }).where(eq(schema.commissionRules.id, id));
    await adminAudit(req, 'commission.delete', 'commission_rule', id, { scope: r.scope, scopeId: r.scopeId, rateBps: r.rateBps });
    return reply.status(204).send();
  });

  /* ───────────── Subscriptions ───────────── */
  app.get('/subscriptions', async (req) => {
    const q = parse(PageQuery, req.query);
    const [{ total }] = await db().select({ total: count() }).from(schema.organisations);
    const orgs = await db().select().from(schema.organisations).orderBy(desc(schema.organisations.createdAt)).limit(q.pageSize).offset(offset(q));
    const subs = await db().select().from(schema.subscriptions);
    return { items: orgs.map((o) => ({ orgId: o.id, orgName: o.name, type: o.type, plan: o.plan, subscription: subs.find((s) => s.orgId === o.id) ?? null })), total: Number(total), page: q.page, pageSize: q.pageSize };
  });

  app.patch('/orgs/:id/plan', async (req) => {
    const { id } = parse(IdParam, req.params);
    const { plan } = parse(z.object({ plan: z.enum(['free', 'pro', 'enterprise']) }), req.body);
    const [o] = await db().select().from(schema.organisations).where(eq(schema.organisations.id, id)).limit(1);
    if (!o) throw notFound('Organisation');
    await db().update(schema.organisations).set({ plan, updatedAt: new Date() }).where(eq(schema.organisations.id, id));
    const [sub] = await db().select().from(schema.subscriptions).where(eq(schema.subscriptions.orgId, id)).limit(1);
    if (sub) await db().update(schema.subscriptions).set({ plan, status: 'active', updatedAt: new Date() }).where(eq(schema.subscriptions.id, sub.id));
    else await db().insert(schema.subscriptions).values({ orgId: id, plan });
    await adminAudit(req, 'org.plan', 'organisation', id, { before: o.plan, after: plan }, id);
    return { orgId: id, plan };
  });

  /* ───────────── Fraud flags ───────────── */
  app.get('/fraud-flags', async (req) => {
    const q = parse(PageQuery.extend({ status: z.enum(['open', 'confirmed', 'dismissed']).optional() }), req.query);
    const where = q.status ? eq(schema.fraudFlags.status, q.status) : undefined;
    const [{ total }] = await db().select({ total: count() }).from(schema.fraudFlags).where(where);
    const items = await db().select().from(schema.fraudFlags).where(where).orderBy(desc(schema.fraudFlags.createdAt)).limit(q.pageSize).offset(offset(q));
    return { items, total: Number(total), page: q.page, pageSize: q.pageSize };
  });

  app.post('/fraud-flags/:id', async (req) => {
    const me = actor(req);
    const { id } = parse(IdParam, req.params);
    const { status } = parse(z.object({ status: z.enum(['open', 'confirmed', 'dismissed']) }), req.body);
    const [f] = await db().update(schema.fraudFlags).set({ status, reviewedBy: me.user.id }).where(eq(schema.fraudFlags.id, id)).returning();
    if (!f) throw notFound('Fraud flag');
    await adminAudit(req, 'fraud_flag.update', 'fraud_flag', id, { status });
    return f;
  });

  /* ───────────── Disputes ───────────── */
  app.get('/disputes', async (req) => {
    const q = parse(PageQuery.extend({ status: z.string().optional() }), req.query);
    const where = q.status ? eq(schema.disputes.status, q.status) : undefined;
    const [{ total }] = await db().select({ total: count() }).from(schema.disputes).where(where);
    const rows = await db().select({ d: schema.disputes, s: schema.trainingSessions }).from(schema.disputes)
      .innerJoin(schema.trainingSessions, eq(schema.trainingSessions.id, schema.disputes.sessionId))
      .where(where).orderBy(desc(schema.disputes.createdAt)).limit(q.pageSize).offset(offset(q));
    return {
      items: rows.map(({ d, s }) => ({ ...d, session: { id: s.id, subject: s.subject, status: s.status, feeCredits: s.feeCredits, settlementStatus: s.settlementStatus, improvement: s.improvement, learnerOrgId: s.learnerOrgId, trainerOrgId: s.trainerOrgId, trainerAgentId: s.trainerAgentId } })),
      total: Number(total), page: q.page, pageSize: q.pageSize,
    };
  });

  app.post('/disputes/:id/resolve', async (req) => {
    const me = actor(req);
    const { id } = parse(IdParam, req.params);
    const body = parse(z.object({ outcome: z.enum(['refund', 'release', 'partial']), refundCredits: z.number().int().min(0).optional(), resolution: z.string().trim().min(3).max(4000) }), req.body);
    if (body.outcome === 'partial' && !body.refundCredits) throw badRequest('refundCredits is required for a partial outcome');
    const d = await resolveDispute(id, { ...body, actorUserId: me.user.id });
    const [s] = await db().select({ trainer: schema.trainingSessions.trainerAgentId, learner: schema.trainingSessions.learnerAgentId }).from(schema.trainingSessions).where(eq(schema.trainingSessions.id, d.sessionId)).limit(1);
    if (s) { await recomputeReputation(s.trainer); await recomputeReputation(s.learner); }
    await adminAudit(req, 'dispute.resolve', 'dispute', id, body);
    return d;
  });
}
