/** Admin-configurable gateway policy (system_settings key "onchain"). Safe defaults: nothing automatic, sensible limits. */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema, type DbOrTx } from '../../db/client.js';

export const OnchainSettings = z.object({
  /** Mirror each platform commission as a Treasury → Revenue transfer. */
  feeMirrorEnabled: z.boolean().default(true),
  /** Smallest withdrawal, in IDLE. */
  minWithdrawalIdle: z.number().int().min(1).default(10),
  /** 0 = unlimited. */
  maxWithdrawalPerRequestIdle: z.number().int().min(0).default(0),
  maxDailyWithdrawalIdle: z.number().int().min(0).default(0),
  /** A changed payout address only takes effect after this many hours (a stolen login cannot redirect funds instantly). */
  payoutAddressCooldownHours: z.number().min(0).max(24 * 30).default(24),
  /** Pay withdrawals automatically from the Treasury (up to autoWithdrawalMaxIdle; larger ones wait for an admin). */
  autoWithdrawalsEnabled: z.boolean().default(false),
  autoWithdrawalMaxIdle: z.number().int().min(0).default(0),
  /** A deposit is valued at the price least favourable to the depositor; the floor is at most this fraction below the trailing 1 h median. */
  depositPriceMaxDropPct: z.number().min(0).max(1).default(0.05),
});
export type OnchainSettingsT = z.infer<typeof OnchainSettings>;
const KEY = 'onchain';

export async function getOnchainSettings(q: DbOrTx = db()): Promise<OnchainSettingsT> {
  const [row] = await q.select().from(schema.systemSettings).where(eq(schema.systemSettings.key, KEY)).limit(1);
  return OnchainSettings.parse(row?.value ?? {});
}

export async function putOnchainSettings(patch: unknown, actorId: string | null): Promise<OnchainSettingsT> {
  const next = OnchainSettings.parse({ ...(await getOnchainSettings()), ...(patch as object) });
  await db().insert(schema.systemSettings).values({ key: KEY, value: next, updatedBy: actorId })
    .onConflictDoUpdate({ target: schema.systemSettings.key, set: { value: next, updatedBy: actorId, updatedAt: new Date() } });
  return next;
}
