import type { FastifyInstance } from 'fastify';
import { and, asc, count, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { CREDIT_CURRENCY } from '@aix/shared';
import { db, rowsOf, schema } from '../../db/client.js';
import { requirePerm } from '../../lib/auth.js';
import { notFound } from '../../lib/errors.js';
import { requireFiat } from '../../lib/fiat.js';
import { PageQuery, offset, parse } from '../../lib/http.js';
import { bonusTotal, getOrCreateWallet, listTransactions, publicPayout, requestPayout } from './ledger.js';
import { buildInvoice, confirmSandboxPayment, createPayment, handleWebhook, publicPayment, taxFor } from './payments.js';

const PayoutBody = z.object({
  amountCredits: z.number().int().positive(),
  method: z.discriminatedUnion('type', [
    z.object({ type: z.literal('bank'), accountName: z.string().min(2).max(120), accountNumber: z.string().regex(/^\d{6,20}$/), ifsc: z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/) }),
    z.object({ type: z.literal('upi'), vpa: z.string().regex(/^[\w.-]{2,64}@[a-zA-Z]{2,64}$/) }),
  ]),
});

/** Fiat routes answer 410 fiat_disabled unless FIAT_ENABLED (checked before auth; see lib/fiat.ts). */
const fiat = { onRequest: requireFiat };

/**
 * Earnings ledger entries for a wallet: positive IDLE from training settlements (tx.org_id = the trainer org)
 * and knowledge sales, minus dispute clawbacks. `available` for IDLE-era rows, `withdrawable` for legacy rows.
 */
const EARNING_ENTRY = (orgId: string) => sql`le.bucket in ('available','withdrawable') and (
  (t.type = 'training_settlement' and t.org_id = ${orgId} and le.amount > 0)
  or (t.type = 'knowledge_purchase' and le.amount > 0)
  or (t.type = 'dispute_refund' and le.amount < 0))`;

export default async function routes(app: FastifyInstance) {
  /** IDLE wallet. Legacy `withdrawable` (pre-IDLE earnings) is not part of the contract and is not shown. */
  app.get('/', async (req) => {
    const a = requirePerm(req, 'wallet.read');
    const w = await getOrCreateWallet(a.orgId);
    return {
      currency: CREDIT_CURRENCY, available: w.available, locked: w.locked,
      earnedTotal: w.earnedTotal, spentTotal: w.spentTotal, refundedTotal: w.refundedTotal, bonusTotal: await bonusTotal(w.id),
    };
  });

  app.get('/transactions', async (req) => {
    const a = requirePerm(req, 'wallet.read');
    const q = parse(PageQuery.extend({ type: z.string().max(40).optional() }), req.query);
    return listTransactions(a.orgId, q);
  });

  app.get('/packages', fiat, async (req) => {
    requirePerm(req, 'wallet.read');
    const rows = await db().select().from(schema.creditPackages).where(eq(schema.creditPackages.active, true)).orderBy(asc(schema.creditPackages.sortOrder));
    return rows.map((p) => ({ ...p, totalCredits: p.credits + p.bonusCredits, taxMinor: taxFor(p.priceMinor), totalMinor: p.priceMinor + taxFor(p.priceMinor) }));
  });

  app.post('/purchase', fiat, async (req, reply) => {
    const a = requirePerm(req, 'wallet.purchase');
    const body = parse(z.object({ packageId: z.string().uuid() }), req.body);
    const p = await createPayment({ orgId: a.orgId, userId: a.user.id, packageId: body.packageId });
    return reply.status(201).send(p);
  });

  app.post('/payments/:id/confirm', fiat, async (req) => {
    const a = requirePerm(req, 'wallet.purchase');
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const body = parse(z.object({ checkoutToken: z.string().min(10).max(200), outcome: z.enum(['success', 'fail']) }), req.body);
    return publicPayment(await confirmSandboxPayment(id, a.orgId, body.checkoutToken, body.outcome));
  });

  app.get('/payments', fiat, async (req) => {
    const a = requirePerm(req, 'wallet.read');
    const q = parse(PageQuery, req.query);
    const where = eq(schema.payments.orgId, a.orgId);
    const [items, [{ n }]] = await Promise.all([
      db().select().from(schema.payments).where(where).orderBy(desc(schema.payments.createdAt)).limit(q.pageSize).offset(offset(q)),
      db().select({ n: count() }).from(schema.payments).where(where),
    ]);
    return { items: items.map(publicPayment), total: n, page: q.page, pageSize: q.pageSize };
  });

  app.get('/payments/:id/invoice', fiat, async (req) => {
    const a = requirePerm(req, 'wallet.read');
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const [p] = await db().select().from(schema.payments).where(and(eq(schema.payments.id, id), eq(schema.payments.orgId, a.orgId))).limit(1);
    if (!p) throw notFound('Payment');
    return buildInvoice(p);
  });

  app.post('/payouts', fiat, async (req, reply) => {
    const a = requirePerm(req, 'wallet.payout');
    const body = parse(PayoutBody, req.body);
    const key = req.headers['idempotency-key'];
    const p = await requestPayout({ orgId: a.orgId, userId: a.user.id, amountCredits: body.amountCredits, method: body.method, idempotencyKey: typeof key === 'string' ? key.slice(0, 100) : undefined });
    return reply.status(201).send(publicPayout(p));
  });

  app.get('/payouts', fiat, async (req) => {
    const a = requirePerm(req, 'wallet.read');
    const q = parse(PageQuery, req.query);
    const where = eq(schema.payouts.orgId, a.orgId);
    const [items, [{ n }]] = await Promise.all([
      db().select().from(schema.payouts).where(where).orderBy(desc(schema.payouts.createdAt)).limit(q.pageSize).offset(offset(q)),
      db().select({ n: count() }).from(schema.payouts).where(where),
    ]);
    return { items: items.map(publicPayout), total: n, page: q.page, pageSize: q.pageSize };
  });

  app.get('/earnings', async (req) => {
    const a = requirePerm(req, 'wallet.read');
    const w = await getOrCreateWallet(a.orgId);
    // Earnings (IDLE) = settlement / knowledge-sale credits to this wallet, net of dispute clawbacks.
    const byMonthRes = await db().execute(sql`
      select to_char(t.created_at, 'YYYY-MM') as month, sum(le.amount)::bigint as earned,
        count(distinct case when t.reference_type = 'training_session' and le.amount > 0 then t.reference_id end)::int as sessions
      from ledger_entries le join transactions t on t.id = le.transaction_id
      where le.wallet_id = ${w.id} and ${EARNING_ENTRY(a.orgId)}
      group by 1 order by 1`);
    const bySourceRes = await db().execute(sql`
      select s.trainer_agent_id as "agentId", ag.name, coalesce(sum(s.trainer_earnings_credits),0)::bigint as earned, count(*)::int as sessions
      from training_sessions s join agents ag on ag.id = s.trainer_agent_id
      where s.trainer_org_id = ${a.orgId} and s.settlement_status in ('settled','refunded') and s.trainer_earnings_credits is not null
      group by s.trainer_agent_id, ag.name order by earned desc`);
    const knowledgeRes = await db().execute(sql`
      select coalesce(sum(le.amount),0)::bigint as earned, count(*)::int as sales
      from knowledge_licences kl join knowledge_listings l on l.id = kl.listing_id
      join ledger_entries le on le.transaction_id = kl.transaction_id and le.wallet_id = ${w.id} and le.bucket in ('available','withdrawable') and le.amount > 0
      where l.org_id = ${a.orgId}`);
    const recentRes = await db().execute(sql`
      select t.id as "transactionId", t.type, t.description, t.reference_type as "referenceType", t.reference_id as "referenceId", le.amount, t.created_at as "createdAt"
      from ledger_entries le join transactions t on t.id = le.transaction_id
      where le.wallet_id = ${w.id} and ${EARNING_ENTRY(a.orgId)}
      order by t.created_at desc limit 10`);
    const bySource = rowsOf<{ agentId: string; name: string; earned: string; sessions: number }>(bySourceRes)
      .map((r) => ({ agentId: r.agentId as string | null, name: r.name, earned: Number(r.earned), sessions: r.sessions }));
    const k = rowsOf<{ earned: string; sales: number }>(knowledgeRes)[0];
    if (k && Number(k.sales) > 0) bySource.push({ agentId: null, name: 'Knowledge sales', earned: Number(k.earned), sessions: 0 });
    return {
      currency: CREDIT_CURRENCY, totalEarned: w.earnedTotal,
      /** Kept for shape compatibility: IDLE cannot be withdrawn, earnings are spendable (in `available`). */
      withdrawable: 0,
      byMonth: rowsOf<{ month: string; earned: string; sessions: number }>(byMonthRes).map((r) => ({ month: r.month, earned: Number(r.earned), sessions: Number(r.sessions) })),
      bySource,
      recent: rowsOf<Record<string, unknown>>(recentRes).map((r) => ({ ...r, amount: Number(r.amount), createdAt: new Date(r.createdAt as string).toISOString() })),
    };
  });

  // Provider webhooks: raw body needed for signature verification (scoped parser).
  app.register(async (scope) => {
    scope.addHook('onRequest', requireFiat);
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));
    scope.post('/webhooks/:provider', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (req) => {
      const { provider } = parse(z.object({ provider: z.string().max(20) }), req.params);
      return handleWebhook(provider, typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {}), req.headers);
    });
  });
}

/** Register background job handlers for this module (called once at startup). */
export function registerJobs() {}
