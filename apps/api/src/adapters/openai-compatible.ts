/**
 * OpenAI-compatible Chat Completions adapter (OpenAI, xAI Grok, Mistral, DeepSeek, Llama hosts
 * such as Ollama/vLLM/Together). POST {baseUrl}/chat/completions with Bearer auth.
 */
import { AdapterError, type AgentRuntime, type ConnectionInfo, type InvokeRequest, type InvokeResult } from './types.js';
import { chatHealth } from './health.js';
import { chatTurns, httpRequest, joinUrl, parseJson, requireText, systemText } from './http.js';

export function createOpenAICompatibleRuntime(info: ConnectionInfo, providerName = 'Provider'): AgentRuntime {
  const baseUrl = info.baseUrl;
  // OpenAI's newer models reject `max_tokens`; other compatible hosts still expect it.
  const tokenField = info.providerSlug === 'openai' ? 'max_completion_tokens' : 'max_tokens';
  const runtime: AgentRuntime = {
    adapter: 'openai_compatible',
    capabilities: { chat: true, tools: true, streaming: false, fineTuning: false, contextInjection: true },
    async invoke(req: InvokeRequest): Promise<InvokeResult> {
      if (!baseUrl) throw new AdapterError('No base URL configured for this agent', 'config');
      const system = systemText(req);
      const messages = [...(system ? [{ role: 'system', content: system }] : []), ...chatTurns(req).map((m) => ({ role: m.role, content: m.content }))];
      const body: Record<string, unknown> = { model: info.model, messages };
      if (req.maxTokens) body[tokenField] = req.maxTokens;
      if (req.temperature !== undefined) body.temperature = req.temperature;
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (info.apiKey) headers.authorization = `Bearer ${info.apiKey}`;
      const res = await httpRequest(joinUrl(baseUrl, 'chat/completions'), {
        body: JSON.stringify(body), headers, timeoutMs: req.timeoutMs, provider: providerName, secrets: [info.apiKey],
      });
      const j = parseJson(res.text, providerName) as {
        choices?: { message?: { content?: unknown; refusal?: unknown } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const msg = j.choices?.[0]?.message;
      if (!msg) throw new AdapterError(`${providerName} response had no choices`, 'bad_response');
      let content: unknown = msg.content;
      // Some hosts return content parts: [{type:'text', text}]
      if (Array.isArray(content)) content = content.map((p) => (typeof p === 'object' && p && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : '')).join('');
      if ((content === null || content === undefined) && typeof msg.refusal === 'string') content = msg.refusal;
      return {
        text: requireText(content, providerName), latencyMs: res.latencyMs,
        usage: { inputTokens: j.usage?.prompt_tokens, outputTokens: j.usage?.completion_tokens },
      };
    },
    health: () => chatHealth(runtime, info.model),
  };
  return runtime;
}
