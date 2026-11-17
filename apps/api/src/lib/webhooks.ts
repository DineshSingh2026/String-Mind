/**
 * Outbound webhooks.
 *
 *   await emitEvent(orgId, 'assessment.completed', { assessmentId, agentId, overallScore })
 *
 * Inserts one `webhook_deliveries` row per active org webhook subscribed to `event` (or '*'),
 * then enqueues `webhooks.deliver` jobs. Delivery is a signed POST:
 *   headers: content-type: application/json, x-aix-event, x-aix-delivery, x-aix-signature: t=<unix>,v1=<hmac>
 *   body:    { id, event, createdAt, data }
 * Failures are retried with exponential backoff (max WEBHOOK_MAX_ATTEMPTS attempts).
 * emitEvent never throws (webhooks must not break business flows); errors are logged.
 */
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { enqueue, registerJob } from '../jobs/queue.js';
import { decrypt, signWebhook } from './crypto.js';
import { assertSafeOutboundUrl, UnsafeUrlError } from './net-guard.js';

export const WEBHOOK_EVENTS = [
  'agent.connected', 'agent.health_failed', 'assessment.completed',
  'training.requested', 'training.accepted', 'training.completed',
  'payment.succeeded', 'payout.updated',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const WEBHOOK_MAX_ATTEMPTS = 5;
const DELIVERY_TIMEOUT_MS = 10_000;
/** Backoff before attempt n+1 (ms): 10s, 1m, 5m, 30m. */
const BACKOFF_MS = [10_000, 60_000, 5 * 60_000, 30 * 60_000];

export async function emitEvent(orgId: string, event: string, payload: Record<string, unknown>): Promise<void> {
  try {
    const hooks = await db().select().from(schema.webhooks)
      .where(and(eq(schema.webhooks.orgId, orgId), eq(schema.webhooks.active, true)));
    const targets = hooks.filter((h) => h.events.includes(event) || h.events.includes('*'));
    for (const h of targets) {
      const [d] = await db().insert(schema.webhookDeliveries)
        .values({ webhookId: h.id, event, payload, status: 'pending', nextAttemptAt: new Date() }).returning();
      await enqueue('webhooks.deliver', { deliveryId: d!.id }, { maxAttempts: 1 });
    }
  } catch (err) {
    console.error(`[webhooks] emitEvent(${event}) failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Build the exact JSON body sent for a delivery (stable so signatures can be verified). */
export function deliveryBody(d: { id: string; event: string; payload: Record<string, unknown>; createdAt: Date }) {
  return JSON.stringify({ id: d.id, event: d.event, createdAt: d.createdAt.toISOString(), data: d.payload });
}

/**
 * Attempt one delivery. Returns the updated row. Schedules a retry job on failure while
 * attempts remain. Exported for the "test delivery" endpoint (maxAttempts: 1 = single shot).
 */
export async function attemptDelivery(deliveryId: string, opts: { scheduleRetry?: boolean; maxAttempts?: number } = {}) {
  const [d] = await db().select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.id, deliveryId)).limit(1);
  if (!d || d.status === 'delivered' || d.status === 'failed') return d ?? null;
  const [hook] = await db().select().from(schema.webhooks).where(eq(schema.webhooks.id, d.webhookId)).limit(1);
  if (!hook || !hook.active) {
    const [u] = await db().update(schema.webhookDeliveries)
      .set({ status: 'failed', lastError: 'Webhook disabled or deleted', nextAttemptAt: null })
      .where(eq(schema.webhookDeliveries.id, d.id)).returning();
    return u ?? null;
  }
  const body = deliveryBody(d);
  const attempts = d.attempts + 1;
  let responseCode: number | null = null;
  let error: string | null = null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DELIVERY_TIMEOUT_MS);
  try {
    // SSRF guard re-checked per delivery (DNS rebinding defence); also validated when the URL is saved.
    await assertSafeOutboundUrl(hook.url);
    const res = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'StringMind-Webhooks/1.0',
        'x-aix-event': d.event,
        'x-aix-delivery': d.id,
        'x-aix-signature': signWebhook(decrypt(hook.secretEnc), body),
      },
      body,
      signal: ctrl.signal,
      redirect: 'manual',
    });
    responseCode = res.status;
    await res.arrayBuffer().catch(() => undefined);
    if (res.status < 200 || res.status >= 300) error = `Endpoint responded with HTTP ${res.status}`;
  } catch (err) {
    error = err instanceof UnsafeUrlError ? `Blocked: ${err.message}` : ctrl.signal.aborted ?`Timed out after ${DELIVERY_TIMEOUT_MS / 1000}s` : `Network error: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    clearTimeout(timer);
  }
  const done = !error;
  const exhausted = !done && attempts >= (opts.maxAttempts ?? WEBHOOK_MAX_ATTEMPTS);
  const delay = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]!;
  const [updated] = await db().update(schema.webhookDeliveries).set({
    attempts, responseCode, lastError: error,
    status: done ? 'delivered' : exhausted ? 'failed' : 'pending',
    nextAttemptAt: done || exhausted ? null : new Date(Date.now() + delay),
  }).where(eq(schema.webhookDeliveries.id, d.id)).returning();
  if (!done && !exhausted && opts.scheduleRetry !== false) {
    await enqueue('webhooks.deliver', { deliveryId: d.id }, { delayMs: delay, maxAttempts: 1 });
  }
  return updated ?? null;
}

let registered = false;
/** Registers the `webhooks.deliver` job handler (called from developer module registerJobs). */
export function registerWebhookJobs() {
  if (registered) return;
  registered = true;
  registerJob('webhooks.deliver', async (payload) => {
    const deliveryId = String(payload.deliveryId ?? '');
    if (!deliveryId) throw new Error('webhooks.deliver: missing deliveryId');
    await attemptDelivery(deliveryId);
  });
}
