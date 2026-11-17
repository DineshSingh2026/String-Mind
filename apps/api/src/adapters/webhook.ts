/**
 * Webhook agent: StringMind POSTs a signed request to the agent's endpoint and waits for a synchronous
 * JSON reply ({ text } | { reply } | { output }).
 *   headers: x-aix-signature: t=<unix>,v1=<hmac_sha256(secret, `${t}.${body}`)>, x-aix-agent-id
 *   body:    { type: 'invoke', agentId, requestId, messages, system, maxTokens?, temperature?, purpose? }
 * Agents verify the signature with their per-agent webhook secret (shown once at connect time).
 */
import { randomUUID } from 'node:crypto';
import { signWebhook } from '../lib/crypto.js';
import { AdapterError, type AgentRuntime, type ConnectionInfo, type InvokeRequest, type InvokeResult } from './types.js';
import { extractReply } from './custom-rest.js';
import { chatHealth } from './health.js';
import { chatTurns, httpRequest, parseJson, systemText } from './http.js';

export function createWebhookRuntime(info: ConnectionInfo): AgentRuntime {
  const provider = 'Webhook agent';
  const runtime: AgentRuntime = {
    adapter: 'webhook',
    capabilities: { chat: true, tools: false, streaming: false, fineTuning: false, contextInjection: true },
    async invoke(req: InvokeRequest): Promise<InvokeResult> {
      if (!info.baseUrl) throw new AdapterError('No endpoint URL configured for this agent', 'config');
      if (!info.webhookSecret) throw new AdapterError('Webhook secret missing — reconnect the agent to issue a new one', 'config');
      const body = JSON.stringify({
        type: 'invoke', agentId: info.agentId, requestId: randomUUID(),
        messages: chatTurns(req).map((m) => ({ role: m.role, content: m.content })),
        system: systemText(req),
        ...(req.maxTokens ? { maxTokens: req.maxTokens } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.purpose ? { purpose: req.purpose } : {}),
      });
      const headers: Record<string, string> = {
        'content-type': 'application/json', accept: 'application/json', 'user-agent': 'StringMind-Agent-Webhook/1.0',
        'x-aix-agent-id': info.agentId, 'x-aix-signature': signWebhook(info.webhookSecret, body),
      };
      if (info.apiKey) headers.authorization = `Bearer ${info.apiKey}`;
      const res = await httpRequest(info.baseUrl, { body, headers, timeoutMs: req.timeoutMs, provider, secrets: [info.apiKey, info.webhookSecret] });
      return { text: extractReply(parseJson(res.text, provider), provider), latencyMs: res.latencyMs };
    },
    health: () => chatHealth(runtime, info.model),
  };
  return runtime;
}
