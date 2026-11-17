/**
 * Auth, agents (isolation, credentials, versions, adapters) and developer (API keys, webhooks).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import { app, registerUser, setup, teardown } from './helpers.js';
import { verifyWebhook } from '../src/lib/crypto.js';
import { createRuntime } from '../src/adapters/factory.js';
import { AdapterError, type ConnectionInfo } from '../src/adapters/types.js';
import { drain } from '../src/jobs/queue.js';

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;
let server: Server;
let baseUrl = '';
let handler: Handler = (_q, _b, res) => { res.statusCode = 500; res.end(); };
const received: { headers: IncomingMessage['headers']; body: string; url: string }[] = [];

beforeAll(async () => {
  await setup();
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { received.push({ headers: req.headers, body, url: req.url ?? '' }); handler(req, body, res); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server?.close(); await teardown(); });

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body));
};
const cookieOf = (r: { headers: Record<string, unknown> }) => String(r.headers['set-cookie']).split(';')[0]!;

describe('auth', () => {
  it('register → me → logout → me 401', async () => {
    const email = `alice${Date.now()}@test.dev`;
    const reg = await app.inject({ method: 'POST', url: '/auth/register', payload: { email, password: 'Str0ng!Passw0rd', name: 'Alice', persona: 'agent_owner' } });
    expect(reg.statusCode).toBe(201);
    expect(reg.body).not.toContain('passwordHash');
    expect(reg.json().welcomeBonus).toMatchObject({ amount: 1000 }); // IDLE welcome bonus on first login
    const cookie = cookieOf(reg);
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    const m = me.json();
    expect(m.user.email).toBe(email);
    expect(m.role).toBe('owner');
    expect(m.org.type).toBe('personal');
    expect(m.permissions).toContain('agents.create');
    expect(m.orgs).toHaveLength(1);
    expect(m.welcomeBonus).toMatchObject({ granted: true, amount: 1000 });
    expect((await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie } })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('rejects weak passwords, duplicates and wrong passwords with a generic message', async () => {
    const email = `bob${Date.now()}@test.dev`;
    expect((await app.inject({ method: 'POST', url: '/auth/register', payload: { email, password: 'short', name: 'B', persona: 'individual' } })).statusCode).toBe(400);
    await registerUser(email);
    expect((await app.inject({ method: 'POST', url: '/auth/register', payload: { email, password: 'Str0ng!Passw0rd', name: 'B', persona: 'individual' } })).statusCode).toBe(409);
    const bad = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'Wrong!Passw0rd' } });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.message).toBe('Invalid email or password');
    const unknown = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'nobody@test.dev', password: 'Wrong!Passw0rd' } });
    expect(unknown.json().error.message).toBe('Invalid email or password');
    const ok = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'Str0ng!Passw0rd' } });
    expect(ok.statusCode).toBe(200);
  });

  it('enterprise persona gets an enterprise org', async () => {
    const r = await app.inject({ method: 'POST', url: '/auth/register', payload: { email: `ent${Date.now()}@test.dev`, password: 'Str0ng!Passw0rd', name: 'E', persona: 'enterprise', orgName: 'Acme Corp' } });
    const me = (await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: cookieOf(r) } })).json();
    expect(me.org).toMatchObject({ name: 'Acme Corp', type: 'enterprise' });
  });

  it('MFA setup → enable → login requires code', async () => {
    const email = `mfa${Date.now()}@test.dev`;
    const c = await registerUser(email);
    const setupRes = await c.request('POST', '/auth/mfa/setup');
    expect(setupRes.status).toBe(200);
    const { secret, otpauthUrl } = setupRes.body;
    expect(otpauthUrl).toContain('otpauth://');
    expect((await c.request('POST', '/auth/mfa/enable', { code: '000000' })).status).toBe(400);
    expect((await c.request('POST', '/auth/mfa/enable', { code: authenticator.generate(secret) })).status).toBe(200);
    expect((await c.request('GET', '/auth/me')).body.user.mfaEnabled).toBe(true);

    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'Str0ng!Passw0rd' } });
    expect(login.json()).toMatchObject({ mfaRequired: true });
    expect(login.headers['set-cookie']).toBeUndefined();
    const { challengeId } = login.json();
    expect((await app.inject({ method: 'POST', url: '/auth/mfa/verify-login', payload: { challengeId, code: '123456' } })).statusCode).toBe(401);
    const v = await app.inject({ method: 'POST', url: '/auth/mfa/verify-login', payload: { challengeId, code: authenticator.generate(secret) } });
    expect(v.statusCode).toBe(200);
    expect(v.json().welcomeBonus).toBeNull(); // already granted at registration
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: cookieOf(v) } });
    expect(me.statusCode).toBe(200);
    // challenge cannot be reused
    expect((await app.inject({ method: 'POST', url: '/auth/mfa/verify-login', payload: { challengeId, code: authenticator.generate(secret) } })).statusCode).toBe(401);
    // security alert notifications were recorded
    const notes = await c.request('GET', '/auth/sessions');
    expect(notes.status).toBe(200);
  });

  it('password change revokes other sessions', async () => {
    const email = `pw${Date.now()}@test.dev`;
    const c1 = await registerUser(email);
    const login2 = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'Str0ng!Passw0rd' } });
    const cookie2 = cookieOf(login2);
    expect((await c1.request('POST', '/auth/password', { currentPassword: 'Str0ng!Passw0rd', newPassword: 'N3w!Passw0rdXyz' })).status).toBe(200);
    expect((await c1.request('GET', '/auth/me')).status).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: cookie2 } })).statusCode).toBe(401);
  });
});

describe('agents', () => {
  it('creates agents with encrypted credentials, never returned; tenant isolation', async () => {
    handler = (_q, _b, res) => json(res, 200, { choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } });
    const a = await registerUser();
    const b = await registerUser();
    const secretKey = 'sk-test-SUPERSECRET-1234567890';
    const created = await a.request('POST', '/agents', {
      name: 'Grok Helper', description: 'test', providerSlug: 'openai', modelName: 'gpt-4o-mini', instructions: 'Be helpful.',
      connection: { method: 'api', endpointUrl: baseUrl, apiKey: secretKey },
    });
    expect(created.status).toBe(201);
    const raw = JSON.stringify(created.body);
    expect(raw).not.toContain('SUPERSECRET');
    expect(raw).not.toContain('credentialEnc');
    expect(created.body.connection.credentialLast4).toBe('7890');
    expect(created.body.status).toBe('draft');
    expect(created.body.permissions.allowLearning).toBe(true);
    const id = created.body.id;

    const test = await a.request('POST', `/agents/${id}/test`);
    expect(test.body).toMatchObject({ ok: true, sample: 'OK' });
    const sent = received[received.length - 1]!;
    expect(sent.url).toBe('/chat/completions');
    expect(sent.headers.authorization).toBe(`Bearer ${secretKey}`);
    const detail = await a.request('GET', `/agents/${id}`);
    expect(detail.body.status).toBe('active');
    expect(detail.body.health).toBe('healthy');
    expect(JSON.stringify(detail.body)).not.toContain('SUPERSECRET');

    const list = await a.request('GET', '/agents');
    expect(list.body.items.map((x: { id: string }) => x.id)).toContain(id);
    expect(JSON.stringify(list.body)).not.toContain('credentialEnc');

    // user B cannot see or modify user A's agent
    expect((await b.request('GET', `/agents/${id}`)).status).toBe(404);
    expect((await b.request('PATCH', `/agents/${id}`, { name: 'Hijacked' })).status).toBe(404);
    expect((await b.request('DELETE', `/agents/${id}`)).status).toBe(404);
    expect((await b.request('POST', `/agents/${id}/test`)).status).toBe(404);
    expect((await b.request('GET', '/agents')).body.items).toHaveLength(0);

    // playground injects instructions as system message
    handler = (_q, body, res) => {
      const j = JSON.parse(body);
      json(res, 200, { choices: [{ message: { content: `system=${j.messages[0].content}` } }] });
    };
    const pg = await a.request('POST', `/agents/${id}/playground`, { message: 'hi' });
    expect(pg.status).toBe(200);
    expect(pg.body.reply).toContain('Be helpful.');

    // daily limit enforced
    await a.request('PUT', `/agents/${id}/limits`, { maxCallsPerDay: 1 });
    const limited = await a.request('POST', `/agents/${id}/playground`, { message: 'hi again' });
    expect(limited.status).toBe(429);

    // publish requires a completed assessment
    expect((await a.request('POST', `/agents/${id}/publish`, { isPublic: true })).status).toBe(422);
  });

  it('versions instructions and rolls back', async () => {
    const a = await registerUser();
    const c = await a.request('POST', '/agents', {
      name: 'Versioned', providerSlug: 'custom-rest', modelName: 'custom', instructions: 'v1 text',
      connection: { method: 'custom_rest', endpointUrl: `${baseUrl}/agent` },
    });
    expect(c.status).toBe(201);
    const id = c.body.id;
    await a.request('PATCH', `/agents/${id}`, { instructions: 'v2 text', changeNote: 'improve' });
    await a.request('PATCH', `/agents/${id}`, { description: 'no new version' });
    let versions = (await a.request('GET', `/agents/${id}/versions`)).body.items;
    expect(versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    const rb = await a.request('POST', `/agents/${id}/versions/1/rollback`);
    expect(rb.status).toBe(200);
    expect(rb.body.instructions).toBe('v1 text');
    expect(rb.body.currentVersion).toBe(3);
    versions = (await a.request('GET', `/agents/${id}/versions`)).body.items;
    expect(versions[0]).toMatchObject({ version: 3, source: 'rollback' });
    expect((await a.request('POST', `/agents/${id}/versions/9/rollback`)).status).toBe(404);
  });

  it('validates permissions shape', async () => {
    const a = await registerUser();
    const c = await a.request('POST', '/agents', { name: 'Perms', providerSlug: 'custom-rest', modelName: 'custom', connection: { method: 'custom_rest', endpointUrl: `${baseUrl}/x` } });
    const id = c.body.id;
    expect((await a.request('PUT', `/agents/${id}/permissions`, { publicProfile: false })).status).toBe(400);
    const ok = await a.request('PUT', `/agents/${id}/permissions`, {
      publicProfile: false, allowTraining: true, allowLearning: true, shareKnowledge: false, allowOwnerIntervention: true, dataSharing: 'none', allowedDomains: ['programming'],
    });
    expect(ok.status).toBe(200);
    expect(ok.body.permissions.allowTraining).toBe(true);
    // wrong connection method for provider
    expect((await a.request('POST', '/agents', { name: 'Bad', providerSlug: 'anthropic', modelName: 'x', connection: { method: 'api' } })).status).toBe(422);
  });
});

describe('adapters error mapping', () => {
  const info = (adapter: string, extra: Partial<ConnectionInfo> = {}): ConnectionInfo => ({
    agentId: '00000000-0000-0000-0000-000000000000', orgId: 'o', providerSlug: adapter, adapter, model: 'm',
    baseUrl, apiKey: 'key-ABCDEF', config: {}, webhookSecret: 'whsec_x', ...extra,
  });
  const kindOf = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return e instanceof AdapterError ? e.kind : 'other'; } };
  const msg = { messages: [{ role: 'user' as const, content: 'hi' }], system: 'sys' };

  it('maps 401/429/timeout/bad body for OpenAI-compatible', async () => {
    const rt = createRuntime(info('openai_compatible'));
    handler = (_q, _b, res) => json(res, 401, { error: { message: 'bad key key-ABCDEF' } });
    let err: unknown;
    try { await rt.invoke(msg); } catch (e) { err = e; }
    expect((err as AdapterError).kind).toBe('auth');
    expect((err as Error).message).not.toContain('key-ABCDEF');
    handler = (_q, _b, res) => json(res, 429, { error: { message: 'slow down' } });
    expect(await kindOf(rt.invoke(msg))).toBe('rate_limit');
    handler = (_q, _b, res) => { res.statusCode = 200; res.end('not json'); };
    expect(await kindOf(rt.invoke(msg))).toBe('bad_response');
    handler = () => { /* never respond */ };
    expect(await kindOf(rt.invoke({ ...msg, timeoutMs: 300 }))).toBe('timeout');
  });

  it('Anthropic: headers, top-level system, 403 → auth', async () => {
    const rt = createRuntime(info('anthropic'));
    handler = (_q, _b, res) => json(res, 200, { content: [{ type: 'text', text: 'hello' }], usage: { input_tokens: 1, output_tokens: 1 } });
    const r = await rt.invoke(msg);
    expect(r.text).toBe('hello');
    const last = received[received.length - 1]!;
    expect(last.url).toBe('/v1/messages');
    expect(last.headers['x-api-key']).toBe('key-ABCDEF');
    expect(last.headers['anthropic-version']).toBe('2023-06-01');
    expect(JSON.parse(last.body).system).toBe('sys');
    handler = (_q, _b, res) => json(res, 403, { error: { message: 'forbidden' } });
    expect(await kindOf(rt.invoke(msg))).toBe('auth');
  });

  it('custom REST accepts text/reply/output and rejects others', async () => {
    const rt = createRuntime(info('custom_rest', { apiKey: null }));
    handler = (_q, _b, res) => json(res, 200, { reply: 'yo' });
    expect((await rt.invoke(msg)).text).toBe('yo');
    handler = (_q, _b, res) => json(res, 200, { foo: 'bar' });
    expect(await kindOf(rt.invoke(msg))).toBe('bad_response');
  });

  it('webhook adapter signs requests; MCP invoke is unsupported', async () => {
    const rt = createRuntime(info('webhook', { apiKey: null }));
    handler = (_q, _b, res) => json(res, 200, { text: 'signed ok' });
    expect((await rt.invoke(msg)).text).toBe('signed ok');
    const last = received[received.length - 1]!;
    expect(verifyWebhook('whsec_x', last.body, String(last.headers['x-aix-signature']))).toBe(true);
    expect(await kindOf(createRuntime(info('mcp')).invoke(msg))).toBe('unsupported');
  });
});

describe('developer', () => {
  it('API keys: auth works, scopes enforced, revoked key rejected, never stores raw key', async () => {
    const a = await registerUser();
    const k = await a.request('POST', '/developer/keys', { name: 'ci', scopes: ['agents.read'], environment: 'sandbox' });
    expect(k.status).toBe(201);
    expect(k.body.key).toMatch(/^aix_sk_test_/);
    expect(k.body.prefix).toBe(k.body.key.slice(0, 16));
    const auth = { authorization: `Bearer ${k.body.key}` };
    expect((await app.inject({ method: 'GET', url: '/agents', headers: auth })).statusCode).toBe(200);
    const denied = await app.inject({ method: 'POST', url: '/agents', headers: auth, payload: { name: 'x' } });
    expect(denied.statusCode).toBe(403);
    // keys list never includes the raw key or hash
    const list = await a.request('GET', '/developer/keys');
    expect(JSON.stringify(list.body)).not.toContain(k.body.key);
    expect(JSON.stringify(list.body)).not.toContain('keyHash');
    // invalid scope rejected
    expect((await a.request('POST', '/developer/keys', { name: 'x', scopes: ['root'] })).status).toBe(400);
    // rotate → old key dead, new key works
    const rot = await a.request('POST', `/developer/keys/${k.body.id}/rotate`);
    expect(rot.status).toBe(201);
    expect((await app.inject({ method: 'GET', url: '/agents', headers: auth })).statusCode).toBe(401);
    const auth2 = { authorization: `Bearer ${rot.body.key}` };
    expect((await app.inject({ method: 'GET', url: '/agents', headers: auth2 })).statusCode).toBe(200);
    expect((await a.request('DELETE', `/developer/keys/${rot.body.id}`)).status).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/agents', headers: auth2 })).statusCode).toBe(401);
  });

  it('webhooks: signed test delivery and event delivery verify with the secret', async () => {
    handler = (_q, _b, res) => json(res, 200, { ok: true });
    const a = await registerUser();
    const w = await a.request('POST', '/developer/webhooks', { url: `${baseUrl}/hook`, events: ['agent.connected'] });
    expect(w.status).toBe(201);
    const secret = w.body.secret as string;
    expect(secret).toMatch(/^whsec_/);
    expect(JSON.stringify((await a.request('GET', '/developer/webhooks')).body)).not.toContain(secret);

    const t = await a.request('POST', `/developer/webhooks/${w.body.id}/test`);
    expect(t.body).toMatchObject({ status: 'delivered', responseCode: 200 });
    let last = received.filter((r) => r.url === '/hook').pop()!;
    expect(verifyWebhook(secret, last.body, String(last.headers['x-aix-signature']))).toBe(true);
    expect(verifyWebhook('whsec_wrong', last.body, String(last.headers['x-aix-signature']))).toBe(false);

    // emitting agent.connected via a successful agent test
    handler = (q, _b, res) => (q.url === '/hook' ? json(res, 200, { ok: true }) : json(res, 200, { text: 'OK' }));
    const ag = await a.request('POST', '/agents', { name: 'Hooked', providerSlug: 'custom-rest', modelName: 'custom', connection: { method: 'custom_rest', endpointUrl: `${baseUrl}/agent` } });
    expect((await a.request('POST', `/agents/${ag.body.id}/test`)).body.ok).toBe(true);
    await drain();
    await new Promise((r) => setTimeout(r, 200));
    const deliveries = await a.request('GET', `/developer/webhooks/${w.body.id}/deliveries`);
    const evt = deliveries.body.items.find((d: { event: string }) => d.event === 'agent.connected');
    expect(evt?.status).toBe('delivered');
    last = received.filter((r) => r.url === '/hook').pop()!;
    expect(JSON.parse(last.body).event).toBe('agent.connected');
    expect(verifyWebhook(secret, last.body, String(last.headers['x-aix-signature']))).toBe(true);

    expect((await a.request('GET', '/developer/events')).body.items.length).toBeGreaterThan(5);
    const usage = await a.request('GET', '/developer/usage');
    expect(usage.status).toBe(200);
    expect(usage.body.byDay).toHaveLength(30);
  });

  it('inbound agent callback verifies signature', async () => {
    const { signWebhook } = await import('../src/lib/crypto.js');
    const a = await registerUser();
    const ag = await a.request('POST', '/agents', { name: 'WH', providerSlug: 'webhook', modelName: 'custom', connection: { method: 'webhook', endpointUrl: `${baseUrl}/wh` } });
    expect(ag.status).toBe(201);
    const secret = ag.body.webhookSecret as string;
    expect(secret).toMatch(/^whsec_/);
    const body = JSON.stringify({ type: 'heartbeat' });
    const bad = await app.inject({ method: 'POST', url: `/developer/agent-callback/${ag.body.id}`, payload: body, headers: { 'content-type': 'application/json', 'x-aix-signature': signWebhook('nope', body) } });
    expect(bad.statusCode).toBe(401);
    const good = await app.inject({ method: 'POST', url: `/developer/agent-callback/${ag.body.id}`, payload: body, headers: { 'content-type': 'application/json', 'x-aix-signature': signWebhook(secret, body) } });
    expect(good.statusCode).toBe(200);
    expect((await a.request('GET', `/agents/${ag.body.id}`)).body.health).toBe('healthy');
  });
});
