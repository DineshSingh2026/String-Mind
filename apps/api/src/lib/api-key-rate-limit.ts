/**
 * Per-API-key rate limiting (enforces api_keys.rate_limit_per_min).
 * Fixed 60-second window keyed by API key id.
 *
 * Process-local: in a multi-instance deployment each instance counts separately, so the effective
 * limit becomes N × rateLimitPerMin. Move this to a shared store (Redis INCR+EXPIRE / Postgres) there.
 */
const WINDOW_MS = 60_000;
const windows = new Map<string, { start: number; count: number }>();

export interface RateDecision { allowed: boolean; limit: number; remaining: number; retryAfterSec: number }

export function consumeApiKeyRequest(keyId: string, limitPerMin: number, now = Date.now()): RateDecision {
  let w = windows.get(keyId);
  if (!w || now - w.start >= WINDOW_MS) {
    w = { start: now, count: 0 };
    windows.set(keyId, w);
    // Opportunistic cleanup so the map does not grow with dead keys.
    if (windows.size > 10_000) for (const [k, v] of windows) if (now - v.start >= WINDOW_MS) windows.delete(k);
  }
  const retryAfterSec = Math.max(1, Math.ceil((w.start + WINDOW_MS - now) / 1000));
  if (w.count >= limitPerMin) return { allowed: false, limit: limitPerMin, remaining: 0, retryAfterSec };
  w.count++;
  return { allowed: true, limit: limitPerMin, remaining: limitPerMin - w.count, retryAfterSec };
}

export function resetApiKeyRateLimits() { windows.clear(); }
