'use client';
/**
 * Browser API client. All calls go through the same-origin Next.js proxy `/api/*` → Hive Mind API,
 * so the httpOnly session cookie is sent automatically. Never put secrets in frontend code.
 *
 *   const { data, error, isLoading, mutate } = useApi<Agent[]>('/agents');
 *   await api.post('/agents', body)
 */
import useSWR, { type SWRConfiguration } from 'swr';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}

const ORG_KEY = 'aix.org';
export function getActiveOrg(): string | null {
  try { return localStorage.getItem(ORG_KEY); } catch { return null; }
}
export function setActiveOrg(id: string | null) {
  try { if (id) localStorage.setItem(ORG_KEY, id); else localStorage.removeItem(ORG_KEY); } catch { /* storage unavailable */ }
}

async function request<T>(method: string, path: string, body?: unknown, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {};
  const org = getActiveOrg();
  if (org) headers['x-aix-org'] = org;
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  if (body !== undefined && !isForm) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method, credentials: 'include', headers: { ...headers, ...(init?.headers as Record<string, string>) },
      body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body), ...init,
    });
  } catch {
    throw new ApiError(0, 'network', 'Cannot reach the Hive Mind API. Check that the API server is running.');
  }
  const text = await res.text();
  const json = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  if (!res.ok) {
    const e = json?.error;
    throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? `Request failed (${res.status})`, e?.details);
  }
  return json as T;
}

export const api = {
  get: <T>(p: string) => request<T>('GET', p),
  post: <T>(p: string, b?: unknown) => request<T>('POST', p, b ?? {}),
  put: <T>(p: string, b?: unknown) => request<T>('PUT', p, b ?? {}),
  patch: <T>(p: string, b?: unknown) => request<T>('PATCH', p, b ?? {}),
  del: <T>(p: string) => request<T>('DELETE', p),
  upload: <T>(p: string, form: FormData) => request<T>('POST', p, form),
};

/** SWR hook. Pass null to skip. */
export function useApi<T>(path: string | null, config?: SWRConfiguration<T, ApiError>) {
  return useSWR<T, ApiError>(path, (p: string) => api.get<T>(p), { revalidateOnFocus: false, ...config });
}

/** Human message for any thrown error. */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const fe = (e.details as { fieldErrors?: Record<string, string[]> } | undefined)?.fieldErrors;
    if (fe) {
      const first = Object.entries(fe).find(([, v]) => v?.length);
      if (first) return `${first[0]}: ${first[1][0]}`;
    }
    return e.message;
  }
  return e instanceof Error ? e.message : 'Unexpected error';
}

/**
 * Browser WebSocket endpoint of the API. Inlined at build time: NEXT_PUBLIC_WS_URL, or derived from a public
 * AIX_API_URL in next.config.mjs (https://api.example.com → wss://api.example.com/ws). Local default: ws://localhost:4700/ws.
 */
export const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:4700/ws';
