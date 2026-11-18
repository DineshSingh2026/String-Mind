/**
 * On-chain worker: ONE self-rescheduling job (`onchain.tick`, every ONCHAIN_WORKER_INTERVAL_SECONDS) that pushes everything
 * unfinished one step further. Every step is idempotent and crash-safe (see deposits.ts / withdrawals.ts / fees.ts), so a
 * tick that dies half-way is simply continued by the next one:
 *
 *   every tick   platform wallets mirrored · agent wallets provisioned · open deposits resumed · fee transfers processed ·
 *                'processing' withdrawals reconciled · automatic withdrawals paid
 *   every 60 s   price samples (deposits are valued conservatively against them)
 *   every scan   deposit scanner over all agent wallets (fallback for owners who never press "verify")
 *   every recon  reconciliation (raises issues; never moves money)
 */
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { enqueue } from '../../jobs/queue.js';
import { config } from '../../lib/config.js';
import { resumeOpenDeposits, scanAgentWallets } from './deposits.js';
import { processOpenSettlements } from './fees.js';
import { recordPriceSamples } from './price.js';
import { runReconciliation } from './reconciliation.js';
import { backfillAgentWallets, ensurePlatformWallets } from './wallets.js';
import { processAutoWithdrawals, reconcileProcessingWithdrawals } from './withdrawals.js';

export const ONCHAIN_TICK_JOB = 'onchain.tick';
const last = { price: 0, scan: 0, recon: 0 };

async function guarded(name: string, fn: () => Promise<unknown>) {
  try { await fn(); } catch (e) { console.error(`[onchain] ${name} failed:`, e instanceof Error ? e.message : e); }
}

export async function onchainTick(now = Date.now()): Promise<void> {
  if (!config.ONCHAIN_ENABLED) return;
  await guarded('platform wallets', ensurePlatformWallets);
  await guarded('agent wallets', () => backfillAgentWallets(50));
  await guarded('resume deposits', () => resumeOpenDeposits());
  await guarded('fee transfers', () => processOpenSettlements());
  await guarded('withdrawals reconcile', reconcileProcessingWithdrawals);
  await guarded('auto withdrawals', () => processAutoWithdrawals());
  if (now - last.price >= 60_000) { last.price = now; await guarded('price samples', recordPriceSamples); }
  if (now - last.scan >= config.DEPOSIT_SCAN_INTERVAL_SECONDS * 1000) { last.scan = now; await guarded('deposit scan', () => scanAgentWallets()); }
  if (now - last.recon >= config.RECONCILIATION_INTERVAL_SECONDS * 1000) { last.recon = now; await guarded('reconciliation', runReconciliation); }
}

/** Enqueue the next tick unless one is already queued (self-rescheduling, like the agent health check). */
export async function ensureOnchainTickScheduled(): Promise<void> {
  if (!config.ONCHAIN_ENABLED) return;
  const [q] = await db().select({ id: schema.jobs.id }).from(schema.jobs).where(and(eq(schema.jobs.type, ONCHAIN_TICK_JOB), eq(schema.jobs.status, 'queued'))).limit(1);
  if (!q) await enqueue(ONCHAIN_TICK_JOB, {}, { delayMs: config.ONCHAIN_WORKER_INTERVAL_SECONDS * 1000, maxAttempts: 1 });
}

/** Test hook: forget the per-interval timers. */
export const resetTickTimersForTests = () => { last.price = last.scan = last.recon = 0; };
