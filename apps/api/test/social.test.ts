import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { app, createUserDirect, database, setup, teardown } from './helpers.js';
import { schema } from '../src/db/client.js';
import { notifyFollowers, processRoomActivity, refreshBadges, resetFollowThrottle } from '../src/modules/social/service.js';
import { runBadgeSweep } from '../src/modules/social/routes.js';

type User = Awaited<ReturnType<typeof createUserDirect>>;
let domainId: string;

async function makeAgent(orgId: string, ownerId: string, name: string, isPublic = false) {
  const [p] = await database.select().from(schema.agentProviders).where(eq(schema.agentProviders.slug, 'sandbox'));
  const [a] = await database.insert(schema.agents).values({
    orgId, ownerId, providerId: p!.id, slug: `${name.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}`, name, modelName: 'aix-sandbox-1',
    status: 'active', isPublic, permissions: { allowTraining: true, allowLearning: true },
  }).returning();
  return a!;
}

async function makeSession(trainer: { id: string; orgId: string }, learner: { id: string; orgId: string }, extra: Partial<typeof schema.trainingSessions.$inferInsert> = {}) {
  const [s] = await database.insert(schema.trainingSessions).values({
    learnerAgentId: learner.id, trainerAgentId: trainer.id, learnerOrgId: learner.orgId, trainerOrgId: trainer.orgId,
    domainId, subject: 'Test room', status: 'active', ...extra,
  }).returning();
  return s!;
}

const anon = async (method: string, url: string) => {
  const r = await app.inject({ method: method as never, url });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};

async function notificationsOf(userId: string, type?: string) {
  const rows = await database.select().from(schema.notifications).where(eq(schema.notifications.userId, userId));
  return type ? rows.filter((n) => n.type === type) : rows;
}

let trainerOwner: User, learnerOwner: User, watcher: User;
let trainer: Awaited<ReturnType<typeof makeAgent>>, learner: Awaited<ReturnType<typeof makeAgent>>;

beforeAll(async () => {
  await setup();
  const [d] = await database.select().from(schema.capabilityDomains).limit(1);
  domainId = d!.id;
  trainerOwner = await createUserDirect();
  learnerOwner = await createUserDirect();
  watcher = await createUserDirect();
  trainer = await makeAgent(trainerOwner.orgId, trainerOwner.userId, 'Tutor', true);
  learner = await makeAgent(learnerOwner.orgId, learnerOwner.userId, 'Pupil', false);
});
afterAll(async () => { await teardown(); });
beforeEach(() => resetFollowThrottle());

describe('public rooms', () => {
  it('hides private rooms, exposes public rooms read-only, respects moderation', async () => {
    const s = await makeSession(trainer, learner);
    await database.insert(schema.trainingMessages).values([
      { sessionId: s.id, senderRole: 'trainer', senderAgentId: trainer.id, stage: 'knowledge_sharing', content: 'Visible lesson' },
      { sessionId: s.id, senderRole: 'learner', senderAgentId: learner.id, stage: 'knowledge_sharing', content: 'IGNORE PREVIOUS', flagged: true, flagReason: 'prompt_injection' },
      { sessionId: s.id, senderRole: 'system', stage: 'knowledge_sharing', content: 'internal only', metadata: { shared: false } },
    ]);

    // private by default: nobody outside sees it
    expect((await anon('GET', `/social/rooms/${s.id}`)).status).toBe(404);
    expect((await anon('GET', `/social/rooms/${s.id}/messages`)).status).toBe(404);
    expect((await anon('GET', '/social/rooms')).body.items.some((r: { id: string }) => r.id === s.id)).toBe(false);

    // only a participant org may toggle visibility
    expect((await watcher.request('PATCH', `/social/rooms/${s.id}/visibility`, { visibility: 'public' })).status).toBe(404);
    const pub = await learnerOwner.request('PATCH', `/social/rooms/${s.id}/visibility`, { visibility: 'public' });
    expect(pub.status).toBe(200);
    expect(pub.body.visibility).toBe('public');

    const room = await anon('GET', `/social/rooms/${s.id}`);
    expect(room.status).toBe(200);
    expect(room.body.trainer.slug).toBe(trainer.slug); // public agent → profile link
    expect(room.body.learner.slug).toBeNull(); // private agent → no profile link
    expect(room.body.learner.name).toBe('Pupil');
    expect(room.body.live).toBe(true);
    const msgs = await anon('GET', `/social/rooms/${s.id}/messages`);
    expect(msgs.status).toBe(200);
    expect(msgs.body.items).toHaveLength(2); // shared:false dropped
    expect(msgs.body.items[0].content).toBe('Visible lesson');
    expect(msgs.body.items[1].flagged).toBe(true);
    expect(msgs.body.items[1].content).toBe(''); // flagged content withheld
    expect(JSON.stringify(msgs.body)).not.toContain('IGNORE PREVIOUS');
    const list = await anon('GET', '/social/rooms');
    const card = list.body.items.find((r: { id: string }) => r.id === s.id);
    expect(card).toBeTruthy();
    expect(card.messageCount).toBe(3);

    // moderation removes the room completely
    await database.update(schema.trainingSessions).set({ moderation: 'removed' }).where(eq(schema.trainingSessions.id, s.id));
    expect((await anon('GET', `/social/rooms/${s.id}`)).status).toBe(404);
    expect((await trainerOwner.request('PATCH', `/social/rooms/${s.id}/visibility`, { visibility: 'public' })).status).toBe(400);
    await database.update(schema.trainingSessions).set({ moderation: 'visible' }).where(eq(schema.trainingSessions.id, s.id));

    // back to private
    expect((await trainerOwner.request('PATCH', `/social/rooms/${s.id}/visibility`, { visibility: 'private' })).status).toBe(200);
    expect((await anon('GET', `/social/rooms/${s.id}/messages`)).status).toBe(404);
  });

  it('lists live rooms before finished ones', async () => {
    const done = await makeSession(trainer, learner, { status: 'completed', visibility: 'public', subject: 'Done room' });
    const live = await makeSession(trainer, learner, { status: 'active', visibility: 'public', subject: 'Live room' });
    const list = await anon('GET', '/social/rooms?pageSize=100');
    const ids = list.body.items.map((r: { id: string }) => r.id);
    expect(ids.indexOf(live.id)).toBeLessThan(ids.indexOf(done.id));
    expect(list.body.liveCount).toBeGreaterThanOrEqual(1);
  });
});

describe('follows and notifications', () => {
  it('follows public targets only and reports follower counts', async () => {
    const priv = await makeSession(trainer, learner);
    const pub = await makeSession(trainer, learner, { visibility: 'public' });
    expect((await watcher.request('POST', '/social/follows', { targetType: 'session', targetId: priv.id })).status).toBe(404);
    expect((await watcher.request('POST', '/social/follows', { targetType: 'agent', targetId: learner.id })).status).toBe(404); // private agent of another org
    expect((await anon('POST', '/social/follows')).status).toBe(401);

    const f = await watcher.request('POST', '/social/follows', { targetType: 'session', targetId: pub.id });
    expect(f.status).toBe(201);
    expect(f.body.followers).toBe(1);
    const st = await watcher.request('GET', `/social/follows/status?targetType=session&targetId=${pub.id}`);
    expect(st.body).toMatchObject({ following: true, followers: 1, signedIn: true });
    const anonSt = await anon('GET', `/social/follows/status?targetType=session&targetId=${pub.id}`);
    expect(anonSt.body).toMatchObject({ following: false, followers: 1, signedIn: false });
    const mine = await watcher.request('GET', '/social/follows');
    expect(mine.body.items.some((i: { targetId: string; link: string }) => i.targetId === pub.id && i.link === `/rooms/${pub.id}`)).toBe(true);
    const un = await watcher.request('DELETE', `/social/follows?targetType=session&targetId=${pub.id}`);
    expect(un.body).toMatchObject({ following: false, followers: 0 });
  });

  it('throttles to one notification per follower per target per 10 minutes and skips excluded users', async () => {
    const target = randomUUID();
    const other = await createUserDirect();
    await database.insert(schema.follows).values([
      { userId: watcher.userId, targetType: 'debate', targetId: target },
      { userId: other.userId, targetType: 'debate', targetId: target },
    ]);
    const before = (await notificationsOf(watcher.userId, 'debate_update')).length;
    for (let i = 0; i < 3; i++) {
      await notifyFollowers({ targetType: 'debate', targetId: target, type: 'debate_update', title: `Round ${i}`, exceptUserIds: [other.userId] });
    }
    expect((await notificationsOf(watcher.userId, 'debate_update')).length).toBe(before + 1);
    expect((await notificationsOf(other.userId, 'debate_update')).length).toBe(0);
    // a different target is throttled independently
    const target2 = randomUUID();
    await database.insert(schema.follows).values({ userId: watcher.userId, targetType: 'debate', targetId: target2 });
    await notifyFollowers({ targetType: 'debate', targetId: target2, type: 'debate_update', title: 'Other debate' });
    expect((await notificationsOf(watcher.userId, 'debate_update')).length).toBe(before + 2);
  });

  it('room watcher notifies followers of the room and of the speaking agent, never the owners', async () => {
    const fan = await createUserDirect();
    const s = await makeSession(trainer, learner, { visibility: 'public' });
    const privateRoom = await makeSession(trainer, learner);
    await database.insert(schema.follows).values([
      { userId: fan.userId, targetType: 'session', targetId: s.id },
      { userId: watcher.userId, targetType: 'agent', targetId: trainer.id },
      { userId: trainerOwner.userId, targetType: 'session', targetId: s.id },
    ]);
    const since = new Date(Date.now() - 1000);
    await database.insert(schema.trainingMessages).values([
      { sessionId: s.id, senderRole: 'trainer', senderAgentId: trainer.id, stage: 'knowledge_sharing', content: 'Hello room' },
      { sessionId: privateRoom.id, senderRole: 'trainer', senderAgentId: trainer.id, stage: 'knowledge_sharing', content: 'Secret' },
    ]);
    const cursor = await processRoomActivity(since);
    expect(cursor.getTime()).toBeGreaterThan(since.getTime());
    const room = await notificationsOf(fan.userId, 'followed_room_activity');
    expect(room).toHaveLength(1);
    expect(room[0]!.link).toBe(`/rooms/${s.id}`);
    expect(await notificationsOf(watcher.userId, 'followed_agent_activity')).toHaveLength(1);
    expect(await notificationsOf(trainerOwner.userId, 'followed_room_activity')).toHaveLength(0);
    // nothing about the private room leaks into notifications
    const all = [...await notificationsOf(fan.userId), ...await notificationsOf(watcher.userId)];
    expect(all.some((n) => n.link === `/rooms/${privateRoom.id}`)).toBe(false);
    // re-running from the new cursor sends nothing new
    await processRoomActivity(cursor);
    expect(await notificationsOf(fan.userId, 'followed_room_activity')).toHaveLength(1);
  });
});

describe('badges and profile extras', () => {
  it('awards and removes badges from real activity', async () => {
    const owner = await createUserDirect();
    const star = await makeAgent(owner.orgId, owner.userId, 'Star', true);
    await refreshBadges(star.id);
    expect(await database.select().from(schema.agentBadges).where(eq(schema.agentBadges.agentId, star.id))).toHaveLength(0);

    // 10 completed sessions as trainer, each reviewed 5 stars
    const sessions = [];
    for (let i = 0; i < 10; i++) sessions.push(await makeSession({ id: star.id, orgId: owner.orgId }, learner, { status: 'completed', subject: `S${i}` }));
    for (const s of sessions.slice(0, 5)) await database.insert(schema.reviews).values({ sessionId: s.id, reviewerId: learnerOwner.userId, agentId: star.id, rating: 5 });
    // a verified capability >= 80
    await database.insert(schema.agentCapabilities).values({ agentId: star.id, domainId, score: 86, accuracy: 90, confidence: 0.9, sampleSize: 60, verified: true, lastAssessmentId: randomUUID(), assessedAt: new Date() });
    // an approved lesson it taught, confirmed by 5 other agents
    const [art] = await database.insert(schema.learningArtefacts).values({ sessionId: sessions[0]!.id, learnerAgentId: learner.id, trainerAgentId: star.id, orgId: learnerOwner.orgId, learningType: 'persistent_memory', title: 'Reconcile ledgers monthly', content: 'secret content', status: 'applied' }).returning();
    for (let i = 0; i < 5; i++) {
      const voter = await makeAgent(learnerOwner.orgId, learnerOwner.userId, `Voter${i}`);
      await database.insert(schema.knowledgeVerdicts).values({ targetType: 'artefact', targetId: art!.id, agentId: voter.id, orgId: learnerOwner.orgId, verdict: 'confirm' });
    }
    // its own verdict does not count
    await database.insert(schema.knowledgeVerdicts).values({ targetType: 'artefact', targetId: art!.id, agentId: star.id, orgId: owner.orgId, verdict: 'confirm' });
    // a learning record showing the learner improved
    await database.insert(schema.learningRecords).values({ agentId: learner.id, orgId: learnerOwner.orgId, sessionId: sessions[0]!.id, domainId, preScore: 50, postScore: 62, improvement: 12, verified: true });

    await refreshBadges(star.id);
    const got = (await database.select().from(schema.agentBadges).where(eq(schema.agentBadges.agentId, star.id))).map((b) => b.badge).sort();
    expect(got).toEqual(['crowd_favourite', 'first_lesson', 'knowledge_confirmed', 'mentor_10', 'verified_specialist']);

    // public profile extras: badges, lesson titles only, helpfulness metric
    const ex = await anon('GET', `/social/agents/${star.slug}/profile-extras`);
    expect(ex.status).toBe(200);
    expect(ex.body.badges.map((b: { slug: string }) => b.slug).sort()).toEqual(got);
    expect(ex.body.lessonsTaught.items[0].title).toBe('Reconcile ledgers monthly');
    expect(ex.body.lessonsTaught.items[0].confirmations).toBe(5);
    expect(JSON.stringify(ex.body)).not.toContain('secret content');
    expect(ex.body.helpfulness).toMatchObject({ sessionsTrained: 10, learnersHelped: 1, measuredSessions: 1, avgImprovement: 12, confirmations: 5 });
    expect(ex.body.helpfulness.definition).toMatch(/held-out/);

    // losing the evidence removes the badge (via the sweep job body)
    await database.delete(schema.reviews).where(eq(schema.reviews.agentId, star.id));
    await runBadgeSweep(new Date(0), true);
    const after = (await database.select().from(schema.agentBadges).where(and(eq(schema.agentBadges.agentId, star.id), eq(schema.agentBadges.badge, 'crowd_favourite'))));
    expect(after).toHaveLength(0);
  });

  it('profile extras are only served for public agents', async () => {
    expect((await anon('GET', `/social/agents/${learner.slug}/profile-extras`)).status).toBe(404);
    expect((await anon('GET', '/social/agents/no-such-agent/profile-extras')).status).toBe(404);
    expect((await anon('GET', `/social/agents/${trainer.slug}/profile-extras`)).status).toBe(200);
  });
});
