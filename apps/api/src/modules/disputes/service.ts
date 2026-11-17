/**
 * Training disputes.
 * - Raise: only the learner or trainer org of the session, within DISPUTE_WINDOW_DAYS of session end, one open
 *   dispute per session. Sets session.status 'disputed' (previous status kept in session.plan.disputePreviousStatus)
 *   and, if the fee is in escrow, settlementStatus 'disputed'. While open, ledger.settleTraining refuses (409 dispute_open).
 * - Resolve (admin): escrowed ⇒ settleTraining(viaDispute); already released ⇒ clawbackTraining (new reversal tx,
 *   needs the trainer's available IDLE to still cover it, else 402). Restores the previous session status.
 */
import { and, eq, inArray, or } from 'drizzle-orm';
import { db, schema, type Tx } from '../../db/client.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { notify, notifyOrg } from '../../lib/notify.js';
import { clawbackTraining, hasOpenDispute, settleTraining } from '../wallet/ledger.js';

export const DISPUTE_WINDOW_DAYS = 14;
export type Dispute = typeof schema.disputes.$inferSelect;

async function notifyAdmins(tx: Tx, title: string, body: string, link: string) {
  const admins = await tx.select({ id: schema.users.id }).from(schema.users)
    .where(and(inArray(schema.users.platformRole, ['admin', 'super_admin']), eq(schema.users.status, 'active')));
  for (const a of admins) await notify(a.id, 'dispute_update', title, body, link, tx);
}

export async function raiseDispute({ sessionId, orgId, userId, reason, details }: { sessionId: string; orgId: string; userId: string; reason: string; details?: string }): Promise<Dispute> {
  return db().transaction(async (tx) => {
    const [s] = await tx.select().from(schema.trainingSessions).where(eq(schema.trainingSessions.id, sessionId)).for('update');
    if (!s || (s.learnerOrgId !== orgId && s.trainerOrgId !== orgId)) throw notFound('Training session');
    if (s.endedAt && Date.now() - s.endedAt.getTime() > DISPUTE_WINDOW_DAYS * 86400_000) {
      throw new AppError(422, 'dispute_window_closed', `Disputes must be raised within ${DISPUTE_WINDOW_DAYS} days of the session ending`);
    }
    if (await hasOpenDispute(sessionId, tx)) throw conflict('A dispute is already open for this session');
    const [d] = await tx.insert(schema.disputes).values({ sessionId, raisedBy: userId, raisedByOrgId: orgId, reason, details: details ?? '' }).returning();
    const prev = s.status === 'disputed' ? (s.plan as Record<string, unknown>).disputePreviousStatus : s.status;
    await tx.update(schema.trainingSessions).set({
      status: 'disputed', plan: { ...s.plan, disputePreviousStatus: prev ?? 'completed' },
      ...(s.settlementStatus === 'escrowed' ? { settlementStatus: 'disputed' } : {}), updatedAt: new Date(),
    }).where(eq(schema.trainingSessions.id, sessionId));
    await audit({ action: 'dispute.raise', targetType: 'dispute', targetId: d!.id, orgId, actorUserId: userId, actorType: 'user', metadata: { sessionId, reason } }, null, tx);
    const msg = `A dispute was raised on training "${s.subject}": ${reason}`;
    await notifyOrg(s.learnerOrgId, 'dispute_update', 'Dispute opened', msg, `/disputes/${d!.id}`, tx);
    if (s.trainerOrgId !== s.learnerOrgId) await notifyOrg(s.trainerOrgId, 'dispute_update', 'Dispute opened', msg, `/disputes/${d!.id}`, tx);
    await notifyAdmins(tx, 'New dispute', msg, `/admin/disputes/${d!.id}`);
    return d!;
  });
}

/** Admin resolution. Idempotent for an already-resolved dispute (returns it). */
export async function resolveDispute(
  disputeId: string,
  { outcome, refundCredits, resolution, actorUserId }: { outcome: 'refund' | 'release' | 'partial'; refundCredits?: number; resolution: string; actorUserId: string },
): Promise<Dispute> {
  if (!resolution?.trim()) throw badRequest('resolution is required');
  return db().transaction(async (tx) => {
    const [d] = await tx.select().from(schema.disputes).where(eq(schema.disputes.id, disputeId)).for('update');
    if (!d) throw notFound('Dispute');
    if (d.status !== 'open' && d.status !== 'under_review') return d;
    const [s] = await tx.select().from(schema.trainingSessions).where(eq(schema.trainingSessions.id, d.sessionId)).for('update');
    if (!s) throw notFound('Training session');

    let refunded = 0;
    if (s.settlementStatus === 'escrowed' || s.settlementStatus === 'disputed' || s.settlementStatus === 'none') {
      if (s.settlementStatus !== 'none' || (s.feeCredits ?? 0) <= 0) {
        await settleTraining(s.id, { outcome, refundCredits, actorUserId, viaDispute: true }, tx);
      }
      if (s.settlementStatus !== 'none') refunded = outcome === 'refund' ? s.feeCredits : outcome === 'partial' ? (refundCredits ?? 0) : 0;
    } else if (s.settlementStatus === 'settled') {
      const paid = (s.commissionCredits ?? 0) + (s.trainerEarningsCredits ?? 0);
      refunded = outcome === 'refund' ? paid : outcome === 'partial' ? (refundCredits ?? 0) : 0;
      if (refunded > 0) await clawbackTraining(s.id, { refundCredits: refunded, disputeId, actorUserId }, tx);
    } else if (s.settlementStatus === 'refunded' && outcome !== 'refund') {
      throw conflict('Session fee was already refunded; only a refund outcome is possible');
    }

    const [u] = await tx.update(schema.disputes).set({
      status: `resolved_${outcome}`, resolution, refundCredits: refunded, resolvedBy: actorUserId, resolvedAt: new Date(),
    }).where(eq(schema.disputes.id, disputeId)).returning();
    const plan = { ...(s.plan as Record<string, unknown>) };
    const prev = (plan.disputePreviousStatus as string | undefined) ?? 'completed';
    delete plan.disputePreviousStatus;
    await tx.update(schema.trainingSessions).set({ status: prev, plan, updatedAt: new Date() }).where(eq(schema.trainingSessions.id, s.id));
    await audit({ action: 'dispute.resolve', targetType: 'dispute', targetId: disputeId, actorUserId, actorType: 'admin', metadata: { outcome, refundCredits: refunded, sessionId: s.id } }, null, tx);
    const msg = `Dispute on "${s.subject}" resolved (${outcome}${refunded ? `, ${refunded} IDLE refunded` : ''}): ${resolution}`;
    await notifyOrg(s.learnerOrgId, 'dispute_update', 'Dispute resolved', msg, `/disputes/${disputeId}`, tx);
    if (s.trainerOrgId !== s.learnerOrgId) await notifyOrg(s.trainerOrgId, 'dispute_update', 'Dispute resolved', msg, `/disputes/${disputeId}`, tx);
    return u!;
  });
}

/** Disputes visible to an org: those on sessions where it is learner or trainer. */
export function orgDisputeFilter(orgId: string) {
  return or(eq(schema.trainingSessions.learnerOrgId, orgId), eq(schema.trainingSessions.trainerOrgId, orgId));
}
