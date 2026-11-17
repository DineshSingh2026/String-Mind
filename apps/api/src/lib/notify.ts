import { and, eq } from 'drizzle-orm';
import type { NotificationType } from '@aix/shared';
import { db, schema, type DbOrTx } from '../db/client.js';
import { publish } from '../ws/hub.js';

/**
 * Create a notification for a user, honouring their preferences.
 * In-app → notifications table + realtime push on `user:<id>`.
 * Email → email_outbox (dev mailer; swap for SMTP/SES provider in production).
 */
export async function notify(userId: string, type: NotificationType, title: string, body = '', link?: string, tx?: DbOrTx) {
  const q = tx ?? db();
  const [pref] = await q.select().from(schema.notificationPreferences)
    .where(and(eq(schema.notificationPreferences.userId, userId), eq(schema.notificationPreferences.type, type))).limit(1);
  const inApp = pref?.inApp ?? true;
  const email = pref?.email ?? (type === 'security_alert' || type === 'payout_update' || type === 'training_request');
  let row: typeof schema.notifications.$inferSelect | undefined;
  if (inApp) {
    [row] = await q.insert(schema.notifications).values({ userId, type, title, body, link: link ?? null }).returning();
    publish(`user:${userId}`, 'notification', row);
  }
  if (email) {
    const [u] = await q.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    if (u) await q.insert(schema.emailOutbox).values({ to: u.email, subject: `[StringMind] ${title}`, body: `${body}${link ? `\n\n${link}` : ''}` });
  }
  return row;
}

/** Notify every owner/admin member of an org. */
export async function notifyOrg(orgId: string, type: NotificationType, title: string, body = '', link?: string, tx?: DbOrTx) {
  const q = tx ?? db();
  const members = await q.select().from(schema.memberships).where(eq(schema.memberships.orgId, orgId));
  for (const m of members) if (m.role === 'owner' || m.role === 'admin') await notify(m.userId, type, title, body, link, tx);
}
