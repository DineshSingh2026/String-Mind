/**
 * Permanent agent wallets + the platform-wallet allowlist.
 *
 * Every agent owns exactly ONE active Solana wallet for its whole life. Wallet "creation" is purely off-chain: the keypair
 * is derived from the master seed (keys.ts) and only its public address is stored. Nothing is sent on-chain — a Solana
 * address exists the moment funds arrive. ensureAgentWallet is idempotent: it returns the existing wallet, or derives the
 * same address again (deterministic per agentId + keyVersion) and inserts it with ON CONFLICT DO NOTHING, so a retry, a
 * race or a crash between steps can never produce two wallets.
 *
 * Roles:  AGENT = the agent's own deposit wallet · MID = Treasury (between agents and Revenue) · ADMIN = Revenue.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Keypair } from '@solana/web3.js';
import { db, schema, type DbOrTx } from '../../db/client.js';
import { config } from '../../lib/config.js';
import { AGENT_WALLET_SCOPE, deriveAgentKeypair, deriveKeypair } from './keys.js';

export type SolanaWalletRow = typeof schema.solanaWallets.$inferSelect;
const AGENT_WALLET_KEY_VERSION = 1;

export async function getActiveAgentWallet(agentId: string, q: DbOrTx = db()): Promise<SolanaWalletRow | null> {
  const [w] = await q.select().from(schema.solanaWallets)
    .where(and(eq(schema.solanaWallets.agentId, agentId), eq(schema.solanaWallets.role, 'AGENT'), eq(schema.solanaWallets.status, 'active'))).limit(1);
  return w ?? null;
}

export async function ensureAgentWallet(agentId: string): Promise<SolanaWalletRow> {
  const existing = await getActiveAgentWallet(agentId);
  if (existing) return existing;
  const kp = await deriveAgentKeypair(agentId, AGENT_WALLET_KEY_VERSION);
  const address = kp.publicKey.toBase58(); // only the public address leaves this function
  await db().insert(schema.solanaWallets).values({
    role: 'AGENT', agentId, publicAddress: address, keySource: 'derived', derivationScope: AGENT_WALLET_SCOPE, derivationId: agentId,
    keyVersion: AGENT_WALLET_KEY_VERSION, status: 'active',
  }).onConflictDoNothing();
  const wallet = await getActiveAgentWallet(agentId);
  if (!wallet || wallet.publicAddress !== address) throw new Error(`Could not provision a wallet for agent ${agentId}`);
  return wallet;
}

/** Re-derives an agent wallet's key for ONE transaction. The caller must keep it in a local variable only. */
export async function agentSigningKeypair(wallet: SolanaWalletRow): Promise<Keypair> {
  if (wallet.role !== 'AGENT' || wallet.keySource !== 'derived' || !wallet.derivationId || !wallet.derivationScope) throw new Error(`Wallet ${wallet.id} is not a derived agent wallet`);
  const kp = await deriveKeypair(wallet.derivationScope, wallet.derivationId, wallet.keyVersion);
  if (kp.publicKey.toBase58() !== wallet.publicAddress) throw new Error(`Derived key does not match wallet ${wallet.id} — refusing to sign`);
  return kp;
}

/** Provision wallets for existing agents that predate this feature. */
export async function backfillAgentWallets(batch = 200): Promise<number> {
  const rows = await db().select({ id: schema.agents.id }).from(schema.agents)
    .leftJoin(schema.solanaWallets, and(eq(schema.solanaWallets.agentId, schema.agents.id), eq(schema.solanaWallets.role, 'AGENT'), eq(schema.solanaWallets.status, 'active')))
    .where(and(isNull(schema.solanaWallets.id), isNull(schema.agents.deletedAt))).limit(batch);
  for (const r of rows) await ensureAgentWallet(r.id);
  return rows.length;
}

/** Mirror the configured Treasury (MID) / Revenue (ADMIN) public addresses into solana_wallets (on the allowlist, visible to admins). A changed address retires the old row. */
export async function ensurePlatformWallets(): Promise<void> {
  for (const [role, address, keySource] of [['MID', config.MID_WALLET_ADDRESS, 'secret'], ['ADMIN', config.ADMIN_WALLET_ADDRESS, 'external']] as const) {
    if (!address) continue;
    const [current] = await db().select().from(schema.solanaWallets).where(and(eq(schema.solanaWallets.role, role), eq(schema.solanaWallets.status, 'active'))).limit(1);
    if (current?.publicAddress === address) continue;
    if (current) await db().update(schema.solanaWallets).set({ status: 'retired', updatedAt: new Date() }).where(eq(schema.solanaWallets.id, current.id));
    const [row] = await db().select().from(schema.solanaWallets).where(eq(schema.solanaWallets.publicAddress, address)).limit(1);
    if (row) {
      if (row.role !== role) throw new Error(`${role} address ${address} is already registered as a ${row.role} wallet`);
      await db().update(schema.solanaWallets).set({ status: 'active', updatedAt: new Date() }).where(eq(schema.solanaWallets.id, row.id));
    } else {
      await db().insert(schema.solanaWallets).values({ role, publicAddress: address, keySource, status: 'active' });
    }
  }
}

function configuredPlatformAddresses(): Set<string> {
  return new Set([config.MID_WALLET_ADDRESS, config.ADMIN_WALLET_ADDRESS, config.LEGACY_FEE_PAYER_ADDRESS].filter(Boolean));
}

/** The subset of `addresses` whose keys the platform controls: Treasury, Revenue, retired platform wallets and every agent wallet. A transfer FROM any of these into an agent wallet is internal and must never create IDLE. */
export async function platformControlled(addresses: Iterable<string>): Promise<Set<string>> {
  const list = [...new Set(addresses)];
  if (!list.length) return new Set();
  const found = new Set(list.filter((a) => configuredPlatformAddresses().has(a)));
  const rows = await db().select({ a: schema.solanaWallets.publicAddress }).from(schema.solanaWallets).where(inArray(schema.solanaWallets.publicAddress, list));
  for (const r of rows) found.add(r.a);
  return found;
}

export async function activePlatformWallet(role: 'MID' | 'ADMIN'): Promise<SolanaWalletRow | null> {
  const [w] = await db().select().from(schema.solanaWallets).where(and(eq(schema.solanaWallets.role, role), eq(schema.solanaWallets.status, 'active'))).limit(1);
  return w ?? null;
}

export const walletCount = async () => Number((await db().select({ n: sql<number>`count(*)::int` }).from(schema.solanaWallets).where(eq(schema.solanaWallets.role, 'AGENT')))[0]?.n ?? 0);
