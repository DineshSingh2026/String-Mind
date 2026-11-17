import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { and, eq, sql } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { WELCOME_BONUS_IDLE } from '@aix/shared';
import { schema } from '../src/db/client.js';
import { config } from '../src/lib/config.js';
import { app, createUserDirect, database, loginAdmin, registerUser, setup, teardown } from './helpers.js';
import {
  adminAdjustment, escrowTraining, getCommissionBps, getOrCreateWallet, grantWelcomeBonus, purchaseKnowledge, reconcile, refundPayment,
  settleTraining,
} from '../src/modules/wallet/ledger.js';
import { resolveDispute } from '../src/modules/disputes/service.js';

type U = Awaited<ReturnType<typeof createUserDirect>>;
let admin: U;
let domainId: string;
let providerId: string;

beforeAll(async () => {
  await setup();
  admin = await createUserDirect({ platformRole: 'super_admin' });
  const [d] = await database.select().from(schema.capabilityDomains).limit(1);
  domainId = d!.id;
  const [p] = await database.select().from(schema.agentProviders).limit(1);
  providerId = p!.id;
});
afterAll(async () => { config.FIAT_ENABLED = false; await teardown(); });

async function wallet(orgId: string) { return getOrCreateWallet(orgId); }
async function platformRevenue() {
  const [r] = await database.select({ w: schema.wallets }).from(schema.wallets)
    .innerJoin(schema.organisations, eq(schema.organisations.id, schema.wallets.orgId))
    .where(and(eq(schema.organisations.slug, 'aix-platform'), eq(schema.wallets.kind, 'platform')));
  return r!.w.available;
}
async function agent(u: { orgId: string; userId: string }) {
  const [a] = await database.insert(schema.agents).values({ orgId: u.orgId, ownerId: u.userId, providerId, slug: `a-${randomBytes(5).toString('hex')}`, name: 'Agent', modelName: 'm' }).returning();
  return a!;
}
async function session(learner: { orgId: string; userId: string }, trainer: { orgId: string; userId: string }, fee: number, extra: Partial<typeof schema.trainingSessions.$inferInsert> = {}) {
  const [la, ta] = [await agent(learner), await agent(trainer)];
  const [s] = await database.insert(schema.trainingSessions).values({
    learnerAgentId: la.id, trainerAgentId: ta.id, learnerOrgId: learner.orgId, trainerOrgId: trainer.orgId, domainId,
    subject: 'Test training', feeCredits: fee, status: 'completed', endedAt: new Date(), ...extra,
  }).returning();
  return s!;
}
const fund = (u: U, amount: number) => adminAdjustment({ orgId: u.orgId, amount, reason: 'test funding', actorUserId: admin.userId });

async function buyStarter(u: U) {
  const pk = await u.request('GET', '/wallet/packages');
  const starter = pk.body.find((p: { name: string }) => p.name === 'Starter');
  const res = await u.request('POST', '/wallet/purchase', { packageId: starter.id });
  expect(res.status).toBe(201);
  return res.body;
}

const PASSWORD = 'Str0ng!Passw0rd';
const login = (email: string) => app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } });
const cookieOf = (r: { headers: Record<string, unknown> }) => String(r.headers['set-cookie']).split(';')[0]!;
async function asCookie(cookie: string, method: string, url: string) {
  const r = await app.inject({ method: method as never, url, headers: { cookie } });
  return { status: r.statusCode, body: r.body ? r.json() : null };
}
/** A pre-existing account (created before the IDLE switch): org + membership + password, no bonus yet. */
async function legacyAccount() {
  const u = await createUserDirect();
  const email = `legacy${randomBytes(4).toString('hex')}@test.dev`;
  await database.update(schema.users).set({ email, passwordHash: await bcrypt.hash(PASSWORD, 4) }).where(eq(schema.users.id, u.userId));
  return { ...u, email };
}

describe('IDLE welcome bonus', () => {
  it('register grants 1000 IDLE exactly once; logout + login again keeps 1000', async () => {
    const email = `w${randomBytes(4).toString('hex')}@test.dev`;
    const reg = await app.inject({ method: 'POST', url: '/auth/register', payload: { email, password: PASSWORD, name: 'W', persona: 'agent_owner' } });
    expect(reg.statusCode).toBe(201);
    expect(reg.json().welcomeBonus).toMatchObject({ amount: WELCOME_BONUS_IDLE, transactionId: expect.any(String) });
    const cookie = cookieOf(reg);

    const w = await asCookie(cookie, 'GET', '/wallet');
    expect(w.body).toEqual({ currency: 'IDLE', available: 1000, locked: 0, earnedTotal: 0, spentTotal: 0, refundedTotal: 0, bonusTotal: 1000 });
    expect(w.body.withdrawable).toBeUndefined();
    expect(w.body.purchasedTotal).toBeUndefined();

    const me = await asCookie(cookie, 'GET', '/auth/me');
    expect(me.body.welcomeBonus).toMatchObject({ granted: true, amount: 1000 });
    expect(new Date(me.body.welcomeBonus.grantedAt).getTime()).toBeGreaterThan(0);

    const txs = await asCookie(cookie, 'GET', '/wallet/transactions?type=welcome_bonus');
    expect(txs.body.total).toBe(1);
    expect(txs.body.items[0]).toMatchObject({ type: 'welcome_bonus', amount: 1000 });

    const notes = await asCookie(cookie, 'GET', '/notifications');
    expect(JSON.stringify(notes.body)).toContain('Welcome to StringMind — 1,000 IDLE Tokens added');

    expect((await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie } })).statusCode).toBe(204);
    const again = await login(email);
    expect(again.statusCode).toBe(200);
    expect(again.json().welcomeBonus).toBeNull();
    const c2 = cookieOf(again);
    expect((await asCookie(c2, 'GET', '/wallet')).body).toMatchObject({ available: 1000, bonusTotal: 1000 });
    expect((await asCookie(c2, 'GET', '/wallet/transactions?type=welcome_bonus')).body.total).toBe(1);
  });

  it('existing account without a bonus gets it on its next login; concurrent logins never double-grant', async () => {
    const u = await legacyAccount();
    const me0 = await u.request('GET', '/auth/me');
    expect(me0.body.welcomeBonus).toEqual({ granted: false, amount: 1000, grantedAt: null });

    const results = await Promise.all([login(u.email), login(u.email), login(u.email)]);
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    const granted = results.map((r) => r.json().welcomeBonus).filter(Boolean);
    expect(granted).toHaveLength(1);
    const w = await wallet(u.orgId);
    expect(w.available).toBe(1000);
    const [{ n }] = await database.select({ n: sql<number>`count(*)::int` }).from(schema.transactions).where(eq(schema.transactions.idempotencyKey, `welcome:${u.userId}`));
    expect(n).toBe(1);
  });

  it('direct concurrent grants are idempotent', async () => {
    const u = await createUserDirect();
    const rs = await Promise.all(Array.from({ length: 5 }, () => grantWelcomeBonus(u.userId)));
    expect(rs.filter((r) => r.granted)).toHaveLength(1);
    expect(new Set(rs.map((r) => r.transactionId)).size).toBe(1);
    expect((await wallet(u.orgId)).available).toBe(1000);
  });

  it('earned IDLE is immediately spendable: trainer earns, then pays for its own training', async () => {
    const trainer = await registerUser(); // +1000 welcome
    const tMe = await trainer.request('GET', '/auth/me');
    const t = { orgId: tMe.body.org.id as string, userId: tMe.body.user.id as string };
    const learner = await registerUser();
    const lMe = await learner.request('GET', '/auth/me');
    const l = { orgId: lMe.body.org.id as string, userId: lMe.body.user.id as string };

    const s1 = await session(l, t, 1000);
    await escrowTraining(s1.id);
    await settleTraining(s1.id, { outcome: 'release' });
    let tw = (await trainer.request('GET', '/wallet')).body;
    expect(tw).toMatchObject({ available: 1800, earnedTotal: 800, bonusTotal: 1000 });
    expect((await trainer.request('GET', '/wallet/earnings')).body).toMatchObject({ totalEarned: 800, currency: 'IDLE' });

    // spend more than the welcome bonus alone would cover → only possible with the earnings
    const s2 = await session(t, l, 1500);
    await escrowTraining(s2.id);
    tw = (await trainer.request('GET', '/wallet')).body;
    expect(tw).toMatchObject({ available: 300, locked: 1500 });
    await settleTraining(s2.id, { outcome: 'release' });
    tw = (await trainer.request('GET', '/wallet')).body;
    expect(tw).toMatchObject({ available: 300, locked: 0, spentTotal: 1500, earnedTotal: 800 });
    const lw = (await learner.request('GET', '/wallet')).body;
    expect(lw).toMatchObject({ available: 1000 - 1000 + 1200, earnedTotal: 1200, spentTotal: 1000 });
    // the learner's earnings only count its trainer income, not its training spend
    expect((await learner.request('GET', '/wallet/earnings')).body.totalEarned).toBe(1200);
    expect((await learner.request('GET', '/wallet/earnings')).body.byMonth.reduce((a: number, m: { earned: number }) => a + m.earned, 0)).toBe(1200);
  });
});

describe('fiat disabled by default (410)', () => {
  it('user fiat endpoints answer 410 fiat_disabled', async () => {
    expect(config.FIAT_ENABLED).toBe(false);
    const u = await createUserDirect();
    const id = '00000000-0000-4000-8000-000000000000';
    const calls: [string, string, unknown?][] = [
      ['GET', '/wallet/packages'], ['POST', '/wallet/purchase', { packageId: id }],
      ['POST', `/wallet/payments/${id}/confirm`, { checkoutToken: 'xxxxxxxxxxxx', outcome: 'success' }],
      ['GET', '/wallet/payments'], ['GET', `/wallet/payments/${id}/invoice`],
      ['POST', '/wallet/payouts', { amountCredits: 500, method: { type: 'upi', vpa: 'a@okbank' } }], ['GET', '/wallet/payouts'],
    ];
    for (const [m, url, body] of calls) {
      const r = await u.request(m, url, body);
      expect(r.status, `${m} ${url}`).toBe(410);
      expect(r.body.error).toMatchObject({ code: 'fiat_disabled', message: 'StringMind uses IDLE Tokens only — they cannot be bought or withdrawn.' });
    }
    const wh = await app.inject({ method: 'POST', url: '/wallet/webhooks/stripe', payload: '{}', headers: { 'content-type': 'application/json' } });
    expect(wh.statusCode).toBe(410);
    // non-fiat wallet endpoints keep working
    expect((await u.request('GET', '/wallet')).status).toBe(200);
    expect((await u.request('GET', '/wallet/transactions')).status).toBe(200);
    expect((await u.request('GET', '/wallet/earnings')).status).toBe(200);
  });

  it('admin payment/payout endpoints answer 410; wallet views + reconcile stay; overview has no INR', async () => {
    const a = await loginAdmin();
    const id = '00000000-0000-4000-8000-000000000000';
    for (const [m, url] of [['GET', '/admin/payments'], ['POST', `/admin/payments/${id}/refund`], ['GET', '/admin/payouts'], ['POST', `/admin/payouts/${id}/approve`]] as const) {
      const r = await a.request(m, url, {});
      expect(r.status, `${m} ${url}`).toBe(410);
      expect(r.body.error.code).toBe('fiat_disabled');
    }
    const ws = await a.request('GET', '/admin/wallets');
    expect(ws.status).toBe(200);
    const rc = await a.request('GET', `/admin/wallets/${ws.body.items[0].id}/reconcile`);
    expect(rc.status).toBe(200);
    expect(rc.body.ok).toBe(true);
    const ov = await a.request('GET', '/admin/overview');
    expect(ov.status).toBe(200);
    expect(JSON.stringify(ov.body)).not.toMatch(/INR|amountMinor/);
    expect(ov.body.tokens).toMatchObject({ currency: 'IDLE' });
    expect(ov.body.tokens.welcomeBonusesGranted).toBeGreaterThan(0);
    // non-admins still get 403 (admin guard runs before the fiat switch)
    const u = await createUserDirect();
    expect((await u.request('GET', '/admin/payments')).status).toBe(403);
  });
});

describe('purchases (dormant fiat path, FIAT_ENABLED=true)', () => {
  beforeAll(() => { config.FIAT_ENABLED = true; });
  afterAll(() => { config.FIAT_ENABLED = false; });

  it('posts tokens exactly once even if confirm is called twice', async () => {
    const u = await createUserDirect();
    const pay = await buyStarter(u);
    expect(pay.status).toBe('created');
    expect(pay.checkoutToken).toBeTruthy();
    expect(pay.taxMinor).toBe(18000);
    expect(pay.totalMinor).toBe(118000);
    const c1 = await u.request('POST', `/wallet/payments/${pay.id}/confirm`, { checkoutToken: pay.checkoutToken, outcome: 'success' });
    const c2 = await u.request('POST', `/wallet/payments/${pay.id}/confirm`, { checkoutToken: pay.checkoutToken, outcome: 'success' });
    expect(c1.status).toBe(200); expect(c2.status).toBe(200);
    expect(c1.body.status).toBe('succeeded');
    const w = await u.request('GET', '/wallet');
    expect(w.body.available).toBe(1000);
    expect((await wallet(u.orgId)).purchasedTotal).toBe(1000);
    const txs = await u.request('GET', '/wallet/transactions?type=purchase');
    expect(txs.body.total).toBe(1);
    expect(txs.body.items[0].amount).toBe(1000);
    const inv = await u.request('GET', `/wallet/payments/${pay.id}/invoice`);
    expect(inv.status).toBe(200);
    expect(inv.body.number).toMatch(/^AIX-INV-\d{6}-\d{5}$/);
    expect(inv.body.tax.amountMinor).toBe(18000);
    expect(inv.body.totalMinor).toBe(118000);
  });

  it('failed payment posts nothing; bad token rejected', async () => {
    const u = await createUserDirect();
    const pay = await buyStarter(u);
    expect((await u.request('POST', `/wallet/payments/${pay.id}/confirm`, { checkoutToken: 'wrong-token-xxxxxxxx', outcome: 'success' })).status).toBe(403);
    const f = await u.request('POST', `/wallet/payments/${pay.id}/confirm`, { checkoutToken: pay.checkoutToken, outcome: 'fail' });
    expect(f.body.status).toBe('failed');
    expect((await u.request('POST', `/wallet/payments/${pay.id}/confirm`, { checkoutToken: pay.checkoutToken, outcome: 'success' })).status).toBe(409);
    expect((await u.request('GET', '/wallet')).body.available).toBe(0);
    expect((await u.request('GET', `/wallet/payments/${pay.id}/invoice`)).status).toBe(409);
  });

  it('flags repeated failed payments', async () => {
    const u = await createUserDirect();
    for (let i = 0; i < 3; i++) {
      const pay = await buyStarter(u);
      await u.request('POST', `/wallet/payments/${pay.id}/confirm`, { checkoutToken: pay.checkoutToken, outcome: 'fail' });
    }
    const flags = await database.select().from(schema.fraudFlags).where(and(eq(schema.fraudFlags.targetId, u.orgId), eq(schema.fraudFlags.rule, 'repeated_failed_payments')));
    expect(flags).toHaveLength(1);
  });

  it('refundPayment reverses unspent tokens and refuses once spent', async () => {
    const u = await createUserDirect();
    const pay = await buyStarter(u);
    await u.request('POST', `/wallet/payments/${pay.id}/confirm`, { checkoutToken: pay.checkoutToken, outcome: 'success' });
    await refundPayment(pay.id, admin.userId);
    expect((await wallet(u.orgId)).available).toBe(0);
    await refundPayment(pay.id, admin.userId); // idempotent
    expect((await wallet(u.orgId)).available).toBe(0);

    const pay2 = await buyStarter(u);
    await u.request('POST', `/wallet/payments/${pay2.id}/confirm`, { checkoutToken: pay2.checkoutToken, outcome: 'success' });
    const t = await createUserDirect();
    const s = await session(u, t, 600);
    await escrowTraining(s.id);
    await expect(refundPayment(pay2.id, admin.userId)).rejects.toMatchObject({ status: 409 });
  });

  it('IDLE earnings are never withdrawable: payouts are refused', async () => {
    const l = await createUserDirect(); const t = await createUserDirect();
    await fund(l, 2000);
    const s = await session(l, t, 1000);
    await escrowTraining(s.id); await settleTraining(s.id, { outcome: 'release' });
    expect((await wallet(t.orgId))).toMatchObject({ available: 800, withdrawable: 0 });
    expect((await t.request('POST', '/wallet/payouts', { amountCredits: 100, method: { type: 'upi', vpa: 'trainer@okbank' } })).status).toBe(400);
    expect((await t.request('POST', '/wallet/payouts', { amountCredits: 500, method: { type: 'upi', vpa: 'trainer@okbank' } })).status).toBe(402);
    expect((await l.request('POST', '/wallet/payouts', { amountCredits: 500, method: { type: 'upi', vpa: 'learner@okbank' } })).status).toBe(402);
    expect((await wallet(t.orgId))).toMatchObject({ available: 800, locked: 0, withdrawable: 0 });
  });

  it('webhooks for unconfigured providers return 503 and unknown providers 404', async () => {
    const r = await app.inject({ method: 'POST', url: '/wallet/webhooks/stripe', payload: '{}', headers: { 'content-type': 'application/json' } });
    expect(r.statusCode).toBe(503);
    const r2 = await app.inject({ method: 'POST', url: '/wallet/webhooks/paypal', payload: '{}', headers: { 'content-type': 'application/json' } });
    expect(r2.statusCode).toBe(404);
  });

  it('tenant isolation for payments', async () => {
    const a = await createUserDirect(); const b = await createUserDirect();
    const pay = await buyStarter(a);
    expect((await b.request('POST', `/wallet/payments/${pay.id}/confirm`, { checkoutToken: pay.checkoutToken, outcome: 'success' })).status).toBe(404);
    expect((await b.request('GET', `/wallet/payments/${pay.id}/invoice`)).status).toBe(404);
    expect((await b.request('GET', '/wallet/payments')).body.total).toBe(0);
    const viewer = await createUserDirect({ role: 'viewer' });
    expect((await viewer.request('POST', '/wallet/purchase', { packageId: pay.packageId })).status).toBe(403);
  });
});

describe('training escrow & settlement', () => {
  it('escrow fails with 402 when funds are insufficient; 0 fee is a no-op', async () => {
    const l = await createUserDirect(); const t = await createUserDirect();
    const s = await session(l, t, 1000);
    await expect(escrowTraining(s.id)).rejects.toMatchObject({ status: 402, code: 'insufficient_funds' });
    const free = await session(l, t, 0);
    expect(await escrowTraining(free.id)).toEqual({ transactionId: '' });
    const [row] = await database.select().from(schema.trainingSessions).where(eq(schema.trainingSessions.id, free.id));
    expect(row!.settlementStatus).toBe('none');
  });

  it('release: 1000 IDLE fee at 20% → 800 trainer (available), 200 platform commission; idempotent', async () => {
    const l = await createUserDirect(); const t = await createUserDirect();
    await fund(l, 1500);
    const s = await session(l, t, 1000);
    const e1 = await escrowTraining(s.id);
    const e2 = await escrowTraining(s.id);
    expect(e2.transactionId).toBe(e1.transactionId);
    let lw = await wallet(l.orgId);
    expect(lw.available).toBe(500); expect(lw.locked).toBe(1000);
    const rev0 = await platformRevenue();
    const r1 = await settleTraining(s.id, { outcome: 'release' });
    const r2 = await settleTraining(s.id, { outcome: 'release' });
    expect(r2.transactionId).toBe(r1.transactionId);
    lw = await wallet(l.orgId);
    const tw = await wallet(t.orgId);
    expect(lw.locked).toBe(0); expect(lw.available).toBe(500); expect(lw.spentTotal).toBe(1000);
    expect(tw.available).toBe(800); expect(tw.earnedTotal).toBe(800); expect(tw.withdrawable).toBe(0);
    expect((await platformRevenue()) - rev0).toBe(200);
    const [row] = await database.select().from(schema.trainingSessions).where(eq(schema.trainingSessions.id, s.id));
    expect(row).toMatchObject({ settlementStatus: 'settled', commissionCredits: 200, trainerEarningsCredits: 800, settlementTxId: r1.transactionId });
    const earn = await t.request('GET', '/wallet/earnings');
    expect(earn.body.totalEarned).toBe(800);
    expect(earn.body.bySource[0]).toMatchObject({ earned: 800, sessions: 1 });
    expect(earn.body.byMonth[0]).toMatchObject({ earned: 800, sessions: 1 });
    expect(earn.body.recent[0]).toMatchObject({ type: 'training_settlement', amount: 800 });
    // the learner did not earn anything
    expect((await l.request('GET', '/wallet/earnings')).body.byMonth).toEqual([]);
  });

  it('refund path returns the full fee to the learner', async () => {
    const l = await createUserDirect(); const t = await createUserDirect();
    await fund(l, 1000);
    const s = await session(l, t, 1000);
    await escrowTraining(s.id);
    await settleTraining(s.id, { outcome: 'refund' });
    const lw = await wallet(l.orgId);
    expect(lw.available).toBe(1000); expect(lw.locked).toBe(0); expect(lw.refundedTotal).toBe(1000);
    expect((await wallet(t.orgId)).available).toBe(0);
    const [row] = await database.select().from(schema.trainingSessions).where(eq(schema.trainingSessions.id, s.id));
    expect(row!.settlementStatus).toBe('refunded');
  });

  it('self-dealing (shared member) holds release and raises a fraud flag; refund still allowed', async () => {
    const l = await createUserDirect();
    await fund(l, 1000);
    const s = await session(l, l, 1000);
    await escrowTraining(s.id);
    await expect(settleTraining(s.id, { outcome: 'release' })).rejects.toMatchObject({ status: 409, code: 'settlement_held' });
    const flags = await database.select().from(schema.fraudFlags).where(and(eq(schema.fraudFlags.targetId, s.id), eq(schema.fraudFlags.rule, 'self_dealing')));
    expect(flags).toHaveLength(1);
    expect((await wallet(l.orgId)).locked).toBe(1000);
    await settleTraining(s.id, { outcome: 'refund' });
    expect((await wallet(l.orgId)).available).toBe(1000);
  });
});

describe('commission rules', () => {
  it('org > domain > global > default', async () => {
    const o = await createUserDirect(); const other = await createUserDirect();
    expect(await getCommissionBps({ orgId: o.orgId, domainId })).toBe(2000);
    const [dr] = await database.insert(schema.commissionRules).values({ scope: 'domain', scopeId: domainId, rateBps: 1000 }).returning();
    const [or] = await database.insert(schema.commissionRules).values({ scope: 'org', scopeId: o.orgId, rateBps: 500 }).returning();
    expect(await getCommissionBps({ orgId: o.orgId, domainId })).toBe(500);
    expect(await getCommissionBps({ orgId: other.orgId, domainId })).toBe(1000);
    expect(await getCommissionBps({ orgId: other.orgId, domainId: null })).toBe(2000);
    await database.update(schema.commissionRules).set({ active: false }).where(eq(schema.commissionRules.id, or!.id));
    expect(await getCommissionBps({ orgId: o.orgId, domainId })).toBe(1000);
    await database.update(schema.commissionRules).set({ active: false }).where(eq(schema.commissionRules.id, dr!.id));
  });
});

describe('disputes', () => {
  it('open dispute blocks release; partial resolution splits correctly', async () => {
    const l = await createUserDirect(); const t = await createUserDirect(); const outsider = await createUserDirect();
    await fund(l, 1000);
    const s = await session(l, t, 1000);
    await escrowTraining(s.id);
    expect((await outsider.request('POST', '/disputes', { sessionId: s.id, reason: 'not mine' })).status).toBe(404);
    const d = await l.request('POST', '/disputes', { sessionId: s.id, reason: 'Trainer did not deliver', details: 'x' });
    expect(d.status).toBe(201);
    expect((await l.request('POST', '/disputes', { sessionId: s.id, reason: 'again' })).status).toBe(409);
    const [row] = await database.select().from(schema.trainingSessions).where(eq(schema.trainingSessions.id, s.id));
    expect(row).toMatchObject({ status: 'disputed', settlementStatus: 'disputed' });
    await expect(settleTraining(s.id, { outcome: 'release' })).rejects.toMatchObject({ status: 409, code: 'dispute_open' });
    expect((await t.request('GET', '/disputes')).body.total).toBe(1);
    expect((await outsider.request('GET', `/disputes/${d.body.id}`)).status).toBe(404);

    const rev0 = await platformRevenue();
    const res = await resolveDispute(d.body.id, { outcome: 'partial', refundCredits: 300, resolution: 'Half delivered', actorUserId: admin.userId });
    expect(res.status).toBe('resolved_partial');
    expect((await wallet(l.orgId))).toMatchObject({ available: 300, locked: 0 });
    expect((await wallet(t.orgId)).available).toBe(560);
    expect((await platformRevenue()) - rev0).toBe(140);
    const [after] = await database.select().from(schema.trainingSessions).where(eq(schema.trainingSessions.id, s.id));
    expect(after).toMatchObject({ status: 'completed', settlementStatus: 'settled' });
    // learner's partial refund is not counted as earnings; trainer's share is
    expect((await l.request('GET', '/wallet/earnings')).body.byMonth).toEqual([]);
    expect((await t.request('GET', '/wallet/earnings')).body.byMonth[0].earned).toBe(560);
  });

  it('dispute after release claws back from trainer available and platform; window enforced', async () => {
    const l = await createUserDirect(); const t = await createUserDirect();
    await fund(l, 1000);
    const s = await session(l, t, 1000);
    await escrowTraining(s.id); await settleTraining(s.id, { outcome: 'release' });
    expect((await wallet(t.orgId)).available).toBe(800);
    const d = await t.request('POST', '/disputes', { sessionId: s.id, reason: 'Learner misuse' });
    await resolveDispute(d.body.id, { outcome: 'refund', resolution: 'Full refund', actorUserId: admin.userId });
    expect((await wallet(l.orgId)).available).toBe(1000);
    expect((await wallet(t.orgId))).toMatchObject({ available: 0, earnedTotal: 0 });
    const earn = (await t.request('GET', '/wallet/earnings')).body;
    expect(earn.byMonth.reduce((a: number, m: { earned: number }) => a + m.earned, 0)).toBe(0);
    const old = await session(l, t, 0, { endedAt: new Date(Date.now() - 15 * 86400_000) });
    expect((await l.request('POST', '/disputes', { sessionId: old.id, reason: 'too late' })).status).toBe(422);
  });

  it('clawback fails with 402 when the trainer already spent the earnings', async () => {
    const l = await createUserDirect(); const t = await createUserDirect(); const other = await createUserDirect();
    await fund(l, 1000);
    const s = await session(l, t, 1000);
    await escrowTraining(s.id); await settleTraining(s.id, { outcome: 'release' });
    const spend = await session(t, other, 800);
    await escrowTraining(spend.id); // trainer spends its 800 IDLE earnings
    const d = await l.request('POST', '/disputes', { sessionId: s.id, reason: 'Not delivered' });
    await expect(resolveDispute(d.body.id, { outcome: 'refund', resolution: 'Full refund', actorUserId: admin.userId })).rejects.toMatchObject({ status: 402 });
    expect((await wallet(l.orgId)).available).toBe(0);
  });
});

describe('ledger integrity', () => {
  it('ledger entries are immutable', async () => {
    await expect(database.execute(sql`UPDATE ledger_entries SET amount = amount + 1`)).rejects.toThrow(/append-only/);
    await expect(database.execute(sql`DELETE FROM ledger_entries`)).rejects.toThrow(/append-only/);
  });

  it('DB rejects an unbalanced transaction at commit', async () => {
    const u = await createUserDirect();
    const w = await wallet(u.orgId);
    const before = (await database.select({ n: sql<number>`count(*)::int` }).from(schema.ledgerEntries))[0]!.n;
    await expect(database.transaction(async (tx) => {
      const [t] = await tx.insert(schema.transactions).values({ type: 'adjustment', idempotencyKey: `bad:${Date.now()}`, amount: 100 }).returning();
      await tx.insert(schema.ledgerEntries).values({ transactionId: t!.id, walletId: w.id, bucket: 'available', amount: 100 });
    })).rejects.toThrow(/unbalanced/);
    const after = (await database.select({ n: sql<number>`count(*)::int` }).from(schema.ledgerEntries))[0]!.n;
    expect(after).toBe(before);
  });

  it('knowledge purchase splits price with commission (seller IDLE is spendable); free listing gives licence without tx', async () => {
    const buyer = await createUserDirect(); const seller = await createUserDirect();
    await fund(buyer, 500);
    const [src] = await database.insert(schema.knowledgeSources).values({ orgId: seller.orgId, ownerId: seller.userId, name: 'src', type: 'text' }).returning();
    const mk = async (price: number) => (await database.insert(schema.knowledgeListings).values({
      sourceId: src!.id, orgId: seller.orgId, contributorId: seller.userId, title: 'KB', category: 'docs', licence: 'cc-by', ownershipAttested: true, priceCredits: price, moderation: 'approved',
    }).returning())[0]!;
    const paid = await mk(300);
    const r1 = await purchaseKnowledge({ listingId: paid.id, buyerOrgId: buyer.orgId, buyerUserId: buyer.userId });
    const r2 = await purchaseKnowledge({ listingId: paid.id, buyerOrgId: buyer.orgId, buyerUserId: buyer.userId });
    expect(r2).toEqual(r1);
    expect((await wallet(buyer.orgId)).available).toBe(200);
    expect((await wallet(seller.orgId))).toMatchObject({ available: 240, withdrawable: 0, earnedTotal: 240 });
    const earn = (await seller.request('GET', '/wallet/earnings')).body;
    expect(earn.bySource.find((x: { name: string }) => x.name === 'Knowledge sales')).toMatchObject({ earned: 240 });
    expect((await buyer.request('GET', '/wallet/earnings')).body.byMonth).toEqual([]);
    const free = await mk(0);
    const r3 = await purchaseKnowledge({ listingId: free.id, buyerOrgId: buyer.orgId, buyerUserId: buyer.userId });
    expect(r3.transactionId).toBeNull(); expect(r3.licenceId).toBeTruthy();
    await expect(purchaseKnowledge({ listingId: paid.id, buyerOrgId: seller.orgId, buyerUserId: seller.userId })).rejects.toMatchObject({ status: 400 });
  });

  it('tenant isolation: cannot read another org wallet', async () => {
    const a = await createUserDirect(); const b = await createUserDirect();
    await fund(a, 777);
    expect((await b.request('GET', '/wallet')).body.available).toBe(0);
    const orig = b.orgId; b.orgId = a.orgId;
    expect((await b.request('GET', '/wallet')).status).toBe(403);
    b.orgId = orig;
  });

  it('reconcile is ok for every wallet after all operations (incl. welcome bonuses)', async () => {
    const ws = await database.select().from(schema.wallets);
    expect(ws.length).toBeGreaterThan(5);
    for (const w of ws) {
      const r = await reconcile(w.id);
      expect(r.ok, `wallet ${w.id} ${JSON.stringify(r)}`).toBe(true);
    }
    // whole system nets to zero
    const [{ s }] = await database.select({ s: sql<string>`coalesce(sum(amount),0)` }).from(schema.ledgerEntries);
    expect(Number(s)).toBe(0);
    // every welcome bonus is a single balanced external → org available transaction of 1000 IDLE
    const bonuses = await database.execute(sql`select t.id, sum(le.amount)::int as net, count(*)::int as legs, max(le.amount)::int as credit
      from transactions t join ledger_entries le on le.transaction_id = t.id where t.type = 'welcome_bonus' group by t.id`);
    const rows = ((bonuses as { rows?: unknown[] }).rows ?? bonuses) as { net: number; legs: number; credit: number }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r).toMatchObject({ net: 0, legs: 2, credit: 1000 });
  });
});
