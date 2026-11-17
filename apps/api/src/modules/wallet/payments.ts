/**
 * DORMANT — only reachable when FIAT_ENABLED=true (default false; StringMind is a pure IDLE Token economy, see
 * docs/IDLE_TOKENS.md). Kept for a possible future.
 *
 * Payment providers + payment lifecycle (token purchases).
 *
 * - sandbox  (default): NO real money. createCheckout returns a one-time `checkoutToken` (only its SHA-256 is
 *   stored, in payments.provider_ref). The web sandbox checkout page calls
 *   POST /wallet/payments/:id/confirm {checkoutToken, outcome:'success'|'fail'}.
 * - razorpay: needs RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET (+ RAZORPAY_WEBHOOK_SECRET for webhooks).
 *   Creates an Order via REST; webhook signature = hex HMAC-SHA256(rawBody, webhookSecret) in `x-razorpay-signature`.
 * - stripe:   needs STRIPE_SECRET_KEY (+ STRIPE_WEBHOOK_SECRET). Creates a Checkout Session via REST;
 *   webhook `stripe-signature: t=<ts>,v1=<hex HMAC-SHA256("<ts>.<rawBody>")>`.
 * Unconfigured real providers throw 503 provider_not_configured. Credits are ONLY posted by ledger.postPurchase.
 *
 * TAX: GST 18% is added on top of the package price as a separate invoice line (taxMinor). This configuration is
 * ILLUSTRATIVE ONLY — rates, place-of-supply (CGST/SGST vs IGST), GSTIN, HSN/SAC codes and invoice numbering rules
 * must be validated per jurisdiction by a tax professional before charging real customers.
 */
import { and, eq, like, sql } from 'drizzle-orm';
import { timingSafeEqual, createHmac } from 'node:crypto';
import { db, schema, type DbOrTx } from '../../db/client.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { config } from '../../lib/config.js';
import { randomToken, sha256 } from '../../lib/crypto.js';
import { audit } from '../../lib/audit.js';
import { notify } from '../../lib/notify.js';
import { checkFraud } from './fraud.js';
import { postPurchase } from './ledger.js';

export type Payment = typeof schema.payments.$inferSelect;
export const GST_RATE_BPS = 1800;
export const taxFor = (priceMinor: number) => Math.round((priceMinor * GST_RATE_BPS) / 10_000);

export interface CheckoutResult {
  providerRef: string;
  /** sandbox only — shown once to the client, never stored in plaintext */
  checkoutToken?: string;
  checkoutUrl?: string;
  /** data the web client needs to open the provider's checkout widget */
  clientPayload?: Record<string, unknown>;
}
export interface WebhookEvent { kind: 'payment_succeeded' | 'payment_failed' | 'ignored'; providerRef?: string; reason?: string }

export interface PaymentProvider {
  name: 'sandbox' | 'razorpay' | 'stripe';
  createCheckout(payment: Payment & { description: string }): Promise<CheckoutResult>;
  /** Verify signature and normalise the event. Throws 400 on bad signature. */
  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): WebhookEvent;
  refund?(payment: Payment): Promise<void>;
}

const notConfigured = (p: string) => new AppError(503, 'provider_not_configured', `Payment provider "${p}" is not configured on this server`);
const header = (h: Record<string, string | string[] | undefined>, k: string) => { const v = h[k]; return Array.isArray(v) ? v[0] : v; };
const safeEq = (a: string, b: string) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const hmacHex = (secret: string, data: string) => createHmac('sha256', secret).update(data).digest('hex');
const total = (p: Payment) => p.amountMinor + p.taxMinor;

class SandboxProvider implements PaymentProvider {
  name = 'sandbox' as const;
  async createCheckout(payment: Payment) {
    const checkoutToken = randomToken(24);
    return { providerRef: `sbx_${sha256(checkoutToken)}`, checkoutToken, checkoutUrl: `/wallet/checkout/${payment.id}?token=${checkoutToken}` };
  }
  verifyWebhook(): WebhookEvent { throw badRequest('The sandbox provider has no webhooks; use POST /wallet/payments/:id/confirm'); }
  async refund() { /* no real money moved */ }
}

export class RazorpayProvider implements PaymentProvider {
  name = 'razorpay' as const;
  private creds() {
    const id = process.env.RAZORPAY_KEY_ID; const secret = process.env.RAZORPAY_KEY_SECRET;
    if (!id || !secret) throw notConfigured('razorpay');
    return { id, secret, auth: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}` };
  }
  async createCheckout(payment: Payment & { description: string }) {
    const c = this.creds();
    const res = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST', headers: { authorization: c.auth, 'content-type': 'application/json' },
      body: JSON.stringify({ amount: total(payment), currency: payment.currency, receipt: payment.id, notes: { paymentId: payment.id } }),
    });
    const body = await res.json().catch(() => ({})) as { id?: string; error?: { description?: string } };
    if (!res.ok || !body.id) throw new AppError(502, 'provider_error', `Razorpay order failed: ${body.error?.description ?? res.status}`);
    return { providerRef: body.id, clientPayload: { keyId: c.id, orderId: body.id, amount: total(payment), currency: payment.currency, description: payment.description } };
  }
  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): WebhookEvent {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) throw notConfigured('razorpay');
    const sig = header(headers, 'x-razorpay-signature');
    if (!sig || !safeEq(hmacHex(secret, rawBody), sig)) throw badRequest('Invalid webhook signature');
    const evt = JSON.parse(rawBody) as { event?: string; payload?: { payment?: { entity?: { order_id?: string; error_description?: string } }; order?: { entity?: { id?: string } } } };
    const orderId = evt.payload?.order?.entity?.id ?? evt.payload?.payment?.entity?.order_id;
    if (evt.event === 'order.paid' || evt.event === 'payment.captured') return { kind: 'payment_succeeded', providerRef: orderId };
    if (evt.event === 'payment.failed') return { kind: 'payment_failed', providerRef: orderId, reason: evt.payload?.payment?.entity?.error_description ?? 'payment failed' };
    return { kind: 'ignored' };
  }
  async refund(payment: Payment) {
    const c = this.creds();
    // Razorpay refunds are issued against the captured payment id; look it up from the order.
    const r = await fetch(`https://api.razorpay.com/v1/orders/${payment.providerRef}/payments`, { headers: { authorization: c.auth } });
    const list = await r.json().catch(() => ({})) as { items?: { id: string; status: string }[] };
    const captured = list.items?.find((i) => i.status === 'captured');
    if (!captured) throw new AppError(502, 'provider_error', 'No captured Razorpay payment found to refund');
    const res = await fetch(`https://api.razorpay.com/v1/payments/${captured.id}/refund`, {
      method: 'POST', headers: { authorization: c.auth, 'content-type': 'application/json' }, body: JSON.stringify({ amount: total(payment) }),
    });
    if (!res.ok) throw new AppError(502, 'provider_error', `Razorpay refund failed (${res.status})`);
  }
}

export class StripeProvider implements PaymentProvider {
  name = 'stripe' as const;
  private key() { const k = process.env.STRIPE_SECRET_KEY; if (!k) throw notConfigured('stripe'); return k; }
  async createCheckout(payment: Payment & { description: string }) {
    const key = this.key();
    const form = new URLSearchParams({
      mode: 'payment', client_reference_id: payment.id, 'metadata[paymentId]': payment.id,
      'line_items[0][quantity]': '1', 'line_items[0][price_data][currency]': payment.currency.toLowerCase(),
      'line_items[0][price_data][unit_amount]': String(total(payment)), 'line_items[0][price_data][product_data][name]': payment.description,
      success_url: `${config.WEB_ORIGINS[0]}/wallet?payment=${payment.id}&status=success`, cancel_url: `${config.WEB_ORIGINS[0]}/wallet?payment=${payment.id}&status=cancelled`,
    });
    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': `checkout-${payment.id}` }, body: form,
    });
    const body = await res.json().catch(() => ({})) as { id?: string; url?: string; error?: { message?: string } };
    if (!res.ok || !body.id) throw new AppError(502, 'provider_error', `Stripe checkout failed: ${body.error?.message ?? res.status}`);
    return { providerRef: body.id, checkoutUrl: body.url };
  }
  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>, toleranceSec = 300): WebhookEvent {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) throw notConfigured('stripe');
    const sig = header(headers, 'stripe-signature') ?? '';
    const parts = sig.split(',').map((p) => p.split('=') as [string, string]);
    const t = Number(parts.find(([k]) => k === 't')?.[1]);
    const v1s = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
    if (!t || !v1s.length || Math.abs(Date.now() / 1000 - t) > toleranceSec) throw badRequest('Invalid webhook signature');
    const expected = hmacHex(secret, `${t}.${rawBody}`);
    if (!v1s.some((v) => safeEq(expected, v))) throw badRequest('Invalid webhook signature');
    const evt = JSON.parse(rawBody) as { type?: string; data?: { object?: { id?: string; payment_status?: string } } };
    const obj = evt.data?.object;
    if (evt.type === 'checkout.session.completed' || evt.type === 'checkout.session.async_payment_succeeded') {
      return obj?.payment_status === 'paid' ? { kind: 'payment_succeeded', providerRef: obj.id } : { kind: 'ignored' };
    }
    if (evt.type === 'checkout.session.async_payment_failed' || evt.type === 'checkout.session.expired') return { kind: 'payment_failed', providerRef: obj?.id, reason: evt.type };
    return { kind: 'ignored' };
  }
  async refund(payment: Payment) {
    const key = this.key();
    const s = await fetch(`https://api.stripe.com/v1/checkout/sessions/${payment.providerRef}`, { headers: { authorization: `Bearer ${key}` } });
    const sess = await s.json().catch(() => ({})) as { payment_intent?: string };
    if (!sess.payment_intent) throw new AppError(502, 'provider_error', 'Stripe payment intent not found');
    const res = await fetch('https://api.stripe.com/v1/refunds', {
      method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': `refund-${payment.id}` },
      body: new URLSearchParams({ payment_intent: sess.payment_intent }),
    });
    if (!res.ok) throw new AppError(502, 'provider_error', `Stripe refund failed (${res.status})`);
  }
}

const providers: Record<string, PaymentProvider> = { sandbox: new SandboxProvider(), razorpay: new RazorpayProvider(), stripe: new StripeProvider() };
export function getProvider(name: string): PaymentProvider {
  const p = providers[name];
  if (!p) throw badRequest(`Unknown payment provider: ${name}`);
  return p;
}

/** `AIX-INV-<yyyymm>-<seq>` — sequence per month, serialised with a transaction-scoped advisory lock. */
export async function nextInvoiceNumber(tx: DbOrTx, now = new Date()): Promise<string> {
  const ym = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const prefix = `AIX-INV-${ym}-`;
  await tx.execute(sql`select pg_advisory_xact_lock(470047)`);
  const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.payments).where(like(schema.payments.invoiceNumber, `${prefix}%`));
  return `${prefix}${String(n + 1).padStart(5, '0')}`;
}

/* ───────────────────────────── lifecycle ───────────────────────────── */

export async function createPayment({ orgId, userId, packageId }: { orgId: string; userId: string; packageId: string }) {
  const [pkg] = await db().select().from(schema.creditPackages).where(and(eq(schema.creditPackages.id, packageId), eq(schema.creditPackages.active, true))).limit(1);
  if (!pkg) throw notFound('Credit package');
  const provider = getProvider(config.PAYMENT_PROVIDER);
  const [payment] = await db().insert(schema.payments).values({
    orgId, userId, provider: provider.name, packageId: pkg.id, amountMinor: pkg.priceMinor, taxMinor: taxFor(pkg.priceMinor),
    currency: pkg.currency, credits: pkg.credits + pkg.bonusCredits, status: 'created',
  }).returning();
  let checkout: CheckoutResult;
  try {
    checkout = await provider.createCheckout({ ...payment!, description: `${pkg.name} — ${pkg.credits + pkg.bonusCredits} StringMind credits` });
  } catch (e) {
    await db().update(schema.payments).set({ status: 'failed', failureReason: (e as Error).message, updatedAt: new Date() }).where(eq(schema.payments.id, payment!.id));
    throw e;
  }
  const [p] = await db().update(schema.payments).set({ providerRef: checkout.providerRef, updatedAt: new Date() }).where(eq(schema.payments.id, payment!.id)).returning();
  await audit({ action: 'wallet.payment_create', targetType: 'payment', targetId: p!.id, orgId, actorUserId: userId, actorType: 'user', metadata: { packageId, provider: provider.name, amountMinor: p!.amountMinor, taxMinor: p!.taxMinor } });
  return { ...publicPayment(p!), checkoutToken: checkout.checkoutToken, checkoutUrl: checkout.checkoutUrl, clientPayload: checkout.clientPayload };
}

export const publicPayment = (p: Payment) => {
  const { providerRef, ...rest } = p;
  return { ...rest, providerRef: p.provider === 'sandbox' ? null : providerRef, totalMinor: total(p) };
};

export async function markPaymentFailed(paymentId: string, reason: string, tx?: DbOrTx) {
  const q = tx ?? db();
  const [p] = await q.update(schema.payments).set({ status: 'failed', failureReason: reason, updatedAt: new Date() })
    .where(and(eq(schema.payments.id, paymentId), eq(schema.payments.status, 'created'))).returning();
  if (!p) return null;
  await audit({ action: 'wallet.payment_failed', targetType: 'payment', targetId: p.id, orgId: p.orgId, actorType: 'system', metadata: { reason } }, null, tx);
  await notify(p.userId, 'payment_update', 'Payment failed', `Your payment could not be completed (${reason}). No credits were charged.`, '/wallet', tx);
  await checkFraud({ type: 'payment_failed', orgId: p.orgId, paymentId: p.id }, tx);
  return p;
}

/** Sandbox checkout confirmation. Idempotent: confirming a succeeded payment again returns it without re-posting. */
export async function confirmSandboxPayment(paymentId: string, orgId: string, checkoutToken: string, outcome: 'success' | 'fail') {
  const [p] = await db().select().from(schema.payments).where(and(eq(schema.payments.id, paymentId), eq(schema.payments.orgId, orgId))).limit(1);
  if (!p) throw notFound('Payment');
  if (p.provider !== 'sandbox') throw badRequest('Only sandbox payments can be confirmed here');
  if (!p.providerRef || !safeEq(p.providerRef, `sbx_${sha256(checkoutToken)}`)) throw new AppError(403, 'invalid_checkout_token', 'Invalid checkout token');
  if (outcome === 'fail') {
    if (p.status === 'failed') return p;
    if (p.status !== 'created') throw conflict(`Payment is already ${p.status}`);
    await markPaymentFailed(p.id, 'Declined in sandbox checkout');
  } else {
    if (p.status === 'failed' || p.status === 'refunded') throw conflict(`Payment is ${p.status}`);
    await postPurchase(p.id);
  }
  const [after] = await db().select().from(schema.payments).where(eq(schema.payments.id, p.id));
  return after!;
}

/** Provider webhook → postPurchase / markPaymentFailed. Unknown payment refs are acknowledged and ignored. */
export async function handleWebhook(providerName: string, rawBody: string, headers: Record<string, string | string[] | undefined>) {
  if (providerName !== 'razorpay' && providerName !== 'stripe') throw notFound('Webhook provider');
  const evt = getProvider(providerName).verifyWebhook(rawBody, headers);
  if (evt.kind === 'ignored' || !evt.providerRef) return { received: true, handled: false };
  const [p] = await db().select().from(schema.payments).where(and(eq(schema.payments.provider, providerName), eq(schema.payments.providerRef, evt.providerRef))).limit(1);
  if (!p) return { received: true, handled: false };
  if (evt.kind === 'payment_succeeded') {
    if (p.status === 'created' || p.status === 'succeeded') await postPurchase(p.id);
  } else {
    await markPaymentFailed(p.id, evt.reason ?? 'payment failed');
  }
  return { received: true, handled: true };
}

/** Invoice JSON for a succeeded/refunded payment. */
export async function buildInvoice(p: Payment) {
  if (!p.invoiceNumber) throw conflict('Invoice is only available for completed payments');
  const [org] = await db().select().from(schema.organisations).where(eq(schema.organisations.id, p.orgId));
  const [pkg] = p.packageId ? await db().select().from(schema.creditPackages).where(eq(schema.creditPackages.id, p.packageId)) : [];
  const half = Math.floor(p.taxMinor / 2);
  return {
    number: p.invoiceNumber, paymentId: p.id, issuedAt: p.updatedAt.toISOString(), status: p.status, currency: p.currency,
    seller: { name: 'StringMind Platform', gstin: 'ILLUSTRATIVE-NOT-REGISTERED' },
    buyer: { orgId: p.orgId, name: org?.name ?? '' },
    lines: [{ description: `${pkg?.name ?? 'Credit package'} — ${p.credits} StringMind credits`, quantity: 1, unitMinor: p.amountMinor, amountMinor: p.amountMinor }],
    subtotalMinor: p.amountMinor,
    tax: { type: 'GST', rateBps: GST_RATE_BPS, amountMinor: p.taxMinor, breakdown: [{ name: 'CGST 9%', amountMinor: half }, { name: 'SGST 9%', amountMinor: p.taxMinor - half }] },
    totalMinor: total(p), credits: p.credits,
    note: 'Tax configuration is illustrative only and must be validated per jurisdiction before charging real customers.',
  };
}
