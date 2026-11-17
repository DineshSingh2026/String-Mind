/**
 * MCP (Model Context Protocol) server connection over Streamable HTTP.
 *
 * An MCP server is a TOOL server, not a conversational agent: it exposes tools/resources for a
 * model to call, but cannot itself answer a prompt. StringMind therefore supports MCP connections for
 * health/tool discovery only — `invoke` throws AdapterError('unsupported'). Assessments and
 * training require a chat-capable adapter.
 *
 * Health: JSON-RPC `initialize` → `notifications/initialized` → `tools/list`.
 */
import { randomUUID } from 'node:crypto';
import { AdapterError, type AgentRuntime, type ConnectionInfo, type InvokeResult } from './types.js';
import type { HealthWithSample } from './health.js';
import { httpRequest } from './http.js';

const PROVIDER = 'MCP server';
const PROTOCOL_VERSION = '2025-06-18';

/** Parse a JSON-RPC response from either a JSON body or an SSE stream (`data:` lines). */
function parseRpc(text: string, contentType: string, id: string): { result?: Record<string, unknown>; error?: { code?: number; message?: string } } {
  const candidates: string[] = [];
  if (contentType.includes('text/event-stream')) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (data) candidates.push(data);
    }
  } else candidates.push(text);
  for (const c of candidates) {
    try {
      const j = JSON.parse(c) as unknown;
      const list = Array.isArray(j) ? j : [j];
      for (const m of list as { id?: unknown; result?: Record<string, unknown>; error?: { code?: number; message?: string } }[]) {
        if (m && String(m.id) === id && (m.result || m.error)) return m;
      }
    } catch { /* skip non-JSON event */ }
  }
  throw new AdapterError(`${PROVIDER} returned no valid JSON-RPC response`, 'bad_response');
}

export function createMcpRuntime(info: ConnectionInfo): AgentRuntime & { listTools(): Promise<{ name: string; description?: string }[]> } {
  let sessionId: string | null = null;

  async function send(method: string, params: unknown, opts: { notification?: boolean; timeoutMs?: number } = {}) {
    if (!info.baseUrl) throw new AdapterError('No MCP server URL configured for this agent', 'config');
    const headers: Record<string, string> = {
      'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL_VERSION,
    };
    if (info.apiKey) headers.authorization = `Bearer ${info.apiKey}`;
    if (sessionId) headers['mcp-session-id'] = sessionId;
    const id = randomUUID();
    const payload = opts.notification ? { jsonrpc: '2.0', method, ...(params ? { params } : {}) } : { jsonrpc: '2.0', id, method, params };
    const res = await httpRequest(info.baseUrl, {
      body: JSON.stringify(payload), headers, timeoutMs: opts.timeoutMs ?? 20_000, provider: PROVIDER, secrets: [info.apiKey],
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;
    if (opts.notification) return { result: {}, latencyMs: res.latencyMs };
    const msg = parseRpc(res.text, res.headers.get('content-type') ?? '', id);
    if (msg.error) throw new AdapterError(`${PROVIDER} ${method} failed: ${String(msg.error.message ?? msg.error.code).slice(0, 300)}`, 'bad_response');
    return { result: msg.result ?? {}, latencyMs: res.latencyMs };
  }

  async function handshake() {
    sessionId = null;
    const init = await send('initialize', {
      protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'aix-platform', version: '1.0.0' },
    });
    await send('notifications/initialized', undefined, { notification: true });
    return init.result as { serverInfo?: { name?: string; version?: string } };
  }

  async function listTools() {
    await handshake();
    const { result } = await send('tools/list', {});
    const tools = (result.tools as { name?: unknown; description?: unknown }[] | undefined) ?? [];
    return tools.filter((t) => typeof t.name === 'string')
      .map((t) => ({ name: String(t.name).slice(0, 200), ...(typeof t.description === 'string' ? { description: t.description.slice(0, 500) } : {}) }));
  }

  return {
    adapter: 'mcp',
    capabilities: { chat: false, tools: true, streaming: false, fineTuning: false, contextInjection: false },
    async invoke(): Promise<InvokeResult> {
      throw new AdapterError('MCP servers expose tools, not a conversational interface; they cannot be prompted directly. Connect a chat-capable agent (and attach the MCP server as its tool source) to run assessments, training or the playground.', 'unsupported');
    },
    async health(): Promise<HealthWithSample> {
      const started = Date.now();
      try {
        const init = await handshake();
        const { result } = await send('tools/list', {});
        const tools = (result.tools as { name?: unknown }[] | undefined) ?? [];
        const server = init.serverInfo?.name ? `${init.serverInfo.name}${init.serverInfo.version ? ` ${init.serverInfo.version}` : ''}` : 'MCP server';
        return {
          ok: true, latencyMs: Date.now() - started, model: info.model,
          sample: `${server}: ${tools.length} tool${tools.length === 1 ? '' : 's'} (${tools.slice(0, 10).map((t) => String(t.name)).join(', ')})`.slice(0, 200),
        };
      } catch (err) {
        return { ok: false, latencyMs: Date.now() - started, model: info.model, error: err instanceof Error ? err.message : String(err), kind: err instanceof AdapterError ? err.kind : undefined };
      }
    },
    listTools,
  };
}
