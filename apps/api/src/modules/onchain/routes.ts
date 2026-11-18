/**
 * On-chain wallets & payment gateway API.
 *
 *   GET  /status                                    gateway on/off, network, Treasury + Revenue addresses, assets, limits
 *   GET  /agents/:agentId/wallet                    the agent's own deposit wallet, balances, deposits, payout address, withdrawable IDLE
 *   POST /agents/:agentId/deposits/verify           { txSignature }  verify + sweep + credit a deposit now
 *   GET  /agents/:agentId/deposits
 *   GET  /agents/:agentId/payout-address            PUT { address } (registered address; a change waits out the cooldown)
 *   POST /agents/:agentId/withdrawals               { amount }  reserve IDLE; paid from the Treasury to the registered address
 *   GET  /agents/:agentId/withdrawals
 *   admin: GET /admin/overview · /admin/{deposits,withdrawals,settlements,issues} · POST /admin/withdrawals/settle ·
 *          /admin/withdrawals/:id/decline · /admin/deposits/:id/retry · /admin/settlements/:id/retry ·
 *          /admin/issues/:id/resolve · /admin/reconcile · /admin/scan · GET|PUT /admin/settings
 */
import type { FastifyInstance } from 'fastify';
import { desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db/client.js';
import { audit } from '../../lib/audit.js';
import { requireAdmin, requirePerm } from '../../lib/auth.js';
import { config } from '../../lib/config.js';
import { AppError, notFound } from '../../lib/errors.js';
import { parse } from '../../lib/http.js';
import { getOwnedAgent } from '../../lib/tenancy.js';
import { registerJob } from '../../jobs/queue.js';
import { withdrawableIdle } from '../wallet/ledger.js';
import { depositView, processDepositSignature, retryFailedDeposit, scanAgentWallets } from './deposits.js';
import { countOpenSettlements, retryFailedSettlement, settlementView } from './fees.js';
import { listIssues, resolveIssue } from './issues.js';
import { getPayoutAddress, setPayoutAddress } from './payout-addresses.js';
import { runReconciliation } from './reconciliation.js';
import { getOnchainSettings, putOnchainSettings } from './settings.js';
import * as sol from './solana.js';
import { ONCHAIN_TICK_JOB, ensureOnchainTickScheduled, onchainTick } from './worker.js';
import { activePlatformWallet, ensureAgentWallet, ensurePlatformWallets, walletCount } from './wallets.js';
import { declineWithdrawal, listWithdrawals, reconcileProcessingWithdrawals, requestWithdrawal, settleWithdrawals, withdrawalView } from './withdrawals.js';
import './fees.js'; // registers the commission hook

const Id = z.string().uuid();
const AgentParam = z.object({ agentId: Id });
const ListQuery = z.object({ status: z.string().max(24).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });

export function registerJobs() {
  registerJob(ONCHAIN_TICK_JOB, async () => {
    try { await onchainTick(); } finally { await ensureOnchainTickScheduled(); }
  });
}

const enabled = () => {
  if (!config.ONCHAIN_ENABLED) throw new AppError(503, 'onchain_disabled', 'The on-chain wallet gateway is not enabled on this deployment.');
};

/** Best-effort on-chain balances for an address (never throws: the UI still renders if the RPC is down). */
async function balancesOf(address: string) {
  try {
    const b = await sol.getWalletBalances(address);
    const out: Record<string, string> = { SOL: sol.rawToDecimal(b.SOL ?? 0n, 9) };
    for (const [mint, v] of Object.entries(sol.supportedMints())) out[v.asset] = sol.rawToDecimal(b[mint] ?? 0n, v.decimals);
    return out;
  } catch { return null; }
}

const assetsInfo = () => Object.entries(sol.supportedMints()).map(([mint, v]) => ({ asset: v.asset, mint, decimals: v.decimals })).concat([{ asset: 'SOL' as const, mint: '', decimals: 9 }]);

export default async function routes(app: FastifyInstance) {
  app.get('/status', async (req) => {
    requireAdminOrAuth(req);
    const s = await getOnchainSettings();
    return {
      enabled: config.ONCHAIN_ENABLED, network: config.SOLANA_NETWORK, testNetwork: config.isTestNetwork,
      treasuryAddress: config.MID_WALLET_ADDRESS || null, revenueAddress: config.ADMIN_WALLET_ADDRESS || null,
      assets: assetsInfo(), minWithdrawalIdle: s.minWithdrawalIdle, payoutAddressCooldownHours: s.payoutAddressCooldownHours,
      note: '1 IDLE = 1 IDLEMINE. Deposits are swept into the Treasury and credited as whole IDLE; USDC/USDT are valued at 1 USD, SOL at the market price.',
    };
  });

  /* ───────────── agent wallet (owner) ───────────── */

  app.get('/agents/:agentId/wallet', async (req) => {
    const a = requirePerm(req, 'wallet.read');
    enabled();
    const { agentId } = parse(AgentParam, req.params);
    const agent = await getOwnedAgent(agentId, a.orgId);
    let wallet;
    try { wallet = await ensureAgentWallet(agent.id); } catch (e) { throw new AppError(503, 'wallet_unavailable', `The agent wallet could not be provisioned: ${e instanceof Error ? e.message : 'secret provider unavailable'}`); }
    const deposits = await db().select().from(schema.blockchainDeposits).where(eq(schema.blockchainDeposits.agentId, agent.id)).orderBy(desc(schema.blockchainDeposits.createdAt)).limit(20);
    const w = await withdrawableIdle(a.orgId);
    return {
      agentId: agent.id, address: wallet.publicAddress, network: config.SOLANA_NETWORK, assets: assetsInfo(),
      balances: await balancesOf(wallet.publicAddress), deposits: deposits.map((d) => depositView(d)), payoutAddress: await getPayoutAddress(agent.id),
      idle: w, treasuryAddress: config.MID_WALLET_ADDRESS || null, revenueAddress: config.ADMIN_WALLET_ADDRESS || null,
    };
  });

  app.post('/agents/:agentId/deposits/verify', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const a = requirePerm(req, 'wallet.purchase');
    enabled();
    const { agentId } = parse(AgentParam, req.params);
    const { txSignature } = parse(z.object({ txSignature: z.string().trim().min(80).max(100) }), req.body);
    const agent = await getOwnedAgent(agentId, a.orgId);
    const wallet = await ensureAgentWallet(agent.id);
    const rows = await processDepositSignature(txSignature, wallet, { detectedVia: 'api' });
    await audit({ action: 'onchain.deposit.verify', targetType: 'agent', targetId: agent.id, metadata: { txSignature, deposits: rows.length } }, req);
    return { deposits: rows.map((d) => depositView(d)) };
  });

  app.get('/agents/:agentId/deposits', async (req) => {
    const a = requirePerm(req, 'wallet.read');
    const { agentId } = parse(AgentParam, req.params);
    const agent = await getOwnedAgent(agentId, a.orgId);
    const q = parse(ListQuery, req.query);
    const rows = await db().select().from(schema.blockchainDeposits).where(eq(schema.blockchainDeposits.agentId, agent.id)).orderBy(desc(schema.blockchainDeposits.createdAt)).limit(q.limit);
    return { items: rows.map((d) => depositView(d)) };
  });

  app.get('/agents/:agentId/payout-address', async (req) => {
    const a = requirePerm(req, 'wallet.read');
    const { agentId } = parse(AgentParam, req.params);
    return getPayoutAddress((await getOwnedAgent(agentId, a.orgId)).id);
  });

  app.put('/agents/:agentId/payout-address', async (req) => {
    const a = requirePerm(req, 'wallet.payout');
    enabled();
    const { agentId } = parse(AgentParam, req.params);
    const { address } = parse(z.object({ address: z.string().trim().min(32).max(64) }), req.body);
    const agent = await getOwnedAgent(agentId, a.orgId);
    const out = await setPayoutAddress({ id: agent.id, orgId: agent.orgId, name: agent.name }, address);
    await audit({ action: 'onchain.payout_address.set', targetType: 'agent', targetId: agent.id, metadata: { address } }, req);
    return out;
  });

  app.post('/agents/:agentId/withdrawals', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const a = requirePerm(req, 'wallet.payout');
    enabled();
    const { agentId } = parse(AgentParam, req.params);
    const { amount } = parse(z.object({ amount: z.number().int().positive() }), req.body);
    const agent = await getOwnedAgent(agentId, a.orgId);
    const w = await requestWithdrawal({ id: agent.id, orgId: agent.orgId, name: agent.name }, a.user.id, amount);
    await audit({ action: 'onchain.withdrawal.request', targetType: 'onchain_withdrawal', targetId: w.id, metadata: { amount, destination: w.destinationWallet } }, req);
    return reply.status(201).send(withdrawalView(w));
  });

  app.get('/agents/:agentId/withdrawals', async (req) => {
    const a = requirePerm(req, 'wallet.read');
    const { agentId } = parse(AgentParam, req.params);
    const agent = await getOwnedAgent(agentId, a.orgId);
    return { items: (await listWithdrawals({ agentId: agent.id, limit: 50 })).map(withdrawalView) };
  });

  /* ───────────── admin: Treasury & Revenue ───────────── */

  app.get('/admin/overview', async (req) => {
    requireAdmin(req);
    await ensurePlatformWallets().catch(() => undefined);
    const mid = await activePlatformWallet('MID'); const admin = await activePlatformWallet('ADMIN');
    const byStatus = async (table: typeof schema.blockchainDeposits | typeof schema.onchainWithdrawals) => {
      const rows = await db().select({ s: table.status, n: sql<number>`count(*)::int` }).from(table).groupBy(table.status);
      return Object.fromEntries(rows.map((r) => [r.s, Number(r.n)]));
    };
    const [openIssues] = await db().select({ n: sql<number>`count(*)::int` }).from(schema.walletReconciliationIssues).where(eq(schema.walletReconciliationIssues.status, 'open'));
    const [feeTotal] = await db().select({ n: sql<string>`coalesce(sum(${schema.onchainSettlements.amountIdle}),0)::text` }).from(schema.onchainSettlements).where(eq(schema.onchainSettlements.status, 'completed'));
    return {
      enabled: config.ONCHAIN_ENABLED, network: config.SOLANA_NETWORK,
      flow: [
        { role: 'AGENT', label: 'Agent wallets', description: "Every agent's own deposit wallet — funds are swept out of it into the Treasury.", count: await walletCount() },
        { role: 'MID', label: 'Treasury (MID)', description: 'Holds the funds, pays gas and withdrawals.', address: mid?.publicAddress ?? null, balances: mid && config.ONCHAIN_ENABLED ? await balancesOf(mid.publicAddress) : null },
        { role: 'ADMIN', label: 'Revenue (ADMIN)', description: 'Only ever receives platform fees from the Treasury; its key is never loaded.', address: admin?.publicAddress ?? null, balances: admin && config.ONCHAIN_ENABLED ? await balancesOf(admin.publicAddress) : null },
      ],
      deposits: await byStatus(schema.blockchainDeposits), withdrawals: await byStatus(schema.onchainWithdrawals),
      openFeeTransfers: await countOpenSettlements(), feesSentIdle: Number(feeTotal?.n ?? 0), openIssues: Number(openIssues?.n ?? 0), settings: await getOnchainSettings(),
    };
  });

  app.get('/admin/deposits', async (req) => {
    requireAdmin(req);
    const q = parse(ListQuery, req.query);
    const rows = await db().select().from(schema.blockchainDeposits).where(q.status ? eq(schema.blockchainDeposits.status, q.status) : undefined).orderBy(desc(schema.blockchainDeposits.createdAt)).limit(q.limit);
    return { items: rows.map((d) => depositView(d, { admin: true })) };
  });
  app.get('/admin/withdrawals', async (req) => { requireAdmin(req); const q = parse(ListQuery, req.query); return { items: (await listWithdrawals({ status: q.status, limit: q.limit })).map(withdrawalView) }; });
  app.get('/admin/settlements', async (req) => {
    requireAdmin(req);
    const q = parse(ListQuery, req.query);
    const rows = await db().select().from(schema.onchainSettlements).where(q.status ? eq(schema.onchainSettlements.status, q.status) : undefined).orderBy(desc(schema.onchainSettlements.createdAt)).limit(q.limit);
    return { items: rows.map(settlementView) };
  });
  app.get('/admin/issues', async (req) => { requireAdmin(req); const q = parse(z.object({ status: z.enum(['open', 'resolved']).default('open') }), req.query); return { items: await listIssues(q.status) }; });

  app.post('/admin/withdrawals/settle', async (req) => {
    const a = requireAdmin(req); enabled();
    const { ids } = parse(z.object({ ids: z.array(Id).min(1).max(50) }), req.body);
    const results = await settleWithdrawals(ids);
    await audit({ action: 'onchain.withdrawal.settle', targetType: 'onchain_withdrawal', targetId: ids[0]!, actorUserId: a.user.id, actorType: 'admin', metadata: { ids, ok: results.filter((r) => r.ok).length } }, req);
    return { results };
  });
  app.post('/admin/withdrawals/reconcile', async (req) => { requireAdmin(req); enabled(); return { outcomes: await reconcileProcessingWithdrawals() }; });
  app.post('/admin/withdrawals/:id/decline', async (req) => {
    const a = requireAdmin(req);
    const { id } = parse(z.object({ id: Id }), req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().max(500).default('') }), req.body ?? {});
    const w = await declineWithdrawal(id, reason);
    await audit({ action: 'onchain.withdrawal.decline', targetType: 'onchain_withdrawal', targetId: id, actorUserId: a.user.id, actorType: 'admin', metadata: { reason } }, req);
    return withdrawalView(w);
  });
  app.post('/admin/deposits/:id/retry', async (req) => { requireAdmin(req); enabled(); return depositView(await retryFailedDeposit(parse(z.object({ id: Id }), req.params).id), { admin: true }); });
  app.post('/admin/settlements/:id/retry', async (req) => { requireAdmin(req); enabled(); return settlementView(await retryFailedSettlement(parse(z.object({ id: Id }), req.params).id)); });
  app.post('/admin/issues/:id/resolve', async (req) => {
    const a = requireAdmin(req);
    const { id } = parse(z.object({ id: Id }), req.params);
    const { note } = parse(z.object({ note: z.string().trim().min(3).max(1000) }), req.body);
    const out = await resolveIssue(id, note);
    if (!out) throw notFound('Open issue');
    await audit({ action: 'onchain.issue.resolve', targetType: 'wallet_reconciliation_issue', targetId: id, actorUserId: a.user.id, actorType: 'admin', metadata: { note } }, req);
    return out;
  });
  app.post('/admin/reconcile', async (req) => { requireAdmin(req); enabled(); await runReconciliation(); return { items: await listIssues('open') }; });
  app.post('/admin/scan', async (req) => { requireAdmin(req); enabled(); return scanAgentWallets(); });
  app.get('/admin/settings', async (req) => { requireAdmin(req); return getOnchainSettings(); });
  app.put('/admin/settings', async (req) => {
    const a = requireAdmin(req);
    const out = await putOnchainSettings(req.body, a.user.id);
    await audit({ action: 'onchain.settings.update', targetType: 'system_settings', targetId: a.user.id, actorUserId: a.user.id, actorType: 'admin', metadata: out }, req);
    return out;
  });
}

function requireAdminOrAuth(req: Parameters<typeof requirePerm>[0]) {
  if (!req.auth) throw new AppError(401, 'unauthorized', 'Authentication required');
}

