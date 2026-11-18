/**
 * Request authentication & authorisation.
 * - Browser: opaque session token in httpOnly cookie `aix_session` (hashed in DB).
 * - API clients: `Authorization: Bearer aix_sk_...` API key (hashed in DB, org-scoped, with scopes).
 * - Active org: header `x-aix-org: <orgId>` or the user's default org. Membership is verified.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq, gt, isNull, type SQL } from 'drizzle-orm';
import { roleHas, type OrgRole, type Permission, type PlatformRole } from '@aix/shared';
import { db, schema } from '../db/client.js';
import { sha256 } from './crypto.js';
import { AppError, forbidden, unauthorized } from './errors.js';
import { consumeApiKeyRequest } from './api-key-rate-limit.js';

export const SESSION_COOKIE = 'aix_session';

export interface AuthContext {
  user: { id: string; email: string; name: string; platformRole: PlatformRole; persona: string };
  sessionId: string | null;
  apiKeyId: string | null;
  apiKeyScopes: string[] | null;
  /** api_keys.rate_limit_per_min for API-key auth (enforced in registerAuth). */
  apiKeyRateLimitPerMin?: number | null;
  orgId: string | null;
  orgRole: OrgRole | null;
}

declare module 'fastify' {
  interface FastifyRequest { auth: AuthContext | null }
}

/** Active org for a user: the requested org (header `x-aix-org`, or `requested`) if a member, else the default / any membership. */
export async function resolveOrg(req: FastifyRequest | null, userId: string, defaultOrgId: string | null, requested?: string | null) {
  const header = requested ?? req?.headers['x-aix-org'];
  const wanted = (typeof header === 'string' && header) || defaultOrgId;
  const rows = await db().select().from(schema.memberships)
    .where(wanted ? and(eq(schema.memberships.userId, userId), eq(schema.memberships.orgId, wanted)) : eq(schema.memberships.userId, userId))
    .limit(1);
  const m = rows[0];
  if (!m && typeof header === 'string' && header) throw forbidden('You are not a member of this organisation');
  if (!m && wanted) {
    const any = await db().select().from(schema.memberships).where(eq(schema.memberships.userId, userId)).limit(1);
    if (any[0]) return { orgId: any[0].orgId, orgRole: any[0].role as OrgRole };
  }
  return m ? { orgId: m.orgId, orgRole: m.role as OrgRole } : { orgId: null, orgRole: null };
}

export async function authenticate(req: FastifyRequest): Promise<AuthContext | null> {
  const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7).trim() : null;
  if (bearer?.startsWith('aix_sk_')) {
    const [key] = await db().select().from(schema.apiKeys)
      .where(and(eq(schema.apiKeys.keyHash, sha256(bearer)), isNull(schema.apiKeys.revokedAt))).limit(1);
    if (!key || (key.expiresAt && key.expiresAt < new Date())) throw unauthorized('Invalid or revoked API key');
    const [u] = await db().select().from(schema.users).where(eq(schema.users.id, key.createdBy)).limit(1);
    if (!u || u.status !== 'active') throw unauthorized('API key owner is inactive');
    const [m] = await db().select().from(schema.memberships)
      .where(and(eq(schema.memberships.userId, u.id), eq(schema.memberships.orgId, key.orgId))).limit(1);
    if (!m) throw unauthorized('API key owner is no longer a member of this organisation');
    void db().update(schema.apiKeys).set({ lastUsedAt: new Date() }).where(eq(schema.apiKeys.id, key.id)).catch(() => undefined);
    return {
      user: { id: u.id, email: u.email, name: u.name, platformRole: 'user', persona: u.persona },
      sessionId: null, apiKeyId: key.id, apiKeyScopes: key.scopes, apiKeyRateLimitPerMin: key.rateLimitPerMin, orgId: key.orgId, orgRole: m.role as OrgRole,
    };
  }
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  return sessionAuth(eq(schema.sessions.tokenHash, sha256(token)), req);
}

/**
 * AuthContext for a live session (not revoked, not expired, MFA complete, user active) selected by `where`
 * — by cookie token hash, or by id for short-lived WebSocket tokens (lib/ws-token.ts).
 */
export async function sessionAuth(where: SQL, req: FastifyRequest | null, requestedOrg?: string | null): Promise<AuthContext | null> {
  const [row] = await db().select({ s: schema.sessions, u: schema.users })
    .from(schema.sessions).innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(and(where, isNull(schema.sessions.revokedAt), gt(schema.sessions.expiresAt, new Date())))
    .limit(1);
  if (!row || row.u.status !== 'active' || row.s.mfaPending) return null;
  // Cookie path: a non-member x-aix-org header is a 403 (as before). Token path: membership may have changed since
  // the token was minted → fall back to the user's default org instead of failing the socket.
  const org = requestedOrg === undefined
    ? await resolveOrg(req, row.u.id, row.u.defaultOrgId)
    : await resolveOrg(null, row.u.id, row.u.defaultOrgId, requestedOrg).catch(() => resolveOrg(null, row.u.id, row.u.defaultOrgId, null));
  return {
    user: { id: row.u.id, email: row.u.email, name: row.u.name, platformRole: row.u.platformRole as PlatformRole, persona: row.u.persona },
    sessionId: row.s.id, apiKeyId: null, apiKeyScopes: null, ...org,
  };
}

export function registerAuth(app: FastifyInstance) {
  app.decorateRequest('auth', null);
  app.addHook('preHandler', async (req, reply) => {
    req.auth = await authenticate(req);
    const a = req.auth;
    if (a?.apiKeyId && a.apiKeyRateLimitPerMin != null) {
      const d = consumeApiKeyRequest(a.apiKeyId, a.apiKeyRateLimitPerMin);
      reply.header('x-ratelimit-limit', d.limit);
      reply.header('x-ratelimit-remaining', d.remaining);
      if (!d.allowed) {
        reply.header('retry-after', d.retryAfterSec);
        throw new AppError(429, 'rate_limited', `API key rate limit exceeded (${d.limit} requests/min). Retry in ${d.retryAfterSec}s.`);
      }
    }
  });
}

/** Throws 401 unless signed in. */
export function requireAuth(req: FastifyRequest): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

/** Permissions that mean "taking part" in the agent economy (training / agents / listings): not available to platform admins. */
const PARTICIPANT_PERMS = new Set<string>(['agents.create', 'training.request', 'training.respond', 'training.participate', 'marketplace.publish']);

/** Signed in + active org + org role grants `perm` (+ API key scope if key auth). Returns ctx with non-null orgId. */
export function requirePerm(req: FastifyRequest, perm: Permission): AuthContext & { orgId: string; orgRole: OrgRole } {
  const a = requireAuth(req);
  // Platform administrators control and monitor the marketplace; they never take part in it.
  if (PARTICIPANT_PERMS.has(perm) && (a.user.platformRole === 'admin' || a.user.platformRole === 'super_admin')) throw forbidden('Platform administrators oversee the platform and cannot create agents, train, teach or list on the marketplace.');
  if (!a.orgId || !a.orgRole) throw forbidden('No active organisation');
  if (!roleHas(a.orgRole, perm)) throw forbidden(`Missing permission: ${perm}`);
  if (a.apiKeyScopes && !a.apiKeyScopes.includes(perm) && !a.apiKeyScopes.includes('*')) throw forbidden(`API key lacks scope: ${perm}`);
  return a as AuthContext & { orgId: string; orgRole: OrgRole };
}

/** Platform administrators only (never via API key). */
export function requireAdmin(req: FastifyRequest): AuthContext {
  const a = requireAuth(req);
  if (a.apiKeyId || (a.user.platformRole !== 'admin' && a.user.platformRole !== 'super_admin')) throw forbidden('Administrator access required');
  return a;
}
