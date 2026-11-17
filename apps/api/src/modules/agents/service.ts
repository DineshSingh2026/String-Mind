import { randomBytes } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DOMAINS } from '@aix/shared';
import { db, schema } from '../../db/client.js';
import { createRuntime } from '../../adapters/factory.js';
import { getConnectionInfo } from '../../adapters/index.js';
import type { HealthWithSample } from '../../adapters/health.js';
import { AdapterError } from '../../adapters/types.js';
import { encrypt, last4, randomToken } from '../../lib/crypto.js';
import { PROMPT_METHOD, computeState, expireOpenTasks, freshClaim, patchConnConfig, promptConfig, promptConfigView, publishConnectionState } from '../../lib/agent-inbox.js';
import { AppError, unprocessable } from '../../lib/errors.js';
import { slugify } from '../../lib/http.js';
import { assertSafeUrlForSave } from '../../lib/net-guard.js';
import { notify } from '../../lib/notify.js';
import { emitEvent } from '../../lib/webhooks.js';
import { enqueue } from '../../jobs/queue.js';

export type Agent = typeof schema.agents.$inferSelect;
export type Provider = typeof schema.agentProviders.$inferSelect;
export type Connection = typeof schema.agentConnections.$inferSelect;

const DOMAIN_SLUGS = DOMAINS.map((d) => d.slug) as [string, ...string[]];

export const DEFAULT_PERMISSIONS = {
  publicProfile: false, allowTraining: false, allowLearning: true, shareKnowledge: false,
  allowOwnerIntervention: true, dataSharing: 'artefacts_only' as const, allowedDomains: [] as string[],
};

export const PermissionsSchema = z.object({
  publicProfile: z.boolean(),
  allowTraining: z.boolean(),
  allowLearning: z.boolean(),
  shareKnowledge: z.boolean(),
  allowOwnerIntervention: z.boolean(),
  dataSharing: z.enum(['none', 'artefacts_only', 'full_session']),
  allowedDomains: z.array(z.enum(DOMAIN_SLUGS)).max(DOMAIN_SLUGS.length),
}).strict();

const HttpUrl = z.string().trim().url('Enter a valid URL').max(2000)
  .refine((u) => /^https?:\/\//i.test(u), 'URL must start with http:// or https://');

export const ConnectionSchema = z.object({
  method: z.enum(['api', 'custom_rest', 'webhook', 'sdk', 'a2a', 'mcp', 'sandbox', 'prompt']),
  endpointUrl: HttpUrl.optional().nullable(),
  apiKey: z.string().trim().min(1).max(4000).optional().nullable(),
  config: z.record(z.unknown()).optional(),
});
export type ConnectionInput = z.infer<typeof ConnectionSchema>;

export const ProfileFields = {
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(4000),
  avatar: z.string().trim().max(500).nullable(),
  modelName: z.string().trim().min(1).max(120),
  modelVersion: z.string().trim().max(120).nullable(),
  instructions: z.string().max(20_000),
  role: z.string().max(2000),
  tools: z.array(z.object({ name: z.string().trim().min(1).max(100), description: z.string().max(1000).optional() })).max(100),
  languages: z.array(z.string().trim().min(2).max(10)).max(50),
  claimedDomains: z.array(z.enum(DOMAIN_SLUGS)).max(DOMAIN_SLUGS.length),
  inputFormats: z.array(z.string().trim().min(1).max(40)).max(20),
  outputFormats: z.array(z.string().trim().min(1).max(40)).max(20),
  knowledgeSourceIds: z.array(z.string().uuid()).max(100),
};

/** Allowed connection methods per adapter kind. */
const METHODS: Record<string, string[]> = {
  openai_compatible: ['api'], anthropic: ['api'], gemini: ['api'], sandbox: ['sandbox'],
  custom_rest: ['custom_rest'], webhook: ['webhook', 'sdk'], a2a: ['a2a'], mcp: ['mcp'], inbox: ['prompt'],
};
const NEEDS_ENDPOINT = new Set(['custom_rest', 'webhook', 'a2a', 'mcp']);
const KEY_OPTIONAL_PROVIDERS = new Set(['meta-llama']);
const NEEDS_KEY = new Set(['openai_compatible', 'anthropic', 'gemini']);
/** config keys we accept and store (never secrets) */
const CONFIG_KEYS = new Set(['timeoutMs', 'headersNote', 'region', 'organization', 'project', 'notes']);

export async function getProviderBySlug(slug: string) {
  const [p] = await db().select().from(schema.agentProviders).where(eq(schema.agentProviders.slug, slug)).limit(1);
  if (!p) throw unprocessable(`Unknown provider "${slug}"`);
  if (p.status === 'disabled') throw unprocessable(`Provider ${p.name} is currently disabled`);
  return p;
}

export async function getProviderById(id: string) {
  const [p] = await db().select().from(schema.agentProviders).where(eq(schema.agentProviders.id, id)).limit(1);
  return p!;
}

/**
 * Validates a connection payload for the provider and returns the column values to store.
 * `existing` lets callers keep the stored credential when rotating other fields.
 */
export async function prepareConnection(provider: Provider, input: ConnectionInput, existing?: Connection | null) {
  const allowed = METHODS[provider.adapter] ?? [];
  if (!allowed.includes(input.method)) {
    throw unprocessable(`Connection method "${input.method}" is not valid for ${provider.name}; use ${allowed.join(' or ')}`);
  }
  const endpointUrl = input.endpointUrl ?? (existing?.method === input.method ? existing.endpointUrl : null) ?? null;
  if (NEEDS_ENDPOINT.has(provider.adapter) && !endpointUrl) throw unprocessable(`${provider.name} requires an endpoint URL`);
  if (provider.adapter === 'sandbox' && (input.endpointUrl || input.apiKey)) throw unprocessable('Sandbox agents take no endpoint or API key');
  if (provider.adapter === 'inbox') {
    // Connect-via-prompt: nothing is shared — the agent claims a one-time code and polls StringMind for tasks.
    if (input.endpointUrl || input.apiKey) throw unprocessable('Connect-via-prompt agents take no endpoint or API key — the agent connects itself with a claim code');
    const claim = freshClaim();
    return {
      values: { method: 'prompt', endpointUrl: null, credentialEnc: null, credentialLast4: null, config: claim.config, webhookSecretEnc: null },
      webhookSecret: null, claim,
    };
  }
  // SSRF guard (private/loopback/metadata addresses, unless ALLOW_PRIVATE_NETWORK_URLS); re-checked per request.
  if (endpointUrl) await assertSafeUrlForSave(endpointUrl, 'Endpoint URL');

  let credentialEnc: string | null = null;
  let credentialLast4: string | null = null;
  if (input.apiKey) {
    credentialEnc = encrypt(input.apiKey);
    credentialLast4 = last4(input.apiKey);
  } else if (existing && existing.method === input.method && existing.credentialEnc) {
    credentialEnc = existing.credentialEnc;
    credentialLast4 = existing.credentialLast4;
  }
  if (NEEDS_KEY.has(provider.adapter) && !KEY_OPTIONAL_PROVIDERS.has(provider.slug) && !credentialEnc) {
    throw unprocessable(`${provider.name} requires an API key`);
  }

  const config: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input.config ?? {})) {
    if (!CONFIG_KEYS.has(k)) throw unprocessable(`Unsupported connection config key "${k}"`);
    config[k] = v;
  }

  // Webhook/SDK agents get a per-agent signing secret (returned once to the caller).
  let webhookSecret: string | null = null;
  let webhookSecretEnc: string | null = null;
  if (provider.adapter === 'webhook') {
    if (existing?.webhookSecretEnc && existing.method === input.method) webhookSecretEnc = existing.webhookSecretEnc;
    else {
      webhookSecret = `whsec_${randomToken(24)}`;
      webhookSecretEnc = encrypt(webhookSecret);
    }
  }
  return {
    values: { method: input.method, endpointUrl, credentialEnc, credentialLast4, config, webhookSecretEnc },
    webhookSecret, claim: null,
  };
}

export const newAgentSlug = (name: string) => `${slugify(name).slice(0, 40)}-${randomBytes(2).toString('hex')}`;

/** Public view of the connection — never includes credentialEnc / webhookSecretEnc. */
export function connectionView(c: Connection | null | undefined) {
  if (!c) return null;
  return {
    method: c.method, endpointUrl: c.endpointUrl, status: c.status, credentialLast4: c.credentialLast4,
    hasCredential: !!c.credentialEnc, hasWebhookSecret: !!c.webhookSecretEnc,
    // prompt connections keep hashed secrets in config — expose only the safe timestamps
    config: c.method === PROMPT_METHOD ? promptConfigView(promptConfig(c)) : c.config,
    lastTestedAt: c.lastTestedAt, lastError: c.lastError,
  };
}

export function agentView(a: Agent, p: Pick<Provider, 'slug' | 'name' | 'adapter'>, c: Connection | null | undefined, rep?: { score: number; level: string } | null) {
  return {
    ...a,
    provider: { slug: p.slug, name: p.name, adapter: p.adapter },
    connection: connectionView(c),
    overallScore: a.overallScore,
    reputation: rep ? { score: rep.score, level: rep.level } : null,
  };
}

export async function validateKnowledgeSources(orgId: string, ids: string[]) {
  if (!ids.length) return;
  const rows = await db().select({ id: schema.knowledgeSources.id }).from(schema.knowledgeSources)
    .where(and(eq(schema.knowledgeSources.orgId, orgId), inArray(schema.knowledgeSources.id, ids)));
  if (rows.length !== new Set(ids).size) throw unprocessable('One or more knowledge sources do not exist in your organisation');
}

/** Map adapter failures to HTTP errors for synchronous endpoints (playground). */
export function adapterHttpError(err: unknown): unknown {
  if (!(err instanceof AdapterError)) return err;
  const status = err.kind === 'rate_limit' ? 429 : err.kind === 'timeout' ? 504 : err.kind === 'config' || err.kind === 'unsupported' ? 422 : 502;
  return new AppError(status, `agent_${err.kind}`, err.message);
}

/* ───────────── Connection testing & health ───────────── */

/**
 * Runs a live health check against the agent and persists the outcome.
 * On first success: agent becomes active + `agent.connected` webhook event.
 * On failure (scheduled checks): owner is notified on transition to down + `agent.health_failed`.
 */
export async function runHealthCheck(agentId: string, opts: { source: 'manual' | 'scheduled' }): Promise<HealthWithSample> {
  const [agent] = await db().select().from(schema.agents).where(eq(schema.agents.id, agentId)).limit(1);
  if (!agent) throw new AdapterError('Agent not found', 'config');
  const [conn] = await db().select().from(schema.agentConnections).where(eq(schema.agentConnections.agentId, agentId)).limit(1);

  let result: HealthWithSample;
  try {
    const runtime = createRuntime(await getConnectionInfo(agentId));
    result = await runtime.health() as HealthWithSample;
  } catch (err) {
    result = { ok: false, latencyMs: 0, error: err instanceof Error ? err.message : String(err), kind: err instanceof AdapterError ? err.kind : undefined };
  }

  const now = new Date();
  const wasConnected = conn?.status === 'connected';
  if (conn) {
    await db().update(schema.agentConnections).set({
      status: result.ok ? 'connected' : 'error', lastError: result.ok ? null : (result.error ?? 'Health check failed').slice(0, 1000),
      lastTestedAt: now, updatedAt: now,
    }).where(eq(schema.agentConnections.id, conn.id));
  }
  const nextStatus = result.ok && (agent.status === 'draft' || agent.status === 'disconnected') ? 'active' : agent.status;
  await db().update(schema.agents).set({
    health: result.ok ? 'healthy' : 'down', lastHealthCheckAt: now, lastLatencyMs: result.latencyMs || null, status: nextStatus, updatedAt: now,
  }).where(eq(schema.agents.id, agentId));

  if (result.ok && !wasConnected) {
    await emitEvent(agent.orgId, 'agent.connected', { agentId, name: agent.name, latencyMs: result.latencyMs });
  }
  if (!result.ok && opts.source === 'scheduled' && agent.health !== 'down') {
    await notify(agent.ownerId, 'agent_connection_failure', `${agent.name} failed its health check`,
      `StringMind could not reach ${agent.name}: ${result.error ?? 'unknown error'}. Check the agent's connection settings.`, `/app/agents/${agentId}`);
    await emitEvent(agent.orgId, 'agent.health_failed', { agentId, name: agent.name, error: result.error ?? null, kind: result.kind ?? null });
  }
  if (result.ok) await ensureHealthCheckScheduled();
  return result;
}

export const HEALTH_INTERVAL_MS = 10 * 60_000;

/** Enqueue the next `agents.health_check` run unless one is already queued. */
export async function ensureHealthCheckScheduled() {
  const [q] = await db().select({ id: schema.jobs.id }).from(schema.jobs)
    .where(and(eq(schema.jobs.type, 'agents.health_check'), eq(schema.jobs.status, 'queued'))).limit(1);
  if (!q) await enqueue('agents.health_check', {}, { delayMs: HEALTH_INTERVAL_MS, maxAttempts: 1 });
}

/** Scheduled job body: checks every active, connected agent (bounded concurrency), then reschedules. */
export async function healthCheckAll() {
  try {
    const rows = await db().select({ id: schema.agents.id }).from(schema.agents)
      .innerJoin(schema.agentConnections, eq(schema.agentConnections.agentId, schema.agents.id))
      .where(and(eq(schema.agents.status, 'active'), isNull(schema.agents.deletedAt), sql`${schema.agentConnections.status} <> 'disconnected'`));
    const ids = rows.map((r) => r.id);
    const CONCURRENCY = 4;
    for (let i = 0; i < ids.length; i += CONCURRENCY) {
      await Promise.all(ids.slice(i, i + CONCURRENCY).map((id) => runHealthCheck(id, { source: 'scheduled' })
        .catch((e) => console.error(`[agents] health check ${id} crashed: ${e instanceof Error ? e.message : e}`))));
    }
  } finally {
    await ensureHealthCheckScheduled();
  }
}

/** Revoke a prompt connection's agent token + unclaimed code and expire its open tasks (disconnect / delete). No-op for other methods. */
export async function revokePromptConnection(agentId: string, orgId: string, opts: { publishState?: boolean } = {}) {
  const [conn] = await db().select().from(schema.agentConnections).where(eq(schema.agentConnections.agentId, agentId)).limit(1);
  if (!conn || conn.method !== PROMPT_METHOD) return;
  await patchConnConfig(conn.id, { agentTokenHash: null, claimCodeHash: null, verifyNonce: null });
  await expireOpenTasks(agentId);
  if (opts.publishState !== false) {
    const [fresh] = await db().select().from(schema.agentConnections).where(eq(schema.agentConnections.id, conn.id)).limit(1);
    await publishConnectionState(agentId, orgId, computeState(promptConfig(fresh)));
  }
}
