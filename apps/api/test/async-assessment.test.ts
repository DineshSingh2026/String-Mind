// These tests count inbox tasks exactly; the on-connect memory sync is covered in experience.test.ts.
process.env.MEMORY_SYNC_ON_CONNECT = 'false';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { app, createUserDirect, database, setup, teardown } from './helpers.js';
import { schema } from '../src/db/client.js';
import { sandboxRespond } from '../src/adapters/sandbox.js';
import { createAssessment, maybeFinalizeAsync, runAssessment, sweepAsyncAssessments } from '../src/engine/assessment.js';
import { drain } from '../src/jobs/queue.js';

beforeAll(async () => { await setup(); });
afterAll(async () => { await drain(); await teardown(); });

type Owner = Awaited<ReturnType<typeof createUserDirect>>;

const agentReq = async (token: string | null, method: string, url: string, body?: unknown) => {
  const r = await app.inject({ method: method as never, url, payload: body as never, headers: token ? { authorization: `Bearer ${token}` } : {} });
  let parsed: any = null;
  try { parsed = r.body ? JSON.parse(r.body) : null; } catch { parsed = r.body; }
  return { status: r.statusCode, body: parsed };
};

/** Create a prompt agent, claim + verify through the BATCH endpoints, then make it look offline (lastSeen 1h ago). */
async function offlinePromptAgent(owner: Owner, name: string) {
  const r = await owner.request('POST', '/agents', { name, providerSlug: 'prompt-connect', connection: { method: 'prompt' } });
  const c = await agentReq(null, 'POST', '/agent-api/claim', { claimCode: r.body.connect.claimCode });
  expect(c.body.endpoints.tasks).toBe('http://localhost:3700/api/agent-api/tasks?limit=50');
  expect(c.body.endpoints.results).toBe('http://localhost:3700/api/agent-api/tasks/results');
  const token = c.body.agentToken as string;
  const batch = await agentReq(token, 'GET', '/agent-api/tasks?limit=50');
  expect(batch.body.tasks).toHaveLength(1);
  const code = /STRINGMIND-OK-[A-F0-9]+/.exec(batch.body.tasks[0].messages[0].content)![0];
  const res = await agentReq(token, 'POST', '/agent-api/tasks/results', { results: [{ id: batch.body.tasks[0].id, text: code }] });
  expect(res.body).toMatchObject({ accepted: 1, rejected: [], verification: { verified: true } });
  await goOffline(r.body.id);
  return { id: r.body.id as string, token };
}

async function goOffline(agentId: string) {
  const [conn] = await database.select().from(schema.agentConnections).where(eq(schema.agentConnections.agentId, agentId));
  await database.update(schema.agentConnections)
    .set({ config: { ...conn!.config, lastSeenAt: new Date(Date.now() - 3_600_000).toISOString() } })
    .where(eq(schema.agentConnections.id, conn!.id));
}

const getA = async (id: string) => (await database.select().from(schema.capabilityAssessments).where(eq(schema.capabilityAssessments.id, id)))[0]!;
const tasksOf = (id: string) => database.select().from(schema.agentTasks).where(sql`${schema.agentTasks.meta}->>'assessmentId' = ${id}`);

/** Check in like a chat assistant: fetch batches and answer everything (sandbox-style answers from system+messages). */
async function checkIn(token: string, max = Infinity) {
  let answered = 0;
  for (;;) {
    if (answered >= max) return answered;
    const b = await agentReq(token, 'GET', `/agent-api/tasks?limit=${Math.min(50, max - answered)}`);
    expect(b.status).toBe(200);
    if (!b.body.tasks.length) return answered;
    const results = b.body.tasks.map((t: any) => ({ id: t.id, text: sandboxRespond({ messages: t.messages, system: t.system ?? undefined }) }));
    if (!results.length) return answered;
    const r = await agentReq(token, 'POST', '/agent-api/tasks/results', { results });
    expect(r.status).toBe(200);
    expect(r.body.rejected).toEqual([]);
    answered += r.body.accepted;
  }
}

describe('async assessments for prompt-connected agents', () => {
  let owner: Owner;
  beforeAll(async () => { owner = await createUserDirect(); });

  it('offline prompt agent: POST /assessments succeeds (Quick, default scope), tasks queued, then batch answers complete it', async () => {
    const ag = await offlinePromptAgent(owner, 'Chat Bot');
    const created = await owner.request('POST', '/assessments', { agentId: ag.id });
    expect(created.status).toBe(202);
    expect(created.body.domainSlugs).toEqual(['general']);
    expect(created.body.repeats).toBe(1);
    await runAssessment(created.body.id); // the job returns immediately — it does not wait for the agent
    let a = await getA(created.body.id);
    expect(a.status).toBe('running');
    expect(a.progress).toBe(0);
    expect((a.summary as any).mode).toBe('async');
    const tasks = await tasksOf(a.id);
    expect(tasks.length).toBe(a.testsTotal);
    expect(tasks.every((t) => t.status === 'pending' && t.kind === 'assessment' && t.deadline.getTime() > Date.now() + 23 * 3_600_000)).toBe(true);

    const status = await owner.request('GET', `/agents/${ag.id}/connection-status`);
    expect(status.body.state).toBe('offline');
    expect(status.body.pendingTasks).toBe(a.testsTotal);
    expect(status.body.oldestPendingAt).toBeTruthy();

    // partial check-in → progress moves, still running
    expect(await checkIn(ag.token, 5)).toBe(5);
    a = await getA(a.id);
    expect(a.status).toBe('running');
    expect(a.testsCompleted).toBe(5);
    expect(a.progress).toBeCloseTo(5 / a.testsTotal, 3);

    await checkIn(ag.token);
    a = await getA(a.id);
    expect(a.status).toBe('completed');
    expect(a.progress).toBe(1);
    expect(typeof a.overallScore).toBe('number');
    const results = await database.select().from(schema.assessmentResults).where(eq(schema.assessmentResults.assessmentId, a.id));
    expect(results.length).toBe(a.testsTotal);
    const notes = await database.select().from(schema.notifications).where(eq(schema.notifications.userId, owner.userId));
    expect(notes.some((n) => n.title === 'Assessment complete: Chat Bot')).toBe(true);
    // consistency not measured on a Quick run
    expect((a.summary as any).domains[0].consistencyMeasured).toBe(false);
    expect((await owner.request('GET', `/agents/${ag.id}/connection-status`)).body.pendingTasks).toBe(0);
  });

  it('partial answers + deadline passed → sweep finalizes with the >50% errors rule', async () => {
    const ag = await offlinePromptAgent(owner, 'Lazy Bot');
    const a0 = await createAssessment({ agentId: ag.id, orgId: owner.orgId, purpose: 'manual', domainSlugs: ['general'], repeats: 1 });
    await runAssessment(a0.id);
    await checkIn(ag.token, 2);
    await database.update(schema.agentTasks).set({ deadline: new Date(Date.now() - 1000) })
      .where(and(sql`${schema.agentTasks.meta}->>'assessmentId' = ${a0.id}`, eq(schema.agentTasks.status, 'pending')));
    const r = await sweepAsyncAssessments();
    expect(r.finalized).toBeGreaterThanOrEqual(1);
    const a = await getA(a0.id);
    expect(a.status).toBe('failed');
    expect(a.error).toMatch(/^Only 2 of \d+ questions were answered before the 24h deadline/);
    expect((await tasksOf(a0.id)).filter((t) => t.status === 'pending')).toHaveLength(0);
  });

  it('mostly answered + rest expired → completes with expired counted as timeouts', async () => {
    const ag = await offlinePromptAgent(owner, 'Mostly Bot');
    const a0 = await createAssessment({ agentId: ag.id, orgId: owner.orgId, purpose: 'manual', domainSlugs: ['general'], repeats: 1 });
    await runAssessment(a0.id);
    const total = (await getA(a0.id)).testsTotal;
    await checkIn(ag.token, total - 2);
    await database.update(schema.agentTasks).set({ deadline: new Date(Date.now() - 1000) })
      .where(and(sql`${schema.agentTasks.meta}->>'assessmentId' = ${a0.id}`, sql`${schema.agentTasks.status} IN ('pending','delivered')`));
    await sweepAsyncAssessments();
    const a = await getA(a0.id);
    expect(a.status).toBe('completed');
    expect((a.summary as any).errors).toBe(2);
    const results = await database.select().from(schema.assessmentResults).where(eq(schema.assessmentResults.assessmentId, a.id));
    expect(results.filter((x) => x.failureCategory === 'timeout')).toHaveLength(2);
  });

  it('concurrent final answers / finalize calls never double-finalize', async () => {
    const ag = await offlinePromptAgent(owner, 'Race Bot');
    const a0 = await createAssessment({ agentId: ag.id, orgId: owner.orgId, purpose: 'manual', domainSlugs: ['general'], repeats: 1 });
    await runAssessment(a0.id);
    const total = (await getA(a0.id)).testsTotal;
    await checkIn(ag.token, total - 2);
    const b = await agentReq(ag.token, 'GET', '/agent-api/tasks?limit=50');
    expect(b.body.tasks).toHaveLength(2);
    const before = (await database.select().from(schema.notifications).where(eq(schema.notifications.userId, owner.userId))).length;
    await Promise.all([
      ...b.body.tasks.map((t: any) => agentReq(ag.token, 'POST', `/agent-api/tasks/${t.id}/result`, { text: 'I don\'t know' })),
      maybeFinalizeAsync(a0.id), maybeFinalizeAsync(a0.id),
    ]);
    await Promise.all([maybeFinalizeAsync(a0.id), sweepAsyncAssessments()]);
    const a = await getA(a0.id);
    expect(a.status).toBe('completed');
    const after = (await database.select().from(schema.notifications).where(eq(schema.notifications.userId, owner.userId)))
      .filter((n) => n.title === 'Assessment complete: Race Bot');
    expect(after).toHaveLength(1);
    expect(before).toBeGreaterThan(0);
    const results = await database.select().from(schema.assessmentResults).where(eq(schema.assessmentResults.assessmentId, a.id));
    expect(results.length).toBe(total);
  });

  it('cancel expires pending tasks', async () => {
    const ag = await offlinePromptAgent(owner, 'Cancel Bot');
    const created = await owner.request('POST', '/assessments', { agentId: ag.id });
    await runAssessment(created.body.id);
    const c = await owner.request('POST', `/assessments/${created.body.id}/cancel`);
    expect(c.status).toBe(200);
    expect((await getA(created.body.id)).status).toBe('cancelled');
    expect((await tasksOf(created.body.id)).every((t) => t.status === 'expired')).toBe(true);
    expect((await agentReq(ag.token, 'GET', '/agent-api/tasks')).body.tasks).toHaveLength(0);
    expect((await owner.request('POST', `/assessments/${created.body.id}/cancel`)).status).toBe(422);
  });

  it('unverified prompt agent is refused with a clear message', async () => {
    const r = await owner.request('POST', '/agents', { name: 'Fresh Bot', providerSlug: 'prompt-connect', connection: { method: 'prompt' } });
    const res = await owner.request('POST', '/assessments', { agentId: r.body.id });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/not finished connecting/);
  });

  it('batch endpoints: auth + validation + redelivery', async () => {
    const ag = await offlinePromptAgent(owner, 'Batch Bot');
    expect((await agentReq(null, 'GET', '/agent-api/tasks')).status).toBe(401);
    expect((await agentReq(null, 'POST', '/agent-api/tasks/results', { results: [{ id: 'x', text: 'y' }] })).status).toBe(401);
    expect((await agentReq(ag.token, 'GET', '/agent-api/tasks?limit=0')).status).toBe(400);
    expect((await agentReq(ag.token, 'POST', '/agent-api/tasks/results', { results: [] })).status).toBe(400);
    const tooMany = Array.from({ length: 101 }, (_, i) => ({ id: `${i}`, text: 'x' }));
    expect((await agentReq(ag.token, 'POST', '/agent-api/tasks/results', { results: tooMany })).status).toBe(400);
    const a0 = await createAssessment({ agentId: ag.id, orgId: owner.orgId, purpose: 'manual', domainSlugs: ['general'], repeats: 1 });
    await runAssessment(a0.id);
    const first = await agentReq(ag.token, 'GET', '/agent-api/tasks?limit=3');
    expect(first.body.tasks).toHaveLength(3);
    expect(first.body.remaining).toBeGreaterThan(0);
    expect(first.body.tasks[0]).toEqual(expect.objectContaining({ kind: 'assessment', deadline: expect.any(String) }));
    expect(first.body.tasks[0].messages[0].role).toBe('user');
    // delivered tasks are not handed out again immediately …
    const second = await agentReq(ag.token, 'GET', '/agent-api/tasks?limit=100');
    expect(second.body.tasks.map((t: any) => t.id)).not.toContain(first.body.tasks[0].id);
    // … but are after 10 minutes unanswered
    await database.update(schema.agentTasks).set({ deliveredAt: new Date(Date.now() - 11 * 60_000) }).where(eq(schema.agentTasks.id, first.body.tasks[0].id));
    const third = await agentReq(ag.token, 'GET', '/agent-api/tasks?limit=100');
    expect(third.body.tasks.map((t: any) => t.id)).toEqual([first.body.tasks[0].id]);
    const mixed = await agentReq(ag.token, 'POST', '/agent-api/tasks/results', { results: [
      { id: first.body.tasks[0].id, text: 'ok' },
      { id: first.body.tasks[0].id, text: 'again' },
      { id: 'not-a-uuid', text: 'x' },
      { id: '00000000-0000-0000-0000-000000000000', text: 'x' },
      { id: first.body.tasks[1].id, text: 'x'.repeat(20_001) },
    ] });
    expect(mixed.status).toBe(200);
    expect(mixed.body.accepted).toBe(1);
    expect(mixed.body.rejected.map((r: any) => r.reason)).toEqual([
      'This task was already answered', 'invalid task id', 'Task not found', 'text must be at most 20000 characters',
    ]);
  });
});
