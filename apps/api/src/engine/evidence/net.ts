/**
 * Outbound network access for proof-based evaluation. EVERY request to a user-supplied URL (or to a public
 * code host on its behalf) goes through `safeFetch`:
 *
 *   - assertSafeOutboundUrl (SSRF guard) before the first request AND before every redirect hop
 *     (redirects are followed manually, max 5 hops, http/https only);
 *   - hard timeout per request (AbortController);
 *   - response body read as a stream and cut at `maxBytes` (the result says `truncated`);
 *   - never sends cookies or credentials of the platform; a fixed generic User-Agent.
 *
 * The functions in `deps` are the only way this module touches the network or DNS, so tests replace them
 * (no real network in tests).
 */
import { resolveTxt } from 'node:dns/promises';
import { assertSafeOutboundUrl, UnsafeUrlError } from '../../lib/net-guard.js';

export const deps = {
  fetch: (url: string, init: RequestInit): Promise<Response> => globalThis.fetch(url, init),
  resolveTxt: (host: string): Promise<string[][]> => resolveTxt(host),
};

export interface SafeFetchResult {
  ok: boolean;
  status: number;
  url: string;
  headers: Record<string, string>;
  body: Buffer;
  text: string;
  truncated: boolean;
  elapsedMs: number;
  redirects: number;
}

export class FetchFailure extends Error {
  constructor(message: string, public reason: 'blocked' | 'timeout' | 'network' | 'too_many_redirects') { super(message); }
}

const USER_AGENT = 'HiveMind-ProofCheck/1.0 (+static checks only)';

async function readCapped(res: Response, maxBytes: number): Promise<{ body: Buffer; truncated: boolean }> {
  if (!res.body) return { body: Buffer.alloc(0), truncated: false };
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const buf = Buffer.from(value);
    if (size + buf.length > maxBytes) {
      chunks.push(buf.subarray(0, maxBytes - size));
      size = maxBytes;
      truncated = true;
      try { await reader.cancel(); } catch { /* ignore */ }
      break;
    }
    chunks.push(buf);
    size += buf.length;
  }
  return { body: Buffer.concat(chunks), truncated };
}

/** GET (or HEAD) a public URL with SSRF checks, timeout, manual redirects and a byte cap. Throws FetchFailure. */
export async function safeFetch(
  rawUrl: string,
  opts: { timeoutMs?: number; maxBytes?: number; method?: 'GET' | 'HEAD'; headers?: Record<string, string>; maxRedirects?: number } = {},
): Promise<SafeFetchResult> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxBytes = opts.maxBytes ?? 1_000_000;
  const maxRedirects = opts.maxRedirects ?? 5;
  const started = Date.now();
  let url = rawUrl;
  for (let hop = 0; ; hop++) {
    try { await assertSafeOutboundUrl(url); } catch (err) {
      if (err instanceof UnsafeUrlError) throw new FetchFailure(err.message, 'blocked');
      throw err;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await deps.fetch(url, {
        method: opts.method ?? 'GET', redirect: 'manual', signal: ctrl.signal, credentials: 'omit',
        headers: { 'user-agent': USER_AGENT, accept: '*/*', ...(opts.headers ?? {}) },
      });
    } catch (err) {
      clearTimeout(timer);
      if (ctrl.signal.aborted) throw new FetchFailure(`Timed out after ${Math.round(timeoutMs / 1000)}s`, 'timeout');
      throw new FetchFailure(err instanceof Error ? err.message : String(err), 'network');
    }
    try {
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        if (hop >= maxRedirects) throw new FetchFailure(`More than ${maxRedirects} redirects`, 'too_many_redirects');
        url = new URL(res.headers.get('location')!, url).toString();
        try { await res.body?.cancel(); } catch { /* ignore */ }
        continue;
      }
      const { body, truncated } = opts.method === 'HEAD' ? { body: Buffer.alloc(0), truncated: false } : await readCapped(res, maxBytes);
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => { headers[k] = v; });
      return {
        ok: res.ok, status: res.status, url, headers, body, text: body.toString('utf8'), truncated,
        elapsedMs: Date.now() - started, redirects: hop,
      };
    } catch (err) {
      if (err instanceof FetchFailure) throw err;
      if (ctrl.signal.aborted) throw new FetchFailure(`Timed out after ${Math.round(timeoutMs / 1000)}s`, 'timeout');
      throw new FetchFailure(err instanceof Error ? err.message : String(err), 'network');
    } finally {
      clearTimeout(timer);
    }
  }
}

/** DNS TXT lookup with a timeout. Hostname must look like a public DNS name (no IP literals, no single labels). */
export async function safeResolveTxt(host: string, timeoutMs = 5_000): Promise<string[]> {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(h)) return [];
  let timer: NodeJS.Timeout | undefined;
  try {
    const records = await Promise.race([
      deps.resolveTxt(h),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('DNS timeout')), timeoutMs); }),
    ]);
    return records.map((parts) => parts.join(''));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
