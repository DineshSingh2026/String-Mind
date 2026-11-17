/**
 * In-memory per-agent daily call counter (UTC day) used to enforce usageLimits.maxCallsPerDay.
 * Process-local: in a multi-instance deployment move this to Redis/Postgres.
 */
const counters = new Map<string, { day: string; count: number }>();
const today = () => new Date().toISOString().slice(0, 10);

export function getDailyCallCount(agentId: string): number {
  const c = counters.get(agentId);
  return c && c.day === today() ? c.count : 0;
}

/** Atomically (single-threaded) checks the limit and records a call. Returns false if over limit. */
export function tryConsumeCall(agentId: string, maxPerDay: number | undefined | null): boolean {
  const day = today();
  const c = counters.get(agentId);
  const count = c && c.day === day ? c.count : 0;
  if (maxPerDay !== undefined && maxPerDay !== null && count >= maxPerDay) return false;
  counters.set(agentId, { day, count: count + 1 });
  return true;
}

export function resetUsageCounters() { counters.clear(); }
