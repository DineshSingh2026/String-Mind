/**
 * Offline trainer: the trainer's experience lives on Hive Mind, so a trainer that is not online can still train.
 * It teaches from its RECORDED cases; only the learner must be live. Without enough recorded cases it still needs
 * to be online (legacy behaviour).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { app, createUserDirect, database, setup, teardown } from './helpers.js';
import { schema } from '../src/db/client.js';
import { drain } from '../src/jobs/queue.js';
import { qualifyTrainer } from './fixtures/experience.js';

process.env.MEMORY_SYNC_ON_CONNECT = 'false';
type Owner = Awaited<ReturnType<typeof createUserDirect>>;
const DOMAIN = 'programming';

const agentReq = async (token: string | null, method: string, url: string, body?: unknown) => {
  const r = await app.inject({ method: method as never, url, payload: body as never, headers: token ? { authorization: `Bearer ${token}` } : {} });
  let parsed: any = null;
  try { parsed = r.body ? JSON.parse(r.body) : null; } catch { parsed = r.body; }
  return { status: r.statusCode, body: parsed };
};

/** A verified prompt-connected agent that has stopped checking in (offline). */
async function offlinePromptTrainer(owner: Owner, name: string) {
  const r = await owner.request('POST', '/agents', { name, providerSlug: 'prompt-connect', connection: { method: 'prompt' } });
  const c = await agentReq(null, 'POST', '/agent-api/claim', { claimCode: r.body.connect.claimCode });
  const token = c.body.agentToken as string;
  const batch = await agentReq(token, 'GET', '/agent-api/tasks?limit=50');
  const code = /STRINGMIND-OK-[A-F0-9]+/.exec(batch.body.tasks[0].messages[0].content)![0];
  await agentReq(token, 'POST', '/agent-api/tasks/results', { results: [{ id: batch.body.tasks[0].id, text: code }] });
  const [conn] = await database.select().from(schema.agentConnections).where(eq(schema.agentConnections.agentId, r.body.id));
  await database.update(schema.agentConnections).set({ config: { ...conn!.config, lastSeenAt: new Date(Date.now() - 3_600_000).toISOString() } }).where(eq(schema.agentConnections.id, conn!.id));
  await database.update(schema.agents).set({ permissions: { allowTraining: true, shareKnowledge: true } }).where(eq(schema.agents.id, r.body.id));
  return (await database.select().from(schema.agents).where(eq(schema.agents.id, r.body.id)))[0]!;
}

async function sandboxLearner(owner: Owner) {
  const [p] = await database.select().from(schema.agentProviders).where(eq(schema.agentProviders.slug, 'sandbox'));
  const [a] = await database.insert(schema.agents).values({
    orgId: owner.orgId, ownerId: owner.userId, providerId: p!.id, slug: `learner-${Math.random().toString(36).slice(2, 8)}`, name: 'Live Learner', modelName: 'aix-sandbox-1',
    status: 'active', permissions: { allowLearning: true, autoApproveArtefacts: true, dataSharing: 'artefacts_only' },
  }).returning();
  await database.insert(schema.agentConnections).values({ agentId: a!.id, method: 'sandbox', status: 'connected' });
  return a!;
}

async function runSession(owner: Owner, learnerId: string, trainerId: string) {
  const req = await owner.request('POST', '/training/requests', { learnerAgentId: learnerId, trainerAgentId: trainerId, domainSlug: DOMAIN, objectives: ['Handle production incidents'] });
  expect(req.status).toBe(201);
  const acc = await owner.request('POST', `/training/requests/${req.body.id}/accept`);
  const sessionId = acc.body.session.id as string;
  expect((await owner.request('POST', `/training/sessions/${sessionId}/start`)).status).toBe(200);
  await drain();
  return sessionId;
}

beforeAll(async () => { await setup(); });
afterAll(async () => { await drain(); await new Promise((r) => setTimeout(r, 100)); await teardown(); });

describe('offline trainer', () => {
  it('an offline trainer with recorded experience still trains a live learner (no live trainer calls)', async () => {
    const owner = await createUserDirect();
    const trainer = await offlinePromptTrainer(owner, 'Sleeping Veteran');
    await qualifyTrainer(trainer, DOMAIN);
    const learner = await sandboxLearner(owner);

    const sessionId = await runSession(owner, learner.id, trainer.id);
    const s = await owner.request('GET', `/training/sessions/${sessionId}`);
    expect(s.body.failureReason ?? null).toBeNull();
    expect(s.body.status).toBe('completed');
    expect(s.body.preScore).toBeLessThan(20);
    expect(s.body.postScore).toBeGreaterThan(s.body.preScore + 30);

    const [row] = await database.select().from(schema.trainingSessions).where(eq(schema.trainingSessions.id, sessionId));
    expect(row!.plan).toMatchObject({ mode: 'experience', trainerRecorded: true });
    // the trainer was never asked anything: no training tasks in its inbox
    const tasks = await database.select().from(schema.agentTasks).where(and(eq(schema.agentTasks.agentId, trainer.id), eq(schema.agentTasks.kind, 'training')));
    expect(tasks).toHaveLength(0);
    // its recorded cases became the learner's memory
    const mem = await database.select().from(schema.agentMemories).where(eq(schema.agentMemories.agentId, learner.id));
    expect(mem.some((m) => /Case from Sleeping Veteran's experience/.test(m.content))).toBe(true);
    expect(s.body.settlement.status).toBe('none'); // free same-org session: no fee to settle (paid settlement is covered in experience.test.ts)
  });

  it('an offline trainer WITHOUT recorded experience still needs to be online (session fails, nothing charged)', async () => {
    const owner = await createUserDirect();
    const trainer = await offlinePromptTrainer(owner, 'Sleeping Newcomer');
    const learner = await sandboxLearner(owner);
    const sessionId = await runSession(owner, learner.id, trainer.id);
    const [row] = await database.select().from(schema.trainingSessions).where(eq(schema.trainingSessions.id, sessionId));
    expect(row!.status).toBe('failed');
    expect(row!.failureReason).toMatch(/too few recorded real cases/);
  });

  it('the learner must still be online', async () => {
    const owner = await createUserDirect();
    const trainer = await offlinePromptTrainer(owner, 'Sleeping Veteran 2');
    await qualifyTrainer(trainer, DOMAIN);
    const learner = await offlinePromptTrainer(owner, 'Sleeping Learner');
    await database.update(schema.agents).set({ permissions: { allowLearning: true } }).where(eq(schema.agents.id, learner.id));
    const sessionId = await runSession(owner, learner.id, trainer.id);
    const [row] = await database.select().from(schema.trainingSessions).where(eq(schema.trainingSessions.id, sessionId));
    expect(row!.status).toBe('failed');
    expect(row!.failureReason).toMatch(/learner agent is not available/);
  });
});

async function onlineSandboxTrainer(owner: Owner) {
  const [p] = await database.select().from(schema.agentProviders).where(eq(schema.agentProviders.slug, 'sandbox'));
  const [a] = await database.insert(schema.agents).values({
    orgId: owner.orgId, ownerId: owner.userId, providerId: p!.id, slug: `trainer-${Math.random().toString(36).slice(2, 8)}`, name: 'Online Veteran', modelName: 'aix-sandbox-1',
    status: 'active', isPublic: true, permissions: { allowTraining: true, shareKnowledge: true },
  }).returning();
  await database.insert(schema.agentConnections).values({ agentId: a!.id, method: 'sandbox', status: 'connected' });
  await qualifyTrainer(a!, DOMAIN);
  return a!;
}

async function sessionFor(owner: Owner, learnerId: string, trainerId: string, coachingMode: 'recorded' | 'live' | undefined) {
  let listingId: string | undefined;
  if (coachingMode) {
    const l = await owner.request('POST', '/marketplace/listings', { agentId: trainerId, title: 'Coaching', domainSlug: DOMAIN, priceCredits: 0, pricingModel: 'free', coachingMode });
    expect(l.status).toBe(201);
    expect(l.body.coachingMode).toBe(coachingMode);
    listingId = l.body.id;
  }
  const req = await owner.request('POST', '/training/requests', { learnerAgentId: learnerId, trainerAgentId: trainerId, domainSlug: DOMAIN, objectives: [], ...(listingId ? { listingId } : {}) });
  expect(req.status).toBe(201);
  const acc = await owner.request('POST', `/training/requests/${req.body.id}/accept`);
  const sessionId = acc.body.session.id as string;
  expect((await owner.request('POST', `/training/sessions/${sessionId}/start`)).status).toBe(200);
  await drain();
  const [row] = await database.select().from(schema.trainingSessions).where(eq(schema.trainingSessions.id, sessionId));
  return row!;
}

describe('coaching mode: recorded by default, live coaching is opt-in', () => {
  it('an ONLINE trainer teaches from recorded cases by default (no listing, or a recorded listing)', async () => {
    const owner = await createUserDirect();
    const trainer = await onlineSandboxTrainer(owner);
    for (const mode of [undefined, 'recorded'] as const) {
      const row = await sessionFor(owner, (await sandboxLearner(owner)).id, trainer.id, mode);
      expect(row.status).toBe('completed');
      expect(row.plan).toMatchObject({ mode: 'experience', trainerRecorded: true });
      expect(row.postScore!).toBeGreaterThan(row.preScore! + 30);
    }
  });

  it('a live-coaching listing with an online trainer uses live trainer replies; the measurement is identical', async () => {
    const owner = await createUserDirect();
    const trainer = await onlineSandboxTrainer(owner);
    const row = await sessionFor(owner, (await sandboxLearner(owner)).id, trainer.id, 'live');
    expect(row.status).toBe('completed');
    expect((row.plan as { trainerRecorded?: boolean }).trainerRecorded).toBeUndefined();
    expect(row.plan).toMatchObject({ mode: 'experience' });
    expect(row.postScore!).toBeGreaterThan(row.preScore! + 30);
    const reps = await database.select().from(schema.experienceReplays).where(eq(schema.experienceReplays.trainingSessionId, row.id));
    expect(reps.map((r) => r.purpose).sort()).toEqual(['post_training', 'pre_training']);
  });

  it('a live-coaching listing falls back to recorded when the trainer is offline', async () => {
    const owner = await createUserDirect();
    const trainer = await offlinePromptTrainer(owner, 'Sleeping Live Coach');
    await qualifyTrainer(trainer, DOMAIN);
    const row = await sessionFor(owner, (await sandboxLearner(owner)).id, trainer.id, 'live');
    expect(row.status).toBe('completed');
    expect(row.plan).toMatchObject({ mode: 'experience', trainerRecorded: true });
  });
});
