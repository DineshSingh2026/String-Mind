import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { NOTIFICATION_TYPES, type NotificationType } from '@aix/shared';
import { db, schema } from '../../db/client.js';
import { requireAuth } from '../../lib/auth.js';
import { notFound } from '../../lib/errors.js';
import { PageQuery, offset, parse } from '../../lib/http.js';

const N = schema.notifications;

/** Defaults mirror lib/notify.ts: in-app always on; email on for security, payouts and incoming training requests. */
export function defaultPreference(type: NotificationType) {
  return { type, inApp: true, email: type === 'security_alert' || type === 'payout_update' || type === 'training_request' };
}

export default async function routes(app: FastifyInstance) {
  app.get('/', async (req) => {
    const a = requireAuth(req);
    const q = parse(PageQuery.extend({ unread: z.enum(['true', 'false']).optional() }), req.query);
    const where = q.unread === 'true' ? and(eq(N.userId, a.user.id), isNull(N.readAt)) : eq(N.userId, a.user.id);
    const [{ n }] = await db().select({ n: count() }).from(N).where(where);
    const items = await db().select().from(N).where(where).orderBy(desc(N.createdAt)).limit(q.pageSize).offset(offset(q));
    return { items, total: Number(n), page: q.page, pageSize: q.pageSize };
  });

  app.get('/unread-count', async (req) => {
    const a = requireAuth(req);
    const [{ n }] = await db().select({ n: count() }).from(N).where(and(eq(N.userId, a.user.id), isNull(N.readAt)));
    return { unread: Number(n) };
  });

  app.post('/:id/read', async (req) => {
    const a = requireAuth(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const [row] = await db().select().from(N).where(and(eq(N.id, id), eq(N.userId, a.user.id))).limit(1);
    if (!row) throw notFound('Notification');
    if (row.readAt) return row;
    const [upd] = await db().update(N).set({ readAt: new Date() }).where(eq(N.id, id)).returning();
    return upd;
  });

  app.post('/read-all', async (req) => {
    const a = requireAuth(req);
    const rows = await db().update(N).set({ readAt: new Date() }).where(and(eq(N.userId, a.user.id), isNull(N.readAt))).returning({ id: N.id });
    return { updated: rows.length };
  });

  app.get('/preferences', async (req) => {
    const a = requireAuth(req);
    const rows = await db().select().from(schema.notificationPreferences).where(eq(schema.notificationPreferences.userId, a.user.id));
    const m = new Map(rows.map((r) => [r.type, r]));
    return NOTIFICATION_TYPES.map((t) => {
      const r = m.get(t);
      return r ? { type: t, inApp: r.inApp, email: r.email } : defaultPreference(t);
    });
  });

  app.put('/preferences', async (req) => {
    const a = requireAuth(req);
    const Pref = z.object({ type: z.enum(NOTIFICATION_TYPES), inApp: z.boolean(), email: z.boolean() });
    const raw = req.body as unknown;
    const prefs = parse(z.array(Pref).max(NOTIFICATION_TYPES.length * 2), Array.isArray(raw) ? raw : (raw as { preferences?: unknown })?.preferences);
    for (const p of prefs) {
      // security alerts cannot be fully silenced
      const inApp = p.type === 'security_alert' ? true : p.inApp;
      await db().insert(schema.notificationPreferences).values({ userId: a.user.id, type: p.type, inApp, email: p.email })
        .onConflictDoUpdate({ target: [schema.notificationPreferences.userId, schema.notificationPreferences.type], set: { inApp, email: p.email } });
    }
    const rows = await db().select().from(schema.notificationPreferences).where(eq(schema.notificationPreferences.userId, a.user.id));
    const m = new Map(rows.map((r) => [r.type, r]));
    return NOTIFICATION_TYPES.map((t) => { const r = m.get(t); return r ? { type: t, inApp: r.inApp, email: r.email } : defaultPreference(t); });
  });
}

/** Register background job handlers for this module (called once at startup). */
export function registerJobs() {}
