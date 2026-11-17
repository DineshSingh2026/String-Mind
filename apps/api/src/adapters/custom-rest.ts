/**
 * Custom REST agent: POST {endpointUrl} with JSON
 *   { messages: [{role, content}], system, maxTokens?, temperature?, purpose? }
 * and expects JSON { text } | { reply } | { output } (string). Optional Bearer token.
 */
import { AdapterError, type AgentRuntime, type ConnectionInfo, type InvokeRequest, type InvokeResult } from './types.js';
import { chatHealth } from './health.js';
import { chatTurns, httpRequest, parseJson, systemText } from './http.js';

/** Pull the reply string out of a custom agent's JSON response. */
export function extractReply(j: unknown, provider: string): string {
  if (j && typeof j === 'object') {
    const o = j as Record<string, unknown>;
    for (const k of ['text', 'reply', 'output'] as const) if (typeof o[k] === 'string') return o[k] as string;
  }
  throw new AdapterError(`${provider} response must be JSON with a string "text", "reply" or "output" field`, 'bad_response');
}

export function createCustomRestRuntime(info: ConnectionInfo): AgentRuntime {
  const provider = 'Custom REST agent';
  const runtime: AgentRuntime = {
    adapter: 'custom_rest',
    capabilities: { chat: true, tools: false, streaming: false, fineTuning: false, contextInjection: true },
    async invoke(req: InvokeRequest): Promise<InvokeResult> {
      if (!info.baseUrl) throw new AdapterError('No endpoint URL configured for this agent', 'config');
      const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
      if (info.apiKey) headers.authorization = `Bearer ${info.apiKey}`;
      const body = {
        messages: chatTurns(req).map((m) => ({ role: m.role, content: m.content })),
        system: systemText(req),
        ...(req.maxTokens ? { maxTokens: req.maxTokens } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.purpose ? { purpose: req.purpose } : {}),
      };
      const res = await httpRequest(info.baseUrl, { body: JSON.stringify(body), headers, timeoutMs: req.timeoutMs, provider, secrets: [info.apiKey] });
      return { text: extractReply(parseJson(res.text, provider), provider), latencyMs: res.latencyMs };
    },
    health: () => chatHealth(runtime, info.model),
  };
  return runtime;
}
