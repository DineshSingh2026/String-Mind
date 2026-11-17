/** Organisations & membership management. See docs/API.md#orgs. */
import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, ilike } from 'drizzle-orm';
import { z } from 'zod';
import { ORG_ROLES } from '@aix/shared';
import { db, schema } from '../../db/client.js';
import { audit } from '../../lib/audit.js';
import { requirePerm } from '../../lib/auth.js';
import { AppError, badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { PageQuery, offset, parse } from '../../lib/http.js';
import { notify } from '../../lib/notify.js';
import { requireSession } from '../auth/service.js';
import { createOrgWithOwner } from './service.js';

const UserIdParam = z.object({ userId: z.string().uuid() });

async function loadOrg(orgId: string) {
  const [org] = await db().select().from(schema.organisations).where(eq(schema.organisations.id, orgId)).limit(1);
  if (!org) throw notFound('Organisation');
  return org;
}

async function orgView(orgId: string, role: string) {
  const org = await loadOrg(orgId);
  const [{ n }] = await db().select({ n: count() }).from(schema.memberships).where(eq(schema.memberships.orgId, orgId));
  return { ...org, memberCount: Number(n), role };
}

export default async function routes(app: FastifyInstance) {
  app.get('/current', async (req) => {
    const a = requirePerm(req, 'org.read');
    return orgView(a.orgId, a.orgRole);
  });

  app.patch('/current', async (req) => {
    const a = requirePerm(req, 'org.manage');
    const body = parse(z.object({ name: z.string().trim().min(2).max(100).optional(), privateNetwork: z.boolean().optional() }).strict(), req.body);
    if (body.name === undefined && body.privateNetwork === undefined) throw badRequest('Nothing to update');
    const org = await loadOrg(a.orgId);
    if (body.privateNetwork !== undefined && org.type !== 'enterprise') throw unprocessable('Private networks are only available to enterprise organisations');
    await db().update(schema.organisations).set({ ...body, updatedAt: new Date() }).where(eq(schema.organisations.id, a.orgId));
    await audit({ action: 'org.update', targetType: 'organisation', targetId: a.orgId, metadata: body }, req);
    return orgView(a.orgId, a.orgRole);
  });

  app.get('/current/members', async (req) => {
    const a = requirePerm(req, 'org.read');
    const rows = await db().select({ m: schema.memberships, u: schema.users }).from(schema.memberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .where(eq(schema.memberships.orgId, a.orgId)).orderBy(schema.memberships.createdAt);
    return rows.map(({ m, u }) => ({ userId: u.id, name: u.name, email: u.email, role: m.role, createdAt: m.createdAt }));
  });

  app.post('/current/members', async (req, reply) => {
    const a = requirePerm(req, 'org.members.manage');
    const body = parse(z.object({ email: z.string().trim().toLowerCase().email(), role: z.enum(ORG_ROLES) }), req.body);
    if (body.role === 'owner' && a.orgRole !== 'owner') throw forbidden('Only owners can add another owner');
    const [u] = await db().select().from(schema.users).where(eq(schema.users.email, body.email)).limit(1);
    if (!u || u.status !== 'active') throw new AppError(404, 'not_found', 'No active Hive Mind user with that email — ask them to sign up first');
    const [existing] = await db().select().from(schema.memberships)
      .where(and(eq(schema.memberships.orgId, a.orgId), eq(schema.memberships.userId, u.id))).limit(1);
    if (existing) throw conflict('That user is already a member of this organisation');
    await db().insert(schema.memberships).values({ orgId: a.orgId, userId: u.id, role: body.role });
    const org = await loadOrg(a.orgId);
    await notify(u.id, 'system', `You were added to ${org.name}`, `${a.user.name} added you to ${org.name} as ${body.role}.`);
    await audit({ action: 'org.member_add', targetType: 'user', targetId: u.id, metadata: { role: body.role } }, req);
    return reply.status(201).send({ userId: u.id, name: u.name, email: u.email, role: body.role });
  });

  app.patch('/current/members/:userId', async (req) => {
    const a = requirePerm(req, 'org.members.manage');
    const { userId } = parse(UserIdParam, req.params);
    const { role } = parse(z.object({ role: z.enum(ORG_ROLES) }), req.body);
    const members = await db().select().from(schema.memberships).where(eq(schema.memberships.orgId, a.orgId));
    const target = members.find((m) => m.userId === userId);
    if (!target) throw notFound('Member');
    if ((target.role === 'owner' || role === 'owner') && a.orgRole !== 'owner') throw forbidden('Only owners can grant or revoke the owner role');
    if (target.role === 'owner' && role !== 'owner' && members.filter((m) => m.role === 'owner').length === 1) {
      throw conflict('An organisation must keep at least one owner');
    }
    await db().update(schema.memberships).set({ role }).where(eq(schema.memberships.id, target.id));
    await audit({ action: 'org.member_role_change', targetType: 'user', targetId: userId, metadata: { from: target.role, to: role } }, req);
    return { userId, role };
  });

  app.delete('/current/members/:userId', async (req, reply) => {
    const { userId } = parse(UserIdParam, req.params);
    const self = req.auth?.user.id === userId;
    const a = requirePerm(req, self ? 'org.read' : 'org.members.manage');
    const members = await db().select().from(schema.memberships).where(eq(schema.memberships.orgId, a.orgId));
    const target = members.find((m) => m.userId === userId);
    if (!target) throw notFound('Member');
    if (target.role === 'owner' && !self && a.orgRole !== 'owner') throw forbidden('Only owners can remove an owner');
    if (target.role === 'owner' && members.filter((m) => m.role === 'owner').length === 1) throw conflict('An organisation must keep at least one owner');
    await db().delete(schema.memberships).where(eq(schema.memberships.id, target.id));
    // Fix default org pointer and revoke keys the member created in this org.
    const [u] = await db().select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    if (u?.defaultOrgId === a.orgId) {
      const [other] = await db().select().from(schema.memberships).where(eq(schema.memberships.userId, userId)).limit(1);
      await db().update(schema.users).set({ defaultOrgId: other?.orgId ?? null }).where(eq(schema.users.id, userId));
    }
    await db().update(schema.apiKeys).set({ revokedAt: new Date() })
      .where(and(eq(schema.apiKeys.orgId, a.orgId), eq(schema.apiKeys.createdBy, userId)));
    await audit({ action: self ? 'org.member_leave' : 'org.member_remove', targetType: 'user', targetId: userId, metadata: { role: target.role } }, req);
    return reply.status(204).send();
  });

  app.post('/', async (req, reply) => {
    const a = requireSession(req);
    const body = parse(z.object({ name: z.string().trim().min(2).max(100), type: z.literal('enterprise').default('enterprise') }), req.body);
    const org = await db().transaction((tx) => createOrgWithOwner(tx, { name: body.name, type: body.type, ownerId: a.user.id }));
    await audit({ action: 'org.create', targetType: 'organisation', targetId: org.id, orgId: org.id, metadata: { name: org.name, type: org.type } }, req);
    return reply.status(201).send({ ...org, memberCount: 1, role: 'owner' });
  });

  app.get('/current/audit', async (req) => {
    const a = requirePerm(req, 'audit.read');
    const q = parse(PageQuery.extend({ action: z.string().max(100).optional() }), req.query);
    const where = and(eq(schema.auditLogs.orgId, a.orgId), q.action ? ilike(schema.auditLogs.action, `${q.action.replace(/[%_]/g, '')}%`) : undefined);
    const [{ n }] = await db().select({ n: count() }).from(schema.auditLogs).where(where);
    const rows = await db().select({ log: schema.auditLogs, actorName: schema.users.name, actorEmail: schema.users.email })
      .from(schema.auditLogs).leftJoin(schema.users, eq(schema.users.id, schema.auditLogs.actorUserId))
      .where(where).orderBy(desc(schema.auditLogs.createdAt)).limit(q.pageSize).offset(offset(q));
    return {
      items: rows.map((r) => ({ ...r.log, actor: r.log.actorUserId ? { id: r.log.actorUserId, name: r.actorName, email: r.actorEmail } : null })),
      total: Number(n), page: q.page, pageSize: q.pageSize,
    };
  });
}

/** Register background job handlers for this module (called once at startup). */
export function registerJobs() {}
