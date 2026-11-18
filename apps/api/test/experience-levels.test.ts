/**
 * Automatic topic discovery + trainer levels (provisional / established):
 *   - untagged cases are tagged only when they clearly match the agent's own tagged cases (never guessed)
 *   - readiness shows both levels; provisional trainers list at a capped price on pay-if-improved terms only
 *   - discovery replays every domain with enough real cases; opportunities + one-click listing
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createUserDirect, database, setup, teardown } from './helpers.js';
import { schema } from '../src/db/client.js';
import { drain } from '../src/jobs/queue.js';
import { adminAdjustment } from '../src/modules/wallet/ledger.js';
import { HISTORY_TEMPLATES, qualifyTrainer, seedHistory } from './fixtures/experience.js';

type Owner = Awaited<ReturnType<typeof createUserDirect>>;
const DOMAIN = 'programming';

async function makeAgent(owner: Owner, name: string, permissions: Record<string, unknown>) {
  const [p] = await database.select().from(schema.agentProviders).where(eq(schema.agentProviders.slug, 'sandbox'));
  const [a] = await database.insert(schema.agents).values({
    orgId: owner.orgId, ownerId: owner.userId, providerId: p!.id, slug: `${name.toLowerCase().replace(/\W+/g, '-')}-${Math.random().toString(36).slice(2, 8)}`,
    name, modelName: 'aix-sandbox-1', status: 'active', isPublic: true, permissions,
  }).returning();
  await database.insert(schema.agentConnections).values({ agentId: a!.id, method: 'sandbox', status: 'connected' });
  return a!;
}

beforeAll(async () => { await setup(); });
afterAll(async () => { await drain(); await new Promise((r) => setTimeout(r, 100)); await teardown(); });

describe('trainer readiness checklist', () => {
  it('shows both trainer levels, counts untagged cases, and tagging them moves the agent forward', async () => {
    const owner = await createUserDirect();
    const agent = await makeAgent(owner, 'Readiness Bot', { allowTraining: true });
    const hist = HISTORY_TEMPLATES.flatMap((t) => Array.from({ length: 5 }, (_, i) => ({ situation: t.situation(i + 30), action: t.action, reasoning: t.reasoning, outcome: t.outcome, lesson: t.lesson, result: t.result, occurredAt: new Date(Date.now() - (i + 1) * 20 * 86_400_000).toISOString() })));
    expect((await owner.request('POST', `/experience/agents/${agent.id}/import`, { content: JSON.stringify(hist) })).body.created).toBe(25);

    const before = await owner.request('GET', `/experience/agents/${agent.id}/readiness?domain=${DOMAIN}`);
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ qualified: false, level: 'none', untaggedCount: 25 }); // nothing tagged yet: nothing to match against, nothing guessed
    expect(before.body.checks.find((c: { key: string }) => c.key === 'cases')).toMatchObject({ okProvisional: false, okEstablished: false, current: 0, provisional: 10, established: 20 });

    const tagged = await owner.request('POST', `/experience/agents/${agent.id}/records/tag-domain`, { domain: DOMAIN });
    expect(tagged.body).toMatchObject({ tagged: 25, domain: DOMAIN });
    const after = await owner.request('GET', `/experience/agents/${agent.id}/readiness?domain=${DOMAIN}`);
    expect(after.body.untaggedCount).toBe(0);
    expect(after.body.checks.find((c: { key: string }) => c.key === 'cases')).toMatchObject({ okProvisional: true, okEstablished: true, current: 25 });
    expect(after.body.checks.find((c: { key: string }) => c.key === 'replay').okProvisional).toBe(false); // still needs a replay
    expect(after.body).toMatchObject({ qualified: false, level: 'none' });
    expect(after.body.missing.join(' ')).toMatch(/replay/);

    expect((await (await createUserDirect()).request('GET', `/experience/agents/${agent.id}/readiness?domain=${DOMAIN}`)).status).toBe(404);
  });
});

describe('automatic topic sorting', () => {
  it("tags an untagged case only when it clearly matches the agent's own tagged cases; never guesses", async () => {
    const owner = await createUserDirect();
    const agent = await makeAgent(owner, 'Sorter', {});
    const tagged = HISTORY_TEMPLATES.flatMap((t) => [0, 1, 2].map((i) => ({ domain: DOMAIN, situation: t.situation(i), action: t.action, outcome: t.outcome, lesson: t.lesson, result: t.result, occurredAt: new Date(Date.now() - (i + 1) * 30 * 86_400_000).toISOString() })));
    expect((await owner.request('POST', `/experience/agents/${agent.id}/records`, { experiences: tagged })).body.created).toHaveLength(15);
    const t0 = HISTORY_TEMPLATES[0]!;
    const similar = { situation: t0.situation(9), action: t0.action, outcome: t0.outcome, lesson: t0.lesson, result: 'success', occurredAt: '2025-03-03' };
    const unrelated = { situation: 'Gardening club asked which tomato varieties suit a shaded balcony in monsoon season.', action: 'Recommended cherry tomatoes in grow bags with weekly feeding.', outcome: 'Good harvest.', result: 'success', occurredAt: '2025-03-04' };
    const r = await owner.request('POST', `/experience/agents/${agent.id}/records`, { experiences: [similar, unrelated] });
    const bySit = (t: string) => r.body.created.find((e: { situation: string }) => e.situation === t);
    expect(bySit(similar.situation)).toMatchObject({ domain: DOMAIN, domainAuto: true });
    expect(bySit(unrelated.situation)).toMatchObject({ domain: 'general', domainAuto: false });
  });
});

describe('trainer levels: provisional and established', () => {
  it('provisional trainers list at a capped price on pay-if-improved terms; established have no such limits', async () => {
    const owner = await createUserDirect();
    const agent = await makeAgent(owner, 'Rising Trainer', { allowTraining: true });
    await seedHistory(agent, DOMAIN, { perTemplate: 3, months: 12 }); // 15 real cases: provisional-sized
    await database.insert(schema.experienceReplays).values({
      agentId: agent.id, orgId: agent.orgId, sourceAgentId: agent.id, domainSlug: DOMAIN, purpose: 'self', status: 'completed', mode: 'sync',
      score: 55, itemsTotal: 10, itemsGraded: 10, method: 'deterministic', startedAt: new Date(), completedAt: new Date(),
    });
    const base = { agentId: agent.id, title: 'Incident response coaching', domainSlug: DOMAIN, durationMinutes: 30 };
    const ready = await owner.request('GET', `/experience/agents/${agent.id}/readiness?domain=${DOMAIN}`);
    expect(ready.body).toMatchObject({ qualified: true, level: 'provisional', terms: { maxPriceCredits: 300, settlement: 'on_improvement' } });
    expect(ready.body.nextMissing.join(' ')).toMatch(/20 experiences/);

    const dear = await owner.request('POST', '/marketplace/listings', { ...base, priceCredits: 500, settlementMode: 'on_improvement', minImprovement: 5 });
    expect(dear.status).toBe(422);
    expect(dear.body.error.details.reason).toBe('provisional_terms');
    const unconditional = await owner.request('POST', '/marketplace/listings', { ...base, priceCredits: 200, settlementMode: 'on_completion' });
    expect(unconditional.status).toBe(422);
    const ok = await owner.request('POST', '/marketplace/listings', { ...base, priceCredits: 200, settlementMode: 'on_improvement', minImprovement: 5 });
    expect(ok.status).toBe(201);
    expect(ok.body.trainerLevel).toBe('provisional');
    expect((await owner.request('PATCH', `/marketplace/listings/${ok.body.id}`, { priceCredits: 500 })).status).toBe(422);

    // the training request re-checks the level: a listing outside provisional terms cannot sell
    await database.update(schema.marketplaceListings).set({ priceCredits: 500, settlementMode: 'on_completion' }).where(eq(schema.marketplaceListings.id, ok.body.id));
    const learner = await makeAgent(owner, 'Buyer', { allowLearning: true });
    await adminAdjustment({ orgId: owner.orgId, amount: 2000, reason: 'test', actorUserId: owner.userId });
    const req = await owner.request('POST', '/training/requests', { learnerAgentId: learner.id, trainerAgentId: agent.id, domainSlug: DOMAIN, objectives: [], listingId: ok.body.id });
    expect(req.status).toBe(422);
    expect(req.body.error.details.reason).toBe('provisional_terms');

    // an established trainer (30 cases, replay 80) has no such limits
    const vet = await makeAgent(owner, 'Veteran', { allowTraining: true });
    await qualifyTrainer(vet, DOMAIN);
    const est = await owner.request('POST', '/marketplace/listings', { ...base, agentId: vet.id, priceCredits: 900, settlementMode: 'on_completion' });
    expect(est.status).toBe(201);
    expect(est.body.trainerLevel).toBe('established');
  });
});

describe('topic discovery and one-click listing', () => {
  it('replays every domain with enough real cases, shows what the agent can train in, and lists in one click', async () => {
    const owner = await createUserDirect();
    const agent = await makeAgent(owner, 'Multi Domain Pro', { allowTraining: true });
    await seedHistory(agent, DOMAIN, { perTemplate: 6, months: 26 });
    const security = HISTORY_TEMPLATES.map((t) => ({ ...t, situation: (i: number) => `Security review: ${t.situation(i + 50)}` }));
    await seedHistory(agent, 'cybersecurity', { perTemplate: 2, months: 26, templates: security }); // 10 cases: provisional-sized

    const found = await owner.request('POST', `/experience/agents/${agent.id}/discover`);
    expect(found.status).toBe(202);
    expect(found.body.replays.map((r: { domain: string }) => r.domain).sort()).toEqual(['all', 'cybersecurity', DOMAIN]);
    await drain();
    const again = await owner.request('POST', `/experience/agents/${agent.id}/discover`);
    expect(again.body.replays).toEqual([]); // cooldown: nothing is replayed twice
    expect(again.body.skipped.length).toBeGreaterThan(0);

    const opp = await owner.request('GET', `/experience/agents/${agent.id}/opportunities`);
    expect(opp.body.allowTraining).toBe(true);
    const by = Object.fromEntries(opp.body.items.map((i: { domain: string }) => [i.domain, i]));
    expect(by[DOMAIN]).toMatchObject({ qualified: true, level: 'established', listed: false });
    expect(by.cybersecurity.qualified).toBe(true);

    const q1 = await owner.request('POST', `/experience/agents/${agent.id}/quick-list`, { domain: DOMAIN });
    expect(q1.status).toBe(201);
    expect(q1.body).toMatchObject({ coachingMode: 'recorded', settlementMode: 'on_improvement', trainerLevel: 'established', priceCredits: 400 });
    expect((await owner.request('POST', `/experience/agents/${agent.id}/quick-list`, { domain: DOMAIN })).status).toBe(409);
    const no = await owner.request('POST', `/experience/agents/${agent.id}/quick-list`, { domain: 'healthcare' });
    expect(no.status).toBe(422);
    expect(no.body.error.details.reason).toBe('experience_required');
    expect((await owner.request('GET', `/experience/agents/${agent.id}/opportunities`)).body.items.find((i: { domain: string }) => i.domain === DOMAIN).listed).toBe(true);
  });
});
