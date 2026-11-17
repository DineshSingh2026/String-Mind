/** Developer console: API keys, outbound webhooks, request logs/usage, inbound agent callbacks. See docs/API.md#developer. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, count, desc, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { PERMISSIONS, roleHas, type Permission } from '@aix/shared';
import { db, schema } from '../../db/client.js';
import { audit } from '../../lib/audit.js';
import { requirePerm } from '../../lib/auth.js';
import { config } from '../../lib/config.js';
import { decrypt, encrypt, randomToken, sha256, verifyWebhook } from '../../lib/crypto.js';
import { badRequest, forbidden, notFound, unauthorized, unprocessable } from '../../lib/errors.js';
import { PageQuery, offset, parse } from '../../lib/http.js';
import { assertSafeUrlForSave } from '../../lib/net-guard.js';
import { WEBHOOK_EVENTS, attemptDelivery, registerWebhookJobs } from '../../lib/webhooks.js';

const IdParam = z.object({ id: z.string().uuid() });
const Scope = z.union([z.literal('*'), z.enum(PERMISSIONS)]);
/** Enforced by the global @fastify/rate-limit registration in app.ts (per API key / IP). */
const GLOBAL_RATE_LIMIT_PER_MIN = 600;
/** Matches the api_keys.rate_limit_per_min column default. */
const DEFAULT_KEY_RATE_LIMIT_PER_MIN = 120;

const EVENT_DESCRIPTIONS: Record<string, string> = {
  'agent.connected': 'An agent passed its connection test for the first time (or after an error).',
  'agent.health_failed': 'A scheduled health check of an active agent failed.',
  'assessment.completed': 'A capability assessment finished.',
  'training.requested': 'Your agent received a training request.',
  'training.accepted': 'A training request was accepted and a session created.',
  'training.completed': 'A training session completed and was evaluated.',
  'payment.succeeded': 'A credit purchase payment succeeded.',
  'payout.updated': 'A payout changed status.',
};

function keyView(k: typeof schema.apiKeys.$inferSelect) {
  const status = k.revokedAt ? 'revoked' : k.expiresAt && k.expiresAt < new Date() ? 'expired' : 'active';
  return {
    id: k.id, name: k.name, prefix: k.prefix, scopes: k.scopes, environment: k.environment, rateLimitPerMin: k.rateLimitPerMin,
    lastUsedAt: k.lastUsedAt, expiresAt: k.expiresAt, revokedAt: k.revokedAt, rotatedFromId: k.rotatedFromId, createdBy: k.createdBy,
    createdAt: k.createdAt, status,
  };
}

function webhookView(w: typeof schema.webhooks.$inferSelect) {
  return { id: w.id, url: w.url, events: w.events, active: w.active, createdBy: w.createdBy, createdAt: w.createdAt };
}

function generateKey(environment: string) {
  const key = `aix_sk_${environment === 'production' ? 'live' : 'test'}_${randomToken(24)}`;
  return { key, prefix: key.slice(0, 16), keyHash: sha256(key) };
}

/** A caller may only grant scopes it holds itself (role permissions ∩ current key scopes). */
function assertGrantable(req: FastifyRequest, scopes: string[]) {
  const a = req.auth!;
  for (const s of scopes) {
    if (s === '*') {
      if (a.apiKeyScopes && !a.apiKeyScopes.includes('*')) throw forbidden('An API key cannot create a key with broader scopes than its own');
      continue;
    }
    if (!roleHas(a.orgRole!, s as Permission)) throw forbidden(`Your role cannot grant scope: ${s}`);
    if (a.apiKeyScopes && !a.apiKeyScopes.includes('*') && !a.apiKeyScopes.includes(s)) throw forbidden(`Your API key cannot grant scope: ${s}`);
  }
}

const WebhookUrl = z.string().trim().url().max(2000).refine((u) => (config.isProd ? /^https:\/\//i : /^https?:\/\//i).test(u),
  config.isProd ? 'Webhook URL must use https://' : 'Webhook URL must use http:// or https://');
const WebhookEvents = z.array(z.union([z.literal('*'), z.enum(WEBHOOK_EVENTS)])).min(1).max(WEBHOOK_EVENTS.length + 1);

async function ownedWebhook(id: string, orgId: string) {
  const [w] = await db().select().from(schema.webhooks).where(and(eq(schema.webhooks.id, id), eq(schema.webhooks.orgId, orgId))).limit(1);
  if (!w) throw notFound('Webhook');
  return w;
}

export default async function routes(app: FastifyInstance) {
  /* ───── API keys ───── */
  app.get('/keys', async (req) => {
    const a = requirePerm(req, 'developer.keys.manage');
    const rows = await db().select().from(schema.apiKeys).where(eq(schema.apiKeys.orgId, a.orgId)).orderBy(desc(schema.apiKeys.createdAt));
    const items = rows.map(keyView);
    return { items, total: items.length, page: 1, pageSize: items.length };
  });

  app.post('/keys', async (req, reply) => {
    const a = requirePerm(req, 'developer.keys.manage');
    const body = parse(z.object({
      name: z.string().trim().min(1).max(100),
      scopes: z.array(Scope).min(1, 'Select at least one scope').max(PERMISSIONS.length + 1),
      environment: z.enum(['sandbox', 'production', 'test', 'live']).default('sandbox').transform((e) => (e === 'live' ? 'production' : e === 'test' ? 'sandbox' : e)),
      expiresInDays: z.number().int().min(1).max(730).optional(),
    }), req.body);
    const scopes = [...new Set(body.scopes)];
    assertGrantable(req, scopes);
    const { key, prefix, keyHash } = generateKey(body.environment);
    const [row] = await db().insert(schema.apiKeys).values({
      orgId: a.orgId, createdBy: a.user.id, name: body.name, prefix, keyHash, scopes, environment: body.environment,
      expiresAt: body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86400_000) : null,
    }).returning();
    await audit({ action: 'api_key.create', targetType: 'api_key', targetId: row!.id, metadata: { name: body.name, scopes, environment: body.environment } }, req);
    return reply.status(201).send({ ...keyView(row!), key });
  });

  app.post('/keys/:id/rotate', async (req, reply) => {
    const a = requirePerm(req, 'developer.keys.manage');
    const { id } = parse(IdParam, req.params);
    const [old] = await db().select().from(schema.apiKeys).where(and(eq(schema.apiKeys.id, id), eq(schema.apiKeys.orgId, a.orgId))).limit(1);
    if (!old) throw notFound('API key');
    if (old.revokedAt) throw unprocessable('Revoked keys cannot be rotated; create a new key instead');
    assertGrantable(req, old.scopes);
    const { key, prefix, keyHash } = generateKey(old.environment);
    const row = await db().transaction(async (tx) => {
      await tx.update(schema.apiKeys).set({ revokedAt: new Date() }).where(eq(schema.apiKeys.id, old.id));
      const [row] = await tx.insert(schema.apiKeys).values({
        orgId: a.orgId, createdBy: a.user.id, name: old.name, prefix, keyHash, scopes: old.scopes, environment: old.environment,
        rateLimitPerMin: old.rateLimitPerMin, expiresAt: old.expiresAt, rotatedFromId: old.id,
      }).returning();
      return row!;
    });
    await audit({ action: 'api_key.rotate', targetType: 'api_key', targetId: row.id, metadata: { rotatedFromId: old.id } }, req);
    return reply.status(201).send({ ...keyView(row), key });
  });

  app.delete('/keys/:id', async (req, reply) => {
    const a = requirePerm(req, 'developer.keys.manage');
    const { id } = parse(IdParam, req.params);
    const [row] = await db().update(schema.apiKeys).set({ revokedAt: new Date() })
      .where(and(eq(schema.apiKeys.id, id), eq(schema.apiKeys.orgId, a.orgId), isNull(schema.apiKeys.revokedAt))).returning();
    if (!row) throw notFound('Active API key');
    await audit({ action: 'api_key.revoke', targetType: 'api_key', targetId: id }, req);
    return reply.status(204).send();
  });

  /* ───── Webhooks ───── */
  app.get('/webhooks', async (req) => {
    const a = requirePerm(req, 'developer.webhooks.manage');
    const rows = await db().select().from(schema.webhooks).where(eq(schema.webhooks.orgId, a.orgId)).orderBy(desc(schema.webhooks.createdAt));
    const items = rows.map(webhookView);
    return { items, total: items.length, page: 1, pageSize: items.length };
  });

  app.post('/webhooks', async (req, reply) => {
    const a = requirePerm(req, 'developer.webhooks.manage');
    const body = parse(z.object({ url: WebhookUrl, events: WebhookEvents }), req.body);
    await assertSafeUrlForSave(body.url, 'Webhook URL');
    const [{ n }] = await db().select({ n: count() }).from(schema.webhooks).where(eq(schema.webhooks.orgId, a.orgId));
    if (Number(n) >= 20) throw unprocessable('An organisation can have at most 20 webhooks');
    const secret = `whsec_${randomToken(24)}`;
    const [w] = await db().insert(schema.webhooks).values({
      orgId: a.orgId, url: body.url, events: [...new Set(body.events)], secretEnc: encrypt(secret), createdBy: a.user.id,
    }).returning();
    await audit({ action: 'webhook.create', targetType: 'webhook', targetId: w!.id, metadata: { url: body.url, events: w!.events } }, req);
    return reply.status(201).send({ ...webhookView(w!), secret });
  });

  app.patch('/webhooks/:id', async (req) => {
    const a = requirePerm(req, 'developer.webhooks.manage');
    const { id } = parse(IdParam, req.params);
    const body = parse(z.object({ url: WebhookUrl.optional(), events: WebhookEvents.optional(), active: z.boolean().optional() }).strict(), req.body);
    if (!Object.keys(body).length) throw badRequest('Nothing to update');
    await ownedWebhook(id, a.orgId);
    if (body.url) await assertSafeUrlForSave(body.url, 'Webhook URL');
    const [w] = await db().update(schema.webhooks).set({ ...body, ...(body.events ? { events: [...new Set(body.events)] } : {}) })
      .where(eq(schema.webhooks.id, id)).returning();
    await audit({ action: 'webhook.update', targetType: 'webhook', targetId: id, metadata: body }, req);
    return webhookView(w!);
  });

  app.delete('/webhooks/:id', async (req, reply) => {
    const a = requirePerm(req, 'developer.webhooks.manage');
    const { id } = parse(IdParam, req.params);
    await ownedWebhook(id, a.orgId);
    await db().delete(schema.webhooks).where(eq(schema.webhooks.id, id));
    await audit({ action: 'webhook.delete', targetType: 'webhook', targetId: id }, req);
    return reply.status(204).send();
  });

  app.post('/webhooks/:id/test', async (req) => {
    const a = requirePerm(req, 'developer.webhooks.manage');
    const { id } = parse(IdParam, req.params);
    const w = await ownedWebhook(id, a.orgId);
    if (!w.active) throw unprocessable('Webhook is disabled; enable it before sending a test');
    const [d] = await db().insert(schema.webhookDeliveries).values({
      webhookId: w.id, event: 'webhook.test', payload: { message: 'This is a test delivery from StringMind.', webhookId: w.id }, status: 'pending',
    }).returning();
    const result = await attemptDelivery(d!.id, { scheduleRetry: false, maxAttempts: 1 });
    await audit({ action: 'webhook.test', targetType: 'webhook', targetId: id, metadata: { status: result?.status, responseCode: result?.responseCode } }, req);
    return result;
  });

  app.get('/webhooks/:id/deliveries', async (req) => {
    const a = requirePerm(req, 'developer.webhooks.manage');
    const { id } = parse(IdParam, req.params);
    const q = parse(PageQuery, req.query);
    await ownedWebhook(id, a.orgId);
    const [{ n }] = await db().select({ n: count() }).from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.webhookId, id));
    const items = await db().select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.webhookId, id))
      .orderBy(desc(schema.webhookDeliveries.createdAt)).limit(q.pageSize).offset(offset(q));
    return { items, total: Number(n), page: q.page, pageSize: q.pageSize };
  });

  app.get('/events', async () => {
    const items = WEBHOOK_EVENTS.map((name) => ({ name, description: EVENT_DESCRIPTIONS[name] ?? '' }));
    return { items, total: items.length, page: 1, pageSize: items.length };
  });

  /* ───── Logs & usage ───── */
  app.get('/logs', async (req) => {
    const a = requirePerm(req, 'developer.logs.read');
    const q = parse(PageQuery.extend({
      status: z.string().regex(/^(2xx|3xx|4xx|5xx|error|\d{3})$/, 'status must be 2xx|3xx|4xx|5xx|error or a status code').optional(),
      apiKeyId: z.string().uuid().optional(),
    }), req.query);
    const sc = schema.apiRequestLogs.statusCode;
    let statusCond;
    if (q.status === 'error') statusCond = gte(sc, 400);
    else if (q.status?.endsWith('xx')) { const base = Number(q.status[0]) * 100; statusCond = and(gte(sc, base), lt(sc, base + 100)); }
    else if (q.status) statusCond = eq(sc, Number(q.status));
    const where = and(eq(schema.apiRequestLogs.orgId, a.orgId), statusCond, q.apiKeyId ? eq(schema.apiRequestLogs.apiKeyId, q.apiKeyId) : undefined);
    const [{ n }] = await db().select({ n: count() }).from(schema.apiRequestLogs).where(where);
    const items = await db().select().from(schema.apiRequestLogs).where(where)
      .orderBy(desc(schema.apiRequestLogs.createdAt)).limit(q.pageSize).offset(offset(q));
    return { items, total: Number(n), page: q.page, pageSize: q.pageSize };
  });

  app.get('/usage', async (req) => {
    const a = requirePerm(req, 'developer.logs.read');
    const { days } = parse(z.object({ days: z.coerce.number().int().min(1).max(90).default(30) }), req.query);
    const since = new Date(Date.now() - days * 86400_000);
    const rows = await db().select({
      date: sql<string>`to_char(date_trunc('day', ${schema.apiRequestLogs.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`,
      requests: sql<number>`count(*)::int`,
      errors: sql<number>`count(*) filter (where ${schema.apiRequestLogs.statusCode} >= 400)::int`,
      latency: sql<number>`coalesce(sum(${schema.apiRequestLogs.latencyMs}), 0)::float8`,
    }).from(schema.apiRequestLogs)
      .where(and(eq(schema.apiRequestLogs.orgId, a.orgId), gte(schema.apiRequestLogs.createdAt, since)))
      .groupBy(sql`1`).orderBy(sql`1`);
    const byDayMap = new Map(rows.map((r) => [r.date, r]));
    const byDay: { date: string; requests: number; errors: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
      const r = byDayMap.get(date);
      byDay.push({ date, requests: Number(r?.requests ?? 0), errors: Number(r?.errors ?? 0) });
    }
    const requests = rows.reduce((s, r) => s + Number(r.requests), 0);
    const errors = rows.reduce((s, r) => s + Number(r.errors), 0);
    const latency = rows.reduce((s, r) => s + Number(r.latency), 0);
    // Actual per-key limits (enforced in lib/auth.ts). Key callers see their own limit; session callers
    // see the highest limit among the org's active keys (or the column default when there are none).
    const keys = (await db().select().from(schema.apiKeys)
      .where(and(eq(schema.apiKeys.orgId, a.orgId), isNull(schema.apiKeys.revokedAt))))
      .filter((k) => !k.expiresAt || k.expiresAt > new Date())
      .map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, rateLimitPerMin: k.rateLimitPerMin }));
    const rateLimitPerMin = a.apiKeyRateLimitPerMin
      ?? (keys.length ? Math.max(...keys.map((k) => k.rateLimitPerMin)) : DEFAULT_KEY_RATE_LIMIT_PER_MIN);
    return {
      byDay,
      totals: { requests, errors, errorRate: requests ? Math.round((errors / requests) * 10000) / 100 : null, avgLatencyMs: requests ? Math.round(latency / requests) : null },
      rateLimitPerMin,
      keyRateLimits: keys,
      /** Coarse per-credential/IP ceiling from @fastify/rate-limit (app.ts), applied in addition. */
      globalRateLimitPerMin: GLOBAL_RATE_LIMIT_PER_MIN,
    };
  });

  /* ───── Inbound agent callback (raw body needed for signature verification) ───── */
  await app.register(async (scope) => {
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));

    scope.post('/agent-callback/:agentId', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
      const { agentId } = parse(z.object({ agentId: z.string().uuid() }), req.params);
      const raw = typeof req.body === 'string' ? req.body : '';
      const sig = req.headers['x-aix-signature'];
      if (typeof sig !== 'string' || !sig) throw unauthorized('Missing x-aix-signature header');
      const [row] = await db().select({ agent: schema.agents, conn: schema.agentConnections }).from(schema.agents)
        .innerJoin(schema.agentConnections, eq(schema.agentConnections.agentId, schema.agents.id))
        .where(and(eq(schema.agents.id, agentId), isNull(schema.agents.deletedAt))).limit(1);
      if (!row || !row.conn.webhookSecretEnc) throw notFound('Agent');
      if (!verifyWebhook(decrypt(row.conn.webhookSecretEnc), raw, sig)) throw unauthorized('Invalid or expired signature');
      let body: unknown;
      try { body = JSON.parse(raw); } catch { throw badRequest('Body must be valid JSON'); }
      const evt = parse(z.discriminatedUnion('type', [
        z.object({ type: z.literal('heartbeat') }),
        z.object({ type: z.literal('error'), message: z.string().max(1000) }),
      ]), body);
      const now = new Date();
      if (evt.type === 'heartbeat') {
        await db().update(schema.agents).set({ health: 'healthy', lastHealthCheckAt: now }).where(eq(schema.agents.id, agentId));
        await db().update(schema.agentConnections).set({ status: 'connected', lastError: null, updatedAt: now }).where(eq(schema.agentConnections.id, row.conn.id));
      } else {
        await db().update(schema.agents).set({ health: 'degraded', lastHealthCheckAt: now }).where(eq(schema.agents.id, agentId));
        await db().update(schema.agentConnections).set({ lastError: `Reported by agent: ${evt.message}`, updatedAt: now }).where(eq(schema.agentConnections.id, row.conn.id));
      }
      await audit({ action: `agent.callback.${evt.type}`, actorType: 'agent', orgId: row.agent.orgId, targetType: 'agent', targetId: agentId }, req);
      return { ok: true, received: evt.type };
    });
  });
}

/** Register background job handlers for this module (called once at startup). */
export function registerJobs() {
  registerWebhookJobs();
}

