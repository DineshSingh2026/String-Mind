/**
 * Short-lived WebSocket tokens.
 *
 * In production the web app and the API live on different hosts (e.g. stringmind-web.onrender.com and
 * stringmind-api.onrender.com). Browser HTTP calls go through the same-origin Next.js proxy (`/api/*`) so the
 * httpOnly session cookie works, but a WebSocket cannot be proxied that way and would reach the API host
 * without the cookie. So the browser first calls `GET /api/auth/ws-token` (cookie-authenticated via the proxy)
 * and connects to `wss://<api>/ws?token=<token>`.
 *
 * Token: `<base64url(json payload)>.<base64url(hmac-sha256)>`, payload `{ v, userId, sessionId, orgId, exp }`.
 * The HMAC key is derived from ENCRYPTION_KEY (separate purpose label, never the raw key). Valid for 60 s;
 * on use the session must still be live (not revoked/expired, user active), so logout kills new sockets too.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '../db/client.js';
import { config } from './config.js';
import { sessionAuth, type AuthContext } from './auth.js';

export const WS_TOKEN_TTL_MS = 60_000;

interface WsTokenPayload { v: 1; userId: string; sessionId: string; orgId: string | null; exp: number }

const signingKey = () => createHash('sha256').update(`stringmind:ws-token:v1:${config.ENCRYPTION_KEY}`).digest();
const sign = (data: string) => createHmac('sha256', signingKey()).update(data).digest('base64url');

export function createWsToken(auth: Pick<AuthContext, 'user' | 'sessionId' | 'orgId'>, now = Date.now()) {
  if (!auth.sessionId) throw new Error('WebSocket tokens require an interactive session');
  const payload: WsTokenPayload = { v: 1, userId: auth.user.id, sessionId: auth.sessionId, orgId: auth.orgId, exp: now + WS_TOKEN_TTL_MS };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return { token: `${body}.${sign(body)}`, expiresAt: new Date(payload.exp).toISOString() };
}

/** Signature + expiry check only (no DB). Returns the payload or null. */
export function verifyWsTokenSignature(token: string, now = Date.now()): WsTokenPayload | null {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  const expected = Buffer.from(sign(body));
  const got = Buffer.from(sig);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
  let p: WsTokenPayload;
  try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as WsTokenPayload; } catch { return null; }
  if (p?.v !== 1 || typeof p.userId !== 'string' || typeof p.sessionId !== 'string' || typeof p.exp !== 'number') return null;
  if (p.exp <= now) return null;
  return p;
}

/** Full verification: signature, expiry, and the session is still live for the same user. */
export async function authenticateWsToken(token: string): Promise<AuthContext | null> {
  const p = verifyWsTokenSignature(token);
  if (!p) return null;
  const auth = await sessionAuth(eq(schema.sessions.id, p.sessionId), null, p.orgId ?? null);
  if (!auth || auth.user.id !== p.userId) return null;
  return auth;
}
