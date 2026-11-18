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
import { buildAgentContext, type AgentContext, type ContextOptions } from '../engine/context.js';
import { createRuntime } from './factory.js';
import { DEFAULT_TIMEOUT_MS, lastUserMessage } from './http.js';
import { tryConsumeCall } from './usage.js';
import { inboxTimeoutMs } from '../lib/agent-inbox.js';
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
  if (provider.status === 'disabled') throw new AdapterError(`Provider ${provider.name} is currently disabled on Hive Mind`, 'config');
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

type AgentRow = typeof schema.agents.$inferSelect;

export interface InvokeContextOptions extends Pick<ContextOptions, 'sessionId' | 'excludeExperienceIds' | 'excludeMemoryIds'> {
  withContext?: boolean; contextQuery?: string;
}

/**
 * The system prompt an agent receives for a call: its instructions, role, the request's own system text and the
 * retrieved knowledge context. Shared by invokeAgent and async (inbox) assessments so both see identical prompts.
 */
export async function buildInvocationSystem(
  agent: Pick<AgentRow, 'id' | 'instructions' | 'role'>, req: Pick<InvokeRequest, 'messages' | 'system'>,
  opts: InvokeContextOptions = {},
): Promise<{ system: string; context: AgentContext | null }> {
  let context: AgentContext | null = null;
  if (opts.withContext !== false) {
    const query = opts.contextQuery ?? lastUserMessage(req as InvokeRequest);
    if (query.trim()) {
      try {
        context = await buildAgentContext(agent.id, query, { sessionId: opts.sessionId, excludeExperienceIds: opts.excludeExperienceIds, excludeMemoryIds: opts.excludeMemoryIds });
      } catch (err) {
        // Context retrieval is an enhancement: degrade to no context rather than failing the call.
        console.error(`[adapters] context build failed for agent ${agent.id}: ${err instanceof Error ? err.message : String(err)}`);
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
  return { system, context };
}

export async function invokeAgent(
  agentId: string, req: InvokeRequest, opts: InvokeContextOptions = {},
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

  const { system, context } = await buildInvocationSystem(agent, req, opts);

  // Inbox (connect-via-prompt) agents answer asynchronously by polling: they get the inbox timeout, not the HTTP one.
  const timeoutMs = runtime.adapter === 'inbox' ? inboxTimeoutMs() : (req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
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
