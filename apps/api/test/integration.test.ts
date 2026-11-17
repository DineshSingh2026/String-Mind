/**
 * Cross-feature integration: things that only break when two Hive Mind features meet.
 *  - reputation recompute keeps debate results
 *  - a prompt-connected agent records its own hive verdict through the agent API
 *  - a paused agent gets a clear 409 from playground / test connection (instead of a timeout)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { app, createUserDirect, database, setup, teardown } from './helpers.js';
import { schema } from '../src/db/client.js';
import { recomputeReputation } from '../src/modules/reputation/service.js';

beforeAll(async () => { await setup(); });
afterAll(async () => { await teardown(); });

type Owner = Awaited<ReturnType<typeof createUserDirect>>;

const agentReq = async (token: string | null, method: string, url: string, body?: unknown) => {
  const r = await app.inject({ method: method as never, url, payload: body as never, headers: token ? { authorization: `Bearer ${token}` } : {} });
  let parsed: any = null;
  try { parsed = r.body ? JSON.parse(r.body) : null; } catch { parsed = r.body; }
  return { status: r.statusCode, body: parsed };
};

async function promptAgent(owner: Owner, name: string) {
  const r = await owner.request('POST', '/agents', { name, providerSlug: 'prompt-connect', connection: { method: 'prompt' } });
  expect(r.status).toBe(201);
  const c = await agentReq(null, 'POST', '/agent-api/claim', { claimCode: r.body.connect.claimCode });
  const next = await agentReq(c.body.agentToken, 'GET', '/agent-api/tasks/next?wait=1');
  const m = /STRINGMIND-OK-[A-F0-9]+/.exec(next.body.task.messages[0].content)!;
  await agentReq(c.body.agentToken, 'POST', `/agent-api/tasks/${next.body.task.id}/result`, { text: m[0] });
  return { agent: r.body, token: c.body.agentToken as string };
}

describe('reputation × debates', () => {
  it('recomputing reputation keeps debate wins, losses and ties', async () => {
    const owner = await createUserDirect();
    const { agent } = await promptAgent(owner, 'Rep Keeper');
    await database.insert(schema.agentReputation).values({ agentId: agent.id, components: { debateWins: 4, debateLosses: 1, debateTies: 2, stale: 9 } });
    await recomputeReputation(agent.id);
    const [row] = await database.select().from(schema.agentReputation).where(eq(schema.agentReputation.agentId, agent.id));
    expect(row!.components).toMatchObject({ debateWins: 4, debateLosses: 1, debateTies: 2 });
    expect(row!.components).not.toHaveProperty('stale'); // only known foreign keys survive
  });
});

describe('agent API × hive verdicts', () => {
  it('a connected agent confirms another org\'s hive lesson, cannot confirm its own, and can change its mind', async () => {
    const a = await createUserDirect();
    const b = await createUserDirect();
    const { agent: mine, token } = await promptAgent(a, 'Verdict Bot');
    const { agent: theirs } = await promptAgent(b, 'Teacher Bot');
    const src = '00000000-0000-4000-8000-000000000001';
    const [lesson] = await database.insert(schema.hiveLessons).values({ sourceType: 'session', sourceId: src, title: 'Use idempotency keys', content: 'Store the key atomically.', agentIds: [theirs.id] }).returning();
    const [own] = await database.insert(schema.hiveLessons).values({ sourceType: 'session', sourceId: src, title: 'Own lesson', content: 'x', agentIds: [mine.id] }).returning();

    const ok = await agentReq(token, 'POST', '/agent-api/verdicts', { targetType: 'hive_lesson', targetId: lesson!.id, verdict: 'confirm', note: 'checked' });
    expect(ok.status).toBe(200);
    let [l] = await database.select().from(schema.hiveLessons).where(eq(schema.hiveLessons.id, lesson!.id));
    expect(l!.confirmCount).toBe(1);

    const self = await agentReq(token, 'POST', '/agent-api/verdicts', { targetType: 'hive_lesson', targetId: own!.id, verdict: 'confirm' });
    expect(self.status).toBe(403);

    const flip = await agentReq(token, 'POST', '/agent-api/verdicts', { targetType: 'hive_lesson', targetId: lesson!.id, verdict: 'dispute', note: 'found a counterexample' });
    expect(flip.status).toBe(200);
    [l] = await database.select().from(schema.hiveLessons).where(eq(schema.hiveLessons.id, lesson!.id));
    expect([l!.confirmCount, l!.disputeCount]).toEqual([0, 1]);

    const anon = await agentReq(null, 'POST', '/agent-api/verdicts', { targetType: 'hive_lesson', targetId: lesson!.id, verdict: 'confirm' });
    expect(anon.status).toBe(401);
  });
});

describe('owner controls × playground', () => {
  it('a paused agent gets 409 from playground and test connection', async () => {
    const owner = await createUserDirect();
    const { agent } = await promptAgent(owner, 'Sleepy Bot');
    expect((await owner.request('POST', `/owner/agents/${agent.id}/pause`, {})).status).toBe(200);
    const play = await owner.request('POST', `/agents/${agent.id}/playground`, { message: 'hi' });
    expect(play.status).toBe(409);
    const test = await owner.request('POST', `/agents/${agent.id}/test`, {});
    expect(test.status).toBe(409);
  });
});
