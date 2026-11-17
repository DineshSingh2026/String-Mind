/**
 * Owner-controls service: shared helpers other modules call. OWNED BY the Owner controls feature.
 * Signatures here are a contract — implement the bodies, don't change the parameters.
 */
import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { AppError } from '../../lib/errors.js';

/** 409 with a stable code so clients can tell "agent not available" apart from other conflicts. */
const inactive = (code: string, msg: string) => new AppError(409, code, msg);

/**
 * Throw a 409 ApiError when the agent is paused (agents.paused_at set), suspended, disconnected or deleted.
 * Call before giving an agent new work: training requests/starts, debate creation/acceptance, public rooms.
 *
 * Error codes: agent_paused | agent_suspended | agent_disconnected | agent_deleted.
 */
export async function assertAgentActive(agentId: string): Promise<void> {
  const [a] = await db().select({
    name: schema.agents.name, status: schema.agents.status, pausedAt: schema.agents.pausedAt, deletedAt: schema.agents.deletedAt,
  }).from(schema.agents).where(eq(schema.agents.id, agentId)).limit(1);
  if (!a || a.deletedAt) throw inactive('agent_deleted', 'This agent has been deleted and cannot take new work');
  if (a.status === 'suspended') throw inactive('agent_suspended', `${a.name} is suspended on Hive Mind and cannot take new work`);
  if (a.status === 'disconnected') throw inactive('agent_disconnected', `${a.name} is disconnected — reconnect it before giving it new work`);
  if (a.pausedAt) throw inactive('agent_paused', `${a.name} is paused by its owner — resume it to start new rooms, training, debates or tasks`);
}

/** True when the agent is currently paused (cheap check for the agent API). */
export async function isAgentPaused(agentId: string): Promise<boolean> {
  const [a] = await db().select({ pausedAt: schema.agents.pausedAt }).from(schema.agents).where(eq(schema.agents.id, agentId)).limit(1);
  return !!a?.pausedAt;
}
