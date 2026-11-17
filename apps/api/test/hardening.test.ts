import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { app, createUserDirect, database, setup, teardown } from './helpers.js';
import { schema } from '../src/db/client.js';
import { config } from '../src/lib/config.js';
import { isPrivateAddress } from '../src/lib/net-guard.js';
import { httpRequest } from '../src/adapters/http.js';
import { AdapterError } from '../src/adapters/types.js';
import { resetApiKeyRateLimits } from '../src/lib/api-key-rate-limit.js';
import { adminAdjustment } from '../src/modules/wallet/ledger.js';

const originalAllow = config.ALLOW_PRIVATE_NETWORK_URLS;

beforeAll(async () => { await setup(); });
afterEach(() => { config.ALLOW_PRIVATE_NETWORK_URLS = originalAllow; });
afterAll(async () => { await teardown(); });

describe('SSRF guard', () => {
  it('classifies private / loopback / link-local / metadata addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
      '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it('defaults to allowing private URLs in test (local Ollama etc.)', () => {
    expect(config.ALLOW_PRIVATE_NETWORK_URLS).toBe(true);
  });

  it('rejects private agent endpoints and webhooks at save time when the flag is false; allows them when true', async () => {
    const u = await createUserDirect();
    const agentBody = (endpointUrl: string) => ({
      name: 'Local LLM', description: 'x', providerSlug: 'openai', modelName: 'gpt-4o-mini',
      connection: { method: 'api', endpointUrl, apiKey: 'sk-test-1234567890' },
    });

    config.ALLOW_PRIVATE_NETWORK_URLS = false;
    const blocked = await u.request('POST', '/agents', agentBody('http://127.0.0.1:11434/v1'));
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.message).toMatch(/private, loopback or link-local/);
    expect((await u.request('POST', '/agents', agentBody('http://169.254.169.254/latest'))).status).toBe(422);
    expect((await u.request('POST', '/agents', agentBody('http://[::ffff:127.0.0.1]:8080/'))).status).toBe(422);
    const hook = await u.request('POST', '/developer/webhooks', { url: 'http://10.0.0.5/hook', events: ['agent.connected'] });
    expect(hook.status).toBe(422);
    expect(hook.body.error.message).toMatch(/Webhook URL rejected/);

    config.ALLOW_PRIVATE_NETWORK_URLS = true;
    const ok = await u.request('POST', '/agents', agentBody('http://127.0.0.1:11434/v1'));
    expect(ok.status).toBe(201);
    const okHook = await u.request('POST', '/developer/webhooks', { url: 'http://10.0.0.5/hook', events: ['agent.connected'] });
    expect(okHook.status).toBe(201);

    // Updating an existing connection to a private URL is also rejected when the flag is false.
    config.ALLOW_PRIVATE_NETWORK_URLS = false;
    const upd = await u.request('POST', `/agents/${ok.body.id}/connection`, { method: 'api', endpointUrl: 'http://192.168.0.10/v1' });
    expect(upd.status).toBe(422);
    const patch = await u.request('PATCH', `/developer/webhooks/${okHook.body.id}`, { url: 'http://localhost:9999/hook' });
    expect(patch.status).toBe(422);
  });

  it('re-checks at request time in the shared HTTP helper (DNS rebinding defence)', async () => {
    config.ALLOW_PRIVATE_NETWORK_URLS = false;
    const err = await httpRequest('http://127.0.0.1:9/chat', { provider: 'Test' }).catch((e) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).kind).toBe('config');
    expect((err as AdapterError).message).toMatch(/Refusing to call Test/);
    const scheme = await httpRequest('file:///etc/passwd', { provider: 'Test' }).catch((e) => e);
    expect((scheme as AdapterError).message).toMatch(/Only http/);
  });
});

describe('per-API-key rate limit', () => {
  it('returns 429 with retry-after once the key exceeds rateLimitPerMin, and /developer/usage reports it', async () => {
    resetApiKeyRateLimits();
    const u = await createUserDirect();
    const k = await u.request('POST', '/developer/keys', { name: 'limited', scopes: ['agents.read', 'developer.logs.read'] });
    expect(k.status).toBe(201);
    await database.update(schema.apiKeys).set({ rateLimitPerMin: 3 }).where(eq(schema.apiKeys.id, k.body.id));
    const headers = { authorization: `Bearer ${k.body.key}` };

    const usage = await app.inject({ method: 'GET', url: '/developer/usage', headers });
    expect(usage.statusCode).toBe(200);
    expect(usage.json().rateLimitPerMin).toBe(3);
    expect(usage.headers['x-ratelimit-limit']).toBe('3');
    for (let i = 0; i < 2; i++) expect((await app.inject({ method: 'GET', url: '/agents', headers })).statusCode).toBe(200);
    const limited = await app.inject({ method: 'GET', url: '/agents', headers });
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.json()).toMatchObject({ error: { code: 'rate_limited' } });
    expect(limited.json().error.message).toMatch(/3 requests\/min/);

    // Session traffic is unaffected and sees the org's key limits.
    const s = await u.request('GET', '/developer/usage');
    expect(s.status).toBe(200);
    expect(s.body.keyRateLimits).toEqual([expect.objectContaining({ id: k.body.id, rateLimitPerMin: 3 })]);
    resetApiKeyRateLimits();
  });
});

describe('agent usageLimits.maxCreditsPerDay', () => {
  it('rejects a training request that would exceed the learner agent daily credit cap', async () => {
    const [domain] = await database.select().from(schema.capabilityDomains).limit(1);
    const [p] = await database.select().from(schema.agentProviders).where(eq(schema.agentProviders.slug, 'sandbox'));
    const trainerOwner = await createUserDirect();
    const learnerOwner = await createUserDirect();
    const mk = async (orgId: string, ownerId: string, name: string, permissions: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
      const [a] = await database.insert(schema.agents).values({
        orgId, ownerId, providerId: p!.id, slug: `${name.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}`, name, modelName: 'aix-sandbox-1',
        status: 'active', permissions, ...extra,
      }).returning();
      await database.insert(schema.agentConnections).values({ agentId: a!.id, method: 'sandbox', status: 'connected' });
      return a!;
    };
    const trainer = await mk(trainerOwner.orgId, trainerOwner.userId, 'Coach', { allowTraining: true, publicProfile: true }, { isPublic: true });
    const learner = await mk(learnerOwner.orgId, learnerOwner.userId, 'Student', { allowLearning: true }, { usageLimits: { maxCreditsPerDay: 150 } });
    const [listing] = await database.insert(schema.marketplaceListings).values({
      agentId: trainer.id, orgId: trainerOwner.orgId, title: 'Coaching', domainId: domain!.id, priceCredits: 100,
    }).returning();
    await adminAdjustment({ orgId: learnerOwner.orgId, amount: 1000, reason: 'test credits', actorUserId: learnerOwner.userId });
    const body = { learnerAgentId: learner.id, trainerAgentId: trainer.id, domainSlug: domain!.slug, objectives: [], listingId: listing!.id };

    const first = await learnerOwner.request('POST', '/training/requests', body);
    expect(first.status).toBe(201);
    const second = await learnerOwner.request('POST', '/training/requests', body);
    expect(second.status).toBe(422);
    expect(second.body.error.message).toMatch(/Daily credit limit/);

    // Raising the cap allows it again.
    await database.update(schema.agents).set({ usageLimits: { maxCreditsPerDay: 200 } }).where(eq(schema.agents.id, learner.id));
    expect((await learnerOwner.request('POST', '/training/requests', body)).status).toBe(201);
  });
});
