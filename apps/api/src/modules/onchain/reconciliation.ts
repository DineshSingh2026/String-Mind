/**
 * Reconciliation — finds mismatches and RAISES them for an admin; it never moves or "fixes" money itself.
 *
 *   deposits      stuck in a non-final state too long, or credited without a ledger entry
 *   settlements   fee transfers stuck 'sending' / 'pending' too long (or failed)
 *   withdrawals   stuck 'processing' too long
 *   balances      Treasury liquidity (gas SOL, IDLEMINE for open fees + withdrawals), and agent wallets left unswept
 */
import { and, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { config } from '../../lib/config.js';
import { raiseIssue } from './issues.js';
import * as sol from './solana.js';
import { activePlatformWallet } from './wallets.js';

const ago = (ms: number) => new Date(Date.now() - ms);
const STUCK_DEPOSIT_MS = 60 * 60_000; // same window as the reference gateway
const STUCK_PAYOUT_MS = 60 * 60_000;

async function checkDeposits() {
  const stuck = await db().select().from(schema.blockchainDeposits).where(and(inArray(schema.blockchainDeposits.status, ['detected', 'verified', 'sweeping', 'swept']), lt(schema.blockchainDeposits.updatedAt, ago(STUCK_DEPOSIT_MS))));
  for (const d of stuck) await raiseIssue({ kind: 'deposit_stuck', severity: 'warning', refType: 'deposit', refKey: d.id, details: { status: d.status, txSignature: d.txSignature, lastError: d.lastError } });
  const failed = await db().select().from(schema.blockchainDeposits).where(eq(schema.blockchainDeposits.status, 'failed'));
  for (const d of failed) await raiseIssue({ kind: 'deposit_failed', severity: 'critical', refType: 'deposit', refKey: d.id, details: { txSignature: d.txSignature, reason: d.rejectionReason ?? d.lastError } });
  const noLedger = await db().select().from(schema.blockchainDeposits).where(and(eq(schema.blockchainDeposits.status, 'credited'), isNull(schema.blockchainDeposits.ledgerTxId)));
  for (const d of noLedger) await raiseIssue({ kind: 'deposit_credited_without_ledger', severity: 'critical', refType: 'deposit', refKey: d.id, details: { txSignature: d.txSignature } });
}

async function checkSettlements() {
  const rows = await db().select().from(schema.onchainSettlements).where(and(inArray(schema.onchainSettlements.status, ['pending', 'sending', 'failed']), lt(schema.onchainSettlements.updatedAt, ago(STUCK_PAYOUT_MS))));
  for (const s of rows) await raiseIssue({ kind: s.status === 'failed' ? 'platform_fee_failed' : 'platform_fee_stuck', severity: s.status === 'failed' ? 'critical' : 'warning', refType: 'settlement', refKey: s.id, details: { status: s.status, sourceId: s.sourceId, lastError: s.lastError } });
}

async function checkWithdrawals() {
  const rows = await db().select().from(schema.onchainWithdrawals).where(and(eq(schema.onchainWithdrawals.status, 'processing'), lt(schema.onchainWithdrawals.createdAt, ago(STUCK_PAYOUT_MS))));
  for (const w of rows) await raiseIssue({ kind: 'withdrawal_stuck', severity: 'warning', refType: 'withdrawal', refKey: w.id, details: { txSignature: w.txSignature } });
}

/** Gas headroom the Treasury needs (it pays every sweep, fee transfer and payout). */
export const MID_MIN_SOL_LAMPORTS = 50_000_000n; // 0.05 SOL

/**
 * Treasury liquidity: it must be able to move IDLEMINE right now — open fee transfers plus withdrawals being paid.
 * (Total IDLE owed vs IDLEMINE held is informational only: deposits in USDC/SOL are swept as USDC/SOL, and the admin
 * converts them to IDLEMINE when needed.) Agent wallets with recent activity must be swept empty.
 */
async function checkBalances() {
  const mid = await activePlatformWallet('MID');
  if (mid) {
    const balances = await sol.getWalletBalances(mid.publicAddress);
    if ((balances.SOL ?? 0n) < MID_MIN_SOL_LAMPORTS) await raiseIssue({ kind: 'mid_low_sol', severity: 'warning', refType: 'wallet', refKey: 'MID', details: { lamports: String(balances.SOL ?? 0n) } });
    const [openFees] = await db().select({ n: sql<string>`coalesce(sum(${schema.onchainSettlements.amountRaw}),0)::text` }).from(schema.onchainSettlements).where(inArray(schema.onchainSettlements.status, ['pending', 'sending']));
    const [openWd] = await db().select({ n: sql<string>`coalesce(sum(${schema.onchainWithdrawals.amountIdle}),0)::text` }).from(schema.onchainWithdrawals).where(inArray(schema.onchainWithdrawals.status, ['pending', 'processing']));
    const needed = BigInt(openFees?.n ?? '0') + BigInt(openWd?.n ?? '0') * 10n ** BigInt(config.IDLEMINE_DECIMALS);
    const held = balances[config.IDLEMINE_MINT] ?? 0n;
    if (held < needed) await raiseIssue({ kind: 'mid_insufficient_idlemine', severity: 'critical', refType: 'wallet', refKey: 'MID', details: { heldRaw: held.toString(), neededRaw: needed.toString() } });
    const [liab] = await db().select({ n: sql<string>`coalesce(sum(${schema.wallets.available} + ${schema.wallets.locked}),0)::text` }).from(schema.wallets).where(eq(schema.wallets.kind, 'org'));
    const owed = BigInt(liab?.n ?? '0') * 10n ** BigInt(config.IDLEMINE_DECIMALS);
    if (held < owed) await raiseIssue({ kind: 'idle_liability_exceeds_mid_idlemine', severity: 'info', refType: 'wallet', refKey: 'MID', details: { idleOwed: liab?.n ?? '0', midIdlemine: sol.rawToDecimal(held, config.IDLEMINE_DECIMALS) } });
  }
  // agent wallets with recent activity should be swept empty
  const recent = await db().selectDistinct({ walletId: schema.blockchainDeposits.walletId }).from(schema.blockchainDeposits).where(gt(schema.blockchainDeposits.createdAt, ago(86_400_000)));
  for (const { walletId } of recent) {
    const [open] = await db().select({ n: sql<number>`count(*)::int` }).from(schema.blockchainDeposits).where(and(eq(schema.blockchainDeposits.walletId, walletId), inArray(schema.blockchainDeposits.status, ['detected', 'verified', 'sweeping', 'swept'])));
    if (Number(open?.n ?? 0) > 0) continue;
    const [w] = await db().select().from(schema.solanaWallets).where(eq(schema.solanaWallets.id, walletId)).limit(1);
    if (!w) continue;
    const bal = await sol.getWalletBalances(w.publicAddress);
    const left: Record<string, string> = {};
    for (const [mint, v] of Object.entries(sol.supportedMints())) if ((bal[mint] ?? 0n) > 0n) left[v.asset] = String(bal[mint]);
    if ((bal.SOL ?? 0n) > 890_880n) left.SOL = String(bal.SOL);
    if (Object.keys(left).length) await raiseIssue({ kind: 'agent_wallet_unswept_balance', severity: 'warning', refType: 'wallet', refKey: w.publicAddress, details: { agentId: w.agentId, balancesRaw: left } });
  }
}

export async function runReconciliation(): Promise<void> {
  for (const step of [checkDeposits, checkSettlements, checkWithdrawals, checkBalances]) {
    try { await step(); } catch (e) { console.error(`[onchain] reconciliation step ${step.name} failed`, e instanceof Error ? e.message : e); }
  }
}
