import type { FastifyReply, FastifyRequest } from 'fastify';
import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import { and, eq, isNull, ne } from 'drizzle-orm';
import { z } from 'zod';
import { ROLE_PERMISSIONS, type OrgRole } from '@aix/shared';
import { db, schema, type DbOrTx } from '../../db/client.js';
import { config } from '../../lib/config.js';
import { randomToken, sha256 } from '../../lib/crypto.js';
import { SESSION_COOKIE, requireAuth, type AuthContext } from '../../lib/auth.js';
import { forbidden } from '../../lib/errors.js';
import { welcomeBonusStatus } from '../wallet/ledger.js';

export const BCRYPT_COST = 10;
export const MFA_CHALLENGE_TTL_MS = 10 * 60_000;

/** TOTP verifier tolerant of ±1 step clock drift (does not mutate otplib's global instance). */
export const totp = authenticator.clone({ window: 1 });

export const PasswordSchema = z.string()
  .min(10, 'Password must be at least 10 characters')
  .max(200, 'Password is too long')
  .refine((p) => /[a-z]/.test(p) && /[A-Z]/.test(p), 'Password must contain both lowercase and uppercase letters')
  .refine((p) => /[0-9]/.test(p) || /[^A-Za-z0-9]/.test(p), 'Password must contain a digit or symbol');

export const EmailSchema = z.string().trim().toLowerCase().email('Enter a valid email address').max(254);

/** Constant-ish time comparison target for unknown users (avoids user enumeration via timing). */
const DUMMY_HASH = bcrypt.hashSync('aix-timing-equaliser-not-a-password', BCRYPT_COST);
export async function verifyPassword(password: string, hash: string | null | undefined) {
  return bcrypt.compare(password, hash || DUMMY_HASH);
}
export const hashPassword = (p: string) => bcrypt.hash(p, BCRYPT_COST);

export function setSessionCookie(reply: FastifyReply, token: string) {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: config.COOKIE_SECURE, path: '/', maxAge: config.SESSION_TTL_HOURS * 3600,
  });
}
export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, sameSite: 'lax', secure: config.COOKIE_SECURE });
}

/** Creates a session row and returns the raw token (only its sha256 is stored). */
export async function createSession(req: FastifyRequest, userId: string, opts: { mfaPending?: boolean; ttlMs?: number } = {}, tx?: DbOrTx) {
  const token = randomToken();
  const [s] = await (tx ?? db()).insert(schema.sessions).values({
    userId, tokenHash: sha256(token), mfaPending: opts.mfaPending ?? false,
    ip: req.ip ?? null, userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300) || null,
    expiresAt: new Date(Date.now() + (opts.ttlMs ?? config.SESSION_TTL_HOURS * 3600_000)),
  }).returning();
  return { token, session: s! };
}

/** Account-security endpoints must be called from a signed-in browser session, never an API key. */
export function requireSession(req: FastifyRequest): AuthContext & { sessionId: string } {
  const a = requireAuth(req);
  if (a.apiKeyId || !a.sessionId) throw forbidden('This action requires an interactive session (API keys are not allowed)');
  return a as AuthContext & { sessionId: string };
}

export function publicUser(u: typeof schema.users.$inferSelect) {
  return {
    id: u.id, email: u.email, name: u.name, avatarUrl: u.avatarUrl, platformRole: u.platformRole, persona: u.persona,
    mfaEnabled: u.mfaEnabled, emailVerified: !!u.emailVerifiedAt, defaultOrgId: u.defaultOrgId,
    lastLoginAt: u.lastLoginAt, createdAt: u.createdAt,
  };
}

/** Shape of GET /auth/me — must match apps/web/lib/session.tsx `Me`. */
export async function buildMe(auth: AuthContext) {
  const [u] = await db().select().from(schema.users).where(eq(schema.users.id, auth.user.id)).limit(1);
  const memberships = await db().select({ m: schema.memberships, o: schema.organisations })
    .from(schema.memberships).innerJoin(schema.organisations, eq(schema.organisations.id, schema.memberships.orgId))
    .where(eq(schema.memberships.userId, auth.user.id));
  const active = memberships.find((r) => r.o.id === auth.orgId);
  const role = (auth.orgRole ?? null) as OrgRole | null;
  let permissions = role ? [...ROLE_PERMISSIONS[role]] : [];
  if (auth.apiKeyScopes && !auth.apiKeyScopes.includes('*')) permissions = permissions.filter((p) => auth.apiKeyScopes!.includes(p));
  return {
    user: {
      id: u!.id, email: u!.email, name: u!.name, platformRole: u!.platformRole, persona: u!.persona,
      mfaEnabled: u!.mfaEnabled, avatarUrl: u!.avatarUrl,
    },
    org: active ? { id: active.o.id, name: active.o.name, slug: active.o.slug, type: active.o.type, plan: active.o.plan } : null,
    role,
    permissions,
    orgs: memberships
      .filter((r) => r.o.status === 'active')
      .map((r) => ({ id: r.o.id, name: r.o.name, slug: r.o.slug, type: r.o.type, role: r.m.role as OrgRole })),
    /** One-time IDLE welcome bonus status (docs/IDLE_TOKENS.md). */
    welcomeBonus: auth.user.platformRole === 'user' ? await welcomeBonusStatus(auth.user.id) : null,
  };
}

export async function revokeUserSessions(userId: string, exceptSessionId?: string | null, tx?: DbOrTx) {
  const rows = await (tx ?? db()).update(schema.sessions).set({ revokedAt: new Date() })
    .where(and(eq(schema.sessions.userId, userId), isNull(schema.sessions.revokedAt),
      exceptSessionId ? ne(schema.sessions.id, exceptSessionId) : undefined))
    .returning({ id: schema.sessions.id });
  return rows.length;
}
