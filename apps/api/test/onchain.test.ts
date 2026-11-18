/**
 * On-chain wallets & payment gateway: agent wallet → Treasury (MID) → Revenue (ADMIN).
 * Everything runs against a fake chain that applies the REAL signed transactions (see fixtures/fake-chain.ts).
 *
 * Price used throughout: 1 IDLEMINE = 0.5 USD, 1 SOL = 100 USD  ⇒  1 USDC = 2 IDLE, 0.5 SOL = 100 IDLE.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { randomBytes } from 'node:crypto';
import { app, createUserDirect, database, loginAdmin, setup, teardown } from './helpers.js';
import { schema } from '../src/db/client.js';
import { config } from '../src/lib/config.js';
import { adminAdjustment, getOrCreateWallet, grantWelcomeBonus, purchaseKnowledge, reconcile, withdrawableIdle } from '../src/modules/wallet/ledger.js';
import { SecretUnavailableError, deriveFromSeed, getMidKeypair, getSecret, setSecretProviderForTests } from '../src/modules/onchain/keys.js';
import { setRpcForTests } from '../src/modules/onchain/solana.js';
import { activePlatformWallet, ensureAgentWallet, ensurePlatformWallets, platformControlled } from '../src/modules/onchain/wallets.js';
import { computeCredit, parseDepositLegs, processDepositSignature, resumeOpenDeposits } from '../src/modules/onchain/deposits.js';
import { SCALE, conservativeDepositQuote, toFixed } from '../src/modules/onchain/price.js';
import { getPayoutAddress, setPayoutAddress } from '../src/modules/onchain/payout-addresses.js';
import { putOnchainSettings } from '../src/modules/onchain/settings.js';
import { processOpenSettlements } from '../src/modules/onchain/fees.js';
import { declineWithdrawal, processAutoWithdrawals, reconcileProcessingWithdrawals, requestWithdrawal, settleWithdrawals } from '../src/modules/onchain/withdrawals.js';
import { runReconciliation } from '../src/modules/onchain/reconciliation.js';
import { listIssues } from '../src/modules/onchain/issues.js';
import { onchainTick, resetTickTimersForTests } from '../src/modules/onchain/worker.js';
import { FakeChain, newAddress } from './fixtures/fake-chain.js';

type Owner = Awaited<ReturnType<typeof createUserDirect>>;
const cfg = config as Record<string, any>;

const USDC = newAddress(); const USDT = newAddress(); const IDLE = newAddress();
const mid = Keypair.generate();
const ADMIN_ADDR = newAddress();
const MASTER_SEED = randomBytes(32).toString('hex');
let chain: FakeChain;

const saved = { ...config };
beforeAll(async () => {
  await setup();
  Object.assign(cfg, {
    ONCHAIN_ENABLED: true, isTestNetwork: true, SOLANA_NETWORK: 'solana-devnet', USDC_MINT: USDC, USDT_MINT: USDT, IDLEMINE_MINT: IDLE,
    USDC_DECIMALS: 6, USDT_DECIMALS: 6, IDLEMINE_DECIMALS: 9, MID_WALLET_ADDRESS: mid.publicKey.toBase58(), ADMIN_WALLET_ADDRESS: ADMIN_ADDR,
    TEST_IDLEMINE_USD_PRICE: '0.5', TEST_SOL_USD_PRICE: '100', ONCHAIN_MAX_ATTEMPTS: 3,
  });
  setSecretProviderForTests(async (id) => {
    if (id === cfg.WALLET_MASTER_SEED_SECRET_ID) return MASTER_SEED;
    if (id === cfg.MID_WALLET_KEY_SECRET_ID) return bs58.encode(mid.secretKey);
    throw new Error(`unknown secret ${id}`);
  });
  await ensurePlatformWallets();
});
afterAll(async () => { Object.assign(cfg, saved); setRpcForTests(null); setSecretProviderForTests(null); await teardown(); });

beforeEach(() => {
  chain = new FakeChain();
  for (const [m, d] of [[USDC, 6], [USDT, 6], [IDLE, 9]] as const) chain.mint(m, d);
  chain.airdrop(mid.publicKey.toBase58(), 10_000_000_000n); // gas
  chain.fund(mid.publicKey.toBase58(), IDLE, 1_000_000n * 10n ** 9n); // IDLEMINE inventory for withdrawals / fees
  setRpcForTests(chain.rpc);
  cfg.ONCHAIN_ENABLED = true; resetTickTimersForTests();
});

async function makeAgent(owner: Owner, name = 'Wallet Agent') {
  const [p] = await database.select().from(schema.agentProviders).where(eq(schema.agentProviders.slug, 'sandbox'));
  const [a] = await database.insert(schema.agents).values({ orgId: owner.orgId, ownerId: owner.userId, providerId: p!.id, slug: `${name.toLowerCase().replace(/\W+/g, '-')}-${Math.random().toString(36).slice(2, 8)}`, name, modelName: 'aix-sandbox-1', status: 'active', permissions: {} }).returning();
  return a!;
}
const idleOf = async (orgId: string) => (await getOrCreateWallet(orgId)).available;
const MID = () => mid.publicKey.toBase58();
const external = () => newAddress();

/** Send `raw` of `asset` into the agent's wallet from an outside wallet and run the whole pipeline. */
async function depositAndProcess(agentId: string, asset: string, raw: bigint, opts: { from?: string } = {}) {
  const wallet = await ensureAgentWallet(agentId);
  const sig = chain.deposit({ from: opts.from ?? external(), to: wallet.publicAddress, asset, raw });
  const rows = await processDepositSignature(sig, wallet, { detectedVia: 'api', waitSecs: 0 });
  return { wallet, sig, rows };
}

describe('keys & wallets', () => {
  it('derives one deterministic wallet per agent; never stores a key; the Treasury key must match its address', async () => {
    const seed = Buffer.from(MASTER_SEED, 'hex');
    const id = crypto.randomUUID();
    expect(deriveFromSeed(seed, 'agent-wallet', id, 1).publicKey.toBase58()).toBe(deriveFromSeed(seed, 'agent-wallet', id, 1).publicKey.toBase58());
    expect(deriveFromSeed(seed, 'agent-wallet', id, 2).publicKey.toBase58()).not.toBe(deriveFromSeed(seed, 'agent-wallet', id, 1).publicKey.toBase58());
    expect(deriveFromSeed(seed, 'other-scope', id, 1).publicKey.toBase58()).not.toBe(deriveFromSeed(seed, 'agent-wallet', id, 1).publicKey.toBase58());
    expect(() => deriveFromSeed(seed, 'a/b', id, 1)).toThrow();

    const owner = await createUserDirect();
    const [a1, a2] = [await makeAgent(owner, 'One'), await makeAgent(owner, 'Two')];
    const w1 = await ensureAgentWallet(a1.id); const w1b = await ensureAgentWallet(a1.id); const w2 = await ensureAgentWallet(a2.id);
    expect(w1b.id).toBe(w1.id);
    expect(w1.publicAddress).not.toBe(w2.publicAddress);
    expect(w1).toMatchObject({ role: 'AGENT', keySource: 'derived', status: 'active' });
    expect(JSON.stringify(w1)).not.toMatch(/secret|private|seed/i);
    // concurrent provisioning can never create two wallets
    const a3 = await makeAgent(owner, 'Three');
    const ws = await Promise.all([ensureAgentWallet(a3.id), ensureAgentWallet(a3.id), ensureAgentWallet(a3.id)]);
    expect(new Set(ws.map((w) => w.id)).size).toBe(1);

    expect((await getMidKeypair()).publicKey.toBase58()).toBe(MID());
    const saved = cfg.MID_WALLET_ADDRESS; cfg.MID_WALLET_ADDRESS = newAddress();
    await expect(getMidKeypair()).rejects.toBeInstanceOf(SecretUnavailableError);
    cfg.MID_WALLET_ADDRESS = saved;
  });

  it('refuses the env secret provider in production', async () => {
    setSecretProviderForTests(null);
    const prev = { isProd: cfg.isProd, SECRET_PROVIDER: cfg.SECRET_PROVIDER };
    Object.assign(cfg, { isProd: true, SECRET_PROVIDER: 'env', DEV_WALLET_MASTER_SEED_HEX: MASTER_SEED });
    await expect(getSecret(cfg.WALLET_MASTER_SEED_SECRET_ID)).rejects.toThrow(/refused in production/);
    Object.assign(cfg, prev);
    setSecretProviderForTests(async (id) => (id === cfg.WALLET_MASTER_SEED_SECRET_ID ? MASTER_SEED : bs58.encode(mid.secretKey)));
  });

  it('mirrors the Treasury and Revenue wallets and treats every platform wallet as internal', async () => {
    expect((await activePlatformWallet('MID'))?.publicAddress).toBe(MID());
    expect((await activePlatformWallet('ADMIN'))?.publicAddress).toBe(ADMIN_ADDR);
    expect((await activePlatformWallet('ADMIN'))?.keySource).toBe('external'); // its key is never available to the app
    const owner = await createUserDirect(); const w = await ensureAgentWallet((await makeAgent(owner)).id);
    const stranger = newAddress();
    expect([...await platformControlled([MID(), ADMIN_ADDR, w.publicAddress, stranger])].sort()).toEqual([MID(), ADMIN_ADDR, w.publicAddress].sort());
  });
});

describe('amounts & pricing (exact, no floats)', () => {
  it('computes credit in fixed point and floors to whole IDLE', () => {
    const q = (idle: string, asset: string | null) => ({ idlemineUsdPrice: toFixed(idle), assetUsdPrice: asset ? toFixed(asset) : null, source: 't', quotedAt: new Date() });
    expect(computeCredit('USDC', 10_000_000n, 6, { ...q('0.5', '1') })).toMatchObject({ idle: 20 });
    expect(computeCredit('USDC', 999_999n, 6, { ...q('0.5', '1') }).idle).toBe(1); // 1.999998 IDLE → 1
    expect(computeCredit('IDLEMINE', 5_500_000_000n, 9, { ...q('0.5', null) }).idle).toBe(5); // 1:1, never through USD
    expect(computeCredit('SOL', 500_000_000n, 9, { ...q('0.5', '100') }).idle).toBe(100);
    expect(toFixed('1e-7')).toBe(SCALE / 10n ** 7n);
    expect(() => computeCredit('SOL', 1n, 9, { ...q('0.5', null) })).toThrow(/price unavailable/);
  });

  it('values a deposit at the price LEAST favourable to the depositor (median floor against a dip)', async () => {
    for (let i = 0; i < 5; i++) await database.insert(schema.tokenPriceSamples).values({ mint: IDLE, usdPrice: '0.5', source: 'test' });
    cfg.TEST_IDLEMINE_USD_PRICE = '0.4'; // a dip right now
    const quote = await conservativeDepositQuote('USDC', null, 0.05);
    cfg.TEST_IDLEMINE_USD_PRICE = '0.5';
    expect(quote.idlemineUsdPrice).toBe(toFixed('0.475')); // floor = median × (1 − 5 %)
    expect(quote.source).toMatch(/median-floor/);
    expect(computeCredit('USDC', 10_000_000n, 6, quote).idle).toBe(21); // 10 / 0.475 = 21.05, not the 25 a dip would have given
  });
});

describe('deposit parsing', () => {
  const tx = (o: { pre?: any[]; post?: any[]; lamports?: [number, number] }) => ({
    meta: { preBalances: [o.lamports?.[0] ?? 0, 0], postBalances: [o.lamports?.[1] ?? 0, 0], preTokenBalances: o.pre ?? [], postTokenBalances: o.post ?? [] },
    transaction: { message: { accountKeys: [{ pubkey: 'WALLET' }, { pubkey: 'SENDER' }] } },
  });
  const bal = (mint: string, owner: string, amount: string, decimals: number, idx = 0) => ({ accountIndex: idx, mint, owner, programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', uiTokenAmount: { amount, decimals } });
  it('credits only supported mints with the right decimals, into the wallet itself', () => {
    const ok = parseDepositLegs(tx({ pre: [bal(USDC, 'WALLET', '0', 6)], post: [bal(USDC, 'WALLET', '5000000', 6)] }), 'WALLET');
    expect(ok).toHaveLength(1); expect(ok[0]).toMatchObject({ asset: 'USDC', rawAmount: 5_000_000n });
    expect(parseDepositLegs(tx({ pre: [bal(USDC, 'WALLET', '0', 9)], post: [bal(USDC, 'WALLET', '5000000', 9)] }), 'WALLET')).toHaveLength(0); // wrong decimals
    expect(parseDepositLegs(tx({ pre: [bal(newAddress(), 'WALLET', '0', 6)], post: [bal(newAddress(), 'WALLET', '5', 6)] }), 'WALLET')).toHaveLength(0); // unsupported token
    expect(parseDepositLegs(tx({ pre: [bal(USDC, 'SOMEONE_ELSE', '0', 6)], post: [bal(USDC, 'SOMEONE_ELSE', '5', 6)] }), 'WALLET')).toHaveLength(0); // not our wallet
    expect(parseDepositLegs(tx({ lamports: [0, 7] }), 'WALLET')[0]).toMatchObject({ asset: 'SOL', rawAmount: 7n });
  });
});

describe('deposits: agent wallet → Treasury → credited IDLE', () => {
  it('verifies, sweeps into the Treasury, credits exactly once, and the ledger stays balanced', async () => {
    const owner = await createUserDirect(); const agent = await makeAgent(owner);
    const { wallet, sig, rows } = await depositAndProcess(agent.id, USDC, 10_000_000n);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'credited', asset: 'USDC', idleCredited: 20, priceSource: expect.stringMatching(/^now/) });
    expect(rows[0]!.sweepSignature).toBeTruthy();
    expect(chain.tokenBalance(MID(), USDC)).toBe(10_000_000n); // arrived in the Treasury
    expect(chain.tokenBalance(wallet.publicAddress, USDC)).toBe(0n); // swept out of the agent wallet
    expect(await idleOf(owner.orgId)).toBe(20);
    expect((await reconcile((await getOrCreateWallet(owner.orgId)).id)).ok).toBe(true);
    // the same transaction again: no chain work, no money
    const callsBefore = chain.calls.length;
    const again = await processDepositSignature(sig, wallet, { detectedVia: 'api', waitSecs: 0 });
    expect(again[0]!.status).toBe('credited'); expect(chain.calls.length).toBe(callsBefore);
    expect(await idleOf(owner.orgId)).toBe(20);
    expect(chain.tokenBalance(MID(), USDC)).toBe(10_000_000n);
  });

  it('survives three racing verify calls for the same deposit (one sweep, one credit)', async () => {
    const owner = await createUserDirect(); const agent = await makeAgent(owner);
    const wallet = await ensureAgentWallet(agent.id);
    const sig = chain.deposit({ from: external(), to: wallet.publicAddress, asset: USDC, raw: 5_000_000n });
    await Promise.allSettled([1, 2, 3].map(() => processDepositSignature(sig, wallet, { detectedVia: 'api', waitSecs: 0 })));
    await resumeOpenDeposits();
    const rows = await database.select().from(schema.blockchainDeposits).where(eq(schema.blockchainDeposits.txSignature, sig));
    expect(rows).toHaveLength(1); expect(rows[0]!.status).toBe('credited');
    expect(await idleOf(owner.orgId)).toBe(10);
    expect(chain.tokenBalance(MID(), USDC)).toBe(5_000_000n);
    const credits = await database.select().from(schema.transactions).where(eq(schema.transactions.idempotencyKey, `onchain:deposit:${rows[0]!.id}`));
    expect(credits).toHaveLength(1);
  });

  it('1 IDLEMINE = 1 IDLE (no price needed); SOL keeps the rent reserve and credits only what was swept', async () => {
    const owner = await createUserDirect(); const agent = await makeAgent(owner);
    const wallet = await ensureAgentWallet(agent.id);
    const idle = await depositAndProcess(agent.id, IDLE, 7_500_000_000n);
    expect(idle.rows[0]).toMatchObject({ status: 'credited', idleCredited: 7 }); // 7.5 → 7 whole IDLE; the half stays in the Treasury
    expect(chain.tokenBalance(MID(), IDLE)).toBe(1_000_000n * 10n ** 9n + 7_500_000_000n);

    chain.airdrop(wallet.publicAddress, 500_000n); // dust already in the wallet: sweeping everything would break rent exemption
    const solDep = await depositAndProcess(agent.id, 'SOL', 500_000_000n);
    expect(solDep.rows[0]).toMatchObject({ status: 'credited', idleCredited: 99 }); // 100 IDLE × (swept / deposited) floored
    expect(chain.solBalance(wallet.publicAddress)).toBe(890_880n); // the rent reserve stays
    expect(await idleOf(owner.orgId)).toBe(7 + 99);
  });

  it('never credits an internal platform transfer, dust, or a wrong-asset transfer', async () => {
    const owner = await createUserDirect(); const agent = await makeAgent(owner); const other = await makeAgent(owner, 'Other');
    const otherWallet = await ensureAgentWallet(other.id);
    const internal = await depositAndProcess(agent.id, USDC, 10_000_000n, { from: otherWallet.publicAddress });
    expect(internal.rows[0]).toMatchObject({ status: 'rejected', rejectionReason: 'internal_transfer' });
    const fromMid = await depositAndProcess(agent.id, USDT, 10_000_000n, { from: MID() });
    expect(fromMid.rows[0]).toMatchObject({ status: 'rejected', rejectionReason: 'internal_transfer' });
    const dust = await depositAndProcess(agent.id, USDC, 400_000n); // 0.8 IDLE
    expect(dust.rows[0]).toMatchObject({ status: 'rejected', rejectionReason: 'below_minimum' });
    const w = await ensureAgentWallet(agent.id);
    await expect(processDepositSignature(chain.deposit({ from: external(), to: newAddress(), asset: USDC, raw: 5_000_000n }), w, { detectedVia: 'api', waitSecs: 0 })).rejects.toThrow(/does not transfer/);
    expect(await idleOf(owner.orgId)).toBe(0);
  });

  it('a transaction that is unknown, malformed or failed is refused', async () => {
    const owner = await createUserDirect(); const w = await ensureAgentWallet((await makeAgent(owner)).id);
    await expect(processDepositSignature('not-a-signature', w, { detectedVia: 'api', waitSecs: 0 })).rejects.toThrow(/valid Solana transaction signature/);
    await expect(processDepositSignature(bs58.encode(randomBytes(64)), w, { detectedVia: 'api', waitSecs: 0 })).rejects.toThrow(/not found or not finalized/);
  });

  it('a sweep that never lands is re-signed ONLY after the chain proves it expired — and the funds move once', async () => {
    const owner = await createUserDirect(); const agent = await makeAgent(owner);
    chain.mode = 'drop';
    const { rows, wallet } = await depositAndProcess(agent.id, USDC, 10_000_000n);
    expect(rows[0]!.status).toBe('sweeping');
    const firstSig = rows[0]!.sweepSignature!;
    expect(chain.landed.has(firstSig)).toBe(false);
    // still within the blockhash window: the SAME bytes are rebroadcast, never a new transaction
    await resumeOpenDeposits();
    const [still] = await database.select().from(schema.blockchainDeposits).where(eq(schema.blockchainDeposits.id, rows[0]!.id));
    expect(still!.sweepSignature).toBe(firstSig); expect(chain.rebroadcasts).toBeGreaterThan(0);
    // the chain moves far past the blockhash validity: now (and only now) it is provably safe to sign a fresh sweep
    chain.advance(400);
    await resumeOpenDeposits();
    const [resigned] = await database.select().from(schema.blockchainDeposits).where(eq(schema.blockchainDeposits.id, rows[0]!.id));
    expect(resigned!.status).toBe('sweeping'); expect(resigned!.sweepSignature).not.toBe(firstSig);
    chain.mode = 'normal';
    await resumeOpenDeposits(); // the signed bytes are rebroadcast and now land
    await resumeOpenDeposits(); // the chain confirms that exact signature: swept → credited
    const [done] = await database.select().from(schema.blockchainDeposits).where(eq(schema.blockchainDeposits.id, rows[0]!.id));
    expect(done!.status).toBe('credited');
    expect(chain.tokenBalance(MID(), USDC)).toBe(10_000_000n);
    expect(chain.tokenBalance(wallet.publicAddress, USDC)).toBe(0n);
    expect(await idleOf(owner.orgId)).toBe(20);
  });

  it('parks a deposit whose funds are missing and raises a critical issue', async () => {
    const owner = await createUserDirect(); const agent = await makeAgent(owner);
    const wallet = await ensureAgentWallet(agent.id);
    const sig = chain.deposit({ from: external(), to: wallet.publicAddress, asset: USDC, raw: 5_000_000n });
    chain.tokens.get(chain.ata(wallet.publicAddress, USDC))!.amount = 0n; // the funds vanish before the sweep
    const rows = await processDepositSignature(sig, wallet, { detectedVia: 'api', waitSecs: 0 });
    expect(rows[0]!.status).toBe('failed');
    expect((await listIssues('open')).some((i) => i.kind === 'deposit_funds_missing' && i.refKey === rows[0]!.id)).toBe(true);
    expect(await idleOf(owner.orgId)).toBe(0);
  });

  it('the scanner finds deposits the owner never verified, through the same pipeline', async () => {
    const owner = await createUserDirect(); const agent = await makeAgent(owner); const wallet = await ensureAgentWallet(agent.id);
    chain.deposit({ from: external(), to: wallet.publicAddress, asset: USDC, raw: 3_000_000n });
    const { scanAgentWallets } = await import('../src/modules/onchain/deposits.js');
    const stats = await scanAgentWallets();
    expect(stats.newDeposits).toBeGreaterThanOrEqual(1);
    await resumeOpenDeposits();
    expect(await idleOf(owner.orgId)).toBe(6);
    const again = await scanAgentWallets(); expect(again.newDeposits).toBe(0);
    expect(await idleOf(owner.orgId)).toBe(6);
  });
});

describe('withdrawals: Treasury → the agent\'s registered address', () => {
  async function funded(idle = 20) {
    const owner = await createUserDirect(); const agent = await makeAgent(owner);
    await depositAndProcess(agent.id, USDC, BigInt(idle / 2) * 1_000_000n);
    const a = { id: agent.id, orgId: agent.orgId, name: agent.name };
    const dest = Keypair.generate().publicKey.toBase58();
    await setPayoutAddress(a, dest);
    return { owner, agent, a, dest };
  }

  it('pays once from the Treasury, burns the reserved IDLE, and never pays twice', async () => {
    const { owner, a, dest } = await funded();
    const w = await requestWithdrawal(a, owner.userId, 10);
    const wallet = await getOrCreateWallet(owner.orgId);
    expect(wallet).toMatchObject({ available: 10, locked: 10 }); // reserved at request time
    const [r1] = await settleWithdrawals([w.id], { waitSecs: 0 });
    expect(r1).toMatchObject({ ok: true });
    const after = await getOrCreateWallet(owner.orgId);
    expect(after).toMatchObject({ available: 10, locked: 0 });
    expect(chain.tokenBalance(dest, IDLE)).toBe(10n * 10n ** 9n);
    expect((await reconcile(after.id)).ok).toBe(true);
    const [r2] = await settleWithdrawals([w.id], { waitSecs: 0 });
    expect(r2!.ok).toBe(false);
    expect(chain.tokenBalance(dest, IDLE)).toBe(10n * 10n ** 9n);
    const [row] = await database.select().from(schema.onchainWithdrawals).where(eq(schema.onchainWithdrawals.id, w.id));
    expect(row).toMatchObject({ status: 'completed', payoutTxB64: null, payoutSource: 'mid' });
  });

  it('a payout that never lands is retried only after it provably expired — paid exactly once', async () => {
    const { owner, a, dest } = await funded();
    const w = await requestWithdrawal(a, owner.userId, 10);
    chain.mode = 'drop';
    const [sent] = await settleWithdrawals([w.id], { waitSecs: 0 });
    expect(sent).toMatchObject({ ok: false }); expect(sent!.error).toMatch(/left 'processing'/);
    const [processing] = await database.select().from(schema.onchainWithdrawals).where(eq(schema.onchainWithdrawals.id, w.id));
    expect(processing!.status).toBe('processing');
    await reconcileProcessingWithdrawals(); // still could land: same bytes rebroadcast, status stays
    expect((await database.select().from(schema.onchainWithdrawals).where(eq(schema.onchainWithdrawals.id, w.id)))[0]!.status).toBe('processing');
    chain.advance(400);
    await reconcileProcessingWithdrawals();
    const [back] = await database.select().from(schema.onchainWithdrawals).where(eq(schema.onchainWithdrawals.id, w.id));
    expect(back).toMatchObject({ status: 'pending', attempts: 1, txSignature: null });
    expect(chain.tokenBalance(dest, IDLE)).toBe(0n); // nothing moved
    chain.mode = 'normal';
    expect((await settleWithdrawals([w.id], { waitSecs: 0 }))[0]!.ok).toBe(true);
    expect(chain.tokenBalance(dest, IDLE)).toBe(10n * 10n ** 9n);
  });

  it('will not sign a payout the Treasury cannot cover (raises an issue instead of failing on-chain)', async () => {
    const { owner, a } = await funded();
    chain.tokens.get(chain.ata(MID(), IDLE))!.amount = 0n;
    const w = await requestWithdrawal(a, owner.userId, 10);
    const [r] = await settleWithdrawals([w.id], { waitSecs: 0 });
    expect(r!.ok).toBe(false); expect(r!.error).toMatch(/does not hold enough IDLEMINE/);
    expect((await database.select().from(schema.onchainWithdrawals).where(eq(schema.onchainWithdrawals.id, w.id)))[0]!.status).toBe('pending');
    expect((await listIssues('open')).some((i) => i.kind === 'treasury_underfunded' && i.refKey === w.id)).toBe(true);
  });

  it('declining refunds the reserve; only the unspent welcome bonus is non-withdrawable', async () => {
    const { owner, a } = await funded();
    const w = await requestWithdrawal(a, owner.userId, 10);
    await declineWithdrawal(w.id, 'looks suspicious');
    expect(await getOrCreateWallet(owner.orgId)).toMatchObject({ available: 20, locked: 0 });
    await expect(declineWithdrawal(w.id, 'again')).rejects.toThrow(/already failed/);

    await grantWelcomeBonus(owner.userId); // +1000 IDLE that no deposit backs
    expect(await withdrawableIdle(owner.orgId)).toMatchObject({ available: 1020, unspentBonus: 1000, withdrawable: 20 });
    await expect(requestWithdrawal(a, owner.userId, 100)).rejects.toThrow(/welcome bonus has to be spent first/);
    await expect(requestWithdrawal(a, owner.userId, 5)).rejects.toThrow(/Minimum withdrawal/);
    expect((await reconcile((await getOrCreateWallet(owner.orgId)).id)).ok).toBe(true);
  });

  it('two simultaneous requests can never dip into the unbacked welcome bonus', async () => {
    const { owner, a } = await funded(20);
    await grantWelcomeBonus(owner.userId); // available 1020, withdrawable 20
    const results = await Promise.allSettled([requestWithdrawal(a, owner.userId, 15), requestWithdrawal(a, owner.userId, 15)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const w = await withdrawableIdle(owner.orgId);
    expect(w.withdrawable).toBeGreaterThanOrEqual(0);
    expect((await getOrCreateWallet(owner.orgId)).locked).toBe(15);
    expect((await reconcile((await getOrCreateWallet(owner.orgId)).id)).ok).toBe(true);
  });

  it('enforces per-request and daily limits', async () => {
    const { owner, a } = await funded(100);
    await putOnchainSettings({ maxWithdrawalPerRequestIdle: 30, maxDailyWithdrawalIdle: 50 }, null);
    await expect(requestWithdrawal(a, owner.userId, 40)).rejects.toThrow(/Maximum withdrawal per request is 30/);
    await requestWithdrawal(a, owner.userId, 30);
    await expect(requestWithdrawal(a, owner.userId, 25)).rejects.toThrow(/Daily withdrawal limit is 50/);
    await putOnchainSettings({ maxWithdrawalPerRequestIdle: 0, maxDailyWithdrawalIdle: 0 }, null);
  });

  it('automatic payouts need an explicit cap; bigger requests wait for an admin', async () => {
    const { owner, a, dest } = await funded(100);
    const small = await requestWithdrawal(a, owner.userId, 10); const big = await requestWithdrawal(a, owner.userId, 60);
    await putOnchainSettings({ autoWithdrawalsEnabled: true, autoWithdrawalMaxIdle: 0 }, null);
    expect(await processAutoWithdrawals()).toBe(0); // enabled but no cap ⇒ nothing is automatic
    await putOnchainSettings({ autoWithdrawalsEnabled: true, autoWithdrawalMaxIdle: 20 }, null);
    expect(await processAutoWithdrawals()).toBeGreaterThanOrEqual(1);
    expect((await database.select().from(schema.onchainWithdrawals).where(eq(schema.onchainWithdrawals.id, small.id)))[0]!.status).toBe('completed');
    expect((await database.select().from(schema.onchainWithdrawals).where(eq(schema.onchainWithdrawals.id, big.id)))[0]!.status).toBe('pending');
    expect(chain.tokenBalance(dest, IDLE)).toBe(10n * 10n ** 9n);
    await putOnchainSettings({ autoWithdrawalsEnabled: false, autoWithdrawalMaxIdle: 0 }, null);
  });

  it('a payout address change waits out the cooldown; token accounts and platform wallets are refused', async () => {
    const owner = await createUserDirect(); const agent = await makeAgent(owner); const a = { id: agent.id, orgId: agent.orgId, name: agent.name };
    const first = Keypair.generate().publicKey.toBase58(); const second = Keypair.generate().publicKey.toBase58();
    expect((await setPayoutAddress(a, first)).activeAddress).toBe(first); // the first one is active immediately
    const changed = await setPayoutAddress(a, second);
    expect(changed).toMatchObject({ activeAddress: first, pendingAddress: second });
    expect(changed.pendingEffectiveAt!.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    expect((await setPayoutAddress(a, first)).pendingAddress).toBeNull(); // changing back cancels the change
    await setPayoutAddress(a, second);
    await database.update(schema.agentPayoutAddresses).set({ effectiveAt: new Date(Date.now() - 1000) }).where(and(eq(schema.agentPayoutAddresses.agentId, agent.id), eq(schema.agentPayoutAddresses.status, 'pending')));
    expect(await getPayoutAddress(agent.id)).toMatchObject({ activeAddress: second, pendingAddress: null });
    await expect(setPayoutAddress(a, chain.ata(first, IDLE))).rejects.toThrow(/wallet \(owner\) address/); // a token account would strand the funds
    await expect(setPayoutAddress(a, MID())).rejects.toThrow(/Hive Mind-controlled/);
    await expect(setPayoutAddress(a, 'nope')).rejects.toThrow();
    const noAddress = await makeAgent(owner, 'NoAddr');
    await expect(requestWithdrawal({ id: noAddress.id, orgId: noAddress.orgId, name: 'x' }, owner.userId, 10)).rejects.toThrow(/Register a payout address/);
  });
});

describe('platform fee: Treasury → Revenue', () => {
  async function knowledgeSale(price = 100) {
    const seller = await createUserDirect(); const buyer = await createUserDirect();
    const [src] = await database.insert(schema.knowledgeSources).values({ orgId: seller.orgId, ownerId: seller.userId, name: 'Pack', type: 'text' }).returning();
    const [listing] = await database.insert(schema.knowledgeListings).values({ sourceId: src!.id, orgId: seller.orgId, contributorId: seller.userId, title: 'Pack', category: 'dataset', licence: 'proprietary', ownershipAttested: true, priceCredits: price, status: 'active', moderation: 'verified' }).returning();
    await adminAdjustment({ orgId: buyer.orgId, amount: 1000, reason: 'test', actorUserId: buyer.userId });
    await purchaseKnowledge({ listingId: listing!.id, buyerOrgId: buyer.orgId, buyerUserId: buyer.userId });
    return { listing: listing!, seller, buyer };
  }

  it('every booked commission becomes one on-chain fee, sent Treasury → Revenue exactly once', async () => {
    const { listing } = await knowledgeSale(100); // 20 % platform commission
    const fees = await database.select().from(schema.onchainSettlements).where(eq(schema.onchainSettlements.sourceId, listing.id));
    expect(fees).toHaveLength(1);
    expect(fees[0]).toMatchObject({ kind: 'platform_fee', status: 'pending', amountIdle: 20, sourceWallet: MID(), destinationWallet: ADMIN_ADDR });
    await processOpenSettlements({ waitSecs: 0 });
    const [done] = await database.select().from(schema.onchainSettlements).where(eq(schema.onchainSettlements.id, fees[0]!.id));
    expect(done).toMatchObject({ status: 'completed', pendingSignature: null, pendingTxB64: null }); expect(done!.transferSignature).toBeTruthy();
    expect(chain.tokenBalance(ADMIN_ADDR, IDLE)).toBe(20n * 10n ** 9n);
    await processOpenSettlements({ waitSecs: 0 });
    expect(chain.tokenBalance(ADMIN_ADDR, IDLE)).toBe(20n * 10n ** 9n);
    // the Revenue wallet never signed anything: only the Treasury's signature is on the transfer
    expect(chain.landed.get(done!.transferSignature!)!.err).toBeNull();
  });

  it('a fee that never lands is re-signed only after it provably expired; gas runs low → an issue is raised', async () => {
    const { listing } = await knowledgeSale(200); // 40 IDLE
    chain.mode = 'drop';
    await processOpenSettlements({ waitSecs: 0 });
    const [sending] = await database.select().from(schema.onchainSettlements).where(eq(schema.onchainSettlements.sourceId, listing.id));
    expect(sending).toMatchObject({ status: 'sending', attemptCount: 1 }); const first = sending!.pendingSignature!;
    await processOpenSettlements({ waitSecs: 0 });
    expect((await database.select().from(schema.onchainSettlements).where(eq(schema.onchainSettlements.sourceId, listing.id)))[0]!.pendingSignature).toBe(first);
    chain.advance(400); chain.mode = 'normal';
    await processOpenSettlements({ waitSecs: 0 }); // expired → pending → re-signed → lands
    await processOpenSettlements({ waitSecs: 0 });
    const [done] = await database.select().from(schema.onchainSettlements).where(eq(schema.onchainSettlements.sourceId, listing.id));
    expect(done!.status).toBe('completed');
    expect(chain.tokenBalance(ADMIN_ADDR, IDLE)).toBe(40n * 10n ** 9n);
    chain.lamports.set(MID(), 1000n);
    await runReconciliation();
    expect((await listIssues('open')).some((i) => i.kind === 'mid_low_sol')).toBe(true);
  });

  it('does nothing when the gateway is off or the fee mirror is disabled', async () => {
    cfg.ONCHAIN_ENABLED = false;
    const off = await knowledgeSale(100);
    expect(await database.select().from(schema.onchainSettlements).where(eq(schema.onchainSettlements.sourceId, off.listing.id))).toHaveLength(0);
    cfg.ONCHAIN_ENABLED = true;
    await putOnchainSettings({ feeMirrorEnabled: false }, null);
    const mirrorOff = await knowledgeSale(100);
    expect(await database.select().from(schema.onchainSettlements).where(eq(schema.onchainSettlements.sourceId, mirrorOff.listing.id))).toHaveLength(0);
    await putOnchainSettings({ feeMirrorEnabled: true }, null);
  });
});

describe('reconciliation & worker', () => {
  it('raises (never fixes) an issue for an agent wallet left unswept and for an underfunded Treasury', async () => {
    const owner = await createUserDirect(); const agent = await makeAgent(owner);
    const { wallet } = await depositAndProcess(agent.id, USDC, 10_000_000n);
    chain.fund(wallet.publicAddress, USDC, 5n); // something is left behind after the last sweep
    await runReconciliation();
    const issues = await listIssues('open');
    expect(issues.some((i) => i.kind === 'agent_wallet_unswept_balance' && i.refKey === wallet.publicAddress)).toBe(true);
    expect(chain.tokenBalance(wallet.publicAddress, USDC)).toBe(5n); // untouched: an admin reviews it
    const before = (await listIssues('open')).length;
    await runReconciliation();
    expect((await listIssues('open')).length).toBe(before); // re-detection refreshes the open issue instead of piling up copies
  });

  it('one worker tick provisions wallets, resumes deposits and pays fees without any other trigger', async () => {
    const owner = await createUserDirect(); const agent = await makeAgent(owner);
    await onchainTick();
    expect(await database.select().from(schema.solanaWallets).where(eq(schema.solanaWallets.agentId, agent.id))).toHaveLength(1);
    const wallet = await ensureAgentWallet(agent.id);
    chain.mode = 'drop';
    await processDepositSignature(chain.deposit({ from: external(), to: wallet.publicAddress, asset: USDC, raw: 4_000_000n }), wallet, { detectedVia: 'api', waitSecs: 0 });
    chain.mode = 'normal';
    await onchainTick(); // same bytes rebroadcast: the sweep lands
    resetTickTimersForTests();
    await onchainTick(); // the chain now confirms it: swept → credited
    expect(await idleOf(owner.orgId)).toBe(8);
  });
});

describe('HTTP API', () => {
  it('is closed when the gateway is off, owner-scoped when on, and admin-only for the Treasury', async () => {
    const owner = await createUserDirect(); const stranger = await createUserDirect(); const agent = await makeAgent(owner);
    cfg.ONCHAIN_ENABLED = false;
    expect((await owner.request('GET', `/onchain/agents/${agent.id}/wallet`)).status).toBe(503);
    expect((await owner.request('GET', '/onchain/status')).body.enabled).toBe(false);
    cfg.ONCHAIN_ENABLED = true;

    const wallet = await owner.request('GET', `/onchain/agents/${agent.id}/wallet`);
    expect(wallet.status).toBe(200);
    expect(wallet.body).toMatchObject({ agentId: agent.id, network: 'solana-devnet', treasuryAddress: MID(), revenueAddress: ADMIN_ADDR });
    expect(wallet.body.address).toBe((await ensureAgentWallet(agent.id)).publicAddress);
    expect((await stranger.request('GET', `/onchain/agents/${agent.id}/wallet`)).status).toBe(404); // another org's agent
    expect((await stranger.request('POST', `/onchain/agents/${agent.id}/deposits/verify`, { txSignature: bs58.encode(randomBytes(64)) })).status).toBe(404);

    const sig = chain.deposit({ from: external(), to: wallet.body.address, asset: USDC, raw: 20_000_000n });
    const verified = await owner.request('POST', `/onchain/agents/${agent.id}/deposits/verify`, { txSignature: sig });
    expect(verified.status).toBe(200);
    expect(verified.body.deposits[0]).toMatchObject({ status: 'credited', idleCredited: 40, asset: 'USDC' });
    expect(JSON.stringify(verified.body)).not.toMatch(/sweepTxB64|tx_b64/);
    expect((await owner.request('POST', `/onchain/agents/${agent.id}/deposits/verify`, { txSignature: bs58.encode(randomBytes(64)) })).status).toBe(409); // not finalized: retry later

    const dest = Keypair.generate().publicKey.toBase58();
    expect((await owner.request('PUT', `/onchain/agents/${agent.id}/payout-address`, { address: dest })).body.activeAddress).toBe(dest);
    const w = await owner.request('POST', `/onchain/agents/${agent.id}/withdrawals`, { amount: 25 });
    expect(w.status).toBe(201); expect(w.body).toMatchObject({ status: 'pending', amountIdle: 25, destinationWallet: dest });
    expect((await owner.request('POST', `/onchain/agents/${agent.id}/withdrawals`, { amount: 25 })).status).toBe(422); // only 15 left
    expect((await owner.request('GET', `/onchain/agents/${agent.id}/withdrawals`)).body.items).toHaveLength(1);

    expect((await owner.request('GET', '/onchain/admin/overview')).status).toBe(403);
    expect((await owner.request('POST', '/onchain/admin/withdrawals/settle', { ids: [w.body.id] })).status).toBe(403);
    const admin = await loginAdmin();
    const overview = await admin.request('GET', '/onchain/admin/overview');
    expect(overview.status).toBe(200);
    expect(overview.body.flow.map((f: { role: string }) => f.role)).toEqual(['AGENT', 'MID', 'ADMIN']); // agent wallets → Treasury → Revenue
    expect(overview.body.flow[1]).toMatchObject({ address: MID() }); expect(overview.body.flow[2]).toMatchObject({ address: ADMIN_ADDR });
    expect(overview.body.withdrawals.pending).toBeGreaterThanOrEqual(1);
    const settled = await admin.request('POST', '/onchain/admin/withdrawals/settle', { ids: [w.body.id] });
    expect(settled.body.results[0]).toMatchObject({ ok: true });
    expect(chain.tokenBalance(dest, IDLE)).toBe(25n * 10n ** 9n);
    expect((await admin.request('PUT', '/onchain/admin/settings', { autoWithdrawalMaxIdle: 5 })).body.autoWithdrawalMaxIdle).toBe(5);
    expect((await admin.request('PUT', '/onchain/admin/settings', { minWithdrawalIdle: 0 })).status).toBe(400);
    await putOnchainSettings({ autoWithdrawalMaxIdle: 0 }, null);
    const issue = (await listIssues('open'))[0];
    if (issue) expect((await admin.request('POST', `/onchain/admin/issues/${issue.id}/resolve`, { note: 'checked by an admin' })).body.status).toBe('resolved');
  });
});
