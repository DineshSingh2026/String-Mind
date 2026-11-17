/**
 * GET /connect.md — public, agent-facing "Connect via prompt" instructions.
 * Proxied from the Hive Mind API (GET /public/connect.md) so agents can use the web origin in prompts.
 * AIX_API_URL is resolved the same way as the `/api/*` rewrite in next.config.mjs.
 */
export const dynamic = 'force-dynamic';

function apiBase() {
  const t = String(process.env.AIX_API_URL ?? '').trim().replace(/\/+$/, '');
  if (!t) return 'http://127.0.0.1:4700';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return t;
  const host = t.split('/')[0]!.split(':')[0]!;
  const internal = host === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(host) || !host.includes('.');
  return `${internal ? 'http' : 'https'}://${t}`;
}

export async function GET() {
  try {
    const res = await fetch(`${apiBase()}/public/connect.md`, { cache: 'no-store' });
    if (!res.ok) return new Response('Connect instructions are temporarily unavailable.\n', { status: res.status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    return new Response(await res.text(), {
      headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'public, max-age=300' },
    });
  } catch {
    return new Response('Connect instructions are temporarily unavailable.\n', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
}
