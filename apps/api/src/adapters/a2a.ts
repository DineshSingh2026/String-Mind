/**
 * A2A (Agent2Agent) adapter — JSON-RPC 2.0 `message/send` to the agent's endpoint.
 * A2A has no separate system-prompt channel, so Hive Mind instructions/context and prior turns are
 * sent as a clearly delimited preamble inside the user message text.
 * If the agent answers with a non-terminal Task, `tasks/get` is polled until it completes
 * or the timeout elapses.
 */
import { randomUUID } from 'node:crypto';
import { AdapterError, type AgentRuntime, type ConnectionInfo, type InvokeRequest, type InvokeResult } from './types.js';
import { chatHealth } from './health.js';
import { chatTurns, DEFAULT_TIMEOUT_MS, httpRequest, lastUserMessage, parseJson, systemText } from './http.js';

const PROVIDER = 'A2A agent';
type Part = { kind?: string; type?: string; text?: unknown };
type A2AMessage = { kind?: string; role?: string; parts?: Part[] };
type A2ATask = { kind?: string; id?: string; status?: { state?: string; message?: A2AMessage }; artifacts?: { parts?: Part[] }[] };

const TERMINAL_OK = new Set(['completed']);
const TERMINAL_FAIL = new Set(['failed', 'canceled', 'cancelled', 'rejected']);
const NEEDS_INPUT = new Set(['input-required', 'auth-required']);

function textOf(parts: Part[] | undefined): string {
  return (parts ?? []).filter((p) => (p.kind ?? p.type) === 'text' && typeof p.text === 'string').map((p) => p.text as string).join('\n');
}

function buildText(req: InvokeRequest): string {
  const system = systemText(req);
  const turns = chatTurns(req);
  const history = turns.slice(0, -1);
  const sections: string[] = [];
  if (system) sections.push(`[Context from Hive Mind]\n${system}`);
  if (history.length) sections.push(`[Conversation so far]\n${history.map((m) => `${m.role}: ${m.content}`).join('\n')}`);
  const last = lastUserMessage(req);
  return sections.length ? `${sections.join('\n\n')}\n\n[Message]\n${last}` : last;
}

export function createA2ARuntime(info: ConnectionInfo): AgentRuntime {
  async function rpc(method: string, params: unknown, timeoutMs: number) {
    if (!info.baseUrl) throw new AdapterError('No endpoint URL configured for this agent', 'config');
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
    if (info.apiKey) headers.authorization = `Bearer ${info.apiKey}`;
    const id = randomUUID();
    const res = await httpRequest(info.baseUrl, {
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), headers, timeoutMs, provider: PROVIDER, secrets: [info.apiKey],
    });
    const j = parseJson(res.text, PROVIDER) as { result?: unknown; error?: { code?: number; message?: string } };
    if (j.error) {
      const msg = String(j.error.message ?? 'unknown error').slice(0, 300);
      throw new AdapterError(`${PROVIDER} JSON-RPC error ${j.error.code ?? ''}: ${msg}`, j.error.code === -32601 ? 'unsupported' : 'bad_response');
    }
    if (j.result === undefined) throw new AdapterError(`${PROVIDER} returned no JSON-RPC result`, 'bad_response');
    return { result: j.result, latencyMs: res.latencyMs };
  }

  const runtime: AgentRuntime = {
    adapter: 'a2a',
    capabilities: { chat: true, tools: false, streaming: false, fineTuning: false, contextInjection: true },
    async invoke(req: InvokeRequest): Promise<InvokeResult> {
      const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const deadline = Date.now() + timeoutMs;
      const started = Date.now();
      const message = { kind: 'message', role: 'user', messageId: randomUUID(), parts: [{ kind: 'text', text: buildText(req) }] };
      let { result } = await rpc('message/send', { message, configuration: { blocking: true, acceptedOutputModes: ['text/plain'] } }, timeoutMs);
      for (;;) {
        const r = result as A2AMessage & A2ATask;
        if (r.kind === 'message' || (!r.status && Array.isArray(r.parts))) {
          return { text: textOf(r.parts), latencyMs: Date.now() - started };
        }
        const state = r.status?.state;
        if (!state) throw new AdapterError(`${PROVIDER} returned an unrecognised result (neither Message nor Task)`, 'bad_response');
        if (TERMINAL_OK.has(state)) {
          const text = [textOf(r.artifacts?.flatMap((a) => a.parts ?? [])), textOf(r.status?.message?.parts)].filter(Boolean).join('\n');
          return { text, latencyMs: Date.now() - started };
        }
        if (TERMINAL_FAIL.has(state)) {
          throw new AdapterError(`${PROVIDER} task ${state}${r.status?.message ? `: ${textOf(r.status.message.parts).slice(0, 300)}` : ''}`, 'bad_response');
        }
        if (NEEDS_INPUT.has(state)) throw new AdapterError(`${PROVIDER} task requires interactive input (${state}), which Hive Mind does not support`, 'unsupported');
        if (!r.id) throw new AdapterError(`${PROVIDER} returned a ${state} task without an id`, 'bad_response');
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new AdapterError(`${PROVIDER} task did not complete within ${Math.round(timeoutMs / 1000)}s`, 'timeout');
        await new Promise((res) => setTimeout(res, Math.min(1000, remaining)));
        ({ result } = await rpc('tasks/get', { id: r.id }, Math.max(1000, deadline - Date.now())));
      }
    },
    health: () => chatHealth(runtime, info.model),
  };
  return runtime;
}
