/**
 * Withdrawals: IDLE → on-chain, paid out of the Treasury (MID) to the agent's registered payout address.
 *
 *   request   reserves the IDLE (available → locked) immediately — nothing is sent on-chain yet
 *   settle    pays from the Treasury as its OWN transaction per withdrawal (a bad destination can't block the others):
 *             claim 'pending' → 'processing' → SIGN → commit signature + bytes → broadcast → ask the chain
 *   confirmed the IDLE is burned (locked → external) in the same database transaction as the status change
 *   failed/expired the funds provably did not move → back to 'pending' (safe to settle again)
 *   decline   an admin refuses it → the reserved IDLE is returned
 *
 * Never pays twice: every payout is signed first and committed as 'processing' with that signature BEFORE broadcast. A
 * repeated or concurrent settle skips it, and an unconfirmed payout stays 'processing' until the chain proves it landed
 * (→ completed) or can never land (→ pending).
 */
import { and, asc, desc, eq, gte, isNull, lt, ne, sql } from 'drizzle-orm';
import { PublicKey } from '@solana/web3.js';
import { db, schema } from '../../db/client.js';
import { config } from '../../lib/config.js';
import { badRequest, conflict, notFound, unprocessable } from '../../lib/errors.js';
import { notifyOrg } from '../../lib/notify.js';
import { finalizeWithdrawal, refundWithdrawal, reserveWithdrawal, withdrawableIdle } from '../wallet/ledger.js';
import { raiseIssue } from './issues.js';
import { getMidKeypair } from './keys.js';
import { getEffectivePayoutAddress } from './payout-addresses.js';
import { getOnchainSettings } from './settings.js';
import * as sol from './solana.js';

export type Withdrawal = typeof schema.onchainWithdrawals.$inferSelect;
const CLAIM_STALE_MS = 2 * 60_000;

export async function requestWithdrawal(agent: { id: string; orgId: string; name: string }, userId: string, amountIdle: number): Promise<Withdrawal> {
  const s = await getOnchainSettings();
  if (!Number.isSafeInteger(amountIdle) || amountIdle <= 0) throw badRequest('amount must be a whole number of IDLE');
  if (amountIdle < s.minWithdrawalIdle) throw badRequest(`Minimum withdrawal is ${s.minWithdrawalIdle} IDLE`);
  if (s.maxWithdrawalPerRequestIdle > 0 && amountIdle > s.maxWithdrawalPerRequestIdle) throw badRequest(`Maximum withdrawal per request is ${s.maxWithdrawalPerRequestIdle} IDLE`);
  if (s.maxDailyWithdrawalIdle > 0) {
    const [r] = await db().select({ n: sql<number>`coalesce(sum(${schema.onchainWithdrawals.amountIdle}),0)::bigint` }).from(schema.onchainWithdrawals)
      .where(and(eq(schema.onchainWithdrawals.orgId, agent.orgId), ne(schema.onchainWithdrawals.status, 'failed'), gte(schema.onchainWithdrawals.createdAt, new Date(Date.now() - 86_400_000))));
    const recent = Number(r?.n ?? 0);
    if (recent + amountIdle > s.maxDailyWithdrawalIdle) throw badRequest(`Daily withdrawal limit is ${s.maxDailyWithdrawalIdle} IDLE; ${Math.max(0, s.maxDailyWithdrawalIdle - recent)} IDLE left in the last 24 h`);
  }
  const destination = await getEffectivePayoutAddress(agent.id);
  if (!destination) throw badRequest('Register a payout address for this agent first');
  const w = await withdrawableIdle(agent.orgId);
  if (amountIdle > w.withdrawable) {
    throw unprocessable(`Only ${w.withdrawable} IDLE is withdrawable: ${w.unspentBonus} IDLE of welcome bonus has to be spent first (bonuses are not backed by a deposit).`, { reason: 'not_withdrawable', ...w });
  }
  return db().transaction(async (tx) => {
    const [row] = await tx.insert(schema.onchainWithdrawals).values({ agentId: agent.id, orgId: agent.orgId, requestedBy: userId, amountIdle, destinationWallet: destination }).returning();
    const r = await reserveWithdrawal({ orgId: agent.orgId, withdrawalId: row!.id, amount: amountIdle, userId }, tx); // 402 if the IDLE is gone
    // Authoritative re-check AFTER the reserve (which locked the wallet row until commit): two simultaneous requests can no
    // longer both pass the pre-check above and together dip into the unbacked welcome bonus.
    const after = await withdrawableIdle(agent.orgId, tx);
    if (after.available - after.unspentBonus < 0) throw unprocessable(`Only ${w.withdrawable} IDLE is withdrawable: welcome-bonus IDLE has to be spent first.`, { reason: 'not_withdrawable' });
    const [out] = await tx.update(schema.onchainWithdrawals).set({ reserveTxId: r.transactionId }).where(eq(schema.onchainWithdrawals.id, row!.id)).returning();
    return out!;
  });
}

/* ───────────── outcome of a payout ───────────── */

/** Move a 'processing' withdrawal to its final state once the chain says what happened. Only the row still carrying THIS signature may change. */
async function applyPayoutState(id: string, signature: string, state: sol.TxState): Promise<'applied' | 'waiting' | 'superseded'> {
  if (state === 'unknown') return 'waiting';
  const guard = and(eq(schema.onchainWithdrawals.id, id), eq(schema.onchainWithdrawals.status, 'processing'), eq(schema.onchainWithdrawals.txSignature, signature));
  if (state === 'confirmed') {
    const done = await db().transaction(async (tx) => {
      const [row] = await tx.update(schema.onchainWithdrawals).set({ status: 'completed', completedAt: new Date(), payoutLastValidBlockHeight: null, payoutTxB64: null }).where(guard).returning();
      if (!row) return null;
      const f = await finalizeWithdrawal({ orgId: row.orgId, withdrawalId: row.id, amount: row.amountIdle }, tx);
      await tx.update(schema.onchainWithdrawals).set({ finalTxId: f.transactionId }).where(eq(schema.onchainWithdrawals.id, id));
      return row;
    });
    if (!done) return 'superseded';
    await notifyOrg(done.orgId, 'payment_update', `Withdrawal completed: ${done.amountIdle.toLocaleString('en-US')} IDLE`, `Sent on-chain to ${done.destinationWallet}.`, '/wallet').catch(() => undefined);
    return 'applied';
  }
  // 'failed' (landed, errored) or 'expired' (can never land): the funds provably did not move — back to pending so it can be settled again
  const [row] = await db().update(schema.onchainWithdrawals).set({ status: 'pending', txSignature: null, payoutLastValidBlockHeight: null, payoutTxB64: null, attempts: sql`${schema.onchainWithdrawals.attempts} + 1` }).where(guard).returning();
  if (row && row.attempts >= config.ONCHAIN_MAX_ATTEMPTS) {
    await raiseIssue({ kind: 'withdrawal_payout_failed', severity: 'critical', refType: 'withdrawal', refKey: id, details: { attempts: row.attempts, lastState: state } });
  }
  return row ? 'applied' : 'superseded';
}

/** Resolve withdrawals left 'processing' (crash, timeout, or RPC error after broadcast) by asking the chain about their payout. */
export async function reconcileProcessingWithdrawals(): Promise<{ id: string; state: string }[]> {
  // a settle that died after claiming but before signing: nothing was signed, release the claim
  await db().update(schema.onchainWithdrawals).set({ status: 'pending' }).where(and(eq(schema.onchainWithdrawals.status, 'processing'), isNull(schema.onchainWithdrawals.txSignature), lt(schema.onchainWithdrawals.createdAt, new Date(Date.now() - CLAIM_STALE_MS))));
  const rows = await db().select().from(schema.onchainWithdrawals).where(and(eq(schema.onchainWithdrawals.status, 'processing'), sql`${schema.onchainWithdrawals.txSignature} is not null`));
  const out: { id: string; state: string }[] = [];
  for (const w of rows) {
    let state: sol.TxState = 'unknown';
    try { state = await sol.getPayoutState(w.txSignature!, Number(w.payoutLastValidBlockHeight)); } catch { /* unknown */ }
    if (state === 'unknown' && w.payoutTxB64) await sol.broadcast(w.payoutTxB64); // same signed bytes: can only ever land once
    await applyPayoutState(w.id, w.txSignature!, state);
    out.push({ id: w.id, state });
  }
  return out;
}

/* ───────────── settle (pay from the Treasury) ───────────── */

export interface SettleResult { id: string; ok: boolean; txSignature?: string; error?: string }

export async function settleWithdrawals(ids: string[], opts: { autoCap?: number; waitSecs?: number } = {}): Promise<SettleResult[]> {
  await reconcileProcessingWithdrawals();
  const results: SettleResult[] = [];
  const mid = await getMidKeypair();
  const mint = new PublicKey(config.IDLEMINE_MINT);
  for (const id of ids) {
    // exclusive claim: only one process may sign a payout for this withdrawal
    const claimWhere = and(eq(schema.onchainWithdrawals.id, id), eq(schema.onchainWithdrawals.status, 'pending'),
      ...(opts.autoCap != null ? [sql`${schema.onchainWithdrawals.amountIdle} <= ${opts.autoCap}`] : []));
    const [w] = await db().update(schema.onchainWithdrawals).set({ status: 'processing', payoutSource: 'mid' }).where(claimWhere).returning();
    if (!w) { results.push({ id, ok: false, error: 'not pending (or no longer eligible for automatic payout)' }); continue; }
    const back = (error: string) => db().update(schema.onchainWithdrawals).set({ status: 'pending' }).where(and(eq(schema.onchainWithdrawals.id, id), eq(schema.onchainWithdrawals.status, 'processing'), isNull(schema.onchainWithdrawals.txSignature))).then(() => results.push({ id, ok: false, error }));

    let signed: sol.SignedTx;
    try {
      const amountRaw = sol.decimalToRaw(String(w.amountIdle), config.IDLEMINE_DECIMALS);
      const dest = new PublicKey(w.destinationWallet);
      const sourceAta = sol.getAssociatedTokenAddress(mid.publicKey, mint);
      const balance = await sol.getTokenAccountRawBalance(sourceAta.toBase58());
      if (balance == null || balance < amountRaw) {
        await raiseIssue({ kind: 'treasury_underfunded', severity: 'warning', refType: 'withdrawal', refKey: id, details: { needed: String(amountRaw), treasuryHolds: String(balance ?? 0n) } });
        await back('The Treasury does not hold enough IDLEMINE to pay this withdrawal yet'); continue;
      }
      signed = await sol.buildSignedTransaction([
        sol.createAtaIdempotentIx(mid.publicKey, dest, mint),
        sol.transferCheckedIx(sourceAta, mint, sol.getAssociatedTokenAddress(dest, mint), mid.publicKey, amountRaw, config.IDLEMINE_DECIMALS),
      ], mid, [mid], { memo: `hivemind:withdrawal:${id}` });
    } catch (e) { await back(e instanceof Error ? e.message : 'could not build the payout'); continue; }

    // durable claim before any money moves
    const committed = await db().update(schema.onchainWithdrawals).set({ txSignature: signed.signature, payoutLastValidBlockHeight: signed.lastValidBlockHeight, payoutTxB64: signed.rawTxB64 })
      .where(and(eq(schema.onchainWithdrawals.id, id), eq(schema.onchainWithdrawals.status, 'processing'), isNull(schema.onchainWithdrawals.txSignature))).returning({ id: schema.onchainWithdrawals.id });
    if (!committed.length) { results.push({ id, ok: false, error: 'claim was released meanwhile; nothing was sent' }); continue; }

    const err = await sol.broadcast(signed.rawTxB64);
    if (err) console.warn(`[onchain] withdrawal ${id} broadcast error (not proof of failure): ${err.slice(0, 120)}`);
    const state = await sol.waitForState(signed.signature, signed.lastValidBlockHeight, opts.waitSecs ?? 45);
    const applied = await applyPayoutState(id, signed.signature, state);
    if (applied === 'superseded') {
      if (state === 'confirmed') await raiseIssue({ kind: 'withdrawal_untracked_payout', severity: 'critical', refType: 'withdrawal', refKey: id, details: { landedSignature: signed.signature } });
      results.push({ id, ok: false, txSignature: signed.signature, error: 'payout was resolved elsewhere meanwhile; nothing changed here' });
    } else if (state === 'confirmed') results.push({ id, ok: true, txSignature: signed.signature });
    else if (state === 'unknown') results.push({ id, ok: false, txSignature: signed.signature, error: "sent but not yet confirmed; left 'processing' and will be reconciled automatically. Do not resend." });
    else results.push({ id, ok: false, error: `payout ${state} on-chain; returned to pending` });
  }
  return results;
}

/** When the admin enables automatic withdrawals, pending withdrawals up to autoWithdrawalMaxIdle are paid from the Treasury without a click. A cap is required (0 = no automatic payouts); bigger ones wait for an admin. */
export async function processAutoWithdrawals(limit = 20): Promise<number> {
  const s = await getOnchainSettings();
  if (!s.autoWithdrawalsEnabled || s.autoWithdrawalMaxIdle <= 0) return 0;
  const ids = (await db().select({ id: schema.onchainWithdrawals.id }).from(schema.onchainWithdrawals).where(and(
    eq(schema.onchainWithdrawals.status, 'pending'), sql`${schema.onchainWithdrawals.amountIdle} <= ${s.autoWithdrawalMaxIdle}`, sql`${schema.onchainWithdrawals.attempts} < ${config.ONCHAIN_MAX_ATTEMPTS}`,
  )).orderBy(asc(schema.onchainWithdrawals.createdAt)).limit(limit)).map((r) => r.id);
  if (ids.length) await settleWithdrawals(ids, { autoCap: s.autoWithdrawalMaxIdle, waitSecs: 0 });
  return ids.length;
}

/** An admin refuses a pending withdrawal: the reserved IDLE returns to the organisation. */
export async function declineWithdrawal(id: string, reason: string): Promise<Withdrawal> {
  const out = await db().transaction(async (tx) => {
    const [row] = await tx.update(schema.onchainWithdrawals).set({ status: 'failed', note: reason.slice(0, 500), completedAt: new Date() })
      .where(and(eq(schema.onchainWithdrawals.id, id), eq(schema.onchainWithdrawals.status, 'pending'))).returning();
    if (!row) return null;
    const r = await refundWithdrawal({ orgId: row.orgId, withdrawalId: row.id, amount: row.amountIdle }, tx);
    await tx.update(schema.onchainWithdrawals).set({ finalTxId: r.transactionId }).where(eq(schema.onchainWithdrawals.id, id));
    return row;
  });
  if (!out) {
    const [cur] = await db().select().from(schema.onchainWithdrawals).where(eq(schema.onchainWithdrawals.id, id)).limit(1);
    if (!cur) throw notFound('Withdrawal');
    throw conflict(`This withdrawal is already ${cur.status}`);
  }
  await notifyOrg(out.orgId, 'payment_update', 'Withdrawal declined', `${out.amountIdle.toLocaleString('en-US')} IDLE returned to your wallet.${reason ? ` Reason: ${reason}` : ''}`, '/wallet').catch(() => undefined);
  return (await db().select().from(schema.onchainWithdrawals).where(eq(schema.onchainWithdrawals.id, id)).limit(1))[0]!;
}

export const withdrawalView = (w: Withdrawal) => ({
  id: w.id, agentId: w.agentId, amountIdle: w.amountIdle, destinationWallet: w.destinationWallet, status: w.status, txSignature: w.txSignature, attempts: w.attempts,
  note: w.note, createdAt: w.createdAt, completedAt: w.completedAt,
});

export async function listWithdrawals(filter: { agentId?: string; orgId?: string; status?: string; limit?: number }) {
  const conds = [filter.agentId ? eq(schema.onchainWithdrawals.agentId, filter.agentId) : undefined, filter.orgId ? eq(schema.onchainWithdrawals.orgId, filter.orgId) : undefined,
    filter.status ? eq(schema.onchainWithdrawals.status, filter.status) : undefined].filter((c): c is NonNullable<typeof c> => !!c);
  return db().select().from(schema.onchainWithdrawals).where(conds.length ? and(...conds) : undefined).orderBy(desc(schema.onchainWithdrawals.createdAt)).limit(filter.limit ?? 50);
}
