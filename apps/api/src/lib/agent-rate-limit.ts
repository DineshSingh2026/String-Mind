/**
 * Per-agent-token rate limiting for /agent-api/* (fixed 60-second window keyed by the token's sha256).
 * Limit: env AGENT_TOKEN_RATE_LIMIT_PER_MIN (read per call, default 120). Over the limit → 429 + Retry-After.
 *
 * Applied before the token is looked up, so floods with invalid tokens are throttled too (keyed by what they send).
 * Process-local like the API-key limiter (lib/api-key-rate-limit.ts): multi-instance deployments need a shared store.
 */
const WINDOW_MS = 60_000;
const DEFAULT_LIMIT = 120;
const windows = new Map<string, { start: number; count: number }>();

export function agentTokenLimitPerMin(): number {
  const v = Number(process.env.AGENT_TOKEN_RATE_LIMIT_PER_MIN);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_LIMIT;
}

export interface AgentRateDecision { allowed: boolean; limit: number; remaining: number; retryAfterSec: number }

export function consumeAgentTokenRequest(tokenHash: string, limit = agentTokenLimitPerMin(), now = Date.now()): AgentRateDecision {
  let w = windows.get(tokenHash);
  if (!w || now - w.start >= WINDOW_MS) {
    w = { start: now, count: 0 };
    windows.set(tokenHash, w);
    if (windows.size > 10_000) for (const [k, v] of windows) if (now - v.start >= WINDOW_MS) windows.delete(k);
  }
  const retryAfterSec = Math.max(1, Math.ceil((w.start + WINDOW_MS - now) / 1000));
  if (w.count >= limit) return { allowed: false, limit, remaining: 0, retryAfterSec };
  w.count++;
  return { allowed: true, limit, remaining: limit - w.count, retryAfterSec };
}

export function resetAgentTokenRateLimits() { windows.clear(); }
