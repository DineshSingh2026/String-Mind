/**
 * A fake Solana chain for tests. It applies the REAL signed transactions our code produces (decodes the bytes, verifies
 * every signature, executes System transfers, ATA creation and SPL TransferChecked with real balance checks, charges the
 * fee payer) and answers the JSON-RPC methods the gateway uses. Nothing here is mocked at the function level — only the
 * network is replaced — so signing, instruction building, replay safety and the state machines are genuinely exercised.
 *
 * Failure injection:  chain.mode = 'drop' → broadcast transactions are accepted but never land (blockhash will expire)
 *                     chain.advance(n)    → move the finalized block height forward n blocks
 *                     chain.flushDropped() → land everything that was dropped (a "late" transaction)
 */
import { Keypair, PublicKey, SystemInstruction, SystemProgram, Transaction } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import bs58 from 'bs58';
import { randomBytes } from 'node:crypto';
import { resetBlockhashCache } from '../../src/modules/onchain/solana.js';

interface TokenAcct { owner: string; mint: string; amount: bigint }
interface LandedTx { signature: string; slot: number; blockTime: number; err: unknown; keys: string[]; pre: bigint[]; post: bigint[]; preTok: any[]; postTok: any[] }

export class FakeChain {
  lamports = new Map<string, bigint>();
  tokens = new Map<string, TokenAcct>();
  landed = new Map<string, LandedTx>();
  dropped: { signature: string; raw: string }[] = [];
  mode: 'normal' | 'drop' = 'normal';
  height = 1000;
  slot = 5000;
  calls: string[] = [];
  decimals = new Map<string, number>();
  genesis = 'FakeGenesis';
  blockhash = bs58.encode(randomBytes(32));
  /** number of times a sendTransaction carried bytes that had already been sent (rebroadcast) */
  rebroadcasts = 0;
  private seen = new Set<string>();

  mint(mint: string, decimals: number) { this.decimals.set(mint, decimals); }
  advance(n: number) { this.height += n; this.blockhash = bs58.encode(randomBytes(32)); resetBlockhashCache(); }
  airdrop(address: string, lamports: bigint) { this.lamports.set(address, (this.lamports.get(address) ?? 0n) + lamports); }
  ata(owner: string, mint: string) { return getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), true).toBase58(); }
  fund(owner: string, mint: string, amount: bigint) { const a = this.ata(owner, mint); const t = this.tokens.get(a) ?? { owner, mint, amount: 0n }; t.amount += amount; this.tokens.set(a, t); }
  tokenBalance(owner: string, mint: string) { return this.tokens.get(this.ata(owner, mint))?.amount ?? 0n; }
  solBalance(address: string) { return this.lamports.get(address) ?? 0n; }

  /** An external wallet sends SOL or an SPL token to `to` (no platform signature involved). Returns the signature. */
  deposit(o: { from: string; to: string; asset: 'SOL' | string; raw: bigint }): string {
    const sig = bs58.encode(randomBytes(64));
    const keys: string[] = []; const pre: bigint[] = []; const post: bigint[] = []; const preTok: any[] = []; const postTok: any[] = [];
    if (o.asset === 'SOL') {
      keys.push(o.from, o.to);
      pre.push(this.solBalance(o.from), this.solBalance(o.to));
      this.lamports.set(o.from, this.solBalance(o.from) - o.raw); this.lamports.set(o.to, this.solBalance(o.to) + o.raw);
      post.push(this.solBalance(o.from), this.solBalance(o.to));
    } else {
      const srcAta = this.ata(o.from, o.asset); const dstAta = this.ata(o.to, o.asset);
      keys.push(o.from, srcAta, dstAta);
      pre.push(0n, 0n, 0n); post.push(0n, 0n, 0n);
      const dec = this.decimals.get(o.asset) ?? 0;
      const mk = (idx: number, acct: TokenAcct) => ({ accountIndex: idx, mint: acct.mint, owner: acct.owner, programId: TOKEN_PROGRAM_ID.toBase58(), uiTokenAmount: { amount: acct.amount.toString(), decimals: dec } });
      const src = this.tokens.get(srcAta) ?? { owner: o.from, mint: o.asset, amount: 0n };
      if (src.amount < o.raw) src.amount = o.raw; // the external sender is simply funded
      this.tokens.set(srcAta, src);
      const dst = this.tokens.get(dstAta) ?? { owner: o.to, mint: o.asset, amount: 0n };
      preTok.push(mk(1, src), mk(2, dst));
      src.amount -= o.raw; dst.amount += o.raw;
      this.tokens.set(srcAta, src); this.tokens.set(dstAta, dst);
      postTok.push(mk(1, src), mk(2, dst));
    }
    this.landed.set(sig, { signature: sig, slot: ++this.slot, blockTime: Math.floor(Date.now() / 1000), err: null, keys, pre, post, preTok, postTok });
    return sig;
  }

  /** Land every dropped transaction now (a transaction that arrives late). */
  flushDropped() { const d = this.dropped.splice(0); for (const t of d) this.execute(t.raw, true); }

  private execute(rawB64: string, force = false): string {
    const tx = Transaction.from(Buffer.from(rawB64, 'base64'));
    if (!tx.verifySignatures()) throw new Error('Transaction signature verification failure');
    const signature = bs58.encode(tx.signature!);
    if (this.landed.has(signature)) return signature; // a signature can only ever execute once
    if (this.mode === 'drop' && !force) { if (!this.dropped.some((d) => d.signature === signature)) this.dropped.push({ signature, raw: rawB64 }); return signature; }
    const lam = new Map(this.lamports); const toks = new Map([...this.tokens].map(([k, v]) => [k, { ...v }]));
    const touched: string[] = []; const touch = (k: string) => { if (!touched.includes(k)) touched.push(k); };
    const preLam = new Map<string, bigint>(); const preTok = new Map<string, TokenAcct>();
    const snap = (k: string) => { touch(k); if (!preLam.has(k)) preLam.set(k, lam.get(k) ?? 0n); };
    let err: unknown = null;
    try {
      const payer = tx.feePayer!.toBase58(); snap(payer);
      const fee = 5000n * BigInt(tx.signatures.length);
      if ((lam.get(payer) ?? 0n) < fee) throw new Error('insufficient funds for fee');
      lam.set(payer, (lam.get(payer) ?? 0n) - fee);
      for (const ix of tx.instructions) {
        const pid = ix.programId.toBase58();
        if (pid === SystemProgram.programId.toBase58()) {
          const t = SystemInstruction.decodeTransfer(ix);
          const from = t.fromPubkey.toBase58(); const to = t.toPubkey.toBase58(); snap(from); snap(to);
          if ((lam.get(from) ?? 0n) < t.lamports) throw new Error('insufficient lamports');
          lam.set(from, (lam.get(from) ?? 0n) - t.lamports); lam.set(to, (lam.get(to) ?? 0n) + t.lamports);
        } else if (pid === ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()) {
          const [, ataK, ownerK, mintK] = ix.keys.map((k) => k.pubkey.toBase58());
          if (!toks.has(ataK!)) toks.set(ataK!, { owner: ownerK!, mint: mintK!, amount: 0n });
        } else if (pid === TOKEN_PROGRAM_ID.toBase58() && ix.data[0] === 12) {
          const [srcK, mintK, dstK, ownerK] = ix.keys.map((k) => k.pubkey.toBase58());
          const amount = ix.data.readBigUInt64LE(1); const dec = ix.data[9]!;
          const src = toks.get(srcK!); const dst = toks.get(dstK!);
          if (!src || !dst) throw new Error('token account does not exist');
          if (src.owner !== ownerK) throw new Error('wrong token account owner');
          if (src.mint !== mintK || dst.mint !== mintK) throw new Error('mint mismatch');
          if (dec !== (this.decimals.get(mintK!) ?? dec)) throw new Error('decimals mismatch');
          if (src.amount < amount) throw new Error('insufficient token balance');
          if (!preTok.has(srcK!)) preTok.set(srcK!, { ...src }); if (!preTok.has(dstK!)) preTok.set(dstK!, { ...dst });
          src.amount -= amount; dst.amount += amount;
        } // compute budget + memo: no-ops
      }
    } catch (e) { err = { InstructionError: [0, String(e instanceof Error ? e.message : e)] }; }
    if (err) { // failed transactions still land (and pay their fee)
      const payer = tx.feePayer!.toBase58(); this.lamports.set(payer, (this.lamports.get(payer) ?? 0n) - 5000n * BigInt(tx.signatures.length));
    } else { this.lamports = lam; this.tokens = toks; }
    const keys = [...new Set([...tx.compileMessage().accountKeys.map((k) => k.toBase58())])];
    this.landed.set(signature, { signature, slot: ++this.slot, blockTime: Math.floor(Date.now() / 1000), err, keys, pre: keys.map((k) => preLam.get(k) ?? this.lamports.get(k) ?? 0n), post: keys.map((k) => this.lamports.get(k) ?? 0n), preTok: [], postTok: [] });
    return signature;
  }

  /** The RpcFn to hand to setRpcForTests. */
  rpc = async (method: string, params: any): Promise<any> => {
    this.calls.push(method);
    switch (method) {
      case 'getGenesisHash': return this.genesis;
      case 'getBlockHeight': return this.height;
      case 'getLatestBlockhash': return { value: { blockhash: this.blockhash, lastValidBlockHeight: this.height + 150 } };
      case 'sendTransaction': {
        const raw = params[0] as string;
        const sig = bs58.encode(Transaction.from(Buffer.from(raw, 'base64')).signature!);
        if (this.seen.has(sig)) this.rebroadcasts++; this.seen.add(sig);
        return this.execute(raw);
      }
      case 'getSignatureStatuses': return { value: (params[0] as string[]).map((s) => { const t = this.landed.get(s); return t ? { confirmationStatus: 'finalized', err: t.err } : null; }) };
      case 'getTransaction': {
        const t = this.landed.get(params[0]); if (!t) return null;
        return { slot: t.slot, blockTime: t.blockTime, meta: { err: t.err, preBalances: t.pre.map(Number), postBalances: t.post.map(Number), preTokenBalances: t.preTok, postTokenBalances: t.postTok }, transaction: { message: { accountKeys: t.keys.map((pubkey) => ({ pubkey })) } } };
      }
      case 'getBalance': return { value: Number(this.solBalance(params[0])) };
      case 'getTokenAccountBalance': { const a = this.tokens.get(params[0]); if (!a) throw new Error('could not find account'); return { value: { amount: a.amount.toString() } }; }
      case 'getTokenAccountsByOwner': return { value: [...this.tokens.values()].filter((t) => t.owner === params[0]).map((t) => ({ account: { data: { parsed: { info: { mint: t.mint, tokenAmount: { amount: t.amount.toString() } } } } } })) };
      case 'getSignaturesForAddress': {
        const target = params[0] as string;
        return [...this.landed.values()].filter((t) => t.keys.includes(target)).map((t) => ({ signature: t.signature, blockTime: t.blockTime, err: t.err })).reverse();
      }
      default: throw new Error(`FakeChain: unsupported RPC method ${method}`);
    }
  };
}

export const newAddress = () => Keypair.generate().publicKey.toBase58();
