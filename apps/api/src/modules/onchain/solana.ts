/**
 * Solana JSON-RPC client + transaction helpers.
 *
 * Every money-moving caller follows the same pattern:
 *   1. buildSignedTransaction — sign locally; the signature is now fixed
 *   2. persist signature + signed bytes + lastValidBlockHeight, COMMIT
 *   3. broadcast             — a send error proves nothing either way
 *   4. getPayoutState        — the only thing that decides the outcome
 * A transfer is only ever re-signed after the chain proves the old transaction can never land ('expired') or that it
 * landed and failed ('failed'). Amounts are exact integers (bigint) — floats never touch money.
 */
import {
  ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, type TransactionInstruction as Ix,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { config, SOLANA_GENESIS_HASHES } from '../../lib/config.js';

export { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID };
export const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
export const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
export const VALID_ASSETS = ['USDC', 'USDT', 'SOL', 'IDLEMINE'] as const;
export type Asset = (typeof VALID_ASSETS)[number];

const STATE_POLL_MS = 1000;
/** A transaction is only declared expired this many blocks past its lastValidBlockHeight, confirmed by this many independent rounds. */
const EXPIRY_MARGIN_BLOCKS = 32;
const EXPIRY_CONFIRMATIONS = 2;
const RPC_RATE_LIMIT_RETRIES = 4;
export const MAX_TRANSACTION_BYTES = 1232;

export type TxState = 'confirmed' | 'failed' | 'expired' | 'unknown';
export interface SignedTx { signature: string; rawTxB64: string; lastValidBlockHeight: number }

/* ───────────── RPC plumbing ───────────── */

export type RpcFn = (method: string, params: unknown) => Promise<unknown>;
let rpcOverride: RpcFn | null = null;
let clusterVerified = false;
let inFlight = 0;
const waiters: (() => void)[] = [];

/** Tests install a fake chain here (cluster verification is skipped for it). */
export function setRpcForTests(fn: RpcFn | null) { rpcOverride = fn; clusterVerified = false; cachedBlockhash = null; }

async function acquire() {
  if (inFlight < config.SOLANA_RPC_MAX_CONCURRENCY) { inFlight++; return; }
  await new Promise<void>((resolve) => waiters.push(resolve));
  inFlight++;
}
function release() { inFlight--; waiters.shift()?.(); }

async function rawRpc(method: string, params: unknown): Promise<unknown> {
  if (rpcOverride) return rpcOverride(method, params);
  if (!config.SOLANA_RPC_URL || config.SOLANA_RPC_URL.includes('REPLACE_ME')) throw new Error('SOLANA_RPC_URL is not configured');
  await acquire();
  try {
    let res: Response | null = null;
    for (let attempt = 0; attempt <= RPC_RATE_LIMIT_RETRIES; attempt++) {
      try {
        res = await fetch(config.SOLANA_RPC_URL, {
          method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(30_000),
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        });
      } catch (e) {
        // fetch errors can carry the URL, which embeds the RPC API key
        throw new Error(`RPC transport error calling ${method}: ${e instanceof Error ? e.name : 'error'}`);
      }
      if (res.status !== 429 || attempt === RPC_RATE_LIMIT_RETRIES) break;
      await new Promise((r) => setTimeout(r, 250 * 2 ** attempt)); // rate limited: not processed; back off and retry
    }
    if (!res || res.status >= 400) throw new Error(`RPC HTTP ${res?.status} calling ${method}`);
    const data = await res.json() as { result?: unknown; error?: unknown };
    if (data.error) throw new Error(`RPC error calling ${method}: ${JSON.stringify(data.error).slice(0, 300)}`);
    return data.result;
  } finally { release(); }
}

/** Refuses every RPC call until the RPC proves (by genesis hash) it is the cluster SOLANA_NETWORK names. */
async function verifyCluster() {
  if (clusterVerified || rpcOverride) return;
  const expected = SOLANA_GENESIS_HASHES[config.SOLANA_NETWORK];
  const actual = await rawRpc('getGenesisHash', []);
  if (actual !== expected) throw new Error(`SOLANA_RPC_URL is not ${config.SOLANA_NETWORK} (genesis ${String(actual)}) — refusing every RPC call`);
  clusterVerified = true;
}

export async function rpc<T = any>(method: string, params: unknown): Promise<T> {
  await verifyCluster();
  return (await rawRpc(method, params)) as T;
}

/* ───────────── exact amounts ───────────── */

export function rawToDecimal(raw: bigint, decimals: number): string {
  const s = raw.toString().padStart(decimals + 1, '0');
  const i = s.length - decimals;
  const frac = s.slice(i).replace(/0+$/, '');
  return frac ? `${s.slice(0, i)}.${frac}` : s.slice(0, i);
}

/** Whole tokens → base units. Refuses (rather than rounds) an amount with more precision than the token has. */
export function decimalToRaw(amount: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!m) throw new Error(`Not a decimal amount: ${amount}`);
  const frac = m[2] ?? '';
  if (frac.length > decimals && /[1-9]/.test(frac.slice(decimals))) throw new Error(`Amount ${amount} has more than ${decimals} decimals`);
  return BigInt(m[1]! + frac.slice(0, decimals).padEnd(decimals, '0'));
}

/* ───────────── mints / accounts ───────────── */

export const supportedMints = (): Record<string, { asset: Asset; decimals: number }> => ({
  [config.USDC_MINT]: { asset: 'USDC', decimals: config.USDC_DECIMALS },
  [config.USDT_MINT]: { asset: 'USDT', decimals: config.USDT_DECIMALS },
  [config.IDLEMINE_MINT]: { asset: 'IDLEMINE', decimals: config.IDLEMINE_DECIMALS },
});
export const mintByAsset = (): Record<string, string> => ({ USDC: config.USDC_MINT, USDT: config.USDT_MINT, IDLEMINE: config.IDLEMINE_MINT });

export const getAssociatedTokenAddress = (owner: PublicKey, mint: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true);

/** On-curve wallet address check (rejects token accounts and PDAs, which would strand tokens). */
export function isWalletAddress(address: string): boolean {
  try { return PublicKey.isOnCurve(new PublicKey(address.trim()).toBytes()); } catch { return false; }
}

/* ───────────── instructions ───────────── */

/** SPL TransferChecked: the token program itself rejects a wrong mint or wrong decimals, so an amount can never move at the wrong scale. */
export const transferCheckedIx = (source: PublicKey, mint: PublicKey, destination: PublicKey, owner: PublicKey, amountRaw: bigint, decimals: number): Ix =>
  createTransferCheckedInstruction(source, mint, destination, owner, amountRaw, decimals, [], TOKEN_PROGRAM_ID);
export const createAtaIdempotentIx = (payer: PublicKey, owner: PublicKey, mint: PublicKey): Ix =>
  createAssociatedTokenAccountIdempotentInstruction(payer, getAssociatedTokenAddress(owner, mint), owner, mint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
export const solTransferIx = (from: PublicKey, to: PublicKey, lamports: bigint): Ix => SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports });
export const memoIx = (text: string): Ix => new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from(text, 'utf8') });

function computeBudgetIxs(): Ix[] {
  const out: Ix[] = [];
  if (config.SOLANA_COMPUTE_UNIT_LIMIT > 0) out.push(ComputeBudgetProgram.setComputeUnitLimit({ units: config.SOLANA_COMPUTE_UNIT_LIMIT }));
  if (config.SOLANA_COMPUTE_UNIT_PRICE_MICROLAMPORTS > 0) out.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.SOLANA_COMPUTE_UNIT_PRICE_MICROLAMPORTS }));
  return out;
}

/** Tests move the fake chain's clock; a cached blockhash must not survive that. */
export function resetBlockhashCache() { cachedBlockhash = null; }

let cachedBlockhash: { at: number; value: { blockhash: string; lastValidBlockHeight: number } } | null = null;
async function latestBlockhash() {
  if (cachedBlockhash && Date.now() - cachedBlockhash.at < 2000) return cachedBlockhash.value;
  const res = await rpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>('getLatestBlockhash', [{ commitment: 'finalized' }]);
  cachedBlockhash = { at: Date.now(), value: res.value };
  return res.value;
}

/**
 * Signs (does not send). `memo` must name the transfer (e.g. the row id) and is written on-chain: it makes every
 * transaction unique — two different transfers with the same payer, accounts and amount, signed against the same
 * blockhash, would otherwise be byte-identical (ONE signature, executed once, yet recorded as two transfers).
 */
export async function buildSignedTransaction(instructions: Ix[], feePayer: Keypair, signers: Keypair[], opts: { memo: string }): Promise<SignedTx> {
  if (!opts.memo) throw new Error('a memo naming the transfer is required');
  const { blockhash, lastValidBlockHeight } = await latestBlockhash();
  const tx = new Transaction({ feePayer: feePayer.publicKey, recentBlockhash: blockhash });
  tx.add(...computeBudgetIxs(), ...instructions, memoIx(opts.memo));
  const unique = [...new Map([feePayer, ...signers].map((k) => [k.publicKey.toBase58(), k])).values()];
  tx.sign(...unique);
  const bytes = tx.serialize();
  if (bytes.length > MAX_TRANSACTION_BYTES) throw new Error(`transaction is ${bytes.length} bytes (limit ${MAX_TRANSACTION_BYTES})`);
  return { signature: bs58.encode(tx.signature!), rawTxB64: bytes.toString('base64'), lastValidBlockHeight };
}

/** Sends already-signed bytes. Rebroadcasting the same bytes is always safe (a signature executes once). Returns an error string instead of throwing: a send error does NOT prove the transaction failed. */
export async function broadcast(rawTxB64: string): Promise<string | null> {
  try {
    await rpc('sendTransaction', [rawTxB64, { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 5 }]);
    return null;
  } catch (e) { return `${e instanceof Error ? e.name : 'Error'}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500); }
}

/** Reads the finalized transaction directly (an independent source from the signature-status index). */
export async function getLandedState(signature: string): Promise<'confirmed' | 'failed' | 'not_found'> {
  const tx = await rpc<{ meta?: { err?: unknown } } | null>('getTransaction', [signature, { encoding: 'json', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]);
  if (!tx) return 'not_found';
  return tx.meta?.err != null ? 'failed' : 'confirmed';
}

/**
 * 'confirmed' — landed and succeeded: the funds moved.   'failed' — landed but errored on-chain: the funds did not move.
 * 'expired'   — never landed and now never can.           'unknown' — not landed yet but still could; check again later.
 *
 * 'expired' is the answer that lets a caller sign a NEW transaction for the same money, so it is only returned when every
 * independent check agrees: the finalized chain is well past the blockhash's validity (plus a safety margin), the
 * signature-status index has no record, AND the finalized transaction itself is not found — twice, a moment apart. One
 * lagging or history-less RPC node answering one call can therefore never turn a landed payment into a second payment.
 */
export async function getPayoutState(signature: string, lastValidBlockHeight: number): Promise<TxState> {
  for (let check = 0; check < EXPIRY_CONFIRMATIONS; check++) {
    // height BEFORE status: if every block up to the expiry height is finalized and the signature still isn't found, it is in none of them
    const height = Number(await rpc('getBlockHeight', [{ commitment: 'finalized' }]));
    const res = await rpc<{ value: ({ err?: unknown; confirmationStatus?: string } | null)[] }>('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]);
    const status = res.value[0];
    if (status) {
      if (status.err) return 'failed';
      return status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized' ? 'confirmed' : 'unknown';
    }
    if (height <= Number(lastValidBlockHeight) + EXPIRY_MARGIN_BLOCKS) return 'unknown';
    const landed = await getLandedState(signature);
    if (landed !== 'not_found') return landed;
    if (check + 1 < EXPIRY_CONFIRMATIONS) await new Promise((r) => setTimeout(r, rpcOverride ? 0 : STATE_POLL_MS));
  }
  return 'expired';
}

/** Polls until the outcome is decided or the timeout passes; 'unknown' on timeout (the caller leaves the row in flight). */
export async function waitForState(signature: string, lastValidBlockHeight: number, timeoutSecs = 45): Promise<TxState> {
  const deadline = Date.now() + timeoutSecs * 1000;
  for (;;) {
    let state: TxState;
    try {
      // fast path, one call: a confirmed (or landed-and-failed) status is positive proof
      const res = await rpc<{ value: ({ err?: unknown; confirmationStatus?: string } | null)[] }>('getSignatureStatuses', [[signature]]);
      const st = res.value[0];
      if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return st.err ? 'failed' : 'confirmed';
      state = await getPayoutState(signature, lastValidBlockHeight);
    } catch { state = 'unknown'; }
    if (state !== 'unknown' || Date.now() >= deadline) return state;
    await new Promise((r) => setTimeout(r, rpcOverride ? 0 : STATE_POLL_MS));
  }
}

/** The finalized jsonParsed transaction, or null if unknown / not finalized yet. Network/RPC failures THROW — they are not "not found". */
export async function getFinalizedTransaction(signature: string): Promise<any | null> {
  return rpc('getTransaction', [signature, { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]);
}

/**
 * Deposit discovery over the RPC: successful signatures touching `address` or any of its supported-mint token accounts
 * (a token transfer into an existing ATA does not list the owner wallet, so each ATA is queried too), newest first,
 * stopping at `sinceBlockTime` (exclusive). Every signature is still fully verified before anything is credited.
 */
export async function listIncomingSignatures(address: string, sinceBlockTime: number | null, limit = 200): Promise<{ signature: string; blockTime: number }[]> {
  const owner = new PublicKey(address);
  const targets = [address, ...Object.values(mintByAsset()).map((m) => getAssociatedTokenAddress(owner, new PublicKey(m)).toBase58())];
  const out = new Map<string, { signature: string; blockTime: number }>();
  for (const target of targets) {
    const rows = await rpc<{ signature: string; blockTime?: number | null; err?: unknown }[] | null>('getSignaturesForAddress', [target, { limit, commitment: 'finalized' }]);
    for (const row of rows ?? []) {
      const blockTime = Number(row.blockTime ?? 0);
      if (row.err != null || !blockTime) continue;
      if (sinceBlockTime != null && blockTime <= sinceBlockTime) continue;
      out.set(row.signature, { signature: row.signature, blockTime });
    }
  }
  return [...out.values()].sort((a, b) => b.blockTime - a.blockTime);
}

/** Raw balances: { SOL: lamports, <mint>: raw }. */
export async function getWalletBalances(address: string): Promise<Record<string, bigint>> {
  const out: Record<string, bigint> = { SOL: BigInt((await rpc<{ value: number }>('getBalance', [address, { commitment: 'confirmed' }])).value) };
  const res = await rpc<{ value: { account: { data: { parsed: { info: { mint: string; tokenAmount: { amount: string } } } } } }[] }>(
    'getTokenAccountsByOwner', [address, { programId: TOKEN_PROGRAM_ID.toBase58() }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  for (const item of res.value) {
    const info = item.account.data.parsed.info;
    out[info.mint] = (out[info.mint] ?? 0n) + BigInt(info.tokenAmount.amount);
  }
  return out;
}

/** Raw balance of a token account, or null if it does not exist. */
export async function getTokenAccountRawBalance(tokenAccount: string): Promise<bigint | null> {
  try {
    const res = await rpc<{ value: { amount: string } }>('getTokenAccountBalance', [tokenAccount, { commitment: 'confirmed' }]);
    return BigInt(res.value.amount);
  } catch (e) {
    const m = (e instanceof Error ? e.message : '').toLowerCase();
    if (m.includes('could not find account') || m.includes('invalid param')) return null;
    throw e;
  }
}

export async function getSolBalance(address: string): Promise<bigint> {
  return BigInt((await rpc<{ value: number }>('getBalance', [address, { commitment: 'confirmed' }])).value);
}
