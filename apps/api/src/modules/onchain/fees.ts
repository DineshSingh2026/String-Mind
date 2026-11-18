/**
 * Platform fee mirror: every commission the ledger books on a settlement (training session, knowledge sale) is moved
 * on-chain from the Treasury (MID) to the Revenue wallet (ADMIN) as one SPL TransferChecked:
 *
 *     pending → sending → completed        (failed after ONCHAIN_MAX_ATTEMPTS, raised for an admin)
 *
 * The row is created INSIDE the settling ledger transaction (commission hook), so the ledger and the fee obligation commit
 * together; one fee per settlement source, ever (unique index). The in-flight signature + signed bytes are committed BEFORE
 * broadcast — a crash or RPC timeout is always resolved by asking the chain about that exact signature, never by sending
 * again. The Revenue key is never loaded: it only ever RECEIVES.
 */
import { and, asc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { PublicKey } from '@solana/web3.js';
import { db, schema } from '../../db/client.js';
import { config } from '../../lib/config.js';
import { AppError } from '../../lib/errors.js';
import { registerCommissionHook } from '../wallet/ledger.js';
import { raiseIssue } from './issues.js';
import { getMidKeypair } from './keys.js';
import { getOnchainSettings } from './settings.js';
import * as sol from './solana.js';

export type Settlement = typeof schema.onchainSettlements.$inferSelect;
const CLAIM_STALE_MS = 2 * 60_000;

/** Registered once at module load: queue the on-chain fee whenever the ledger books platform commission. */
registerCommissionHook(async (tx, e) => {
  if (!config.ONCHAIN_ENABLED) return;
  if (!config.MID_WALLET_ADDRESS || !config.ADMIN_WALLET_ADDRESS) { console.error(`[onchain] fee not queued for ${e.sourceId}: MID/ADMIN wallet address not configured`); return; }
  if (!(await getOnchainSettings(tx)).feeMirrorEnabled) return;
  await tx.insert(schema.onchainSettlements).values({
    kind: 'platform_fee', sourceType: e.sourceType, sourceId: e.sourceId, amountIdle: e.commission,
    amountRaw: sol.decimalToRaw(String(e.commission), config.IDLEMINE_DECIMALS).toString(), mintAddress: config.IDLEMINE_MINT,
    sourceWallet: config.MID_WALLET_ADDRESS, destinationWallet: config.ADMIN_WALLET_ADDRESS,
  }).onConflictDoNothing(); // one fee per settlement source
});

const patch = (id: string, expected: string, set: Partial<typeof schema.onchainSettlements.$inferInsert>) =>
  db().update(schema.onchainSettlements).set({ ...set, updatedAt: new Date() }).where(and(eq(schema.onchainSettlements.id, id), eq(schema.onchainSettlements.status, expected))).returning();

async function startFee(id: string): Promise<boolean> {
  const [cur] = await db().select().from(schema.onchainSettlements).where(eq(schema.onchainSettlements.id, id)).limit(1);
  if (!cur || cur.status !== 'pending') return false;
  if (cur.attemptCount >= config.ONCHAIN_MAX_ATTEMPTS) {
    if ((await patch(id, 'pending', { status: 'failed', lastError: 'attempts exhausted' })).length) await raiseIssue({ kind: 'platform_fee_failed', severity: 'critical', refType: 'settlement', refKey: id, details: { sourceId: cur.sourceId, attempts: cur.attemptCount } });
    return false;
  }
  // exclusive claim: only one worker may build + sign this transfer
  const [row] = await db().update(schema.onchainSettlements).set({ status: 'sending', lastError: null, updatedAt: new Date() })
    .where(and(eq(schema.onchainSettlements.id, id), eq(schema.onchainSettlements.status, 'pending'), isNull(schema.onchainSettlements.pendingSignature))).returning();
  if (!row) return false;
  const release = (set: Partial<typeof schema.onchainSettlements.$inferInsert>) =>
    db().update(schema.onchainSettlements).set({ ...set, updatedAt: new Date() }).where(and(eq(schema.onchainSettlements.id, id), eq(schema.onchainSettlements.status, 'sending'), isNull(schema.onchainSettlements.pendingSignature))).returning({ id: schema.onchainSettlements.id });
  try {
    const mid = await getMidKeypair();
    if (row.sourceWallet !== mid.publicKey.toBase58()) throw new Error('fee source wallet is not the configured Treasury');
    const mint = new PublicKey(row.mintAddress); const revenue = new PublicKey(row.destinationWallet);
    const amountRaw = BigInt(row.amountRaw);
    const sourceAta = sol.getAssociatedTokenAddress(mid.publicKey, mint);
    const balance = await sol.getTokenAccountRawBalance(sourceAta.toBase58());
    if (balance == null || balance < amountRaw) {
      await raiseIssue({ kind: 'treasury_underfunded', severity: 'warning', refType: 'settlement', refKey: id, details: { needed: String(amountRaw), treasuryHolds: String(balance ?? 0n) } });
      await release({ status: 'pending', attemptCount: row.attemptCount + 1, lastError: 'Treasury does not hold enough IDLEMINE yet' });
      return false;
    }
    const signed = await sol.buildSignedTransaction([
      sol.createAtaIdempotentIx(mid.publicKey, revenue, mint),
      sol.transferCheckedIx(sourceAta, mint, sol.getAssociatedTokenAddress(revenue, mint), mid.publicKey, amountRaw, config.IDLEMINE_DECIMALS),
    ], mid, [mid], { memo: `hivemind:fee:${id}` });
    const ok = await release({ pendingSignature: signed.signature, pendingTxB64: signed.rawTxB64, pendingLastValidBlockHeight: signed.lastValidBlockHeight, attemptCount: row.attemptCount + 1 });
    if (!ok.length) return false; // claim released meanwhile: never broadcast what was not durably recorded
    const err = await sol.broadcast(signed.rawTxB64);
    if (err) console.warn(`[onchain] fee ${id} broadcast error (not proof of failure): ${err.slice(0, 120)}`);
    return true;
  } catch (e) {
    await release({ status: 'pending', attemptCount: row.attemptCount + 1, lastError: `build failed: ${e instanceof Error ? e.message : 'error'}`.slice(0, 500) });
    return false;
  }
}

async function settleFee(id: string, waitSecs: number): Promise<boolean> {
  const [row] = await db().select().from(schema.onchainSettlements).where(eq(schema.onchainSettlements.id, id)).limit(1);
  if (!row || row.status !== 'sending' || !row.pendingSignature) return false;
  const sig = row.pendingSignature; const lvbh = Number(row.pendingLastValidBlockHeight);
  let state: sol.TxState;
  if (waitSecs > 0) state = await sol.waitForState(sig, lvbh, waitSecs);
  else { try { state = await sol.getPayoutState(sig, lvbh); } catch { state = 'unknown'; } }
  if (state === 'unknown') { if (row.pendingTxB64) await sol.broadcast(row.pendingTxB64); return false; }
  const where = and(eq(schema.onchainSettlements.id, id), eq(schema.onchainSettlements.status, 'sending'), eq(schema.onchainSettlements.pendingSignature, sig));
  if (state === 'confirmed') await db().update(schema.onchainSettlements).set({ status: 'completed', transferSignature: sig, completedAt: new Date(), pendingSignature: null, pendingTxB64: null, pendingLastValidBlockHeight: null, updatedAt: new Date() }).where(where);
  else await db().update(schema.onchainSettlements).set({ status: 'pending', lastError: `transfer ${sig} ${state}`, pendingSignature: null, pendingTxB64: null, pendingLastValidBlockHeight: null, updatedAt: new Date() }).where(where);
  return true;
}

/** One worker pass over open fee transfers. Returns how many rows were looked at. */
export async function processOpenSettlements(opts: { limit?: number; waitSecs?: number } = {}): Promise<number> {
  // a worker that died after claiming but before signing: nothing was signed or broadcast, release the claim
  await db().update(schema.onchainSettlements).set({ status: 'pending', updatedAt: new Date() }).where(and(eq(schema.onchainSettlements.status, 'sending'), isNull(schema.onchainSettlements.pendingSignature), lt(schema.onchainSettlements.updatedAt, new Date(Date.now() - CLAIM_STALE_MS))));
  const rows = await db().select().from(schema.onchainSettlements).where(inArray(schema.onchainSettlements.status, ['pending', 'sending'])).orderBy(asc(schema.onchainSettlements.createdAt)).limit(opts.limit ?? 50);
  for (const r of rows) {
    try {
      if (r.status === 'pending') { if (await startFee(r.id)) await settleFee(r.id, opts.waitSecs ?? 30); }
      else await settleFee(r.id, opts.waitSecs ?? 0);
    } catch (e) { console.error(`[onchain] fee ${r.id} step failed`, e instanceof Error ? e.message : e); }
  }
  return rows.length;
}

/** Admin action after fixing the cause (e.g. topping up the Treasury). Only a 'failed' row with nothing in flight can be retried. */
export async function retryFailedSettlement(id: string): Promise<Settlement> {
  const [row] = await db().select().from(schema.onchainSettlements).where(eq(schema.onchainSettlements.id, id)).limit(1);
  if (!row) throw new AppError(404, 'not_found', 'Settlement not found');
  if (row.status !== 'failed' || row.pendingSignature) throw new AppError(409, 'conflict', `Settlement is ${row.status}; only a failed settlement with nothing in flight can be retried`);
  const [out] = await db().update(schema.onchainSettlements).set({ status: 'pending', attemptCount: 0, lastError: null, updatedAt: new Date() }).where(and(eq(schema.onchainSettlements.id, id), eq(schema.onchainSettlements.status, 'failed'))).returning();
  return out!;
}

export const settlementView = (s: Settlement) => ({
  id: s.id, kind: s.kind, sourceType: s.sourceType, sourceId: s.sourceId, amountIdle: s.amountIdle, status: s.status, transferSignature: s.transferSignature,
  attempts: s.attemptCount, lastError: s.lastError, createdAt: s.createdAt, completedAt: s.completedAt,
});

export const countOpenSettlements = async () => Number((await db().select({ n: sql<number>`count(*)::int` }).from(schema.onchainSettlements).where(inArray(schema.onchainSettlements.status, ['pending', 'sending'])))[0]?.n ?? 0);
