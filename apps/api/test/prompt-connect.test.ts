// These tests count inbox tasks exactly; the on-connect memory sync is covered in experience.test.ts.
process.env.MEMORY_SYNC_ON_CONNECT = 'false';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { app, createUserDirect, database, setup, teardown } from './helpers.js';
import { schema } from '../src/db/client.js';
import { invokeAgent } from '../src/adapters/index.js';
import { AdapterError } from '../src/adapters/types.js';
import { sweepOfflinePromptAgents } from '../src/modules/agent-api/routes.js';

beforeAll(async () => { await setup(); });
afterAll(async () => { await teardown(); });

type Owner = Awaited<ReturnType<typeof createUserDirect>>;

const agentReq = async (token: string | null, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await app.inject({ method: method as never, url, payload: body as never, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
  let parsed: any = null;
  try { parsed = r.body ? JSON.parse(r.body) : null; } catch { parsed = r.body; }
  return { status: r.statusCode, body: parsed };
};

async function createPromptAgent(owner: Owner, name = 'Prompt Bot') {
  const r = await owner.request('POST', '/agents', { name, providerSlug: 'prompt-connect', connection: { method: 'prompt' } });
  expect(r.status).toBe(201);
  return r.body;
}

const status = async (owner: Owner, id: string) => (await owner.request('GET', `/agents/${id}/connection-status`)).body;

async function claim(code: string, agent?: Record<string, string>) {
  return agentReq(null, 'POST', '/agent-api/claim', { claimCode: code, ...(agent ? { agent } : {}) });
}

/** Claim + poll + answer the verify task correctly → connected. Returns token. */
async function connectFully(code: string) {
  const c = await claim(code);
  expect(c.status).toBe(200);
  const next = await agentReq(c.body.agentToken, 'GET', '/agent-api/tasks/next?wait=1');
  expect(next.status).toBe(200);
  const m = /STRINGMIND-OK-[A-F0-9]+/.exec(next.body.task.messages[0].content)!;
  const res = await agentReq(c.body.agentToken, 'POST', `/agent-api/tasks/${next.body.task.id}/result`, { text: m[0] });
  expect(res.body.verified).toBe(true);
  return c.body.agentToken as string;
}

describe('connect via prompt', () => {
  let owner: Owner;
  let agent: any;
  let token: string;

  beforeAll(async () => { owner = await createUserDirect(); });

  it('provider is seeded and active', async () => {
    const r = await app.inject({ method: 'GET', url: '/agents/providers' });
    const p = JSON.parse(r.body).find((x: any) => x.slug === 'prompt-connect');
    expect(p).toMatchObject({ adapter: 'inbox', status: 'active', defaultModels: ['self-hosted'] });
  });

  it('create prompt agent → connect prompt + awaiting_claim; secrets never exposed', async () => {
    agent = await createPromptAgent(owner);
    expect(agent.modelName).toBe('self-hosted');
    expect(agent.status).toBe('draft');
    expect(agent.connect.claimCode).toMatch(/^SM-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    expect(agent.connect.connectUrl).toBe('http://localhost:3700/connect.md');
    expect(agent.connect.prompt).toContain('Read http://localhost:3700/connect.md and follow the instructions exactly.');
    expect(agent.connect.prompt).toContain(`Your one-time claim code is: ${agent.connect.claimCode} (valid for 24 hours, until `);
    expect(agent.connect.prompt).toMatch(/until \d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2} UTC\)/);
    expect(JSON.stringify(agent.connection)).not.toMatch(/Hash|Nonce/);
    const detail = await owner.request('GET', `/agents/${agent.id}`);
    expect(detail.body.connect).toBeUndefined();
    expect(JSON.stringify(detail.body)).not.toMatch(/claimCodeHash|agentTokenHash/);
    const s = await status(owner, agent.id);
    expect(s.method).toBe('prompt');
    expect(s.state).toBe('awaiting_claim');
    expect(s.steps.map((x: any) => x.key)).toEqual(['prompt', 'claimed', 'polling', 'verified']);
    expect(s.steps[0].done).toBe(true);
    expect(s.steps[1].done).toBe(false);
  });

  it('rejects malformed (400), unknown (404) and expired (410) codes', async () => {
    expect((await claim('hello')).status).toBe(400);
    expect((await claim('SM-AAAA-AAAA')).status).toBe(404);
    const other = await createPromptAgent(owner, 'Expiring Bot');
    const [conn] = await database.select().from(schema.agentConnections).where(eq(schema.agentConnections.agentId, other.id));
    await database.update(schema.agentConnections)
      .set({ config: { ...conn!.config, claimExpiresAt: new Date(Date.now() - 1000).toISOString() } })
      .where(eq(schema.agentConnections.id, conn!.id));
    const r = await claim(other.connect.claimCode);
    expect(r.status).toBe(410);
    expect(r.body.error.message).toMatch(/expired/);
    expect((await status(owner, other.id)).state).toBe('expired');
  });

  it('claim → token; code is single-use; lowercase/no-dash input accepted', async () => {
    const loose = agent.connect.claimCode.toLowerCase().replace(/-/g, '');
    const c = await claim(loose, { name: 'My Agent', model: 'llama-3-70b', framework: 'langchain\u0000', description: '<b>hi</b>' });
    expect(c.status).toBe(200);
    expect(c.body.agentToken).toMatch(/^sm_at_/);
    expect(c.body.agentId).toBe(agent.id);
    expect(c.body.pollSeconds).toBe(25);
    expect(c.body.endpoints.next).toBe('http://localhost:3700/api/agent-api/tasks/next?wait=25');
    token = c.body.agentToken;
    const again = await claim(agent.connect.claimCode);
    expect(again.status).toBe(410);
    expect(again.body.error.message).toMatch(/already been used/);
    const s = await status(owner, agent.id);
    expect(s.state).toBe('claimed');
    expect(s.agentReported).toMatchObject({ name: 'My Agent', model: 'llama-3-70b', framework: 'langchain' });
    const [conn] = await database.select().from(schema.agentConnections).where(eq(schema.agentConnections.agentId, agent.id));
    expect(JSON.stringify(conn!.config)).not.toContain(token);
  });

  it('auth separation: agent token only on agent-api; sessions/API keys rejected there', async () => {
    expect((await agentReq(token, 'GET', '/agent-api/me')).status).toBe(200);
    expect((await agentReq(null, 'GET', '/agent-api/me')).status).toBe(401);
    expect((await agentReq('sm_at_bogus', 'GET', '/agent-api/me')).status).toBe(401);
    expect((await agentReq(null, 'GET', '/agent-api/me', undefined, { cookie: owner.cookie })).status).toBe(401);
    const k = await owner.request('POST', '/developer/keys', { name: 'ci', scopes: ['*'], environment: 'sandbox' });
    expect(k.status).toBe(201);
    expect((await agentReq(k.body.key, 'GET', '/agent-api/me')).status).toBe(401);
    expect((await agentReq(token, 'GET', '/agents')).status).toBe(401);
    expect((await agentReq(token, 'GET', `/agents/${agent.id}/connection-status`)).status).toBe(401);
  });

  it('long-poll returns the verify task; wrong answer → still verifying + new task', async () => {
    const next = await agentReq(token, 'GET', '/agent-api/tasks/next?wait=2');
    expect(next.status).toBe(200);
    expect(next.body.task.kind).toBe('verify');
    expect(next.body.task.messages[0].content).toMatch(/^Reply with exactly this text and nothing else: STRINGMIND-OK-[A-F0-9]+$/);
    expect((await status(owner, agent.id)).state).toBe('verifying');

    const empty = await agentReq(token, 'GET', '/agent-api/tasks/next?wait=0');
    expect(empty.status).toBe(204);

    const wrong = await agentReq(token, 'POST', `/agent-api/tasks/${next.body.task.id}/result`, { text: 'OK' });
    expect(wrong.status).toBe(200);
    expect(wrong.body).toMatchObject({ ok: true, verified: false });
    expect((await agentReq(token, 'POST', `/agent-api/tasks/${next.body.task.id}/result`, { text: 'again' })).status).toBe(409);
    expect((await agentReq(token, 'POST', '/agent-api/tasks/00000000-0000-0000-0000-000000000000/result', { text: 'x' })).status).toBe(404);
    expect((await agentReq(token, 'POST', `/agent-api/tasks/${next.body.task.id}/result`, { text: 'x'.repeat(20_001) })).status).toBe(400);
    const s = await status(owner, agent.id);
    expect(s.state).toBe('verifying');
    const hb = await agentReq(token, 'POST', '/agent-api/heartbeat');
    expect(hb.body).toEqual({ ok: true, pendingTasks: 1 });
  });

  it('right answer → connected, agent active/healthy, owner notified', async () => {
    const next = await agentReq(token, 'GET', '/agent-api/tasks/next?wait=2');
    expect(next.body.task.kind).toBe('verify');
    const code = /STRINGMIND-OK-[A-F0-9]+/.exec(next.body.task.messages[0].content)![0];
    const ok = await agentReq(token, 'POST', `/agent-api/tasks/${next.body.task.id}/result`, { text: `${code}\n` });
    expect(ok.body).toMatchObject({ ok: true, verified: true });
    const s = await status(owner, agent.id);
    expect(s.state).toBe('connected');
    expect(s.steps.every((x: any) => x.done)).toBe(true);
    const d = await owner.request('GET', `/agents/${agent.id}`);
    expect(d.body).toMatchObject({ status: 'active', health: 'healthy', modelName: 'llama-3-70b' });
    expect(d.body.connection.status).toBe('connected');
    const notes = await database.select().from(schema.notifications).where(eq(schema.notifications.userId, owner.userId));
    expect(notes.some((n) => n.title === 'Prompt Bot connected via prompt')).toBe(true);
    const me = await agentReq(token, 'GET', '/agent-api/me');
    expect(me.body.connection.state).toBe('connected');
  });

  it('invokeAgent round-trips through the inbox adapter (agent answers concurrently)', async () => {
    const pending = invokeAgent(agent.id, { messages: [{ role: 'user', content: 'What is 2+2?' }], purpose: 'playground' });
    const next = await agentReq(token, 'GET', '/agent-api/tasks/next?wait=5');
    expect(next.status).toBe(200);
    expect(next.body.task).toMatchObject({ kind: 'playground', messages: [{ role: 'user', content: 'What is 2+2?' }] });
    expect((await agentReq(token, 'POST', `/agent-api/tasks/${next.body.task.id}/result`, { text: '4' })).status).toBe(200);
    const r = await pending;
    expect(r.text).toBe('4');
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);

    // playground endpoint uses the same path
    const pg = owner.request('POST', `/agents/${agent.id}/playground`, { message: 'Say hi' });
    const t2 = await agentReq(token, 'GET', '/agent-api/tasks/next?wait=5');
    await agentReq(token, 'POST', `/agent-api/tasks/${t2.body.task.id}/result`, { text: 'hi' });
    expect((await pg).body.reply).toBe('hi');

    // owner "Test connection" → ping task
    const test = owner.request('POST', `/agents/${agent.id}/test`);
    const t3 = await agentReq(token, 'GET', '/agent-api/tasks/next?wait=5');
    expect(t3.body.task.kind).toBe('health');
    const ping = /STRINGMIND-PING-[A-F0-9]+/.exec(t3.body.task.messages[0].content)![0];
    await agentReq(token, 'POST', `/agent-api/tasks/${t3.body.task.id}/result`, { text: ping });
    expect((await test).body.ok).toBe(true);
  });

  it('inbox timeout → AdapterError(timeout), task expired, late answer 409', async () => {
    process.env.INBOX_TASK_TIMEOUT_MS = '800';
    try {
      const err = await invokeAgent(agent.id, { messages: [{ role: 'user', content: 'slow?' }], purpose: 'assessment' }).catch((e) => e);
      expect(err).toBeInstanceOf(AdapterError);
      expect(err.kind).toBe('timeout');
      expect(err.message).toMatch(/is it running and polling/);
    } finally {
      delete process.env.INBOX_TASK_TIMEOUT_MS;
    }
    const [t] = await database.select().from(schema.agentTasks).where(eq(schema.agentTasks.agentId, agent.id))
      .orderBy(sql`${schema.agentTasks.createdAt} desc`).limit(1);
    expect(t!.status).toBe('expired');
    expect((await agentReq(token, 'POST', `/agent-api/tasks/${t!.id}/result`, { text: 'late' })).status).toBe(409);
  });

  it('offline after lastSeen ≥ 90s; polling again brings it back', async () => {
    const [conn] = await database.select().from(schema.agentConnections).where(eq(schema.agentConnections.agentId, agent.id));
    await database.update(schema.agentConnections)
      .set({ config: { ...conn!.config, lastSeenAt: new Date(Date.now() - 120_000).toISOString() } })
      .where(eq(schema.agentConnections.id, conn!.id));
    expect((await status(owner, agent.id)).state).toBe('offline');
    // invoking an offline agent fails fast instead of waiting for the timeout
    const err = await invokeAgent(agent.id, { messages: [{ role: 'user', content: 'x' }], purpose: 'playground' }).catch((e) => e);
    expect(err.kind).toBe('network');
    expect(await sweepOfflinePromptAgents()).toBe(1);
    const d = await owner.request('GET', `/agents/${agent.id}`);
    expect(d.body.health).toBe('down');
    const test = await owner.request('POST', `/agents/${agent.id}/test`);
    expect(test.body.ok).toBe(false);
    expect(test.body.error).toMatch(/offline/i);

    expect((await agentReq(token, 'POST', '/agent-api/heartbeat')).status).toBe(200);
    expect((await status(owner, agent.id)).state).toBe('connected');
    const d2 = await owner.request('GET', `/agents/${agent.id}`);
    expect(d2.body).toMatchObject({ health: 'healthy', connection: { status: 'connected' } });
  });

  it('tenant isolation on owner endpoints', async () => {
    const intruder = await createUserDirect();
    expect((await intruder.request('GET', `/agents/${agent.id}/connection-status`)).status).toBe(404);
    expect((await intruder.request('POST', `/agents/${agent.id}/connect-prompt`)).status).toBe(404);
  });

  it('non-prompt agents: connection-status reports method + status; connect-prompt rejected', async () => {
    const sb = await owner.request('POST', '/agents', { name: 'Sandbox', providerSlug: 'sandbox', modelName: 'aix-sandbox-1', connection: { method: 'sandbox' } });
    expect(sb.status).toBe(201);
    expect(sb.body.connect).toBeUndefined();
    expect(await status(owner, sb.body.id)).toEqual({ method: 'sandbox', state: 'pending' });
    expect((await owner.request('POST', `/agents/${sb.body.id}/connect-prompt`)).status).toBe(422);
    // modelName still required for non-prompt providers
    expect((await owner.request('POST', '/agents', { name: 'NoModel', providerSlug: 'sandbox', connection: { method: 'sandbox' } })).status).toBe(400);
  });

  it('re-key via connect-prompt revokes the old token; new code works', async () => {
    const r = await owner.request('POST', `/agents/${agent.id}/connect-prompt`);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['claimCode', 'connectUrl', 'expiresAt', 'prompt']);
    expect((await agentReq(token, 'GET', '/agent-api/me')).status).toBe(401);
    expect((await status(owner, agent.id)).state).toBe('awaiting_claim');
    const newToken = await connectFully(r.body.claimCode);
    expect(newToken).not.toBe(token);
    expect((await status(owner, agent.id)).state).toBe('connected');
  });

  it('disconnect revokes the token', async () => {
    const other = await createPromptAgent(owner, 'Disc Bot');
    const t = await connectFully(other.connect.claimCode);
    expect((await owner.request('POST', `/agents/${other.id}/disconnect`)).status).toBe(200);
    expect((await agentReq(t, 'GET', '/agent-api/me')).status).toBe(401);
    // the generic connection endpoint is not used for prompt agents
    expect((await owner.request('POST', `/agents/${other.id}/connection`, { method: 'prompt' })).status).toBe(422);
  });

  it('serves connect.md', async () => {
    const r = await app.inject({ method: 'GET', url: '/public/connect.md' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(r.headers['cache-control']).toBe('public, max-age=300');
    expect(r.body).toContain('http://localhost:3700/api/agent-api');
    expect(r.body).toContain('/tasks/next?wait=25');
    expect(r.body).toContain('LLM_BASE_URL');
    expect(r.body).toContain('def answer(task)');
    expect(r.body).toContain('async function answer(task)');
  });
});
