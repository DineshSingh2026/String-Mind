/**
 * Deposits into permanent agent wallets — ONE implementation shared by the instant API (POST …/deposits/verify) and the
 * scanner. Nothing is ever credited because a balance went up. A deposit is one finalized, successful transaction that
 * moves a supported asset (matched by mint address AND decimals, never by symbol) into the agent's own wallet from a wallet
 * the platform does not control. Each (signature, wallet, asset) becomes one row, guarded by a unique index, and walks a
 * persistent state machine in short steps:
 *
 *   detected → verified   price captured; USD value, IDLEMINE amount and IDLE fixed forever
 *   verified → sweeping   sweep tx (agent wallet → Treasury, Treasury pays gas) SIGNED; signature + bytes COMMITTED before broadcast
 *   sweeping → swept      the chain confirms that exact signature
 *              (→ verified if the chain proves it failed or can never land)
 *   swept    → credited   IDLE ledger credit — in the SAME database transaction as the status change (exactly once, ever)
 *   rejected              internal platform transfer / below the minimum — never credited
 *   failed                parked for an admin (raises a reconciliation issue)
 *
 * Every transition is an atomic conditional UPDATE (… WHERE id = ? AND status = <expected> RETURNING): the API, the scanner
 * and the resume loop can race on the same deposit and at most one of them performs each transition. No database
 * transaction is held open while waiting for the chain; a worker that dies between claiming and signing is recovered by
 * resumeOpenDeposits (nothing was signed or broadcast, so the claim is simply released).
 */
import { and, asc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { db, schema } from '../../db/client.js';
import { config } from '../../lib/config.js';
import { AppError, badRequest } from '../../lib/errors.js';
import { notifyOrg } from '../../lib/notify.js';
import { creditOnchainDeposit } from '../wallet/ledger.js';
import { raiseIssue } from './issues.js';
import { getMidKeypair } from './keys.js';
import { SCALE, conservativeDepositQuote, divFixed, fixedToString, mulFixed, toFixed, type PriceQuote } from './price.js';
import { getOnchainSettings } from './settings.js';
import * as sol from './solana.js';
import { agentSigningKeypair, platformControlled, type SolanaWalletRow } from './wallets.js';

export type Deposit = typeof schema.blockchainDeposits.$inferSelect;
export const DEPOSIT_OPEN = ['detected', 'verified', 'sweeping', 'swept'] as const;

/** Smallest credited deposit (whole IDLE) and SOL lamports required to trigger a sweep — dust must never drain the Treasury's gas. */
export const MIN_DEPOSIT_IDLE = 1;
export const MIN_SOL_DEPOSIT_LAMPORTS = 100_000n;
/** Minimum balance for a 0-data system account to stay rent-exempt. A sweep may not leave an agent wallet between 0 and this. */
export const RENT_EXEMPT_MIN_LAMPORTS = 890_880n;
/** A claimed-but-never-signed sweep older than this is released (the worker died before signing). */
const CLAIM_STALE_MS = 2 * 60_000;

export class DepositNotReadyError extends AppError {
  constructor(message: string) { super(409, 'deposit_not_ready', message); }
}
class UpstreamUnavailableError extends AppError {
  constructor(message: string) { super(503, 'upstream_unavailable', message); }
}
class SweepImpossible extends Error {}

/* ───────────── per-wallet mutex (serialises SOL balance / rent-reserve maths for one wallet) ───────────── */
const walletLocks = new Map<string, Promise<unknown>>();
async function withWalletLock<T>(walletId: string, fn: () => Promise<T>): Promise<T> {
  const prev = walletLocks.get(walletId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  walletLocks.set(walletId, next);
  try { return await next; } finally { if (walletLocks.get(walletId) === next) walletLocks.delete(walletId); }
}

/* ───────────── parsing — exact integer amounts only ───────────── */

export interface DepositLeg { asset: sol.Asset; mint: string | null; decimals: number; rawAmount: bigint; tokenAccount: string | null; senders: Set<string>; tokenAccountCount: number }

function accountKeys(tx: any): string[] {
  const meta = tx.meta ?? {};
  const keys: string[] = (tx.transaction.message.accountKeys as any[]).map((k) => (typeof k === 'string' ? k : k.pubkey));
  // versioned transactions: lookup-table addresses follow accountKeys (writable first) in balance-array order
  if (keys.length < (meta.preBalances?.length ?? 0)) keys.push(...(meta.loadedAddresses?.writable ?? []), ...(meta.loadedAddresses?.readonly ?? []));
  return keys;
}

/** Every supported asset whose balance at `walletAddress` increased in this transaction, with the wallets whose balance of that asset decreased (the senders). Native SOL is read from lamport deltas; SPL tokens from the token-balance deltas of accounts OWNED by the wallet, matched by mint, decimals and the classic SPL Token program. */
export function parseDepositLegs(tx: any, walletAddress: string): DepositLeg[] {
  const meta = tx.meta ?? {};
  const keys = accountKeys(tx);
  const legs: DepositLeg[] = [];
  const pre: number[] = meta.preBalances ?? []; const post: number[] = meta.postBalances ?? [];
  const i = keys.indexOf(walletAddress);
  if (i >= 0) {
    const delta = BigInt(post[i] ?? 0) - BigInt(pre[i] ?? 0);
    if (delta > 0n) {
      const senders = new Set<string>();
      for (let j = 0; j < Math.min(pre.length, post.length, keys.length); j++) if (BigInt(post[j]!) - BigInt(pre[j]!) < 0n) senders.add(keys[j]!);
      legs.push({ asset: 'SOL', mint: null, decimals: 9, rawAmount: delta, tokenAccount: null, senders, tokenAccountCount: 1 });
    }
  }
  const mints = sol.supportedMints();
  const tokenProgram = sol.TOKEN_PROGRAM_ID.toBase58();
  const preTok = new Map<number, any>((meta.preTokenBalances ?? []).map((b: any) => [b.accountIndex, b]));
  const postTok = new Map<number, any>((meta.postTokenBalances ?? []).map((b: any) => [b.accountIndex, b]));
  const amountOf = (b: any) => BigInt(b?.uiTokenAmount?.amount ?? 0);
  const deltas: { idx: number; mint: string; owner: string | null; delta: bigint; decimals: number; program: string | null }[] = [];
  for (const idx of new Set([...preTok.keys(), ...postTok.keys()])) {
    const ref = postTok.get(idx) ?? preTok.get(idx);
    deltas.push({ idx, mint: ref.mint, owner: ref.owner ?? null, delta: amountOf(postTok.get(idx)) - amountOf(preTok.get(idx)), decimals: Number(ref.uiTokenAmount?.decimals ?? 0), program: ref.programId ?? null });
  }
  const received = new Map<string, { idx: number; delta: bigint }[]>();
  for (const d of deltas) {
    if (d.owner !== walletAddress || d.delta <= 0n || !mints[d.mint]) continue;
    if (d.program != null && d.program !== tokenProgram) continue;
    if (d.decimals !== mints[d.mint]!.decimals) continue; // wrong scale: ignored, never credited
    received.set(d.mint, [...(received.get(d.mint) ?? []), { idx: d.idx, delta: d.delta }]);
  }
  for (const [mint, items] of received) {
    const senders = new Set(deltas.filter((d) => d.mint === mint && d.delta < 0n && d.owner).map((d) => d.owner!));
    legs.push({ asset: mints[mint]!.asset, mint, decimals: mints[mint]!.decimals, rawAmount: items.reduce((a, b) => a + b.delta, 0n), tokenAccount: keys[items[0]!.idx] ?? null, senders, tokenAccountCount: items.length });
  }
  return legs;
}

/** (usdValue, idlemineAmount, wholeIdle) — fixed-point bigint throughout. 1 IDLEMINE == 1 IDLE, so IDLEMINE deposits never go through USD. */
export function computeCredit(asset: sol.Asset, normalizedRaw: bigint, decimals: number, quote: PriceQuote): { usd: bigint | null; idlemine: bigint; idle: number } {
  const normalized = toFixed(sol.rawToDecimal(normalizedRaw, decimals));
  let usd: bigint | null; let idlemine: bigint;
  if (asset === 'IDLEMINE') { idlemine = normalized; usd = quote.idlemineUsdPrice ? mulFixed(normalized, quote.idlemineUsdPrice) : null; }
  else {
    if (!quote.assetUsdPrice || !quote.idlemineUsdPrice || quote.idlemineUsdPrice <= 0n) throw new Error('price unavailable');
    usd = mulFixed(normalized, quote.assetUsdPrice);
    idlemine = divFixed(usd, quote.idlemineUsdPrice);
  }
  const idle = idlemine / SCALE; // floor: the sub-IDLE remainder stays in the Treasury, never credited
  if (idle > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('credit out of range');
  return { usd, idlemine, idle: Number(idle) };
}

/* ───────────── entry point (API + scanner) ───────────── */

function checkSignatureFormat(signature: string) {
  try { if (bs58.decode(signature).length !== 64) throw new Error('len'); } catch { throw badRequest('tx_signature is not a valid Solana transaction signature'); }
}

const rowsFor = (signature: string, walletId: string) =>
  db().select().from(schema.blockchainDeposits).where(and(eq(schema.blockchainDeposits.txSignature, signature), eq(schema.blockchainDeposits.walletId, walletId))).orderBy(asc(schema.blockchainDeposits.asset));

/** Detects, verifies and advances every deposit leg `signature` carries into `wallet`. Idempotent: calling it again for a signature already credited does no chain work and moves no money — it returns the rows. */
export async function processDepositSignature(signature: string, wallet: SolanaWalletRow, opts: { detectedVia: 'api' | 'scanner'; waitSecs?: number }): Promise<Deposit[]> {
  signature = signature.trim();
  checkSignatureFormat(signature);
  let rows = await rowsFor(signature, wallet.id);
  if (!rows.length) {
    let tx: any;
    try { tx = await sol.getFinalizedTransaction(signature); } catch { throw new UpstreamUnavailableError('Could not read the transaction from Solana — retry shortly'); }
    if (!tx) throw new DepositNotReadyError('Transaction not found or not finalized yet — retry once it is finalized (usually under a minute)');
    if (tx.meta?.err != null) throw badRequest('This transaction failed on-chain; nothing was deposited');
    const legs = parseDepositLegs(tx, wallet.publicAddress);
    if (!legs.length) throw badRequest('This transaction does not transfer SOL, USDC, USDT or IDLEMINE into this agent wallet');
    const internal = await platformControlled(legs.flatMap((l) => [...l.senders]));
    const blockTime = tx.blockTime ? new Date(tx.blockTime * 1000) : null;
    const [owner] = await db().select({ orgId: schema.agents.orgId }).from(schema.agents).where(eq(schema.agents.id, wallet.agentId!)).limit(1);
    for (const leg of legs) {
      let status = 'detected'; let reason: string | null = null;
      const external = [...leg.senders].filter((s) => !internal.has(s)).sort();
      if (leg.senders.size && !external.length) { status = 'rejected'; reason = 'internal_transfer'; }
      else if (leg.tokenAccountCount > 1) { status = 'failed'; reason = 'multiple_token_accounts'; }
      await db().insert(schema.blockchainDeposits).values({
        agentId: wallet.agentId!, orgId: owner!.orgId, walletId: wallet.id, txSignature: signature, detectedVia: opts.detectedVia,
        sourceAddress: external[0] ?? [...leg.senders].sort()[0] ?? null, destinationAddress: wallet.publicAddress, destinationTokenAccount: leg.tokenAccount,
        asset: leg.asset, mintAddress: leg.mint, decimals: leg.decimals, rawAmount: leg.rawAmount.toString(), blockTime, slot: tx.slot ?? null, status, rejectionReason: reason,
      }).onConflictDoNothing();
    }
    rows = await rowsFor(signature, wallet.id);
    for (const r of rows) if (r.status === 'failed' && r.rejectionReason === 'multiple_token_accounts') {
      await raiseIssue({ kind: 'deposit_needs_review', severity: 'warning', refType: 'deposit', refKey: r.id, details: { reason: 'deposit spread across several token accounts', txSignature: signature } });
    }
  }
  for (const r of rows) if ((DEPOSIT_OPEN as readonly string[]).includes(r.status)) await advanceDeposit(r.id, opts.waitSecs ?? config.DEPOSIT_VERIFY_WAIT_SECONDS);
  return rowsFor(signature, wallet.id);
}

/* ───────────── state machine ───────────── */

const patch = (id: string, expected: string, set: Partial<typeof schema.blockchainDeposits.$inferInsert>) =>
  db().update(schema.blockchainDeposits).set({ ...set, updatedAt: new Date() })
    .where(and(eq(schema.blockchainDeposits.id, id), eq(schema.blockchainDeposits.status, expected))).returning();

export async function advanceDeposit(id: string, waitSecs = config.DEPOSIT_VERIFY_WAIT_SECONDS): Promise<void> {
  for (let n = 0; n < 6; n++) {
    const [row] = await db().select({ status: schema.blockchainDeposits.status }).from(schema.blockchainDeposits).where(eq(schema.blockchainDeposits.id, id)).limit(1);
    if (!row) return;
    const step = ({ detected: priceStep, verified: startSweep, sweeping: (d: string) => settleSweep(d, waitSecs), swept: creditStep } as Record<string, (d: string) => Promise<boolean>>)[row.status];
    if (!step || !(await step(id))) return;
  }
}

async function priceStep(id: string): Promise<boolean> {
  const [row] = await db().select().from(schema.blockchainDeposits).where(eq(schema.blockchainDeposits.id, id)).limit(1);
  if (!row || row.status !== 'detected') return false;
  let quote: PriceQuote; let credit: ReturnType<typeof computeCredit>;
  try {
    quote = await conservativeDepositQuote(row.asset as sol.Asset, row.blockTime, (await getOnchainSettings()).depositPriceMaxDropPct);
    credit = computeCredit(row.asset as sol.Asset, BigInt(row.rawAmount), row.decimals, quote);
  } catch (e) {
    await db().update(schema.blockchainDeposits).set({ lastError: `pricing failed: ${e instanceof Error ? e.message : 'error'}`.slice(0, 300), updatedAt: new Date() }).where(eq(schema.blockchainDeposits.id, id));
    return false;
  }
  const dust = credit.idle < MIN_DEPOSIT_IDLE || (row.asset === 'SOL' && BigInt(row.rawAmount) < MIN_SOL_DEPOSIT_LAMPORTS);
  const fields = {
    assetUsdPrice: quote.assetUsdPrice == null ? null : fixedToString(quote.assetUsdPrice, 12), idlemineUsdPrice: quote.idlemineUsdPrice == null ? null : fixedToString(quote.idlemineUsdPrice, 12),
    usdValue: credit.usd == null ? null : fixedToString(credit.usd, 12), idlemineAmount: fixedToString(credit.idlemine, 12), idleCredited: credit.idle,
    priceSource: quote.source, pricedAt: quote.quotedAt, lastError: null,
  };
  const out = await patch(id, 'detected', dust ? { ...fields, status: 'rejected', rejectionReason: 'below_minimum' } : { ...fields, status: 'verified', verifiedAt: new Date() });
  return out.length > 0 && !dust;
}

/** Signed sweep of exactly this deposit (agent wallet → Treasury, the Treasury pays gas). Returns the signed tx (or null if nothing is sweepable) and the raw amount swept. */
async function buildSweep(row: Deposit, wallet: SolanaWalletRow): Promise<{ signed: sol.SignedTx | null; amount: bigint }> {
  const mid = await getMidKeypair();
  const agentKp = await agentSigningKeypair(wallet);
  const raw = BigInt(row.rawAmount);
  if (row.asset === 'SOL') {
    const balance = await sol.getSolBalance(wallet.publicAddress);
    if (balance < raw) throw new SweepImpossible(`wallet holds ${balance} lamports, deposit is ${raw}`);
    const remainder = balance - raw;
    let amount = raw;
    // sweeping exactly would leave the wallet below rent exemption, which the runtime rejects: keep the rent reserve in the wallet
    if (remainder > 0n && remainder < RENT_EXEMPT_MIN_LAMPORTS) { amount = raw - (RENT_EXEMPT_MIN_LAMPORTS - remainder); if (amount <= 0n) return { signed: null, amount: 0n }; }
    return { signed: await sol.buildSignedTransaction([sol.solTransferIx(agentKp.publicKey, mid.publicKey, amount)], mid, [mid, agentKp], { memo: `hivemind:sweep:${row.id}` }), amount };
  }
  const mint = new PublicKey(row.mintAddress!);
  const balance = await sol.getTokenAccountRawBalance(row.destinationTokenAccount!);
  if (balance == null || balance < raw) throw new SweepImpossible(`token account holds ${balance}, deposit is ${raw}`);
  const destination = sol.getAssociatedTokenAddress(mid.publicKey, mint);
  const signed = await sol.buildSignedTransaction([
    sol.createAtaIdempotentIx(mid.publicKey, mid.publicKey, mint),
    sol.transferCheckedIx(new PublicKey(row.destinationTokenAccount!), mint, destination, agentKp.publicKey, raw, row.decimals),
  ], mid, [mid, agentKp], { memo: `hivemind:sweep:${row.id}` });
  return { signed, amount: raw };
}

async function startSweep(id: string): Promise<boolean> {
  const [cur] = await db().select().from(schema.blockchainDeposits).where(eq(schema.blockchainDeposits.id, id)).limit(1);
  if (!cur || cur.status !== 'verified') return false;
  if (cur.sweepAttempts >= config.ONCHAIN_MAX_ATTEMPTS) {
    const out = await patch(id, 'verified', { status: 'failed', lastError: 'sweep attempts exhausted' });
    if (out.length) await raiseIssue({ kind: 'deposit_sweep_failed', severity: 'critical', refType: 'deposit', refKey: id, details: { txSignature: cur.txSignature, attempts: cur.sweepAttempts } });
    return false;
  }
  // exclusive claim: only one worker may build + sign a sweep for this deposit
  const [row] = await db().update(schema.blockchainDeposits).set({ status: 'sweeping', lastError: null, updatedAt: new Date() })
    .where(and(eq(schema.blockchainDeposits.id, id), eq(schema.blockchainDeposits.status, 'verified'), isNull(schema.blockchainDeposits.sweepSignature))).returning();
  if (!row) return false;
  const release = (extra: Partial<typeof schema.blockchainDeposits.$inferInsert>) =>
    db().update(schema.blockchainDeposits).set({ ...extra, updatedAt: new Date() }).where(and(eq(schema.blockchainDeposits.id, id), eq(schema.blockchainDeposits.status, 'sweeping'), isNull(schema.blockchainDeposits.sweepSignature))).returning({ id: schema.blockchainDeposits.id });

  const [wallet] = await db().select().from(schema.solanaWallets).where(eq(schema.solanaWallets.id, row.walletId)).limit(1);
  let built: { signed: sol.SignedTx | null; amount: bigint };
  try {
    built = await withWalletLock(row.walletId, () => buildSweep(row, wallet!));
  } catch (e) {
    if (e instanceof SweepImpossible) {
      await release({ status: 'failed', lastError: `sweep impossible: ${e.message}`.slice(0, 500) });
      await raiseIssue({ kind: 'deposit_funds_missing', severity: 'critical', refType: 'deposit', refKey: id, details: { txSignature: row.txSignature, detail: e.message } });
    } else {
      await release({ status: 'verified', sweepAttempts: row.sweepAttempts + 1, lastError: `sweep build failed: ${e instanceof Error ? e.message : 'error'}`.slice(0, 500) });
    }
    return false;
  }
  const { signed, amount } = built;
  if (!signed || amount <= 0n) {
    // sub-rent SOL deposit where nothing can be swept: never credit unswept rent reserve
    await release({ status: 'rejected', rejectionReason: 'below_rent_reserve', sweptRawAmount: '0', idleCredited: 0, lastError: 'below rent-exempt reserve; not swept' });
    return false;
  }
  const rawTotal = BigInt(row.rawAmount);
  // only credit the proportion of SOL actually swept into the Treasury, never the unswept rent reserve
  const credited = amount < rawTotal && row.idleCredited != null ? Number((BigInt(row.idleCredited) * amount) / rawTotal) : row.idleCredited;
  if (credited != null && credited < MIN_DEPOSIT_IDLE) {
    await release({ status: 'rejected', rejectionReason: 'below_rent_reserve', sweptRawAmount: '0', idleCredited: 0, lastError: 'swept share below the minimum credit' });
    return false;
  }
  // durable commit of the signature BEFORE any money moves
  const committed = await release({ sweepSignature: signed.signature, sweepTxB64: signed.rawTxB64, sweepLastValidBlockHeight: signed.lastValidBlockHeight, sweepAttempts: row.sweepAttempts + 1, sweptRawAmount: amount.toString(), idleCredited: credited });
  if (!committed.length) return false; // our claim was released meanwhile (we were too slow): never broadcast what was not durably recorded
  const err = await sol.broadcast(signed.rawTxB64);
  if (err) console.warn(`[onchain] deposit ${id} sweep broadcast error (not proof of failure): ${err.slice(0, 120)}`);
  return true;
}

async function settleSweep(id: string, waitSecs: number): Promise<boolean> {
  const [row] = await db().select().from(schema.blockchainDeposits).where(eq(schema.blockchainDeposits.id, id)).limit(1);
  if (!row || row.status !== 'sweeping' || !row.sweepSignature) return false; // claimed but not signed yet: another worker owns it
  const { sweepSignature: signature, sweepLastValidBlockHeight: lvbh, sweepTxB64: rawTx } = row;
  let state: sol.TxState;
  if (waitSecs > 0) state = await sol.waitForState(signature, Number(lvbh), waitSecs);
  else { try { state = await sol.getPayoutState(signature, Number(lvbh)); } catch { state = 'unknown'; } }
  if (state === 'unknown') { if (rawTx) await sol.broadcast(rawTx); return false; } // same bytes: can only ever land once
  const where = and(eq(schema.blockchainDeposits.id, id), eq(schema.blockchainDeposits.status, 'sweeping'), eq(schema.blockchainDeposits.sweepSignature, signature));
  if (state === 'confirmed') await db().update(schema.blockchainDeposits).set({ status: 'swept', sweptAt: new Date(), sweepTxB64: null, updatedAt: new Date() }).where(where);
  else {
    // 'failed' (landed, errored: nothing moved) or 'expired' (can never land): provably safe to sign a fresh sweep
    await db().update(schema.blockchainDeposits).set({ status: 'verified', lastError: `sweep ${signature} ${state}`, sweepSignature: null, sweepTxB64: null, sweepLastValidBlockHeight: null, updatedAt: new Date() }).where(where);
  }
  return true;
}

/** swept → credited: the status change and the ledger credit commit together (and the ledger's idempotency key backs it up). */
async function creditStep(id: string): Promise<boolean> {
  const credited = await db().transaction(async (tx) => {
    const [row] = await tx.update(schema.blockchainDeposits).set({ status: 'credited', creditedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(schema.blockchainDeposits.id, id), eq(schema.blockchainDeposits.status, 'swept'))).returning();
    if (!row) return null;
    if (!row.idleCredited || row.idleCredited <= 0) throw new Error('deposit has no credit amount');
    const r = await creditOnchainDeposit({ orgId: row.orgId, depositId: row.id, amount: row.idleCredited, description: `On-chain deposit: ${sol.rawToDecimal(BigInt(row.rawAmount), row.decimals)} ${row.asset}` }, tx);
    await tx.update(schema.blockchainDeposits).set({ ledgerTxId: r.transactionId }).where(eq(schema.blockchainDeposits.id, id));
    return row;
  });
  if (!credited) return false;
  await notifyOrg(credited.orgId, 'payment_update', `Deposit credited: ${credited.idleCredited!.toLocaleString('en-US')} IDLE`,
    `${sol.rawToDecimal(BigInt(credited.rawAmount), credited.decimals)} ${credited.asset} arrived in your agent wallet and was credited to your wallet.`, '/wallet').catch(() => undefined);
  return true;
}

/* ───────────── background: resume open deposits + scanner ───────────── */

/** Exponential backoff (15 s … 5 min) between failed sweep retries. */
export const depositRetryBackoffMs = (attempts: number) => (attempts <= 0 ? 0 : Math.min(300, 15 * 2 ** Math.max(0, attempts - 1)) * 1000);

/** Pushes every unfinished deposit one step further (crash recovery: a sweep that was signed but never confirmed is settled from its persisted signature, never re-sent blindly). */
export async function resumeOpenDeposits(limit = 200): Promise<number> {
  // a worker that died after claiming but before signing: nothing was signed or broadcast, release the claim
  await db().update(schema.blockchainDeposits).set({ status: 'verified', updatedAt: new Date() }).where(and(
    eq(schema.blockchainDeposits.status, 'sweeping'), isNull(schema.blockchainDeposits.sweepSignature), lt(schema.blockchainDeposits.updatedAt, new Date(Date.now() - CLAIM_STALE_MS))));
  const rows = await db().select().from(schema.blockchainDeposits).where(inArray(schema.blockchainDeposits.status, [...DEPOSIT_OPEN])).orderBy(asc(schema.blockchainDeposits.createdAt)).limit(limit);
  for (const r of rows) {
    if (!config.isTest && r.sweepAttempts > 0 && Date.now() - r.updatedAt.getTime() < depositRetryBackoffMs(r.sweepAttempts)) continue;
    try { await advanceDeposit(r.id, 0); } catch (e) { console.error(`[onchain] resume failed for deposit ${r.id}`, e instanceof Error ? e.message : e); }
  }
  return rows.length;
}

/** Fallback for agents that never call verify: finds incoming transfers over the RPC and feeds each unseen signature through the SAME processDepositSignature the API uses. */
export async function scanAgentWallets(maxWallets = 500): Promise<{ wallets: number; newDeposits: number; errors: number }> {
  const wallets = await db().select().from(schema.solanaWallets).where(and(eq(schema.solanaWallets.role, 'AGENT'), eq(schema.solanaWallets.status, 'active')))
    .orderBy(sql`${schema.solanaWallets.lastScannedAt} asc nulls first`).limit(maxWallets);
  const stats = { wallets: 0, newDeposits: 0, errors: 0 };
  for (const wallet of wallets) {
    const cursor = wallet.lastScannedBlockTime;
    let transfers: { signature: string; blockTime: number }[];
    try { transfers = await sol.listIncomingSignatures(wallet.publicAddress, cursor ? cursor - 120 : null); } // re-scan a small overlap: duplicates are free, gaps are not
    catch (e) { console.warn('[onchain] deposit scan aborted:', e instanceof Error ? e.message.slice(0, 120) : e); stats.errors++; break; }
    let newCursor = cursor ?? 0; let blocked = transfers.length >= 200; // pagination ceiling: do not advance past a possible gap
    for (const item of [...transfers].sort((a, b) => a.blockTime - b.blockTime)) {
      try {
        if (!(await rowsFor(item.signature, wallet.id)).length) { await processDepositSignature(item.signature, wallet, { detectedVia: 'scanner', waitSecs: 0 }); stats.newDeposits++; }
      } catch (e) {
        if (e instanceof DepositNotReadyError || e instanceof UpstreamUnavailableError) blocked = true; // retry next scan: do not move the cursor past it
        else if (e instanceof AppError && e.status === 400) { /* not a deposit into this wallet (e.g. dust of an unsupported token) */ }
        else { blocked = true; stats.errors++; console.error(`[onchain] scan error for wallet ${wallet.id}`, e instanceof Error ? e.message : e); }
      }
      if (!blocked) newCursor = Math.max(newCursor, item.blockTime);
    }
    await db().update(schema.solanaWallets).set({ lastScannedBlockTime: newCursor || null, lastScannedAt: new Date() }).where(eq(schema.solanaWallets.id, wallet.id));
    stats.wallets++;
  }
  return stats;
}

/** Admin retry for a deposit that exhausted its sweep attempts or failed without moving funds. */
export async function retryFailedDeposit(id: string): Promise<Deposit> {
  const [row] = await db().select().from(schema.blockchainDeposits).where(eq(schema.blockchainDeposits.id, id)).limit(1);
  if (!row) throw new AppError(404, 'not_found', 'Deposit not found');
  if (row.status !== 'failed') throw badRequest(`Only failed deposits can be retried (current status: ${row.status})`);
  // a signature that exists must be resolved from the chain first
  const next = row.sweepSignature ? 'sweeping' : row.pricedAt ? 'verified' : 'detected';
  const out = await patch(id, 'failed', { status: next, sweepAttempts: 0, lastError: null, rejectionReason: null });
  if (!out.length) throw new AppError(409, 'conflict', 'Deposit changed; try again');
  await advanceDeposit(id, 0);
  return (await db().select().from(schema.blockchainDeposits).where(eq(schema.blockchainDeposits.id, id)).limit(1))[0]!;
}

/** Public shape (no signed bytes). Internal error text (it can name secret ids / RPC details) is admin-only. */
export const depositView = (d: Deposit, opts: { admin?: boolean } = {}) => ({
  id: d.id, agentId: d.agentId, txSignature: d.txSignature, asset: d.asset, amount: sol.rawToDecimal(BigInt(d.rawAmount), d.decimals), status: d.status,
  idleCredited: d.idleCredited, usdValue: d.usdValue, rejectionReason: d.rejectionReason, sourceAddress: d.sourceAddress, detectedVia: d.detectedVia,
  sweepSignature: d.sweepSignature, needsAttention: d.status === 'failed', ...(opts.admin ? { lastError: d.status === 'credited' ? null : d.lastError } : {}), blockTime: d.blockTime, createdAt: d.createdAt, creditedAt: d.creditedAt,
});
