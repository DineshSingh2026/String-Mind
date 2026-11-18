/**
 * Registered external withdrawal addresses.
 *
 * Agent wallets are custodial (the platform holds their keys), so a withdrawal must leave platform custody: it is paid
 * Treasury → the agent's ONE registered payout address, never to an address supplied per request.
 *   - the first address an agent registers is active immediately;
 *   - a change is 'pending' until payoutAddressCooldownHours have passed — a stolen login cannot redirect funds instantly,
 *     and the owner is notified so they can react;
 *   - only on-curve wallet addresses are accepted (rejects token accounts and PDAs, which would strand tokens), and never a
 *     platform-controlled one.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { badRequest } from '../../lib/errors.js';
import { notifyOrg } from '../../lib/notify.js';
import { getOnchainSettings } from './settings.js';
import { isWalletAddress } from './solana.js';
import { platformControlled } from './wallets.js';

type Row = typeof schema.agentPayoutAddresses.$inferSelect;

export function validateExternalAddress(address: string): string {
  const a = (address ?? '').trim();
  if (!isWalletAddress(a)) throw badRequest('Use a valid Solana wallet (owner) address — not a token account or program-derived address');
  return a;
}

async function rows(agentId: string): Promise<{ active: Row | null; pending: Row | null }> {
  const r = await db().select().from(schema.agentPayoutAddresses).where(and(eq(schema.agentPayoutAddresses.agentId, agentId), inArray(schema.agentPayoutAddresses.status, ['active', 'pending'])));
  return { active: r.find((x) => x.status === 'active') ?? null, pending: r.find((x) => x.status === 'pending') ?? null };
}

/** A pending change whose cooldown has passed becomes active (and the old active one is superseded) — atomically. */
async function promoteDue(agentId: string): Promise<{ active: Row | null; pending: Row | null }> {
  let { active, pending } = await rows(agentId);
  if (pending && pending.effectiveAt.getTime() <= Date.now()) {
    await db().transaction(async (tx) => {
      if (active) await tx.update(schema.agentPayoutAddresses).set({ status: 'superseded' }).where(and(eq(schema.agentPayoutAddresses.id, active.id), eq(schema.agentPayoutAddresses.status, 'active')));
      await tx.update(schema.agentPayoutAddresses).set({ status: 'active' }).where(and(eq(schema.agentPayoutAddresses.id, pending!.id), eq(schema.agentPayoutAddresses.status, 'pending')));
    });
    ({ active, pending } = await rows(agentId));
  }
  return { active, pending };
}

export async function getPayoutAddress(agentId: string) {
  const { active, pending } = await promoteDue(agentId);
  return { activeAddress: active?.address ?? null, pendingAddress: pending?.address ?? null, pendingEffectiveAt: pending?.effectiveAt ?? null };
}

export async function getEffectivePayoutAddress(agentId: string): Promise<string | null> {
  return (await promoteDue(agentId)).active?.address ?? null;
}

export async function setPayoutAddress(agent: { id: string; orgId: string; name: string }, address: string) {
  address = validateExternalAddress(address);
  if ((await platformControlled([address])).size) throw badRequest('That address is a Hive Mind-controlled wallet; register your own external wallet');
  const { active, pending } = await promoteDue(agent.id);
  const now = new Date();
  if (!active) {
    await db().insert(schema.agentPayoutAddresses).values({ agentId: agent.id, address, status: 'active', effectiveAt: now }).onConflictDoNothing();
  } else if (active.address === address) {
    if (pending) await db().update(schema.agentPayoutAddresses).set({ status: 'cancelled' }).where(eq(schema.agentPayoutAddresses.id, pending.id)); // changing back cancels the change
  } else {
    if (pending) await db().update(schema.agentPayoutAddresses).set({ status: 'cancelled' }).where(eq(schema.agentPayoutAddresses.id, pending.id));
    const hours = (await getOnchainSettings()).payoutAddressCooldownHours;
    const effectiveAt = new Date(now.getTime() + hours * 3_600_000);
    await db().insert(schema.agentPayoutAddresses).values({ agentId: agent.id, address, status: 'pending', effectiveAt });
    await notifyOrg(agent.orgId, 'system', `Payout address change requested for ${agent.name}`,
      `A new payout address was registered and takes effect ${effectiveAt.toISOString()}. If this was not you, cancel it by registering the current address again and review your account security.`, `/app/agents/${agent.id}`).catch(() => undefined);
  }
  return getPayoutAddress(agent.id);
}
