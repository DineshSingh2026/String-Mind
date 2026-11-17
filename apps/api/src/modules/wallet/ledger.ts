/**
 * StringMind double-entry ledger service — the ONLY code allowed to change wallet balances.
 *
 * Accounting model
 * ────────────────
 * Every balance change is a `transactions` row + ≥2 `ledger_entries` rows whose amounts sum to 0
 * (enforced again at COMMIT by a deferred DB constraint trigger), plus an update of the cached
 * wallet columns — all in ONE database transaction. Ledger entries are append-only (DB trigger);
 * corrections are new transactions (`reversalOf`). Every operation has a deterministic
 * idempotency key (unique index on transactions.idempotency_key) so retries never double-post.
 *
 * Unit: IDLE Tokens (docs/IDLE_TOKENS.md). StringMind is a pure token economy — IDLE is never money.
 *
 * Buckets (ledger_entries.bucket) → cached column:
 *   org wallet       available    → wallets.available     spendable IDLE (welcome bonus, earnings, refunds)
 *                    locked       → wallets.locked        escrow for training (+ payouts in flight, fiat mode only)
 *                    withdrawable → wallets.withdrawable  LEGACY: earnings before the IDLE switch; only the dormant
 *                                                         FIAT_ENABLED payout path reads it. Nothing new lands here.
 *   platform wallet  revenue      → wallets.available     StringMind platform commission (IDLE)
 *   external wallet  external     → wallets.available     issuance counterparty (goes negative as IDLE is minted)
 *
 * Policy: earnings (training settlement, knowledge sales) land in `available` and are immediately
 * spendable; spending (training fees, knowledge purchases) uses `available` only. The welcome bonus
 * (WELCOME_BONUS_IDLE, once per user) is minted external → org available.
 * Org/platform buckets can never go negative (checked under SELECT … FOR UPDATE).
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { DEFAULT_COMMISSION_BPS, MIN_PAYOUT_CREDITS, WELCOME_BONUS_IDLE } from '@aix/shared';
import { db, rowsOf, schema, type DbOrTx, type Tx } from '../../db/client.js';
import { AppError, badRequest, conflict, insufficientFunds, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { notify, notifyOrg } from '../../lib/notify.js';
import { encrypt } from '../../lib/crypto.js';
import { checkFraud } from './fraud.js';
import { getProvider, nextInvoiceNumber } from './payments.js';

export type Wallet = typeof schema.wallets.$inferSelect;
export type Bucket = 'available' | 'locked' | 'withdrawable' | 'revenue' | 'external';
type TotalKey = 'purchasedTotal' | 'earnedTotal' | 'spentTotal' | 'refundedTotal';

const PLATFORM_ORG_SLUG = 'aix-platform';
const BUCKET_COLUMN: Record<Bucket, 'available' | 'locked' | 'withdrawable'> = {
  available: 'available', locked: 'locked', withdrawable: 'withdrawable', revenue: 'available', external: 'available',
};
const BUCKETS_BY_KIND: Record<string, Bucket[]> = {
  org: ['available', 'locked', 'withdrawable'], platform: ['revenue'], external: ['external'],
};

/* ───────────────────────────── primitives ───────────────────────────── */

/** Run `fn` in the caller's transaction if given, else in a new one. */
async function withTx<T>(outer: DbOrTx | undefined, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (outer) return fn(outer as Tx);
  return db().transaction(fn);
}

export async function getOrCreateWallet(orgId: string, tx?: DbOrTx): Promise<Wallet> {
  const q = tx ?? db();
  await q.insert(schema.wallets).values({ orgId, kind: 'org' }).onConflictDoNothing();
  const [w] = await q.select().from(schema.wallets).where(and(eq(schema.wallets.orgId, orgId), eq(schema.wallets.kind, 'org'))).limit(1);
  if (!w) throw notFound('Wallet');
  return w;
}

async function platformWallets(q: DbOrTx): Promise<{ platform: Wallet; external: Wallet }> {
  const rows = await q.select({ w: schema.wallets }).from(schema.wallets)
    .innerJoin(schema.organisations, eq(schema.organisations.id, schema.wallets.orgId))
    .where(eq(schema.organisations.slug, PLATFORM_ORG_SLUG));
  const platform = rows.find((r) => r.w.kind === 'platform')?.w;
  const external = rows.find((r) => r.w.kind === 'external')?.w;
  if (!platform || !external) throw new AppError(500, 'platform_wallets_missing', 'Platform wallets are not seeded');
  return { platform, external };
}

interface Leg { walletId: string; bucket: Bucket; amount: number; totals?: Partial<Record<TotalKey, number>> }
interface PostInput {
  type: string; idempotencyKey: string; orgId?: string | null; referenceType?: string | null; referenceId?: string | null;
  description?: string; createdBy?: string | null; reversalOf?: string | null; legs: Leg[];
}

/**
 * Post a balanced transaction. Returns `created:false` (and the existing id) if the idempotency key
 * was already used — the caller must then treat the operation as already done.
 */
async function post(tx: Tx, p: PostInput): Promise<{ id: string; created: boolean }> {
  for (const l of p.legs) if (!Number.isSafeInteger(l.amount)) throw new AppError(500, 'ledger_invalid_amount', 'Ledger amounts must be integers');
  const sum = p.legs.reduce((s, l) => s + l.amount, 0);
  if (sum !== 0) throw new AppError(500, 'ledger_unbalanced', `Refusing to post unbalanced transaction (sum=${sum})`);
  const gross = p.legs.filter((l) => l.amount > 0).reduce((s, l) => s + l.amount, 0);
  if (gross <= 0) throw new AppError(500, 'ledger_empty', 'Refusing to post an empty transaction');

  const [row] = await tx.insert(schema.transactions).values({
    type: p.type, orgId: p.orgId ?? null, referenceType: p.referenceType ?? null, referenceId: p.referenceId ?? null,
    idempotencyKey: p.idempotencyKey, description: p.description ?? '', amount: gross, createdBy: p.createdBy ?? null,
    reversalOf: p.reversalOf ?? null,
  }).onConflictDoNothing({ target: schema.transactions.idempotencyKey }).returning();
  if (!row) {
    const [ex] = await tx.select({ id: schema.transactions.id }).from(schema.transactions)
      .where(eq(schema.transactions.idempotencyKey, p.idempotencyKey)).limit(1);
    return { id: ex!.id, created: false };
  }

  // Lock affected wallets in a stable order (deadlock avoidance), then validate + apply.
  const ids = [...new Set(p.legs.map((l) => l.walletId))].sort();
  const locked = await tx.select().from(schema.wallets).where(inArray(schema.wallets.id, ids)).orderBy(asc(schema.wallets.id)).for('update');
  const byId = new Map(locked.map((w) => [w.id, { ...w }]));
  for (const l of p.legs) {
    const w = byId.get(l.walletId);
    if (!w) throw new AppError(500, 'wallet_missing', `Wallet ${l.walletId} not found`);
    if (!BUCKETS_BY_KIND[w.kind]?.includes(l.bucket)) throw new AppError(500, 'ledger_bad_bucket', `Bucket ${l.bucket} invalid for ${w.kind} wallet`);
    w[BUCKET_COLUMN[l.bucket]] += l.amount;
    for (const [k, v] of Object.entries(l.totals ?? {}) as [TotalKey, number][]) w[k] += v;
  }
  for (const w of byId.values()) {
    if (w.kind === 'external') continue;
    for (const col of ['available', 'locked', 'withdrawable'] as const) {
      if (w[col] < 0) {
        const bucket = w.kind === 'platform' ? 'revenue' : col;
        throw insufficientFunds(`Insufficient ${bucket} IDLE for this operation`);
      }
    }
  }
  const entries = p.legs.filter((l) => l.amount !== 0).map((l) => ({ transactionId: row.id, walletId: l.walletId, bucket: l.bucket, amount: l.amount }));
  await tx.insert(schema.ledgerEntries).values(entries);
  for (const w of byId.values()) {
    await tx.update(schema.wallets).set({
      available: w.available, locked: w.locked, withdrawable: w.withdrawable, purchasedTotal: w.purchasedTotal,
      earnedTotal: w.earnedTotal, spentTotal: w.spentTotal, refundedTotal: w.refundedTotal, updatedAt: new Date(),
    }).where(eq(schema.wallets.id, w.id));
  }
  return { id: row.id, created: true };
}

const sys = (actorUserId?: string | null) => (actorUserId ? 'user' : 'system') as 'user' | 'system';

/* ───────────────────────────── commission ───────────────────────────── */

/** Most specific active rule wins: org > domain > global > DEFAULT_COMMISSION_BPS. Latest rule per scope. */
export async function getCommissionBps({ orgId, domainId }: { orgId: string; domainId?: string | null }, tx?: DbOrTx): Promise<number> {
  const q = tx ?? db();
  const rules = await q.select().from(schema.commissionRules).where(eq(schema.commissionRules.active, true)).orderBy(desc(schema.commissionRules.createdAt));
  const org = rules.find((r) => r.scope === 'org' && r.scopeId === orgId);
  if (org) return org.rateBps;
  const dom = domainId ? rules.find((r) => r.scope === 'domain' && r.scopeId === domainId) : undefined;
  if (dom) return dom.rateBps;
  const glob = rules.find((r) => r.scope === 'global');
  return glob?.rateBps ?? DEFAULT_COMMISSION_BPS;
}

const commissionOf = (amount: number, bps: number) => Math.floor((amount * bps) / 10_000);

/* ───────────────────────────── training ───────────────────────────── */

async function lockSession(tx: Tx, sessionId: string) {
  const [s] = await tx.select().from(schema.trainingSessions).where(eq(schema.trainingSessions.id, sessionId)).for('update');
  if (!s) throw notFound('Training session');
  return s;
}

export async function hasOpenDispute(sessionId: string, tx?: DbOrTx) {
  const [d] = await (tx ?? db()).select({ id: schema.disputes.id }).from(schema.disputes)
    .where(and(eq(schema.disputes.sessionId, sessionId), inArray(schema.disputes.status, ['open', 'under_review']))).limit(1);
  return !!d;
}

/**
 * Learner org available → locked for session.feeCredits. Locks in the commission rate at escrow time
 * (rule for trainer org / session domain). Fee 0 ⇒ no-op ({transactionId:''}, settlementStatus stays 'none').
 * Idempotent (key `escrow:<sessionId>`). Throws 402 insufficient_funds.
 */
export async function escrowTraining(sessionId: string, tx?: DbOrTx): Promise<{ transactionId: string }> {
  return withTx(tx, async (t) => {
    const s = await lockSession(t, sessionId);
    if (s.settlementStatus !== 'none') return { transactionId: s.escrowTxId ?? '' };
    if (!s.feeCredits || s.feeCredits <= 0) return { transactionId: '' };
    const w = await getOrCreateWallet(s.learnerOrgId, t);
    const bps = await getCommissionBps({ orgId: s.trainerOrgId, domainId: s.domainId }, t);
    const r = await post(t, {
      type: 'training_escrow', idempotencyKey: `escrow:${sessionId}`, orgId: s.learnerOrgId,
      referenceType: 'training_session', referenceId: sessionId, description: `Escrow for training: ${s.subject}`,
      legs: [{ walletId: w.id, bucket: 'available', amount: -s.feeCredits }, { walletId: w.id, bucket: 'locked', amount: s.feeCredits }],
    });
    await t.update(schema.trainingSessions).set({ escrowTxId: r.id, settlementStatus: 'escrowed', commissionRateBps: bps, updatedAt: new Date() })
      .where(eq(schema.trainingSessions.id, sessionId));
    if (r.created) await audit({ action: 'wallet.training_escrow', targetType: 'training_session', targetId: sessionId, orgId: s.learnerOrgId, actorType: 'system', metadata: { transactionId: r.id, amount: s.feeCredits, commissionBps: bps } }, null, t);
    return { transactionId: r.id };
  });
}

export interface SettleOpts {
  outcome: 'release' | 'refund' | 'partial'; refundCredits?: number; actorUserId?: string;
  /** Internal: set by dispute resolution (admin). Bypasses the open-dispute freeze and self-dealing hold. */
  viaDispute?: boolean;
  /** Admin override after reviewing a self-dealing fraud flag. */
  adminOverride?: boolean;
}

/**
 * Settle an escrowed session. release: locked → trainer available (fee − commission, spendable IDLE) + platform revenue (commission).
 * refund: locked → learner available. partial: refundCredits → learner, remainder split trainer/commission.
 * Idempotent (key `settle:<sessionId>`). Frozen while a dispute is open (409 dispute_open) unless via dispute resolution.
 * Self-dealing (learner & trainer orgs share a member) ⇒ fraud flag + 409 settlement_held for release/partial.
 */
export async function settleTraining(sessionId: string, opts: SettleOpts, tx?: DbOrTx): Promise<{ transactionId: string }> {
  // A held settlement returns a marker from the DB tx so the fraud flag COMMITS, then we throw.
  const res = await withTx(tx, async (t): Promise<{ transactionId: string; held?: boolean }> => {
    const s = await lockSession(t, sessionId);
    if (s.settlementStatus === 'settled' || s.settlementStatus === 'refunded') return { transactionId: s.settlementTxId ?? '' };
    const privileged = !!opts.viaDispute;
    if (!privileged && await hasOpenDispute(sessionId, t)) throw new AppError(409, 'dispute_open', 'Settlement is frozen while a dispute is open');

    const fee = s.feeCredits ?? 0;
    let refund = 0;
    if (opts.outcome === 'refund') refund = fee;
    else if (opts.outcome === 'partial') {
      refund = opts.refundCredits ?? -1;
      if (!Number.isSafeInteger(refund) || refund < 0 || refund > fee) throw badRequest(`refundCredits must be an integer between 0 and ${fee}`);
    }
    const paid = fee - refund;

    if (paid > 0 && !privileged && !opts.adminOverride) {
      const f = await checkFraud({ type: 'settlement', sessionId, learnerOrgId: s.learnerOrgId, trainerOrgId: s.trainerOrgId }, t);
      if (f.block) return { transactionId: '', held: true };
    }

    if (fee <= 0) {
      await t.update(schema.trainingSessions).set({ commissionCredits: 0, trainerEarningsCredits: 0, settlementStatus: opts.outcome === 'refund' ? 'refunded' : 'settled', updatedAt: new Date() })
        .where(eq(schema.trainingSessions.id, sessionId));
      return { transactionId: '' };
    }
    if (!s.escrowTxId || !['escrowed', 'disputed'].includes(s.settlementStatus)) throw conflict('Session fee has not been escrowed');

    const commission = commissionOf(paid, s.commissionRateBps);
    const trainerShare = paid - commission;
    const learner = await getOrCreateWallet(s.learnerOrgId, t);
    const trainer = await getOrCreateWallet(s.trainerOrgId, t);
    const { platform } = await platformWallets(t);
    const legs: Leg[] = [
      { walletId: learner.id, bucket: 'locked', amount: -fee, totals: { spentTotal: paid, refundedTotal: refund } },
      { walletId: learner.id, bucket: 'available', amount: refund },
      { walletId: trainer.id, bucket: 'available', amount: trainerShare, totals: { earnedTotal: trainerShare } },
      { walletId: platform.id, bucket: 'revenue', amount: commission },
    ];
    const type = opts.outcome === 'refund' ? (privileged ? 'dispute_refund' : 'training_refund') : 'training_settlement';
    const r = await post(t, {
      type, idempotencyKey: `settle:${sessionId}`, orgId: s.trainerOrgId, referenceType: 'training_session', referenceId: sessionId,
      description: `${opts.outcome === 'refund' ? 'Refund' : opts.outcome === 'partial' ? 'Partial settlement' : 'Settlement'} for training: ${s.subject}`,
      createdBy: opts.actorUserId ?? null, legs,
    });
    await t.update(schema.trainingSessions).set({
      commissionCredits: commission, trainerEarningsCredits: trainerShare, settlementStatus: refund === fee ? 'refunded' : 'settled',
      settlementTxId: r.id, updatedAt: new Date(),
    }).where(eq(schema.trainingSessions.id, sessionId));
    if (r.created) {
      await audit({ action: 'wallet.training_settle', targetType: 'training_session', targetId: sessionId, orgId: s.trainerOrgId, actorUserId: opts.actorUserId ?? null,
        actorType: opts.viaDispute || opts.adminOverride ? 'admin' : sys(opts.actorUserId), metadata: { transactionId: r.id, outcome: opts.outcome, fee, refund, commission, trainerShare } }, null, t);
      if (refund > 0) await notifyOrg(s.learnerOrgId, 'payment_update', `${fmtIdle(refund)} returned`, `Training "${s.subject}" refunded ${fmtIdle(refund)} to your wallet.`, '/wallet', t);
      if (trainerShare > 0) await notifyOrg(s.trainerOrgId, 'payment_update', `You earned ${fmtIdle(trainerShare)}`, `Training "${s.subject}" settled (${fmtIdle(commission)} platform commission).`, '/wallet/earnings', t);
    }
    return { transactionId: r.id };
  });
  if (res.held) throw new AppError(409, 'settlement_held', 'Settlement held for review: learner and trainer organisations share a member');
  return { transactionId: res.transactionId };
}

/**
 * Post-settlement dispute refund (reversal as a NEW transaction): pulls `refundCredits` back from the trainer's
 * available IDLE and platform revenue proportionally, credits learner available. 402 if the trainer already spent it.
 */
export async function clawbackTraining(sessionId: string, opts: { refundCredits: number; disputeId: string; actorUserId: string }, tx?: DbOrTx): Promise<{ transactionId: string }> {
  return withTx(tx, async (t) => {
    const s = await lockSession(t, sessionId);
    const commission = s.commissionCredits ?? 0;
    const earned = s.trainerEarningsCredits ?? 0;
    const paid = commission + earned;
    const r0 = opts.refundCredits;
    if (!Number.isSafeInteger(r0) || r0 < 0 || r0 > paid) throw badRequest(`refundCredits must be between 0 and ${paid}`);
    if (r0 === 0) return { transactionId: '' };
    const commissionBack = paid ? Math.floor((r0 * commission) / paid) : 0;
    const trainerBack = r0 - commissionBack;
    const learner = await getOrCreateWallet(s.learnerOrgId, t);
    const trainer = await getOrCreateWallet(s.trainerOrgId, t);
    const { platform } = await platformWallets(t);
    const r = await post(t, {
      type: 'dispute_refund', idempotencyKey: `dispute:${opts.disputeId}`, orgId: s.learnerOrgId, referenceType: 'dispute', referenceId: opts.disputeId,
      description: `Dispute refund for training: ${s.subject}`, createdBy: opts.actorUserId, reversalOf: s.settlementTxId,
      legs: [
        { walletId: trainer.id, bucket: 'available', amount: -trainerBack, totals: { earnedTotal: -trainerBack } },
        { walletId: platform.id, bucket: 'revenue', amount: -commissionBack },
        { walletId: learner.id, bucket: 'available', amount: r0, totals: { refundedTotal: r0, spentTotal: -r0 } },
      ],
    });
    if (r.created) {
      await t.update(schema.trainingSessions).set({
        commissionCredits: commission - commissionBack, trainerEarningsCredits: earned - trainerBack,
        settlementStatus: r0 === paid ? 'refunded' : 'settled', updatedAt: new Date(),
      }).where(eq(schema.trainingSessions.id, sessionId));
      await audit({ action: 'wallet.dispute_clawback', targetType: 'training_session', targetId: sessionId, actorUserId: opts.actorUserId, actorType: 'admin', metadata: { transactionId: r.id, refund: r0, commissionBack, trainerBack } }, null, t);
    }
    return { transactionId: r.id };
  });
}

/* ──────────────── purchases (dormant fiat path, FIAT_ENABLED only) ──────────────── */

/** Credit a succeeded payment: external → org available. Idempotent (payment row lock + key `purchase:<paymentId>`). */
export async function postPurchase(paymentId: string, tx?: DbOrTx): Promise<{ transactionId: string; created: boolean }> {
  return withTx(tx, async (t) => {
    const [p] = await t.select().from(schema.payments).where(eq(schema.payments.id, paymentId)).for('update');
    if (!p) throw notFound('Payment');
    if (p.status === 'succeeded' && p.transactionId) return { transactionId: p.transactionId, created: false };
    if (p.status !== 'created') throw conflict(`Payment is ${p.status}`);
    const w = await getOrCreateWallet(p.orgId, t);
    const { external } = await platformWallets(t);
    const r = await post(t, {
      type: 'purchase', idempotencyKey: `purchase:${paymentId}`, orgId: p.orgId, referenceType: 'payment', referenceId: paymentId,
      description: `Purchased ${p.credits} credits`, createdBy: p.userId,
      legs: [{ walletId: external.id, bucket: 'external', amount: -p.credits }, { walletId: w.id, bucket: 'available', amount: p.credits, totals: { purchasedTotal: p.credits } }],
    });
    const invoiceNumber = p.invoiceNumber ?? await nextInvoiceNumber(t);
    await t.update(schema.payments).set({ status: 'succeeded', transactionId: r.id, invoiceNumber, updatedAt: new Date() }).where(eq(schema.payments.id, paymentId));
    await audit({ action: 'wallet.purchase', targetType: 'payment', targetId: paymentId, orgId: p.orgId, actorUserId: p.userId, actorType: 'user', metadata: { transactionId: r.id, credits: p.credits, provider: p.provider, invoiceNumber } }, null, t);
    await notify(p.userId, 'payment_update', 'Payment successful', `${p.credits} credits were added to your wallet. Invoice ${invoiceNumber}.`, '/wallet', t);
    return { transactionId: r.id, created: r.created };
  });
}

/** Refund a purchase: reverses credits (org available → external) only if still unspent, else 409. */
export async function refundPayment(paymentId: string, actorUserId: string, tx?: DbOrTx): Promise<{ transactionId: string }> {
  return withTx(tx, async (t) => {
    const [p] = await t.select().from(schema.payments).where(eq(schema.payments.id, paymentId)).for('update');
    if (!p) throw notFound('Payment');
    if (p.status === 'refunded') {
      const [ex] = await t.select({ id: schema.transactions.id }).from(schema.transactions).where(eq(schema.transactions.idempotencyKey, `payment_refund:${paymentId}`));
      return { transactionId: ex?.id ?? '' };
    }
    if (p.status !== 'succeeded') throw conflict(`Only succeeded payments can be refunded (payment is ${p.status})`);
    const w = await getOrCreateWallet(p.orgId, t);
    const { external } = await platformWallets(t);
    const [cur] = await t.select().from(schema.wallets).where(eq(schema.wallets.id, w.id)).for('update');
    if (cur!.available < p.credits) throw new AppError(409, 'credits_spent', 'Purchased credits have already been spent and cannot be refunded');
    const r = await post(t, {
      type: 'purchase_refund', idempotencyKey: `payment_refund:${paymentId}`, orgId: p.orgId, referenceType: 'payment', referenceId: paymentId,
      description: `Refund of ${p.credits} purchased credits`, createdBy: actorUserId, reversalOf: p.transactionId,
      legs: [{ walletId: w.id, bucket: 'available', amount: -p.credits, totals: { purchasedTotal: -p.credits } }, { walletId: external.id, bucket: 'external', amount: p.credits }],
    });
    // Provider-side refund (no-op for sandbox). If it throws, the whole DB transaction rolls back.
    await getProvider(p.provider).refund?.(p);
    await t.update(schema.payments).set({ status: 'refunded', updatedAt: new Date() }).where(eq(schema.payments.id, paymentId));
    if (p.transactionId) await t.update(schema.transactions).set({ status: 'reversed' }).where(eq(schema.transactions.id, p.transactionId));
    await audit({ action: 'wallet.payment_refund', targetType: 'payment', targetId: paymentId, orgId: p.orgId, actorUserId, actorType: 'admin', metadata: { transactionId: r.id, credits: p.credits } }, null, t);
    await notify(p.userId, 'payment_update', 'Payment refunded', `Your payment was refunded and ${p.credits} credits were removed from your wallet.`, '/wallet', t);
    return { transactionId: r.id };
  });
}

/* ───────────────────────────── knowledge ───────────────────────────── */

/**
 * Buy a knowledge listing licence: buyer available → contributor org available (minus commission) + platform revenue.
 * Free listing ⇒ licence without transaction. Idempotent per (listing, buyer org).
 */
export async function purchaseKnowledge(
  { listingId, buyerOrgId, buyerUserId, agentId }: { listingId: string; buyerOrgId: string; buyerUserId: string; agentId?: string | null },
  tx?: DbOrTx,
): Promise<{ licenceId: string; transactionId: string | null }> {
  return withTx(tx, async (t) => {
    const [l] = await t.select().from(schema.knowledgeListings).where(eq(schema.knowledgeListings.id, listingId)).limit(1);
    if (!l || l.status !== 'active' || l.moderation === 'rejected') throw notFound('Knowledge listing');
    if (l.orgId === buyerOrgId) throw badRequest('You cannot buy your own listing');
    const [existing] = await t.select().from(schema.knowledgeLicences)
      .where(and(eq(schema.knowledgeLicences.listingId, listingId), eq(schema.knowledgeLicences.buyerOrgId, buyerOrgId))).limit(1);
    if (existing) return { licenceId: existing.id, transactionId: existing.transactionId };

    let transactionId: string | null = null;
    if (l.priceCredits > 0) {
      const bps = await getCommissionBps({ orgId: l.orgId, domainId: l.domainId }, t);
      const commission = commissionOf(l.priceCredits, bps);
      const buyer = await getOrCreateWallet(buyerOrgId, t);
      const seller = await getOrCreateWallet(l.orgId, t);
      const { platform } = await platformWallets(t);
      const r = await post(t, {
        type: 'knowledge_purchase', idempotencyKey: `knowledge:${listingId}:${buyerOrgId}`, orgId: buyerOrgId,
        referenceType: 'knowledge_listing', referenceId: listingId, description: `Knowledge licence: ${l.title}`, createdBy: buyerUserId,
        legs: [
          { walletId: buyer.id, bucket: 'available', amount: -l.priceCredits, totals: { spentTotal: l.priceCredits } },
          { walletId: seller.id, bucket: 'available', amount: l.priceCredits - commission, totals: { earnedTotal: l.priceCredits - commission } },
          { walletId: platform.id, bucket: 'revenue', amount: commission },
        ],
      });
      transactionId = r.id;
      await notifyOrg(l.orgId, 'payment_update', 'Knowledge sale', `"${l.title}" was licensed — you earned ${fmtIdle(l.priceCredits - commission)}.`, '/wallet/earnings', t);
    }
    const [lic] = await t.insert(schema.knowledgeLicences).values({ listingId, buyerOrgId, buyerUserId, agentId: agentId ?? null, transactionId }).returning();
    await audit({ action: 'wallet.knowledge_purchase', targetType: 'knowledge_listing', targetId: listingId, orgId: buyerOrgId, actorUserId: buyerUserId, actorType: 'user', metadata: { licenceId: lic!.id, transactionId, price: l.priceCredits } }, null, t);
    return { licenceId: lic!.id, transactionId };
  });
}

/* ──────────────── payouts (dormant fiat path, FIAT_ENABLED only; legacy withdrawable bucket) ──────────────── */

export type Payout = typeof schema.payouts.$inferSelect;
export type PayoutMethod = { type: 'bank'; accountName: string; accountNumber: string; ifsc: string } | { type: 'upi'; vpa: string };

/** Payout method is stored masked; full details encrypted at rest (AES-256-GCM). */
function protectMethod(m: PayoutMethod): Record<string, string> {
  const secret = m.type === 'bank' ? m.accountNumber : m.vpa;
  return {
    type: m.type, last4: secret.slice(-4), ...(m.type === 'bank' ? { accountName: m.accountName, ifsc: m.ifsc } : {}),
    enc: encrypt(JSON.stringify(m)),
  };
}
export const publicPayout = (p: Payout) => ({ ...p, method: Object.fromEntries(Object.entries(p.method).filter(([k]) => k !== 'enc')) });

/** withdrawable → locked (payout in flight). ≥ MIN_PAYOUT_CREDITS; 402 if exceeding withdrawable. Optional idempotencyKey. */
export async function requestPayout(
  { orgId, userId, amountCredits, method, idempotencyKey }: { orgId: string; userId: string; amountCredits: number; method: PayoutMethod; idempotencyKey?: string },
  tx?: DbOrTx,
): Promise<Payout> {
  if (!Number.isSafeInteger(amountCredits) || amountCredits < MIN_PAYOUT_CREDITS) throw badRequest(`Minimum payout is ${MIN_PAYOUT_CREDITS} credits`);
  const payout = await withTx(tx, async (t) => {
    const key = idempotencyKey ? `payout_request:${orgId}:${idempotencyKey}` : null;
    if (key) {
      const [ex] = await t.select().from(schema.transactions).where(eq(schema.transactions.idempotencyKey, key)).limit(1);
      if (ex?.referenceId) {
        const [p] = await t.select().from(schema.payouts).where(eq(schema.payouts.id, ex.referenceId));
        if (p) return p;
      }
    }
    const w = await getOrCreateWallet(orgId, t);
    const [p] = await t.insert(schema.payouts).values({ orgId, requestedBy: userId, amountCredits, method: protectMethod(method) }).returning();
    const r = await post(t, {
      type: 'payout_request', idempotencyKey: key ?? `payout_request:${p!.id}`, orgId, referenceType: 'payout', referenceId: p!.id,
      description: `Payout requested (${method.type})`, createdBy: userId,
      legs: [{ walletId: w.id, bucket: 'withdrawable', amount: -amountCredits }, { walletId: w.id, bucket: 'locked', amount: amountCredits }],
    });
    const [upd] = await t.update(schema.payouts).set({ requestTxId: r.id }).where(eq(schema.payouts.id, p!.id)).returning();
    await audit({ action: 'wallet.payout_request', targetType: 'payout', targetId: p!.id, orgId, actorUserId: userId, actorType: 'user', metadata: { amountCredits, method: method.type, transactionId: r.id } }, null, t);
    await notify(userId, 'payout_update', 'Payout requested', `Your payout of ${amountCredits} credits is awaiting review.`, '/wallet', t);
    await checkFraud({ type: 'payout_requested', orgId, payoutId: p!.id, amountCredits }, t);
    return upd!;
  });
  return payout;
}

async function lockPayout(t: Tx, payoutId: string) {
  const [p] = await t.select().from(schema.payouts).where(eq(schema.payouts.id, payoutId)).for('update');
  if (!p) throw notFound('Payout');
  return p;
}

export async function approvePayout(payoutId: string, actorUserId: string, note?: string, tx?: DbOrTx): Promise<Payout> {
  return withTx(tx, async (t) => {
    const p = await lockPayout(t, payoutId);
    if (p.status === 'approved') return p;
    if (p.status !== 'requested') throw conflict(`Payout is ${p.status}`);
    const [u] = await t.update(schema.payouts).set({ status: 'approved', reviewedBy: actorUserId, reviewNote: note ?? p.reviewNote, updatedAt: new Date() }).where(eq(schema.payouts.id, payoutId)).returning();
    await audit({ action: 'wallet.payout_approve', targetType: 'payout', targetId: payoutId, orgId: p.orgId, actorUserId, actorType: 'admin', metadata: { amountCredits: p.amountCredits } }, null, t);
    await notify(p.requestedBy, 'payout_update', 'Payout approved', `Your payout of ${p.amountCredits} credits was approved and will be paid shortly.`, '/wallet', t);
    return u!;
  });
}

/** locked → external (money leaves the system). Requires 'approved'. Idempotent. */
export async function markPayoutPaid(payoutId: string, actorUserId: string, providerRef?: string, tx?: DbOrTx): Promise<Payout> {
  return withTx(tx, async (t) => {
    const p = await lockPayout(t, payoutId);
    if (p.status === 'paid') return p;
    if (p.status !== 'approved') throw conflict(`Payout must be approved before it is paid (is ${p.status})`);
    const w = await getOrCreateWallet(p.orgId, t);
    const { external } = await platformWallets(t);
    const r = await post(t, {
      type: 'payout_paid', idempotencyKey: `payout_paid:${payoutId}`, orgId: p.orgId, referenceType: 'payout', referenceId: payoutId,
      description: `Payout paid${providerRef ? ` (ref ${providerRef})` : ''}`, createdBy: actorUserId,
      legs: [{ walletId: w.id, bucket: 'locked', amount: -p.amountCredits }, { walletId: external.id, bucket: 'external', amount: p.amountCredits }],
    });
    const [u] = await t.update(schema.payouts).set({ status: 'paid', settleTxId: r.id, updatedAt: new Date(), ...(providerRef ? { reviewNote: `paid ref ${providerRef}` } : {}) }).where(eq(schema.payouts.id, payoutId)).returning();
    await audit({ action: 'wallet.payout_paid', targetType: 'payout', targetId: payoutId, orgId: p.orgId, actorUserId, actorType: 'admin', metadata: { transactionId: r.id, amountCredits: p.amountCredits, providerRef } }, null, t);
    await notify(p.requestedBy, 'payout_update', 'Payout sent', `${p.amountCredits} credits were paid out to your ${p.method.type ?? 'account'}.`, '/wallet', t);
    return u!;
  });
}

/** locked → withdrawable. Allowed from 'requested' or 'approved'. Idempotent. */
export async function rejectPayout(payoutId: string, actorUserId: string, reason?: string, tx?: DbOrTx): Promise<Payout> {
  return withTx(tx, async (t) => {
    const p = await lockPayout(t, payoutId);
    if (p.status === 'rejected') return p;
    if (p.status !== 'requested' && p.status !== 'approved') throw conflict(`Payout is ${p.status}`);
    const w = await getOrCreateWallet(p.orgId, t);
    const r = await post(t, {
      type: 'payout_rejected', idempotencyKey: `payout_rejected:${payoutId}`, orgId: p.orgId, referenceType: 'payout', referenceId: payoutId,
      description: 'Payout rejected — credits returned to withdrawable', createdBy: actorUserId, reversalOf: p.requestTxId,
      legs: [{ walletId: w.id, bucket: 'locked', amount: -p.amountCredits }, { walletId: w.id, bucket: 'withdrawable', amount: p.amountCredits }],
    });
    const [u] = await t.update(schema.payouts).set({ status: 'rejected', reviewedBy: actorUserId, reviewNote: reason ?? null, settleTxId: r.id, updatedAt: new Date() }).where(eq(schema.payouts.id, payoutId)).returning();
    await audit({ action: 'wallet.payout_reject', targetType: 'payout', targetId: payoutId, orgId: p.orgId, actorUserId, actorType: 'admin', metadata: { transactionId: r.id, reason } }, null, t);
    await notify(p.requestedBy, 'payout_update', 'Payout rejected', `Your payout of ${p.amountCredits} credits was rejected${reason ? `: ${reason}` : ''}. Credits are back in your withdrawable balance.`, '/wallet', t);
    return u!;
  });
}

/* ───────────────────────────── welcome bonus ───────────────────────────── */

export const fmtIdle = (n: number) => `${n.toLocaleString('en-US')} IDLE`;
export const welcomeKey = (userId: string) => `welcome:${userId}`;

/**
 * Grant the one-time welcome bonus (WELCOME_BONUS_IDLE) to the user's default organisation wallet:
 * external → org available, type `welcome_bonus`, idempotency key `welcome:<userId>`.
 * Exactly-once even under concurrent logins: the unique idempotency key makes the losing insert a
 * no-op (it waits for the winner's commit, then returns `created:false`), so balances move once.
 * Returns `granted:true` only for the call that actually posted it. Users without a default org get nothing.
 */
export async function grantWelcomeBonus(userId: string, tx?: DbOrTx): Promise<{ granted: boolean; transactionId: string | null; amount: number }> {
  return withTx(tx, async (t) => {
    const key = welcomeKey(userId);
    const [done] = await t.select({ id: schema.transactions.id }).from(schema.transactions).where(eq(schema.transactions.idempotencyKey, key)).limit(1);
    if (done) return { granted: false, transactionId: done.id, amount: WELCOME_BONUS_IDLE };
    const [u] = await t.select({ defaultOrgId: schema.users.defaultOrgId, status: schema.users.status }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    if (!u || !u.defaultOrgId || u.status !== 'active') return { granted: false, transactionId: null, amount: WELCOME_BONUS_IDLE };
    const w = await getOrCreateWallet(u.defaultOrgId, t);
    const { external } = await platformWallets(t);
    const r = await post(t, {
      type: 'welcome_bonus', idempotencyKey: key, orgId: u.defaultOrgId, referenceType: 'user', referenceId: userId,
      description: `Welcome bonus: ${fmtIdle(WELCOME_BONUS_IDLE)}`, createdBy: userId,
      legs: [{ walletId: external.id, bucket: 'external', amount: -WELCOME_BONUS_IDLE }, { walletId: w.id, bucket: 'available', amount: WELCOME_BONUS_IDLE }],
    });
    if (r.created) {
      await audit({ action: 'wallet.welcome_bonus', targetType: 'wallet', targetId: w.id, orgId: u.defaultOrgId, actorUserId: userId, actorType: 'system', metadata: { transactionId: r.id, amount: WELCOME_BONUS_IDLE } }, null, t);
      await notify(userId, 'payment_update', 'Welcome to StringMind — 1,000 IDLE Tokens added',
        `${fmtIdle(WELCOME_BONUS_IDLE)} were added to your wallet. Spend them on training and knowledge, and earn more by teaching other agents.`, '/wallet', t);
    }
    return { granted: r.created, transactionId: r.id, amount: WELCOME_BONUS_IDLE };
  });
}

/** Welcome-bonus status for GET /auth/me. */
export async function welcomeBonusStatus(userId: string, tx?: DbOrTx): Promise<{ granted: boolean; amount: number; grantedAt: string | null }> {
  const [row] = await (tx ?? db()).select({ amount: schema.transactions.amount, createdAt: schema.transactions.createdAt }).from(schema.transactions)
    .where(eq(schema.transactions.idempotencyKey, welcomeKey(userId))).limit(1);
  return row ? { granted: true, amount: row.amount, grantedAt: new Date(row.createdAt).toISOString() } : { granted: false, amount: WELCOME_BONUS_IDLE, grantedAt: null };
}

/** IDLE received by a wallet from welcome bonuses (no cached column; computed from the ledger). */
export async function bonusTotal(walletId: string, tx?: DbOrTx): Promise<number> {
  const [r] = await (tx ?? db()).select({ total: sql<string>`coalesce(sum(${schema.ledgerEntries.amount}),0)` }).from(schema.ledgerEntries)
    .innerJoin(schema.transactions, eq(schema.transactions.id, schema.ledgerEntries.transactionId))
    .where(and(eq(schema.ledgerEntries.walletId, walletId), eq(schema.transactions.type, 'welcome_bonus')));
  return Number(r?.total ?? 0);
}

/* ───────────────────────────── admin ───────────────────────────── */

/**
 * Manual correction on an org's `available` bucket. Counterparty is the external wallet (credits minted/burned),
 * so platform revenue is never distorted. Negative amounts require sufficient available balance (402).
 */
export async function adminAdjustment(
  { orgId, amount, reason, actorUserId, idempotencyKey }: { orgId: string; amount: number; reason: string; actorUserId: string; idempotencyKey?: string },
  tx?: DbOrTx,
): Promise<{ transactionId: string }> {
  if (!Number.isSafeInteger(amount) || amount === 0) throw badRequest('amount must be a non-zero integer');
  if (!reason?.trim()) throw badRequest('reason is required');
  return withTx(tx, async (t) => {
    const w = await getOrCreateWallet(orgId, t);
    const { external } = await platformWallets(t);
    const r = await post(t, {
      type: 'adjustment', idempotencyKey: idempotencyKey ? `adjust:${idempotencyKey}` : `adjust:${crypto.randomUUID()}`, orgId,
      referenceType: 'organisation', referenceId: orgId, description: `Adjustment: ${reason}`, createdBy: actorUserId,
      legs: [{ walletId: w.id, bucket: 'available', amount }, { walletId: external.id, bucket: 'external', amount: -amount }],
    });
    if (r.created) {
      await audit({ action: 'wallet.adjustment', targetType: 'wallet', targetId: w.id, orgId, actorUserId, actorType: 'admin', metadata: { amount, reason, transactionId: r.id } }, null, t);
      await notifyOrg(orgId, 'payment_update', 'Wallet adjusted', `${amount > 0 ? '+' : ''}${fmtIdle(amount)}: ${reason}`, '/wallet', t);
    }
    return { transactionId: r.id };
  });
}

/** Compare cached wallet columns with ledger sums per bucket. */
export async function reconcile(walletId: string, tx?: DbOrTx): Promise<{ cached: Record<string, number>; ledger: Record<string, number>; ok: boolean }> {
  const q = tx ?? db();
  const [w] = await q.select().from(schema.wallets).where(eq(schema.wallets.id, walletId)).limit(1);
  if (!w) throw notFound('Wallet');
  const rows = await q.select({ bucket: schema.ledgerEntries.bucket, total: sql<string>`coalesce(sum(${schema.ledgerEntries.amount}),0)` })
    .from(schema.ledgerEntries).where(eq(schema.ledgerEntries.walletId, walletId)).groupBy(schema.ledgerEntries.bucket);
  const buckets = BUCKETS_BY_KIND[w.kind] ?? [];
  const ledger: Record<string, number> = Object.fromEntries(buckets.map((b) => [b, 0]));
  for (const r of rows) ledger[r.bucket] = Number(r.total);
  const cached: Record<string, number> = Object.fromEntries(buckets.map((b) => [b, w[BUCKET_COLUMN[b]]]));
  const keys = new Set([...Object.keys(ledger), ...Object.keys(cached)]);
  const ok = [...keys].every((k) => (ledger[k] ?? 0) === (cached[k] ?? 0));
  return { cached, ledger, ok };
}

/* ───────────────────────────── queries ───────────────────────────── */

/**
 * Transactions touching the org's wallet. `amount` is signed for this wallet = net change of spendable IDLE
 * (+ legacy withdrawable; escrow shows as −fee; refunds +); `entries` gives the per-bucket breakdown.
 */
export async function listTransactions(orgId: string, filters: { type?: string; page?: number; pageSize?: number } = {}) {
  const page = filters.page ?? 1;
  const pageSize = filters.pageSize ?? 20;
  const w = await getOrCreateWallet(orgId);
  const typeCond = filters.type ? sql`and t.type = ${filters.type}` : sql``;
  const res = await db().execute(sql`
    select t.id, t.type, t.status, t.description, t.reference_type as "referenceType", t.reference_id as "referenceId", t.created_at as "createdAt",
      coalesce(sum(case when le.bucket in ('available','withdrawable') then le.amount else 0 end),0)::bigint as amount,
      json_agg(json_build_object('bucket', le.bucket, 'amount', le.amount)) as entries,
      count(*) over() as total
    from transactions t join ledger_entries le on le.transaction_id = t.id
    where le.wallet_id = ${w.id} ${typeCond}
    group by t.id order by t.created_at desc, t.id desc
    limit ${pageSize} offset ${(page - 1) * pageSize}`);
  const rows = rowsOf<Record<string, unknown>>(res);
  const total = rows.length ? Number(rows[0]!.total) : await countTx(w.id, filters.type);
  return {
    items: rows.map(({ total: _t, ...r }) => ({ ...r, amount: Number(r.amount), createdAt: new Date(r.createdAt as string).toISOString(),
      entries: (r.entries as { bucket: string; amount: number }[]).map((e) => ({ bucket: e.bucket, amount: Number(e.amount) })) })),
    total, page, pageSize,
  };
}

async function countTx(walletId: string, type?: string) {
  const res = await db().execute(sql`select count(distinct t.id)::int as n from transactions t join ledger_entries le on le.transaction_id = t.id where le.wallet_id = ${walletId} ${type ? sql`and t.type = ${type}` : sql``}`);
  return Number(rowsOf<{ n: number }>(res)[0]?.n ?? 0);
}

/** Re-exported for older imports; the helper lives in db/client.ts. */
export { rowsOf };

