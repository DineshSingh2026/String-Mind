import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '../src/db/client.js';
import { app, createUserDirect, database, setup, teardown } from './helpers.js';
import { csvCell, toCsv } from '../src/modules/analytics/csv.js';
import { qualifyTrainer } from './fixtures/experience.js';

let providerId: string;
const domainIds: Record<string, string> = {};

async function makeAgent(orgId: string, ownerId: string, opts: Partial<typeof schema.agents.$inferInsert> = {}) {
  const slug = `agent-${Math.random().toString(36).slice(2, 10)}`;
  const [a] = await database.insert(schema.agents).values({
    orgId, ownerId, providerId, slug, name: opts.name ?? slug, modelName: 'aix-sandbox-1', status: 'active', isPublic: true,
    permissions: { allowTraining: true, allowLearning: true }, ...opts,
  }).returning();
  return a!;
}

async function addCap(agentId: string, domain: string, score: number, verified: boolean) {
  await database.insert(schema.agentCapabilities).values({
    agentId, domainId: domainIds[domain]!, score, accuracy: score, confidence: verified ? 0.9 : 0.4, sampleSize: verified ? 40 : 5,
    verified, lastAssessmentId: crypto.randomUUID(), assessedAt: new Date(),
  });
}

async function makeSession(learner: { id: string; orgId: string }, trainer: { id: string; orgId: string }, opts: Partial<typeof schema.trainingSessions.$inferInsert> = {}) {
  const [s] = await database.insert(schema.trainingSessions).values({
    learnerAgentId: learner.id, trainerAgentId: trainer.id, learnerOrgId: learner.orgId, trainerOrgId: trainer.orgId,
    domainId: domainIds.programming!, subject: 'Debugging, "edge" cases', status: 'completed', ...opts,
  }).returning();
  return s!;
}

beforeAll(async () => {
  await setup();
  const [p] = await database.select().from(schema.agentProviders).where(eq(schema.agentProviders.slug, 'sandbox'));
  providerId = p!.id;
  for (const d of await database.select().from(schema.capabilityDomains)) domainIds[d.slug] = d.id;
});
afterAll(teardown);

describe('public stats', () => {
  it('returns real counts (0 on empty DB)', async () => {
    const r = await app.inject({ method: 'GET', url: '/public/stats' });
    expect(r.statusCode).toBe(200);
    const s = r.json();
    expect(s).toMatchObject({ agents: 0, verifiedAgents: 0, completedSessions: 0, knowledgeListings: 0, domainsWithVerifiedAgents: 0 });
    expect(s.domains).toBeGreaterThan(0); // seeded benchmark domains are real
    const f = await app.inject({ method: 'GET', url: '/public/featured-agents' });
    expect(f.json().items).toEqual([]);
  });
});

describe('marketplace', () => {
  let owner: Awaited<ReturnType<typeof createUserDirect>>;
  let verifiedAgent: typeof schema.agents.$inferSelect;
  let claimedAgent: typeof schema.agents.$inferSelect;
  let privateAgent: typeof schema.agents.$inferSelect;

  beforeAll(async () => {
    owner = await createUserDirect();
    verifiedAgent = await makeAgent(owner.orgId, owner.userId, { name: 'Verified Coder' });
    await addCap(verifiedAgent.id, 'programming', 82, true);
    // claims everything, has a high but UNVERIFIED score
    claimedAgent = await makeAgent(owner.orgId, owner.userId, { name: 'Claims Everything', claimedDomains: ['programming', 'finance'], overallScore: 99 });
    await addCap(claimedAgent.id, 'programming', 99, false);
    const ent = await createUserDirect({ orgType: 'enterprise' });
    await database.update(schema.organisations).set({ privateNetwork: true }).where(eq(schema.organisations.id, ent.orgId));
    privateAgent = await makeAgent(ent.orgId, ent.userId, { name: 'Private Net Agent' });
    await addCap(privateAgent.id, 'programming', 95, true);
  });

  it('ranks verified above unverified/claimed and hides private-network agents', async () => {
    const viewer = await createUserDirect();
    for (const sort of ['score', 'popular']) {
      const r = await viewer.request('GET', `/marketplace/agents?sort=${sort}`);
      expect(r.status).toBe(200);
      const names = r.body.items.map((i: { name: string }) => i.name);
      expect(names).not.toContain('Private Net Agent');
      expect(names.indexOf('Verified Coder')).toBeLessThan(names.indexOf('Claims Everything'));
    }
    const dom = await viewer.request('GET', '/marketplace/agents?domain=programming');
    expect(dom.body.items.map((i: { name: string }) => i.name)).toEqual(['Verified Coder']);
    const fin = await viewer.request('GET', '/marketplace/agents?domain=finance');
    expect(fin.body.total).toBe(0); // claimed domains never match filters
    const all = await viewer.request('GET', '/marketplace/agents');
    const claimed = all.body.items.find((i: { name: string }) => i.name === 'Claims Everything');
    expect(claimed.overallScore).toBeNull();
    expect(claimed.claimedDomains.map((d: { slug: string; claimed: boolean }) => [d.slug, d.claimed])).toEqual([['programming', true], ['finance', true]]);
    expect((await viewer.request('GET', `/marketplace/agents/${privateAgent.slug}`)).status).toBe(404);
    const prof = await viewer.request('GET', `/marketplace/agents/${verifiedAgent.slug}`);
    expect(prof.status).toBe(200);
    expect(prof.body.verifiedDomains[0]).toMatchObject({ slug: 'programming', score: 82 });
    const cats = await viewer.request('GET', '/marketplace/categories');
    expect(cats.body.find((c: { slug: string }) => c.slug === 'programming').agentCount).toBe(1);
  });

  it('blocks listing creation without real, proven experience — a verified model score alone does not qualify', async () => {
    const base = { title: 'Learn debugging', domainSlug: 'programming', priceCredits: 100, durationMinutes: 30 };
    const bad = await owner.request('POST', '/marketplace/listings', { ...base, agentId: claimedAgent.id });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details.reason).toBe('experience_required');
    // verified capability 82, but no recorded experience yet
    const noExp = await owner.request('POST', '/marketplace/listings', { ...base, agentId: verifiedAgent.id });
    expect(noExp.status).toBe(422);
    expect(noExp.body.error.details.reason).toBe('experience_required');
    await qualifyTrainer(verifiedAgent, 'programming');
    const none = await owner.request('POST', '/marketplace/listings', { ...base, agentId: verifiedAgent.id, domainSlug: 'finance' });
    expect(none.status).toBe(422);
    const ok = await owner.request('POST', '/marketplace/listings', { ...base, agentId: verifiedAgent.id });
    expect(ok.status).toBe(201);
  });

  it('allows a review only after a completed session, once', async () => {
    const learnerOwner = await createUserDirect();
    const learner = await makeAgent(learnerOwner.orgId, learnerOwner.userId, { isPublic: false });
    const active = await makeSession(learner, verifiedAgent, { status: 'active' });
    expect((await learnerOwner.request('POST', '/marketplace/reviews', { sessionId: active.id, rating: 5, body: 'x' })).status).toBe(422);
    const done = await makeSession(learner, verifiedAgent, { improvement: 12, settlementStatus: 'settled' });
    expect((await owner.request('POST', '/marketplace/reviews', { sessionId: done.id, rating: 5 })).status).toBe(403); // trainer side
    const r1 = await learnerOwner.request('POST', '/marketplace/reviews', { sessionId: done.id, rating: 4, body: 'Great' });
    expect(r1.status).toBe(201);
    expect((await learnerOwner.request('POST', '/marketplace/reviews', { sessionId: done.id, rating: 5 })).status).toBe(409);
    const [rep] = await database.select().from(schema.agentReputation).where(eq(schema.agentReputation.agentId, verifiedAgent.id));
    expect(rep!.ratingCount).toBe(1);
    expect(rep!.avgRating).toBe(4);
    const notes = await database.select().from(schema.notifications).where(eq(schema.notifications.userId, owner.userId));
    expect(notes.some((n) => n.type === 'new_review')).toBe(true);
  });
});

describe('admin', () => {
  it('rejects non-admins with 403', async () => {
    const u = await createUserDirect();
    for (const url of ['/admin/overview', '/admin/users', '/admin/system-health', '/admin/audit']) {
      expect((await u.request('GET', url)).status).toBe(403);
    }
    expect((await u.request('POST', `/admin/agents/${crypto.randomUUID()}/suspend`, { reason: 'nope' })).status).toBe(403);
  });

  it('suspending an agent hides it from the marketplace and is audited', async () => {
    const admin = await createUserDirect({ platformRole: 'super_admin' });
    const o = await createUserDirect();
    const a = await makeAgent(o.orgId, o.userId, { name: 'Soon Suspended' });
    await addCap(a.id, 'mathematics', 90, true);
    const before = await app.inject({ method: 'GET', url: '/marketplace/agents?domain=mathematics' });
    expect(before.json().items.map((i: { id: string }) => i.id)).toContain(a.id);
    const r = await admin.request('POST', `/admin/agents/${a.id}/suspend`, { reason: 'Policy violation' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'suspended', isPublic: false });
    const after = await app.inject({ method: 'GET', url: '/marketplace/agents?domain=mathematics' });
    expect(after.json().items.map((i: { id: string }) => i.id)).not.toContain(a.id);
    const logs = await database.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, 'admin.agent.suspend'));
    expect(logs.find((l) => l.targetId === a.id)).toMatchObject({ actorType: 'admin', actorUserId: admin.userId });
    const health = await admin.request('GET', '/admin/system-health');
    expect(health.status).toBe(200);
    expect(health.body.db.ok).toBe(true);
  });
});

describe('analytics', () => {
  it('dashboard numbers match inserted data', async () => {
    const me = await createUserDirect();
    const other = await createUserDirect();
    const mine = await makeAgent(me.orgId, me.userId, { isPublic: false });
    await makeAgent(me.orgId, me.userId, { isPublic: false, status: 'draft' });
    const theirs = await makeAgent(other.orgId, other.userId);
    await makeSession({ id: mine.id, orgId: me.orgId }, theirs, { improvement: 10, settlementStatus: 'settled', feeCredits: 200, trainerEarningsCredits: 160, commissionCredits: 40, endedAt: new Date() });
    await makeSession({ id: mine.id, orgId: me.orgId }, theirs, { improvement: 20, settlementStatus: 'settled', feeCredits: 100, trainerEarningsCredits: 80, commissionCredits: 20, endedAt: new Date() });
    await makeSession(theirs, { id: mine.id, orgId: me.orgId }, { improvement: 5, settlementStatus: 'settled', feeCredits: 50, trainerEarningsCredits: 40, commissionCredits: 10, endedAt: new Date() });
    await makeSession({ id: mine.id, orgId: me.orgId }, theirs, { status: 'failed', endedAt: new Date() });
    const r = await me.request('GET', '/analytics/dashboard?period=30d');
    expect(r.status).toBe(200);
    expect(r.body.totals).toMatchObject({
      agents: 2, activeAgents: 1, sessions: 4, completedSessions: 3, avgImprovement: 15, totalEarnings: 40, trainingSpend: 300, availableCredits: 0, successRate: 75,
    });
    expect(Object.values(r.body.deltas).every((v) => v === null)).toBe(true); // no prior-period data
    expect(r.body.growth).toHaveLength(30);
    const today = new Date().toISOString().slice(0, 10);
    expect(r.body.growth.find((g: { date: string }) => g.date === today)).toMatchObject({ sessions: 4, earnings: 40 });
    expect(r.body.growth.reduce((s: number, g: { sessions: number }) => s + g.sessions, 0)).toBe(4);

    const csv = await app.inject({ method: 'GET', url: '/analytics/export?report=sessions&format=csv', headers: { cookie: me.cookie, 'x-aix-org': me.orgId } });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toMatch(/attachment; filename="aix-sessions-.*\.csv"/);
    expect(csv.body).toContain('"Debugging, ""edge"" cases"');
    expect(csv.body.trim().split('\r\n')).toHaveLength(5);
  });

  it('escapes CSV cells', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(null)).toBe('');
    expect(toCsv(['a', 'b'], [[1, 'x,y']])).toBe('a,b\r\n1,"x,y"\r\n');
  });
});
