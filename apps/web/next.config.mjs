/**
 * AIX_API_URL — where the server-side `/api/*` proxy sends requests (the StringMind API).
 *   IMPORTANT: rewrites are compiled at BUILD time (`next build`), so AIX_API_URL must be set in the
 *   environment of the build step (on Render: an env var of the web service — Render exposes env vars to builds).
 *   Accepts a full URL or a bare host: `stringmind-api.onrender.com` → https://…, `stringmind-api:10000`
 *   (Render private network host:port, no dots) → http://….
 *
 * NEXT_PUBLIC_WS_URL — browser WebSocket endpoint (also inlined at build time). If unset it is derived from a public
 *   AIX_API_URL (https://api.example.com → wss://api.example.com/ws); local default ws://localhost:4700/ws.
 * NEXT_PUBLIC_API_URL — public API base shown in developer docs snippets (display only); derived the same way.
 */
const DEV_API = 'http://127.0.0.1:4700';

function withScheme(v) {
  const t = String(v ?? '').trim().replace(/\/+$/, '');
  if (!t) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return t;
  const host = t.split('/')[0].split(':')[0];
  const internal = host === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(host) || !host.includes('.');
  return `${internal ? 'http' : 'https'}://${t}`;
}

function toWsUrl(v) {
  const t = withScheme(v);
  if (!t) return '';
  const u = new URL(t);
  u.protocol = u.protocol === 'https:' || u.protocol === 'wss:' ? 'wss:' : 'ws:';
  if (u.pathname === '/' || u.pathname === '') u.pathname = '/ws';
  return u.toString().replace(/\/$/, '');
}

const API = withScheme(process.env.AIX_API_URL) || DEV_API;
const apiHost = new URL(API).hostname;
const apiIsPublic = apiHost.includes('.') && !/^\d+\.\d+\.\d+\.\d+$/.test(apiHost);
const WS = process.env.NEXT_PUBLIC_WS_URL
  ? toWsUrl(process.env.NEXT_PUBLIC_WS_URL)
  : apiIsPublic ? toWsUrl(API) : 'ws://localhost:4700/ws';
/** Public API base shown in the developer docs / console snippets (display only). */
const PUBLIC_API = process.env.NEXT_PUBLIC_API_URL
  ? withScheme(process.env.NEXT_PUBLIC_API_URL)
  : apiIsPublic ? API : 'http://localhost:4700';

if (process.env.NODE_ENV === 'production' && !process.env.AIX_API_URL) {
  console.warn('[stringmind-web] AIX_API_URL is not set at build time — /api/* will proxy to http://127.0.0.1:4700.');
}

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  transpilePackages: ['@aix/shared'],
  env: { NEXT_PUBLIC_WS_URL: WS, NEXT_PUBLIC_API_URL: PUBLIC_API },
  async rewrites() {
    // Same-origin API proxy so the httpOnly session cookie works without CORS.
    // Next forwards the incoming request headers (incl. the platform's X-Forwarded-For) to the API.
    return [
      { source: '/api/:path*', destination: `${API}/:path*` },
      // Agent-facing "Connect via prompt" instructions (served by the API).
    ];
  },
  async headers() {
    return [{ source: '/:path*', headers: [
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    ] }];
  },
};
