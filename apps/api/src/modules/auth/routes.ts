/**
 * Authentication & account: register, login (+ TOTP MFA), logout, /me, password, MFA management,
 * sessions, account deletion. See docs/API.md#auth.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { NOTIFICATION_TYPES, PERSONAS } from '@aix/shared';
import { db, schema } from '../../db/client.js';
import { audit } from '../../lib/audit.js';
import { config } from '../../lib/config.js';
import { decrypt, encrypt, randomToken, sha256 } from '../../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../../lib/errors.js';
import { parse } from '../../lib/http.js';
import { createWsToken } from '../../lib/ws-token.js';
import { notify } from '../../lib/notify.js';
import { SESSION_COOKIE, requireAuth } from '../../lib/auth.js';
import { createOrgWithOwner } from '../orgs/service.js';
import { grantWelcomeBonus } from '../wallet/ledger.js';
import {
  EmailSchema, MFA_CHALLENGE_TTL_MS, PasswordSchema, buildMe, clearSessionCookie, createSession, hashPassword,
  publicUser, requireSession, revokeUserSessions, setSessionCookie, totp, verifyPassword,
} from './service.js';

const INVALID_LOGIN = 'Invalid email or password';
const MAX_MFA_ATTEMPTS = 5;
/** failed MFA attempts per pending challenge session (process-local; challenge expires in 10 min anyway) */
const mfaFailures = new Map<string, number>();

const strictLimit = (max: number) => ({
  rateLimit: { max: config.isTest ? 10_000 : max, timeWindow: '1 minute', keyGenerator: (req: { ip: string }) => `auth:${req.ip}` },
});

const RegisterBody = z.object({
  email: EmailSchema,
  password: PasswordSchema,
  name: z.string().trim().min(1, 'Name is required').max(100),
  persona: z.enum(PERSONAS).default('individual'),
  orgName: z.string().trim().min(2).max(100).optional(),
});
const LoginBody = z.object({ email: z.string().trim().toLowerCase().max(254), password: z.string().min(1).max(200) });
const CodeBody = z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app') });

/**
 * One-time IDLE welcome bonus on the first successful session (docs/IDLE_TOKENS.md). Idempotent
 * (`welcome:<userId>`), so it is safe to call on every session creation. Non-null only when THIS
 * call granted it. A ledger failure never blocks sign-in (logged; retried on the next login).
 */
async function welcomeBonusOnLogin(req: FastifyRequest, userId: string): Promise<{ amount: number; transactionId: string } | null> {
  try {
    const r = await grantWelcomeBonus(userId);
    return r.granted && r.transactionId ? { amount: r.amount, transactionId: r.transactionId } : null;
  } catch (err) {
    req.log.error({ err, userId }, 'welcome bonus grant failed');
    return null;
  }
}

export default async function routes(app: FastifyInstance) {
  app.post('/register', { config: strictLimit(10) }, async (req, reply) => {
    const body = parse(RegisterBody, req.body);
    const [settings] = await db().select().from(schema.systemSettings).where(eq(schema.systemSettings.key, 'platform')).limit(1);
    if ((settings?.value as { signupsOpen?: boolean } | undefined)?.signupsOpen === false) throw forbidden('New sign-ups are currently closed');
    const [existing] = await db().select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, body.email)).limit(1);
    if (existing) throw conflict('An account with this email already exists');
    const passwordHash = await hashPassword(body.password);

    const { user, org } = await db().transaction(async (tx) => {
      const [user] = await tx.insert(schema.users).values({
        email: body.email, name: body.name, passwordHash, persona: body.persona,
      }).returning();
      const enterprise = body.persona === 'enterprise';
      const org = await createOrgWithOwner(tx, {
        name: body.orgName ?? (enterprise ? `${body.name}'s Organisation` : `${body.name}'s Workspace`),
        type: enterprise ? 'enterprise' : 'personal',
        ownerId: user!.id,
      });
      const [u] = await tx.update(schema.users).set({ defaultOrgId: org.id }).where(eq(schema.users.id, user!.id)).returning();
      await tx.insert(schema.notificationPreferences).values(NOTIFICATION_TYPES.map((type) => ({
        userId: user!.id, type, inApp: true, email: type === 'security_alert' || type === 'payout_update' || type === 'training_request',
      }))).onConflictDoNothing();
      return { user: u!, org };
    });

    const { token } = await createSession(req, user.id);
    setSessionCookie(reply, token);
    await audit({ action: 'auth.register', targetType: 'user', targetId: user.id, orgId: org.id, actorUserId: user.id, actorType: 'user', metadata: { persona: user.persona } }, req);
    const welcomeBonus = await welcomeBonusOnLogin(req, user.id);
    return reply.status(201).send({ user: publicUser(user), welcomeBonus });
  });

  app.post('/login', { config: strictLimit(10) }, async (req, reply) => {
    const body = parse(LoginBody, req.body);
    const [user] = await db().select().from(schema.users).where(eq(schema.users.email, body.email)).limit(1);
    const ok = await verifyPassword(body.password, user?.passwordHash);
    if (!user || !ok || user.status !== 'active') {
      await audit({
        action: 'auth.login_failed', actorType: 'user', actorUserId: user?.id ?? null, targetType: 'user', targetId: user?.id ?? null,
        metadata: { email: body.email, reason: !user ? 'unknown_email' : !ok ? 'bad_password' : `status_${user.status}` },
      }, req);
      throw unauthorized(INVALID_LOGIN);
    }
    if (user.mfaEnabled) {
      const { token: challengeId } = await createSession(req, user.id, { mfaPending: true, ttlMs: MFA_CHALLENGE_TTL_MS });
      await audit({ action: 'auth.mfa_challenge', actorType: 'user', actorUserId: user.id, targetType: 'user', targetId: user.id }, req);
      return { mfaRequired: true, challengeId };
    }
    const { token } = await createSession(req, user.id);
    await db().update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, user.id));
    setSessionCookie(reply, token);
    await audit({ action: 'auth.login', actorType: 'user', actorUserId: user.id, targetType: 'user', targetId: user.id, orgId: user.defaultOrgId }, req);
    const welcomeBonus = await welcomeBonusOnLogin(req, user.id);
    return { user: publicUser(user), welcomeBonus };
  });

  app.post('/mfa/verify-login', { config: strictLimit(10) }, async (req, reply) => {
    const body = parse(z.object({ challengeId: z.string().min(10).max(200), code: CodeBody.shape.code }), req.body);
    const [pending] = await db().select().from(schema.sessions).where(and(
      eq(schema.sessions.tokenHash, sha256(body.challengeId)), eq(schema.sessions.mfaPending, true),
      isNull(schema.sessions.revokedAt), gt(schema.sessions.expiresAt, new Date()),
    )).limit(1);
    if (!pending) throw unauthorized('This sign-in challenge has expired. Please sign in again.');
    const [user] = await db().select().from(schema.users).where(eq(schema.users.id, pending.userId)).limit(1);
    if (!user || user.status !== 'active' || !user.mfaEnabled || !user.mfaSecretEnc) throw unauthorized(INVALID_LOGIN);
    if (!totp.check(body.code, decrypt(user.mfaSecretEnc))) {
      const n = (mfaFailures.get(pending.id) ?? 0) + 1;
      mfaFailures.set(pending.id, n);
      await audit({ action: 'auth.login_failed', actorType: 'user', actorUserId: user.id, targetType: 'user', targetId: user.id, metadata: { reason: 'bad_mfa_code', attempt: n } }, req);
      if (n >= MAX_MFA_ATTEMPTS) {
        await db().update(schema.sessions).set({ revokedAt: new Date() }).where(eq(schema.sessions.id, pending.id));
        mfaFailures.delete(pending.id);
        throw unauthorized('Too many incorrect codes. Please sign in again.');
      }
      throw unauthorized('Incorrect authentication code');
    }
    mfaFailures.delete(pending.id);
    await db().update(schema.sessions).set({ revokedAt: new Date() }).where(eq(schema.sessions.id, pending.id));
    const { token } = await createSession(req, user.id);
    await db().update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, user.id));
    setSessionCookie(reply, token);
    await audit({ action: 'auth.login', actorType: 'user', actorUserId: user.id, targetType: 'user', targetId: user.id, orgId: user.defaultOrgId, metadata: { mfa: true } }, req);
    const welcomeBonus = await welcomeBonusOnLogin(req, user.id);
    return { user: publicUser(user), welcomeBonus };
  });

  app.post('/logout', async (req, reply) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) {
      const [s] = await db().update(schema.sessions).set({ revokedAt: new Date() })
        .where(and(eq(schema.sessions.tokenHash, sha256(token)), isNull(schema.sessions.revokedAt))).returning();
      if (s) await audit({ action: 'auth.logout', actorType: 'user', actorUserId: s.userId, targetType: 'session', targetId: s.id }, req);
    }
    clearSessionCookie(reply);
    return reply.status(204).send();
  });

  app.get('/me', async (req) => buildMe(requireAuth(req)));

  /** Short-lived token for the WebSocket (`/ws?token=`) when the API is on another host than the web app. */
  app.get('/ws-token', async (req, reply) => {
    const a = requireSession(req);
    reply.header('cache-control', 'no-store');
    return createWsToken(a);
  });

  app.patch('/me', async (req) => {
    const a = requireSession(req);
    const body = parse(z.object({
      name: z.string().trim().min(1).max(100).optional(),
      avatarUrl: z.string().trim().url().max(500).refine((u) => /^https?:\/\//i.test(u), 'Avatar URL must be http(s)').nullable().optional(),
    }).strict(), req.body);
    if (body.name === undefined && body.avatarUrl === undefined) throw badRequest('Nothing to update');
    const [u] = await db().update(schema.users).set({ ...body, updatedAt: new Date() }).where(eq(schema.users.id, a.user.id)).returning();
    await audit({ action: 'user.update_profile', targetType: 'user', targetId: a.user.id, metadata: { fields: Object.keys(body) } }, req);
    return { user: publicUser(u!) };
  });

  app.post('/password', { config: strictLimit(10) }, async (req) => {
    const a = requireSession(req);
    const body = parse(z.object({ currentPassword: z.string().min(1).max(200), newPassword: PasswordSchema }), req.body);
    const [u] = await db().select().from(schema.users).where(eq(schema.users.id, a.user.id)).limit(1);
    if (!u || !(await verifyPassword(body.currentPassword, u.passwordHash))) throw badRequest('Current password is incorrect');
    if (body.currentPassword === body.newPassword) throw badRequest('New password must be different from the current password');
    await db().update(schema.users).set({ passwordHash: await hashPassword(body.newPassword), updatedAt: new Date() }).where(eq(schema.users.id, u.id));
    const revoked = await revokeUserSessions(u.id, a.sessionId);
    await audit({ action: 'auth.password_change', targetType: 'user', targetId: u.id, metadata: { otherSessionsRevoked: revoked } }, req);
    await notify(u.id, 'security_alert', 'Your password was changed',
      'Your StringMind password was just changed and your other sessions were signed out. If this was not you, reset your password and contact support immediately.');
    return { ok: true, otherSessionsRevoked: revoked };
  });

  app.post('/mfa/setup', async (req) => {
    const a = requireSession(req);
    const [u] = await db().select().from(schema.users).where(eq(schema.users.id, a.user.id)).limit(1);
    if (u!.mfaEnabled) throw conflict('Two-factor authentication is already enabled');
    const secret = totp.generateSecret();
    await db().update(schema.users).set({ mfaSecretEnc: encrypt(secret), updatedAt: new Date() }).where(eq(schema.users.id, u!.id));
    await audit({ action: 'auth.mfa_setup', targetType: 'user', targetId: u!.id }, req);
    return { secret, otpauthUrl: totp.keyuri(u!.email, 'StringMind', secret) };
  });

  app.post('/mfa/enable', { config: strictLimit(10) }, async (req) => {
    const a = requireSession(req);
    const { code } = parse(CodeBody, req.body);
    const [u] = await db().select().from(schema.users).where(eq(schema.users.id, a.user.id)).limit(1);
    if (u!.mfaEnabled) throw conflict('Two-factor authentication is already enabled');
    if (!u!.mfaSecretEnc) throw badRequest('Start setup first (POST /auth/mfa/setup)');
    if (!totp.check(code, decrypt(u!.mfaSecretEnc))) throw badRequest('Incorrect authentication code');
    await db().update(schema.users).set({ mfaEnabled: true, updatedAt: new Date() }).where(eq(schema.users.id, u!.id));
    await audit({ action: 'auth.mfa_enable', targetType: 'user', targetId: u!.id }, req);
    await notify(u!.id, 'security_alert', 'Two-factor authentication enabled', 'Two-factor authentication is now required when you sign in to StringMind. If this was not you, contact support immediately.');
    return { ok: true, mfaEnabled: true };
  });

  app.post('/mfa/disable', { config: strictLimit(10) }, async (req) => {
    const a = requireSession(req);
    const { code } = parse(CodeBody, req.body);
    const [u] = await db().select().from(schema.users).where(eq(schema.users.id, a.user.id)).limit(1);
    if (!u!.mfaEnabled || !u!.mfaSecretEnc) throw conflict('Two-factor authentication is not enabled');
    if (!totp.check(code, decrypt(u!.mfaSecretEnc))) throw badRequest('Incorrect authentication code');
    await db().update(schema.users).set({ mfaEnabled: false, mfaSecretEnc: null, updatedAt: new Date() }).where(eq(schema.users.id, u!.id));
    await audit({ action: 'auth.mfa_disable', targetType: 'user', targetId: u!.id }, req);
    await notify(u!.id, 'security_alert', 'Two-factor authentication disabled', 'Two-factor authentication was turned off for your StringMind account. If this was not you, change your password and contact support immediately.');
    return { ok: true, mfaEnabled: false };
  });

  app.get('/sessions', async (req) => {
    const a = requireSession(req);
    const rows = await db().select().from(schema.sessions).where(and(
      eq(schema.sessions.userId, a.user.id), isNull(schema.sessions.revokedAt), eq(schema.sessions.mfaPending, false), gt(schema.sessions.expiresAt, new Date()),
    )).orderBy(sql`${schema.sessions.createdAt} desc`);
    const items = rows.map((s) => ({ id: s.id, ip: s.ip, userAgent: s.userAgent, createdAt: s.createdAt, expiresAt: s.expiresAt, current: s.id === a.sessionId }));
    return { items, total: items.length, page: 1, pageSize: items.length };
  });

  app.delete('/sessions/:id', async (req, reply) => {
    const a = requireSession(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const [s] = await db().update(schema.sessions).set({ revokedAt: new Date() })
      .where(and(eq(schema.sessions.id, id), eq(schema.sessions.userId, a.user.id), isNull(schema.sessions.revokedAt))).returning();
    if (!s) throw notFound('Session');
    await audit({ action: 'auth.session_revoke', targetType: 'session', targetId: id }, req);
    if (id === a.sessionId) clearSessionCookie(reply);
    return reply.status(204).send();
  });

  app.post('/delete-account', { config: strictLimit(5) }, async (req, reply) => {
    const a = requireSession(req);
    const { password } = parse(z.object({ password: z.string().min(1).max(200) }), req.body);
    const [u] = await db().select().from(schema.users).where(eq(schema.users.id, a.user.id)).limit(1);
    if (!u || !(await verifyPassword(password, u.passwordHash))) throw badRequest('Password is incorrect');
    if (u.platformRole !== 'user') throw forbidden('Platform administrator accounts cannot be self-deleted');

    const memberships = await db().select().from(schema.memberships).where(eq(schema.memberships.userId, u.id));
    const soleOrgs: string[] = [];
    for (const m of memberships) {
      const members = await db().select().from(schema.memberships).where(eq(schema.memberships.orgId, m.orgId));
      if (members.length === 1) { soleOrgs.push(m.orgId); continue; }
      const owners = members.filter((x) => x.role === 'owner');
      if (m.role === 'owner' && owners.length === 1) {
        throw conflict('You are the only owner of an organisation with other members. Transfer ownership before deleting your account.');
      }
    }

    const now = new Date();
    await db().transaction(async (tx) => {
      await tx.update(schema.users).set({
        email: `deleted+${u.id}@deleted.aix.invalid`, name: 'Deleted user', avatarUrl: null,
        passwordHash: sha256(randomToken()), mfaEnabled: false, mfaSecretEnc: null,
        status: 'deleted', deletedAt: now, updatedAt: now, defaultOrgId: null,
      }).where(eq(schema.users.id, u.id));
      await tx.update(schema.sessions).set({ revokedAt: now }).where(and(eq(schema.sessions.userId, u.id), isNull(schema.sessions.revokedAt)));
      await tx.update(schema.apiKeys).set({ revokedAt: now }).where(and(eq(schema.apiKeys.createdBy, u.id), isNull(schema.apiKeys.revokedAt)));
      for (const orgId of soleOrgs) {
        // Orgs where the user was the only member: retire their agents & integrations.
        await tx.update(schema.agents).set({ deletedAt: now, isPublic: false, updatedAt: now })
          .where(and(eq(schema.agents.orgId, orgId), isNull(schema.agents.deletedAt)));
        await tx.update(schema.agentConnections).set({ credentialEnc: null, credentialLast4: null, webhookSecretEnc: null, status: 'disconnected', updatedAt: now })
          .where(sql`${schema.agentConnections.agentId} in (select id from agents where org_id = ${orgId})`);
        await tx.update(schema.webhooks).set({ active: false }).where(eq(schema.webhooks.orgId, orgId));
        await tx.update(schema.organisations).set({ status: 'deleted', updatedAt: now }).where(eq(schema.organisations.id, orgId));
      }
      // Leave shared orgs.
      for (const m of memberships) if (!soleOrgs.includes(m.orgId)) await tx.delete(schema.memberships).where(eq(schema.memberships.id, m.id));
    });
    await audit({ action: 'user.delete_account', actorType: 'user', actorUserId: u.id, targetType: 'user', targetId: u.id, metadata: { retiredOrgs: soleOrgs } }, req);
    clearSessionCookie(reply);
    return reply.status(202).send({ status: 'deleted', deletedAt: now.toISOString() });
  });
}

/** Register background job handlers for this module (called once at startup). */
export function registerJobs() {}
