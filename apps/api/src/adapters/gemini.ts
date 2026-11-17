/**
 * Google Gemini generateContent adapter.
 * POST {baseUrl}/models/{model}:generateContent with systemInstruction.
 * The API key is sent in the `x-goog-api-key` header (officially supported, equivalent to
 * `?key=`) so it never appears in URLs, proxies or access logs.
 */
import { AdapterError, type AgentRuntime, type ConnectionInfo, type InvokeRequest, type InvokeResult } from './types.js';
import { chatHealth } from './health.js';
import { chatTurns, httpRequest, joinUrl, parseJson, systemText } from './http.js';

const PROVIDER = 'Google Gemini';

export function createGeminiRuntime(info: ConnectionInfo): AgentRuntime {
  const runtime: AgentRuntime = {
    adapter: 'gemini',
    capabilities: { chat: true, tools: true, streaming: false, fineTuning: false, contextInjection: true },
    async invoke(req: InvokeRequest): Promise<InvokeResult> {
      if (!info.baseUrl) throw new AdapterError('No base URL configured for this agent', 'config');
      if (!info.apiKey) throw new AdapterError('No Gemini API key configured for this agent', 'config');
      const contents: { role: 'user' | 'model'; parts: { text: string }[] }[] = [];
      for (const m of chatTurns(req)) {
        const role = m.role === 'assistant' ? 'model' : 'user';
        const prev = contents[contents.length - 1];
        if (prev && prev.role === role) prev.parts.push({ text: m.content });
        else contents.push({ role, parts: [{ text: m.content }] });
      }
      if (!contents.length) throw new AdapterError('Cannot invoke with an empty conversation', 'config');
      const system = systemText(req);
      const generationConfig: Record<string, unknown> = {};
      if (req.maxTokens) generationConfig.maxOutputTokens = req.maxTokens;
      if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
      const body: Record<string, unknown> = { contents, generationConfig };
      if (system) body.systemInstruction = { parts: [{ text: system }] };
      const model = info.model.replace(/^models\//, '');
      const res = await httpRequest(joinUrl(info.baseUrl, `models/${encodeURIComponent(model)}:generateContent`), {
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json', 'x-goog-api-key': info.apiKey },
        timeoutMs: req.timeoutMs, provider: PROVIDER, secrets: [info.apiKey],
      });
      const j = parseJson(res.text, PROVIDER) as {
        candidates?: { content?: { parts?: { text?: unknown }[] }; finishReason?: string }[];
        promptFeedback?: { blockReason?: string };
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      };
      if (j.promptFeedback?.blockReason) throw new AdapterError(`${PROVIDER} blocked the prompt (${j.promptFeedback.blockReason})`, 'bad_response');
      const cand = j.candidates?.[0];
      if (!cand) throw new AdapterError(`${PROVIDER} response had no candidates`, 'bad_response');
      const text = (cand.content?.parts ?? []).map((p) => (typeof p.text === 'string' ? p.text : '')).join('');
      if (!text && cand.finishReason && cand.finishReason !== 'STOP' && cand.finishReason !== 'MAX_TOKENS') {
        throw new AdapterError(`${PROVIDER} returned no text (finishReason: ${cand.finishReason})`, 'bad_response');
      }
      return { text, latencyMs: res.latencyMs, usage: { inputTokens: j.usageMetadata?.promptTokenCount, outputTokens: j.usageMetadata?.candidatesTokenCount } };
    },
    health: () => chatHealth(runtime, info.model),
  };
  return runtime;
}
