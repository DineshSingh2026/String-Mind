/**
 * Anthropic Messages API adapter. POST {baseUrl}/v1/messages with x-api-key and
 * anthropic-version headers; system prompt is a top-level field.
 */
import { AdapterError, type AgentRuntime, type ConnectionInfo, type InvokeRequest, type InvokeResult } from './types.js';
import { chatHealth } from './health.js';
import { chatTurns, httpRequest, joinUrl, parseJson, systemText } from './http.js';

const PROVIDER = 'Anthropic';
const DEFAULT_MAX_TOKENS = 1024;

/** Anthropic requires alternating user/assistant turns starting with user: merge consecutive roles. */
function normaliseTurns(req: InvokeRequest) {
  const out: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const m of chatTurns(req)) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const prev = out[out.length - 1];
    if (prev && prev.role === role) prev.content += `\n\n${m.content}`;
    else out.push({ role, content: m.content });
  }
  if (out[0]?.role === 'assistant') out.unshift({ role: 'user', content: '(conversation continues)' });
  return out;
}

export function createAnthropicRuntime(info: ConnectionInfo): AgentRuntime {
  const runtime: AgentRuntime = {
    adapter: 'anthropic',
    capabilities: { chat: true, tools: true, streaming: false, fineTuning: false, contextInjection: true },
    async invoke(req: InvokeRequest): Promise<InvokeResult> {
      if (!info.baseUrl) throw new AdapterError('No base URL configured for this agent', 'config');
      if (!info.apiKey) throw new AdapterError('No Anthropic API key configured for this agent', 'config');
      const messages = normaliseTurns(req);
      if (!messages.length) throw new AdapterError('Cannot invoke with an empty conversation', 'config');
      const system = systemText(req);
      const body: Record<string, unknown> = { model: info.model, max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS, messages };
      if (system) body.system = system;
      if (req.temperature !== undefined) body.temperature = req.temperature;
      const res = await httpRequest(joinUrl(info.baseUrl, 'v1/messages'), {
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json', 'x-api-key': info.apiKey, 'anthropic-version': '2023-06-01' },
        timeoutMs: req.timeoutMs, provider: PROVIDER, secrets: [info.apiKey],
      });
      const j = parseJson(res.text, PROVIDER) as {
        content?: { type?: string; text?: unknown }[]; stop_reason?: string;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      if (!Array.isArray(j.content)) throw new AdapterError(`${PROVIDER} response had no content`, 'bad_response');
      const text = j.content.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text as string).join('');
      if (!text && j.stop_reason === 'refusal') throw new AdapterError(`${PROVIDER} declined to respond (stop_reason: refusal)`, 'bad_response');
      return { text, latencyMs: res.latencyMs, usage: { inputTokens: j.usage?.input_tokens, outputTokens: j.usage?.output_tokens } };
    },
    health: () => chatHealth(runtime, info.model),
  };
  return runtime;
}
