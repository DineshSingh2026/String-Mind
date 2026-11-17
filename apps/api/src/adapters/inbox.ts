/**
 * Inbox adapter — agents connected via prompt (pull model, provider `prompt-connect`).
 * Hive Mind never calls the agent: `invoke` queues an agent_task and waits for the agent (which long-polls
 * GET /agent-api/tasks/next) to POST its answer. No provider key is ever shared with Hive Mind.
 */
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { enqueueTask, inboxTimeoutMs, isOnline, promptConfig, waitForAnswer, type TaskKind } from '../lib/agent-inbox.js';
import { AdapterError, type AgentRuntime, type ConnectionInfo, type HealthResult, type InvokeRequest, type InvokeResult } from './types.js';

const KIND: Record<NonNullable<InvokeRequest['purpose']>, TaskKind> = {
  assessment: 'assessment', training: 'training', playground: 'playground', health: 'health',
};

async function currentConfig(agentId: string) {
  const [conn] = await db().select().from(schema.agentConnections).where(eq(schema.agentConnections.agentId, agentId)).limit(1);
  return promptConfig(conn);
}

export function createInboxRuntime(info: ConnectionInfo): AgentRuntime {
  return {
    adapter: 'inbox',
    capabilities: { chat: true, tools: false, streaming: false, fineTuning: false, contextInjection: true },

    async invoke(req: InvokeRequest): Promise<InvokeResult> {
      const cfg = await currentConfig(info.agentId);
      if (!cfg.verifiedAt) throw new AdapterError('Agent has not completed the connect-via-prompt handshake yet', 'config');
      if (!isOnline(cfg)) {
        throw new AdapterError('Agent is offline — it has not polled Hive Mind in the last 90s. Start it (or its bridge script) and try again.', 'network');
      }
      const timeoutMs = req.timeoutMs ?? inboxTimeoutMs();
      const started = Date.now();
      const task = await enqueueTask(info.agentId, info.orgId, KIND[req.purpose ?? 'playground'] ?? 'playground', {
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
        system: req.system ?? null,
      }, timeoutMs);
      const done = await waitForAnswer(task.id, timeoutMs);
      if (!done) throw new AdapterError(`Agent did not answer within ${Math.round(timeoutMs / 1000)}s — is it running and polling?`, 'timeout');
      return { text: done.response ?? '', latencyMs: Date.now() - started };
    },

    async health(): Promise<HealthResult> {
      const cfg = promptConfig({ config: info.config });
      if (!cfg.verifiedAt) return { ok: false, latencyMs: 0, model: info.model, error: 'Agent has not completed the connect-via-prompt handshake yet' };
      if (!isOnline(cfg)) {
        const ago = cfg.lastSeenAt ? `${Math.round((Date.now() - Date.parse(cfg.lastSeenAt)) / 1000)}s ago` : 'never';
        return { ok: false, latencyMs: 0, model: info.model, error: `Agent offline — last polled Hive Mind ${ago}` };
      }
      return { ok: true, latencyMs: 0, model: info.model };
    },
  };
}
