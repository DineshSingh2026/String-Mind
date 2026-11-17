/**
 * Shared HTTP plumbing for provider adapters: timeouts, status → AdapterError mapping,
 * secret redaction and defensive parsing. Provider responses are untrusted text.
 */
import { assertSafeOutboundUrl, UnsafeUrlError } from '../lib/net-guard.js';
import { AdapterError, type ChatMessage, type InvokeRequest } from './types.js';

export const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_ERROR_DETAIL = 300;

export interface HttpResult { status: number; headers: Headers; text: string; latencyMs: number }

/** Remove any occurrence of the given secrets from a string (providers sometimes echo keys). */
export function redact(s: string, secrets: (string | null | undefined)[]): string {
  let out = s;
  for (const sec of secrets) if (sec && sec.length >= 4) out = out.split(sec).join('[redacted]');
  return out;
}

/** Best-effort extraction of a provider error message from a JSON/text body. */
export function providerErrorDetail(text: string): string {
  let msg = text;
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const e = j.error as Record<string, unknown> | string | undefined;
    if (typeof e === 'string') msg = e;
    else if (e && typeof e.message === 'string') msg = e.message;
    else if (typeof j.message === 'string') msg = j.message;
    else if (typeof j.detail === 'string') msg = j.detail;
  } catch { /* not JSON */ }
  msg = msg.replace(/\s+/g, ' ').trim();
  return msg.length > MAX_ERROR_DETAIL ? `${msg.slice(0, MAX_ERROR_DETAIL)}…` : msg;
}

/**
 * POST (or other method) with timeout + error mapping:
 *   401/403 → auth, 429 → rate_limit, abort → timeout, fetch failure → network,
 *   404 → config (wrong endpoint/model), other non-2xx → bad_response.
 */
export async function httpRequest(url: string, init: {
  method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number;
  provider: string; secrets?: (string | null | undefined)[]; allowStatuses?: number[];
}): Promise<HttpResult> {
  // SSRF guard re-checked per request (DNS rebinding defence); also validated when the URL is saved.
  try { await assertSafeOutboundUrl(url); } catch (err) {
    if (err instanceof UnsafeUrlError) throw new AdapterError(`Refusing to call ${init.provider}: ${err.message}`, 'config');
    throw err;
  }
  const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  const secrets = init.secrets ?? [];
  let res: Response;
  let text: string;
  try {
    res = await fetch(url, { method: init.method ?? 'POST', headers: init.headers, body: init.body, signal: ctrl.signal, redirect: 'error' });
    text = await res.text();
  } catch (err) {
    if (ctrl.signal.aborted) throw new AdapterError(`${init.provider} did not respond within ${Math.round(timeoutMs / 1000)}s`, 'timeout');
    const cause = err instanceof Error ? ((err as Error & { cause?: { code?: string; message?: string } }).cause?.code ?? err.message) : String(err);
    throw new AdapterError(`Could not reach ${init.provider}: ${redact(String(cause), secrets)}`, 'network');
  } finally {
    clearTimeout(timer);
  }
  const latencyMs = Date.now() - started;
  if (res.ok || init.allowStatuses?.includes(res.status)) return { status: res.status, headers: res.headers, text, latencyMs };
  const detail = redact(providerErrorDetail(text), secrets);
  const suffix = detail ? `: ${detail}` : '';
  if (res.status === 401 || res.status === 403) throw new AdapterError(`${init.provider} rejected the credentials (HTTP ${res.status})${suffix}`, 'auth');
  if (res.status === 429) throw new AdapterError(`${init.provider} rate limit or quota exceeded (HTTP 429)${suffix}`, 'rate_limit');
  if (res.status === 404) throw new AdapterError(`${init.provider} endpoint or model not found (HTTP 404)${suffix}`, 'config');
  if (res.status === 408 || res.status === 504) throw new AdapterError(`${init.provider} timed out (HTTP ${res.status})${suffix}`, 'timeout');
  throw new AdapterError(`${init.provider} returned HTTP ${res.status}${suffix}`, 'bad_response');
}

export function parseJson(text: string, provider: string): unknown {
  try { return JSON.parse(text); } catch { throw new AdapterError(`${provider} returned a non-JSON response`, 'bad_response'); }
}

/** Joins StringMind-injected system text with any system messages in the conversation. */
export function systemText(req: InvokeRequest): string {
  return [req.system, ...req.messages.filter((m) => m.role === 'system').map((m) => m.content)]
    .filter((s): s is string => !!s && !!s.trim()).join('\n\n');
}

export function chatTurns(req: InvokeRequest): ChatMessage[] {
  return req.messages.filter((m) => m.role !== 'system');
}

export function lastUserMessage(req: InvokeRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) if (req.messages[i]!.role === 'user') return req.messages[i]!.content;
  return '';
}

export function requireText(text: unknown, provider: string): string {
  if (typeof text !== 'string') throw new AdapterError(`${provider} response contained no text output`, 'bad_response');
  return text;
}

/** Trailing-slash-safe URL join. */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export const HEALTH_PROMPT: InvokeRequest = {
  messages: [{ role: 'user', content: 'Connection check from StringMind. Reply with the single word: OK' }],
  maxTokens: 32, purpose: 'health', timeoutMs: 20_000,
};
