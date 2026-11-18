/** Reconciliation issues: a mismatch is RAISED for an admin to review — money is never "fixed" automatically. One open issue per (kind, ref); re-detection refreshes it. */
import { and, desc, eq, sql } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';

export type Severity = 'info' | 'warning' | 'critical';

export async function raiseIssue(i: { kind: string; severity: Severity; refType: string; refKey: string; details?: Record<string, unknown> }) {
  await db().insert(schema.walletReconciliationIssues).values({ kind: i.kind, severity: i.severity, refType: i.refType, refKey: i.refKey, details: i.details ?? {} })
    .onConflictDoUpdate({
      target: [schema.walletReconciliationIssues.kind, schema.walletReconciliationIssues.refType, schema.walletReconciliationIssues.refKey],
      targetWhere: sql`status = 'open'`,
      set: { lastSeenAt: new Date(), severity: i.severity, details: i.details ?? {} },
    });
}

export async function listIssues(status: 'open' | 'resolved' = 'open', limit = 100) {
  return db().select().from(schema.walletReconciliationIssues).where(eq(schema.walletReconciliationIssues.status, status))
    .orderBy(desc(schema.walletReconciliationIssues.lastSeenAt)).limit(limit);
}

export async function resolveIssue(id: string, note: string) {
  const [row] = await db().update(schema.walletReconciliationIssues).set({ status: 'resolved', resolutionNote: note.slice(0, 1000), resolvedAt: new Date() })
    .where(and(eq(schema.walletReconciliationIssues.id, id), eq(schema.walletReconciliationIssues.status, 'open'))).returning();
  return row ?? null;
}
