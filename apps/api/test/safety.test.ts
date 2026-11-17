import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { app, createUserDirect, database, loginAdmin, setup, teardown } from './helpers.js';
import { schema } from '../src/db/client.js';
import { resetAgentTokenRateLimits } from '../src/lib/agent-rate-limit.js';

beforeAll(async () => { await setup(); });
afterAll(async () => { await teardown(); });

type Owner = Awaited<ReturnType<typeof createUserDirect>>;

async function makeAgent(owner: Owner, name: string, isPublic = true) {
  const [p] = await database.select().from(schema.agentProviders).where(eq(schema.agentProviders.slug, 'sandbox'));
  const [a] = await database.insert(schema.agents).values({
    orgId: owner.orgId, ownerId: owner.userId, providerId: p!.id, slug: `${name.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}`,
    name, modelName: 'aix-sandbox-1', status: 'active', isPublic,
  }).returning();
  return a!;
}

/** Social content owned by `owner`: a debate with one message, a public + a private room, a hive lesson and a verdict. */
async function makeContent(owner: Owner) {
  const a = await makeAgent(owner, 'Alpha');
  const b = await makeAgent(owner, 'Beta');
  const [domain] = await database.select().from(schema.capabilityDomains).limit(1);
  const [debate] = await database.insert(schema.debates).values({
    title: 'Is honesty scored?', prompt: 'Motion: calibrated answers beat confident ones', createdBy: owner.userId, orgId: owner.orgId, agentAId: a.id, agentBId: b.id,
  }).returning();
  const [message] = await database.insert(schema.debateMessages).values({ debateId: debate!.id, agentId: a.id, content: 'Buy cheap pills at spam.example' }).returning();
  const room = async (visibility: string) => (await database.insert(schema.trainingSessions).values({
    learnerAgentId: a.id, trainerAgentId: b.id, learnerOrgId: owner.orgId, trainerOrgId: owner.orgId, domainId: domain!.id, subject: `Room ${visibility}`, visibility,
  }).returning())[0]!;
  const publicRoom = await room('public');
  const privateRoom = await room('private');
  const [lesson] = await database.insert(schema.hiveLessons).values({ sourceType: 'debate', sourceId: debate!.id, title: 'Lesson', content: 'Always cite', agentIds: [a.id] }).returning();
  const [verdict] = await database.insert(schema.knowledgeVerdicts).values({ targetType: 'hive_lesson', targetId: lesson!.id, agentId: b.id, orgId: owner.orgId, verdict: 'dispute', note: 'wrong' }).returning();
  return { debate: debate!, message: message!, publicRoom, privateRoom, lesson: lesson!, verdict: verdict! };
}

describe('reports for social content', () => {
  let owner: Owner;
  let c: Awaited<ReturnType<typeof makeContent>>;
  beforeAll(async () => { owner = await createUserDirect(); c = await makeContent(owner); });

  it('accepts every new target type once per user; duplicates get 409 already_reported', async () => {
    const reporter = await createUserDirect();
    const targets: [string, string][] = [
      ['session', c.publicRoom.id], ['debate', c.debate.id], ['debate_message', c.message.id], ['hive_lesson', c.lesson.id], ['verdict', c.verdict.id],
    ];
    for (const [targetType, targetId] of targets) {
      const r = await reporter.request('POST', '/owner/reports', { targetType, targetId, reason: 'spam', details: 'looks like spam' });
      expect(r.status, `${targetType}: ${JSON.stringify(r.body)}`).toBe(201);
    }
    const dupe = await reporter.request('POST', '/owner/reports', { targetType: 'debate', targetId: c.debate.id, reason: 'harassment' });
    expect(dupe.status).toBe(409);
    expect(dupe.body.error.code).toBe('already_reported');
    const mine = await reporter.request('GET', `/owner/reports/mine?targetType=debate&targetId=${c.debate.id}`);
    expect(mine.body.reported).toBe(true);
    // a different user can report the same item
    const second = await createUserDirect();
    expect((await second.request('POST', '/owner/reports', { targetType: 'debate', targetId: c.debate.id, reason: 'misinformation' })).status).toBe(201);
  });

  it('validates target existence, visibility, reason and auth', async () => {
    const reporter = await createUserDirect();
    const missing = await reporter.request('POST', '/owner/reports', { targetType: 'debate', targetId: '00000000-0000-0000-0000-000000000000', reason: 'spam' });
    expect(missing.status).toBe(404);
    // private room of another org: not reportable (and its existence is not confirmed)
    expect((await reporter.request('POST', '/owner/reports', { targetType: 'session', targetId: c.privateRoom.id, reason: 'spam' })).status).toBe(404);
    // ...but a participant org can report it
    expect((await owner.request('POST', '/owner/reports', { targetType: 'session', targetId: c.privateRoom.id, reason: 'unsafe' })).status).toBe(201);
    expect((await reporter.request('POST', '/owner/reports', { targetType: 'debate', targetId: c.debate.id, reason: 'because' })).status).toBe(400);
    expect((await reporter.request('POST', '/owner/reports', { targetType: 'debate', targetId: c.debate.id, reason: 'other' })).status).toBe(400);
    expect((await reporter.request('POST', '/owner/reports', { targetType: 'nonsense', targetId: c.debate.id, reason: 'spam' })).status).toBe(400);
    const anon = await app.inject({ method: 'POST', url: '/owner/reports', payload: { targetType: 'debate', targetId: c.debate.id, reason: 'spam' } });
    expect(anon.statusCode).toBe(401);
  });

  it('rate-limits report creation per user (10/min)', async () => {
    const spammer = await createUserDirect();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      // distinct (missing) targets → 404s still count towards the limit
      statuses.push((await spammer.request('POST', '/owner/reports', { targetType: 'debate', targetId: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`, reason: 'spam' })).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 404)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });
});

describe('admin removal of social content', () => {
  it('lists open reports of all types with previews; remove resolves reports, notifies the owner org and is audited; restore works', async () => {
    const owner = await createUserDirect();
    const c = await makeContent(owner);
    const reporter = await createUserDirect();
    const rep = await reporter.request('POST', '/owner/reports', { targetType: 'debate_message', targetId: c.message.id, reason: 'spam', details: 'pill spam' });
    expect(rep.status).toBe(201);
    const admin = await loginAdmin();

    const list = await admin.request('GET', '/admin/reports?status=open&targetType=debate_message');
    expect(list.status).toBe(200);
    const item = list.body.items.find((i: any) => i.id === rep.body.id);
    expect(item.removable).toBe(true);
    expect(item.target).toMatchObject({ excerpt: 'Buy cheap pills at spam.example', link: `/app/debates/${c.debate.id}`, moderation: 'visible' });

    // non-admins cannot moderate
    expect((await owner.request('POST', `/admin/content/debate_message/${c.message.id}/remove`)).status).toBe(403);

    const res = await admin.request('POST', `/admin/reports/${rep.body.id}/resolve`, { action: 'remove_content', note: 'spam link' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('actioned');
    const [m] = await database.select().from(schema.debateMessages).where(eq(schema.debateMessages.id, c.message.id));
    expect(m!.moderation).toBe('removed');
    const notes = await database.select().from(schema.notifications).where(and(eq(schema.notifications.userId, owner.userId), eq(schema.notifications.type, 'content_removed')));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toContain('spam link');
    const [log] = await database.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, 'admin.content.remove'), eq(schema.auditLogs.targetId, c.message.id)));
    expect(log).toMatchObject({ actorType: 'admin', targetType: 'debate_message', orgId: owner.orgId });

    const removed = await admin.request('GET', '/admin/content/removed?type=debate_message');
    expect(removed.body.items.map((i: any) => i.id)).toContain(c.message.id);

    const restore = await admin.request('POST', `/admin/content/debate_message/${c.message.id}/restore`, { note: 'false positive' });
    expect(restore.status).toBe(200);
    const [m2] = await database.select().from(schema.debateMessages).where(eq(schema.debateMessages.id, c.message.id));
    expect(m2!.moderation).toBe('visible');
  });

  it('removes every removable type directly and resolves all open reports on the target', async () => {
    const owner = await createUserDirect();
    const c = await makeContent(owner);
    const admin = await loginAdmin();
    const r1 = await createUserDirect();
    const r2 = await createUserDirect();
    await r1.request('POST', '/owner/reports', { targetType: 'session', targetId: c.publicRoom.id, reason: 'unsafe' });
    await r2.request('POST', '/owner/reports', { targetType: 'session', targetId: c.publicRoom.id, reason: 'spam' });

    const cases: [string, string, () => Promise<string | undefined>][] = [
      ['session', c.publicRoom.id, async () => (await database.select().from(schema.trainingSessions).where(eq(schema.trainingSessions.id, c.publicRoom.id)))[0]?.moderation],
      ['debate', c.debate.id, async () => (await database.select().from(schema.debates).where(eq(schema.debates.id, c.debate.id)))[0]?.moderation],
      ['hive_lesson', c.lesson.id, async () => (await database.select().from(schema.hiveLessons).where(eq(schema.hiveLessons.id, c.lesson.id)))[0]?.moderation],
      ['verdict', c.verdict.id, async () => (await database.select().from(schema.knowledgeVerdicts).where(eq(schema.knowledgeVerdicts.id, c.verdict.id)))[0]?.moderation],
    ];
    for (const [type, id, read] of cases) {
      const r = await admin.request('POST', `/admin/content/${type}/${id}/remove`, {});
      expect(r.status, type).toBe(200);
      expect(await read()).toBe('removed');
    }
    const open = await database.select().from(schema.reports).where(and(eq(schema.reports.targetId, c.publicRoom.id), eq(schema.reports.status, 'open')));
    expect(open).toHaveLength(0);
    // a second removal is idempotent and does not notify again
    const before = (await database.select().from(schema.notifications).where(eq(schema.notifications.userId, owner.userId))).length;
    const again = await admin.request('POST', `/admin/content/debate/${c.debate.id}/remove`, {});
    expect(again.body.changed).toBe(false);
    expect((await database.select().from(schema.notifications).where(eq(schema.notifications.userId, owner.userId))).length).toBe(before);
    expect((await admin.request('POST', `/admin/content/debate/00000000-0000-0000-0000-000000000000/remove`, {})).status).toBe(404);
  });

  it('existing report types keep working (hide_target on an agent)', async () => {
    const owner = await createUserDirect();
    const agent = await makeAgent(owner, 'Visible');
    const reporter = await createUserDirect();
    const rep = await reporter.request('POST', '/owner/reports', { targetType: 'agent', targetId: agent.id, reason: 'impersonation', details: 'pretends to be someone' });
    expect(rep.status).toBe(201);
    const admin = await loginAdmin();
    const res = await admin.request('POST', `/admin/reports/${rep.body.id}/resolve`, { action: 'hide_target' });
    expect(res.status).toBe(200);
    const [a] = await database.select().from(schema.agents).where(eq(schema.agents.id, agent.id));
    expect(a!.isPublic).toBe(false);
  });
});

describe('agent-token rate limit', () => {
  const prev = process.env.AGENT_TOKEN_RATE_LIMIT_PER_MIN;
  afterEach(() => { if (prev === undefined) delete process.env.AGENT_TOKEN_RATE_LIMIT_PER_MIN; else process.env.AGENT_TOKEN_RATE_LIMIT_PER_MIN = prev; resetAgentTokenRateLimits(); });

  it('returns 429 with retry-after per token once the limit is hit; other tokens are unaffected', async () => {
    process.env.AGENT_TOKEN_RATE_LIMIT_PER_MIN = '5';
    resetAgentTokenRateLimits();
    const owner = await createUserDirect();
    const r = await owner.request('POST', '/agents', { name: 'Limited', providerSlug: 'prompt-connect', connection: { method: 'prompt' } });
    const claim = await app.inject({ method: 'POST', url: '/agent-api/claim', payload: { claimCode: r.body.connect.claimCode } });
    const token = JSON.parse(claim.body).agentToken as string;
    const hit = () => app.inject({ method: 'POST', url: '/agent-api/heartbeat', headers: { authorization: `Bearer ${token}` } });
    for (let i = 0; i < 5; i++) {
      const ok = await hit();
      expect(ok.statusCode).toBe(200);
      expect(Number(ok.headers['x-ratelimit-remaining'])).toBe(4 - i);
    }
    const limited = await hit();
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(JSON.parse(limited.body).error.code).toBe('rate_limited');
    // invalid tokens are throttled per token value as well, independently
    const bogus = await app.inject({ method: 'GET', url: '/agent-api/me', headers: { authorization: 'Bearer sm_at_bogus' } });
    expect(bogus.statusCode).toBe(401);
  });
});
