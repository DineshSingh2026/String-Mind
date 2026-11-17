import { and, eq, isNull } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { forbidden, notFound } from './errors.js';

/** Load an agent that belongs to `orgId` (tenant isolation). Throws 404 otherwise (never leaks existence). */
export async function getOwnedAgent(agentId: string, orgId: string) {
  const [a] = await db().select().from(schema.agents)
    .where(and(eq(schema.agents.id, agentId), eq(schema.agents.orgId, orgId), isNull(schema.agents.deletedAt))).limit(1);
  if (!a) throw notFound('Agent');
  return a;
}

/** Load an agent visible to `orgId`: own agents, or public active agents not in a private network. */
export async function getVisibleAgent(agentId: string, orgId: string | null) {
  const [a] = await db().select().from(schema.agents)
    .where(and(eq(schema.agents.id, agentId), isNull(schema.agents.deletedAt))).limit(1);
  if (!a) throw notFound('Agent');
  if (a.orgId === orgId) return a;
  if (!a.isPublic || a.status !== 'active') throw notFound('Agent');
  const [org] = await db().select().from(schema.organisations).where(eq(schema.organisations.id, a.orgId)).limit(1);
  if (org?.privateNetwork) throw notFound('Agent');
  return a;
}

export function assertSameOrg(rowOrgId: string, orgId: string) {
  if (rowOrgId !== orgId) throw forbidden();
}
