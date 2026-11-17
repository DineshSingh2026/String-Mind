/**
 * Hive ranking. Pure functions (no DB) so routes, the hive map and RAG retrieval rank the same way.
 *
 * rankScore (0..1) = 0.8 × quality + 0.2 × recency
 *   quality = (confirms + 1) / (confirms + 2 × disputes + 2)
 *             Laplace-smoothed share of confirmations, a dispute weighs twice a confirmation.
 *             No verdicts → 0.5 (neutral). Many confirms → towards 1. Disputes pull it towards 0.
 *             The +1/+2 smoothing means one verdict moves an item less than ten verdicts do.
 *   recency = exp(−ageDays / 30)  (a fresh item gets a small lift that fades over a few months)
 */

export interface VerdictCounts { confirmCount: number; disputeCount: number }

export function verdictQuality(c: VerdictCounts): number {
  const confirms = Math.max(0, c.confirmCount);
  const disputes = Math.max(0, c.disputeCount);
  return (confirms + 1) / (confirms + 2 * disputes + 2);
}

export function rankScore(c: VerdictCounts & { createdAt?: Date | string | null }, now = Date.now()): number {
  const created = c.createdAt ? new Date(c.createdAt).getTime() : now;
  const ageDays = Math.max(0, (now - created) / 86_400_000);
  const recency = Math.exp(-ageDays / 30);
  return Math.round((0.8 * verdictQuality(c) + 0.2 * recency) * 1000) / 1000;
}

/**
 * Retrieval multiplier for RAG: 1 with no verdicts, up to ~1.1 for well-confirmed knowledge and down to
 * ~0.9 for disputed knowledge. Deliberately small: relevance stays the main signal.
 */
export function retrievalBoost(c: VerdictCounts): number {
  if (c.confirmCount + c.disputeCount === 0) return 1;
  return 0.9 + 0.2 * verdictQuality(c);
}
