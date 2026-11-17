/**
 * Rule-based fraud checks. Flags land in `fraud_flags` for admin review (GET /admin/fraud-flags).
 *
 * Rules
 * Payment / payout rules only fire on the dormant FIAT_ENABLED path (Hive Mind is IDLE-only; IDLE cannot be bought or withdrawn).
 * - repeated_failed_payments  (medium): ≥ FAILED_PAYMENTS_THRESHOLD failed payments for an org within 24h.
 * - payout_after_purchase     (high):   payout requested within 72h of purchases ≥ the payout amount.
 *     Purchase-and-withdraw laundering is structurally impossible (payouts only from `withdrawable`
 *     earnings, purchases land in `available`), so this flags attempts to cycle money through
 *     colluding counterparties (buy → pay a related trainer → withdraw).
 * - self_dealing              (high, BLOCKING): learner and trainer orgs of a paid training session share
 *     a member user (incl. same org). Settlement release/partial is HELD (409 settlement_held) and escrow
 *     stays locked until an admin reviews: resolve via dispute or settleTraining(..., { adminOverride:true }).
 *     A plain refund is never blocked.
 */
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { db, schema, type DbOrTx } from '../../db/client.js';

export const FAILED_PAYMENTS_THRESHOLD = 3;
const PURCHASE_WINDOW_MS = 72 * 3600_000;

export type FraudEvent =
  | { type: 'payment_failed'; orgId: string; paymentId: string }
  | { type: 'payout_requested'; orgId: string; payoutId: string; amountCredits: number }
  | { type: 'settlement'; sessionId: string; learnerOrgId: string; trainerOrgId: string };

export interface FraudResult { flagged: string[]; block: boolean }

async function flag(q: DbOrTx, rule: string, severity: 'low' | 'medium' | 'high', targetType: string, targetId: string, details: Record<string, unknown>) {
  const [open] = await q.select({ id: schema.fraudFlags.id }).from(schema.fraudFlags)
    .where(and(eq(schema.fraudFlags.rule, rule), eq(schema.fraudFlags.targetType, targetType), eq(schema.fraudFlags.targetId, targetId), eq(schema.fraudFlags.status, 'open'))).limit(1);
  if (open) return;
  await q.insert(schema.fraudFlags).values({ rule, severity, targetType, targetId, details });
}

export async function checkFraud(event: FraudEvent, tx?: DbOrTx): Promise<FraudResult> {
  const q = tx ?? db();
  const flagged: string[] = [];
  let block = false;

  if (event.type === 'payment_failed') {
    const since = new Date(Date.now() - 24 * 3600_000);
    const [{ n }] = await q.select({ n: sql<number>`count(*)::int` }).from(schema.payments)
      .where(and(eq(schema.payments.orgId, event.orgId), eq(schema.payments.status, 'failed'), gte(schema.payments.updatedAt, since)));
    if (n >= FAILED_PAYMENTS_THRESHOLD) {
      await flag(q, 'repeated_failed_payments', 'medium', 'organisation', event.orgId, { failedLast24h: n, lastPaymentId: event.paymentId });
      flagged.push('repeated_failed_payments');
    }
  }

  if (event.type === 'payout_requested') {
    const since = new Date(Date.now() - PURCHASE_WINDOW_MS);
    const [{ total }] = await q.select({ total: sql<number>`coalesce(sum(${schema.payments.credits}),0)::bigint` }).from(schema.payments)
      .where(and(eq(schema.payments.orgId, event.orgId), eq(schema.payments.status, 'succeeded'), gte(schema.payments.updatedAt, since)));
    if (Number(total) > 0 && Number(total) >= event.amountCredits) {
      await flag(q, 'payout_after_purchase', 'high', 'payout', event.payoutId, { orgId: event.orgId, purchasedLast72h: Number(total), payoutCredits: event.amountCredits });
      flagged.push('payout_after_purchase');
    }
  }

  if (event.type === 'settlement') {
    let shared = event.learnerOrgId === event.trainerOrgId;
    if (!shared) {
      const rows = await q.select({ userId: schema.memberships.userId, orgId: schema.memberships.orgId }).from(schema.memberships)
        .where(inArray(schema.memberships.orgId, [event.learnerOrgId, event.trainerOrgId]));
      const learners = new Set(rows.filter((r) => r.orgId === event.learnerOrgId).map((r) => r.userId));
      shared = rows.some((r) => r.orgId === event.trainerOrgId && learners.has(r.userId));
    }
    if (shared) {
      await flag(q, 'self_dealing', 'high', 'training_session', event.sessionId, { learnerOrgId: event.learnerOrgId, trainerOrgId: event.trainerOrgId });
      flagged.push('self_dealing');
      block = true;
    }
  }

  return { flagged, block };
}
