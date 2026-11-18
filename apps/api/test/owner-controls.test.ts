// These tests count inbox tasks exactly; the on-connect memory sync is covered in experience.test.ts.
process.env.MEMORY_SYNC_ON_CONNECT = 'false';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { app, createUserDirect, database, setup, teardown } from './helpers.js';
import { schema } from '../src/db/client.js';
import { assertAgentActive } from '../src/modules/owner-controls/service.js';
import { enqueueTask } from '../src/lib/agent-inbox.js';

beforeAll(async () => { await setup(); });
afterAll(async () => { await teardown(); });

type Owner = Awaited<ReturnType<typeof createUserDirect>>;

const agentReq = async (token: string | null, method: string, url: string, body?: unknown) => {
  const r = await app.inject({ method: method as never, url, payload: body as never, headers: token ? { authorization: `Bearer ${token}` } : {} });
  let parsed: any = null;
  try { parsed = r.body ? JSON.parse(r.body) : null; } catch { parsed = r.body; }
  return { status: r.statusCode, body: parsed, headers: r.headers };
};

async function createPromptAgent(owner: Owner, name = 'Prompt Bot') {
  const r = await owner.request('POST', '/agents', { name, providerSlug: 'prompt-connect', connection: { method: 'prompt' } });
  expect(r.status).toBe(201);
  return r.body;
}

/** Claim + answer the verify task → connected. Returns the agent token. */
async function connectFully(code: string) {
  const c = await agentReq(null, 'POST', '/agent-api/claim', { claimCode: code });
  expect(c.status).toBe(200);
  const next = await agentReq(c.body.agentToken, 'GET', '/agent-api/tasks/next?wait=1');
  expect(next.status).toBe(200);
  const m = /STRINGMIND-OK-[A-F0-9]+/.exec(next.body.task.messages[0].content)!;
  const res = await agentReq(c.body.agentToken, 'POST', `/agent-api/tasks/${next.body.task.id}/result`, { text: m[0] });
  expect(res.body.verified).toBe(true);
  return c.body.agentToken as string;
}

async function makeSandboxAgent(orgId: string, ownerId: string, name: string, permissions: Record<string, unknown>, isPublic = false) {
  const [p] = await database.select().from(schema.agentProviders).where(eq(schema.agentProviders.slug, 'sandbox'));
  const [a] = await database.insert(schema.agents).values({
    orgId, ownerId, providerId: p!.id, slug: `${name.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}`, name, modelName: 'aix-sandbox-1',
    status: 'active', isPublic, permissions,
  }).returning();
  await database.insert(schema.agentConnections).values({ agentId: a!.id, method: 'sandbox', status: 'connected' });
  return a!;
}

describe('pause / resume', () => {
  let owner: Owner;
  let agent: any;
  let token: string;

  beforeAll(async () => {
    owner = await createUserDirect();
    agent = await createPromptAgent(owner);
    token = await connectFully(agent.connect.claimCode);
  });

  it('pausing is org-scoped, audited and shows paused in the agent detail and /agent-api/me', async () => {
    const other = await createUserDirect();
    expect((await other.request('POST', `/owner/agents/${agent.id}/pause`)).status).toBe(404);

    const r = await owner.request('POST', `/owner/agents/${agent.id}/pause`, { reason: 'holiday' });
    expect(r.status).toBe(200);
    expect(r.body.paused).toBe(true);
    expect((await owner.request('POST', `/owner/agents/${agent.id}/pause`)).status).toBe(409);

    const detail = await owner.request('GET', `/agents/${agent.id}`);
    expect(detail.body.pausedAt).toBeTruthy();
    const me = await agentReq(token, 'GET', '/agent-api/me');
    expect(me.status).toBe(200);
    expect(me.body.paused).toBe(true);

    const [log] = await database.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, 'agent.pause'));
    expect(log).toMatchObject({ targetType: 'agent', targetId: agent.id, orgId: owner.orgId });
  });

  it('a paused agent receives no tasks (single + batch) and assertAgentActive throws 409 agent_paused', async () => {
    await enqueueTask(agent.id, owner.orgId, 'playground', { system: null, messages: [{ role: 'user', content: 'hello' }] }, 60_000);
    const next = await agentReq(token, 'GET', '/agent-api/tasks/next?wait=0');
    expect(next.status).toBe(204);
    expect(next.headers['x-hive-paused']).toBe('true');
    const batch = await agentReq(token, 'GET', '/agent-api/tasks');
    expect(batch.body.tasks).toEqual([]);
    expect(batch.body.paused).toBe(true);
    expect(batch.body.remaining).toBe(1);
    await expect(assertAgentActive(agent.id)).rejects.toMatchObject({ status: 409, code: 'agent_paused' });
    const assess = await owner.request('POST', '/assessments', { agentId: agent.id });
    expect(assess.status).toBe(409);
  });

  it('resume delivers the waiting task again', async () => {
    expect((await owner.request('POST', `/owner/agents/${agent.id}/resume`)).status).toBe(200);
    expect((await owner.request('POST', `/owner/agents/${agent.id}/resume`)).status).toBe(409);
    const next = await agentReq(token, 'GET', '/agent-api/tasks/next?wait=0');
    expect(next.status).toBe(200);
    expect(next.body.task.messages[0].content).toBe('hello');
    expect((await agentReq(token, 'GET', '/agent-api/me')).body.paused).toBe(false);
    await expect(assertAgentActive(agent.id)).resolves.toBeUndefined();
  });

  it('assertAgentActive rejects suspended, disconnected and deleted agents', async () => {
    const a = await makeSandboxAgent(owner.orgId, owner.userId, 'Checker', {});
    await database.update(schema.agents).set({ status: 'suspended' }).where(eq(schema.agents.id, a.id));
    await expect(assertAgentActive(a.id)).rejects.toMatchObject({ status: 409, code: 'agent_suspended' });
    await database.update(schema.agents).set({ status: 'disconnected' }).where(eq(schema.agents.id, a.id));
    await expect(assertAgentActive(a.id)).rejects.toMatchObject({ status: 409, code: 'agent_disconnected' });
    await database.update(schema.agents).set({ status: 'active', deletedAt: new Date() }).where(eq(schema.agents.id, a.id));
    await expect(assertAgentActive(a.id)).rejects.toMatchObject({ status: 409, code: 'agent_deleted' });
    await expect(assertAgentActive('00000000-0000-0000-0000-000000000000')).rejects.toMatchObject({ status: 409 });
  });
});

describe('pause blocks training', () => {
  it('rejects a training request and session start while the learner is paused', async () => {
    const owner = await createUserDirect();
    const [domain] = await database.select().from(schema.capabilityDomains).limit(1);
    const learner = await makeSandboxAgent(owner.orgId, owner.userId, 'Learner', { allowLearning: true });
    const trainer = await makeSandboxAgent(owner.orgId, owner.userId, 'Trainer', { allowTraining: true, shareKnowledge: true });
    const body = { learnerAgentId: learner.id, trainerAgentId: trainer.id, domainSlug: domain!.slug };

    await owner.request('POST', `/owner/agents/${learner.id}/pause`);
    const blocked = await owner.request('POST', '/training/requests', body);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('agent_paused');

    await owner.request('POST', `/owner/agents/${learner.id}/resume`);
    const ok = await owner.request('POST', '/training/requests', body);
    expect(ok.status).toBe(201);
    const acc = await owner.request('POST', `/training/requests/${ok.body.id}/accept`);
    expect(acc.status).toBe(200);
    const sessionId = acc.body.session.id;

    await owner.request('POST', `/owner/agents/${trainer.id}/pause`);
    const start = await owner.request('POST', `/training/sessions/${sessionId}/start`);
    expect(start.status).toBe(409);
    expect(start.body.error.code).toBe('agent_paused');
    const [s] = await database.select().from(schema.trainingSessions).where(eq(schema.trainingSessions.id, sessionId));
    expect(s!.status).toBe('scheduled');
  });
});

describe('rotate agent link', () => {
  it('revokes the old token immediately and returns a new prompt once', async () => {
    const owner = await createUserDirect();
    const agent = await createPromptAgent(owner, 'Rotator');
    const oldToken = await connectFully(agent.connect.claimCode);
    expect((await agentReq(oldToken, 'GET', '/agent-api/me')).status).toBe(200);

    const other = await createUserDirect();
    expect((await other.request('POST', `/owner/agents/${agent.id}/rotate-link`)).status).toBe(404);

    const r = await owner.request('POST', `/owner/agents/${agent.id}/rotate-link`);
    expect(r.status).toBe(200);
    expect(r.body.revokedToken).toBe(true);
    expect(r.body.claimCode).toMatch(/^SM-/);
    expect(r.body.claimCode).not.toBe(agent.connect.claimCode);
    expect(r.body.prompt).toContain(r.body.claimCode);
    expect(JSON.stringify(r.body)).not.toMatch(/sm_at_|Hash/);

    expect((await agentReq(oldToken, 'GET', '/agent-api/me')).status).toBe(401);
    expect((await agentReq(oldToken, 'GET', '/agent-api/tasks/next?wait=0')).status).toBe(401);
    // the old claim code is dead too; the new one works
    expect((await agentReq(null, 'POST', '/agent-api/claim', { claimCode: agent.connect.claimCode })).status).toBe(404);
    const newToken = await connectFully(r.body.claimCode);
    expect(newToken).not.toBe(oldToken);

    // the prompt is shown once: the agent detail never contains it
    const detail = await owner.request('GET', `/agents/${agent.id}`);
    expect(JSON.stringify(detail.body)).not.toContain(r.body.claimCode);
    const [log] = await database.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, 'agent.rotate_link'));
    expect(log).toMatchObject({ targetId: agent.id, orgId: owner.orgId });
  });

  it('refuses non-prompt agents', async () => {
    const owner = await createUserDirect();
    const a = await makeSandboxAgent(owner.orgId, owner.userId, 'Sandy', {});
    expect((await owner.request('POST', `/owner/agents/${a.id}/rotate-link`)).status).toBe(422);
  });
});

describe('activity log', () => {
  it('merges audit rows and agent events, paginates, and is org-scoped', async () => {
    const owner = await createUserDirect();
    const agent = await createPromptAgent(owner, 'Logger');
    const token = await connectFully(agent.connect.claimCode);
    await owner.request('POST', `/owner/agents/${agent.id}/pause`);
    await owner.request('POST', `/owner/agents/${agent.id}/resume`);
    void token;

    const r = await owner.request('GET', `/owner/agents/${agent.id}/activity?pageSize=50`);
    expect(r.status).toBe(200);
    const kinds = r.body.items.map((i: any) => i.kind);
    expect(kinds).toEqual(expect.arrayContaining(['agent.create', 'agent.pause', 'agent.resume', 'task.delivered', 'task.answered']));
    // newest first
    const times = r.body.items.map((i: any) => Date.parse(i.at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(r.body.total).toBe(r.body.items.length);

    const p1 = await owner.request('GET', `/owner/agents/${agent.id}/activity?pageSize=2&page=1`);
    const p2 = await owner.request('GET', `/owner/agents/${agent.id}/activity?pageSize=2&page=2`);
    expect(p1.body.items).toHaveLength(2);
    expect(p2.body.items[0].id).not.toBe(p1.body.items[0].id);
    const tasksOnly = await owner.request('GET', `/owner/agents/${agent.id}/activity?source=task`);
    expect(tasksOnly.body.items.every((i: any) => i.source === 'task')).toBe(true);

    // another org: 404, and its own agents' logs never include this agent's rows
    const other = await createUserDirect();
    expect((await other.request('GET', `/owner/agents/${agent.id}/activity`)).status).toBe(404);
    // a viewer in the same org may read (agents.read) but not pause (agents.update)
    const [viewerUser] = await database.insert(schema.users).values({ email: `v${Date.now()}@test.dev`, name: 'Viewer', passwordHash: 'x', defaultOrgId: owner.orgId }).returning();
    await database.insert(schema.memberships).values({ orgId: owner.orgId, userId: viewerUser!.id, role: 'viewer' });
    const { randomBytes, createHash } = await import('node:crypto');
    const t = randomBytes(32).toString('base64url');
    await database.insert(schema.sessions).values({ userId: viewerUser!.id, tokenHash: createHash('sha256').update(t).digest('hex'), expiresAt: new Date(Date.now() + 86400_000) });
    const asViewer = (method: string, url: string) => app.inject({ method: method as never, url, headers: { cookie: `aix_session=${t}`, 'x-aix-org': owner.orgId } });
    expect((await asViewer('GET', `/owner/agents/${agent.id}/activity`)).statusCode).toBe(200);
    expect((await asViewer('POST', `/owner/agents/${agent.id}/pause`)).statusCode).toBe(403);
  });
});
