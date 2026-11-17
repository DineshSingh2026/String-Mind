import { randomBytes } from 'node:crypto';
import { schema, type DbOrTx } from '../../db/client.js';
import { slugify } from '../../lib/http.js';

/** Creates an organisation with `ownerId` as owner. Wallets are created lazily by the wallet module. */
export async function createOrgWithOwner(tx: DbOrTx, input: { name: string; type: 'personal' | 'enterprise'; ownerId: string }) {
  const slug = `${slugify(input.name).slice(0, 40)}-${randomBytes(3).toString('hex')}`;
  const [org] = await tx.insert(schema.organisations).values({
    name: input.name, slug, type: input.type, plan: 'free',
  }).returning();
  await tx.insert(schema.memberships).values({ orgId: org!.id, userId: input.ownerId, role: 'owner' });
  return org!;
}
