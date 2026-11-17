/**
 * Adapter entry points used across the platform (assessments, training, playground, health).
 *
 *   getConnectionInfo(agentId)  → decrypted connection info (server-side only)
 *   getRuntime(agentId)         → AgentRuntime for the agent's adapter
 *   invokeAgent(agentId, req, { withContext, contextQuery, sessionId })
 *       → enforces status + daily limits, injects instructions/role/RAG context, calls the agent
 *         with a timeout and returns the reply plus the context that was injected.
 */
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { decrypt } from '../lib/crypto.js';
import { buildAgentContext, type AgentContext } from '../engine/context.js';
import { createRuntime } from './factory.js';
import { DEFAULT_TIMEOUT_MS, lastUserMessage } from './http.js';
import { tryConsumeCall } from './usage.js';
import { AdapterError, type AgentRuntime, type ConnectionInfo, type InvokeRequest, type InvokeResult } from './types.js';

export async function getConnectionInfo(agentId: string): Promise<ConnectionInfo> {
  const [row] = await db().select({ agent: schema.agents, provider: schema.agentProviders, conn: schema.agentConnections })
    .from(schema.agents)
    .innerJoin(schema.agentProviders, eq(schema.agentProviders.id, schema.agents.providerId))
    .leftJoin(schema.agentConnections, eq(schema.agentConnections.agentId, schema.agents.id))
    .where(eq(schema.agents.id, agentId)).limit(1);
  if (!row) throw new AdapterError('Agent not found', 'config');
  if (row.agent.deletedAt) throw new AdapterError('Agent has been deleted', 'config');
  const { agent, provider, conn } = row;
  if (!conn || conn.status === 'disconnected') throw new AdapterError('Agent is not connected — add a connection first', 'config');
  if (provider.status === 'disabled') throw new AdapterError(`Provider ${provider.name} is currently disabled on StringMind`, 'config');
  let apiKey: string | null = null;
  let webhookSecret: string | null = null;
  try {
    apiKey = conn.credentialEnc ? decrypt(conn.credentialEnc) : null;
    webhookSecret = conn.webhookSecretEnc ? decrypt(conn.webhookSecretEnc) : null;
  } catch {
    throw new AdapterError('Stored credential could not be decrypted (encryption key changed?) — re-enter the credential', 'config');
  }
  return {
    agentId: agent.id, orgId: agent.orgId, providerSlug: provider.slug, adapter: provider.adapter,
    model: agent.modelName, baseUrl: conn.endpointUrl ?? provider.defaultBaseUrl, apiKey, config: conn.config ?? {}, webhookSecret,
  };
}

export async function getRuntime(agentId: string): Promise<AgentRuntime> {
  return createRuntime(await getConnectionInfo(agentId));
}

export async function invokeAgent(
  agentId: string, req: InvokeRequest, opts: { withContext?: boolean; contextQuery?: string; sessionId?: string } = {},
): Promise<InvokeResult & { context: AgentContext | null }> {
  const [agent] = await db().select().from(schema.agents).where(eq(schema.agents.id, agentId)).limit(1);
  if (!agent || agent.deletedAt) throw new AdapterError('Agent not found or deleted', 'config');
  if (agent.status === 'suspended') throw new AdapterError('Agent is suspended and cannot be invoked', 'config');
  if (agent.status === 'disconnected') throw new AdapterError('Agent is disconnected — reconnect it before use', 'config');

  const runtime = await getRuntime(agentId);
  if (!runtime.capabilities.chat) {
    throw new AdapterError(`The ${runtime.adapter} adapter is not conversational and cannot be invoked with prompts`, 'unsupported');
  }

  if (req.purpose !== 'health' && !tryConsumeCall(agentId, agent.usageLimits?.maxCallsPerDay)) {
    throw new AdapterError(`Daily call limit reached for this agent (${agent.usageLimits.maxCallsPerDay}/day). Raise it in the agent's limits settings.`, 'rate_limit');
  }

  let context: AgentContext | null = null;
  if (opts.withContext !== false) {
    const query = opts.contextQuery ?? lastUserMessage(req);
    if (query.trim()) {
      try {
        context = await buildAgentContext(agentId, query, { sessionId: opts.sessionId });
      } catch (err) {
        // Context retrieval is an enhancement: degrade to no context rather than failing the call.
        console.error(`[adapters] context build failed for agent ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
        context = null;
      }
    }
  }

  const system = [
    agent.instructions?.trim(),
    agent.role?.trim() ? `Your role: ${agent.role.trim()}` : '',
    req.system?.trim(),
    context?.text ?? '',
  ].filter(Boolean).join('\n\n');

  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  // Adapters enforce the timeout via AbortController; this guard also covers runtimes that don't.
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AdapterError(`Agent did not respond within ${Math.round(timeoutMs / 1000)}s`, 'timeout')), timeoutMs + 2_000);
  });
  try {
    const result = await Promise.race([runtime.invoke({ ...req, system: system || undefined, timeoutMs }), guard]);
    return { ...result, context };
  } finally {
    clearTimeout(timer);
  }
}
