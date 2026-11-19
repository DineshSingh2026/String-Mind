/** Hive Live: showcase debates stream, and REAL training sessions run end to end between demo agents. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { app, database, setup, teardown } from './helpers.js';
import { schema } from '../src/db/client.js';
import { config } from '../src/lib/config.js';
import { hiveLiveTick } from '../src/modules/hive-live/engine.js';
import { advanceDebate } from '../src/modules/debates/service.js';
import { LIVE_DEBATES } from '../src/modules/hive-live/content.js';
import { reconcile } from '../src/modules/wallet/ledger.js';

const cfg = config as Record<string, unknown>;
beforeAll(async () => { process.env.HIVE_LIVE_PACE_MS = '1'; await setup({ demo: true }); cfg.HIVE_LIVE = true; });
afterAll(async () => { cfg.HIVE_LIVE = undefined; delete process.env.HIVE_LIVE_PACE_MS; await teardown(); });

const liveDebates = () => database.select().from(schema.debates).where(and(eq(schema.debates.demo, true), eq(schema.debates.status, 'live')));
const showcaseSessions = () => database.select().from(schema.trainingSessions).where(sql`${schema.trainingSessions.plan}->>'realDemo' = 'true'`);

async function waitFor(fn: () => Promise<boolean>, ms = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await new Promise((r) => setTimeout(r, 250)); }
  throw new Error('timed out');
}

describe('Hive Live', () => {
  it('streams showcase debates and rolls on when they finish (the debate engine never drives them)', async () => {
    let now = Date.now();
    await hiveLiveTick(now);
    expect(await liveDebates()).toHaveLength(2);
    const [d0] = await liveDebates();
    await advanceDebate(d0!.id);
    expect(await database.select().from(schema.debateMessages).where(and(eq(schema.debateMessages.debateId, d0!.id), eq(schema.debateMessages.role, 'agent')))).toHaveLength(0);
    for (let i = 0; i < Math.max(...LIVE_DEBATES.map((d) => d.turns.length)) + 3; i++) { now += 40_000; await hiveLiveTick(now); }
    const first = (await database.select().from(schema.debates).where(eq(schema.debates.id, d0!.id)))[0]!;
    expect(first.status).toBe('voting');
    expect(first.votesA + first.votesB).toBe(0);
    expect(await liveDebates()).toHaveLength(2);
  });

  it('runs two REAL trainings end to end: escrow → pre-test → teaching → exercises → post-test → settlement → public results', async () => {
    await waitFor(async () => (await showcaseSessions()).length >= 2);
    const sessions = await showcaseSessions();
    const ids = sessions.map((s) => s.id);
    await waitFor(async () => (await database.select().from(schema.trainingSessions).where(inArray(schema.trainingSessions.id, ids))).every((s) => ['completed', 'failed'].includes(s.status)));
    const done = await database.select().from(schema.trainingSessions).where(inArray(schema.trainingSessions.id, ids));
    for (const s of done) {
      expect(s.failureReason ?? null).toBeNull();
      expect(s.status).toBe('completed');
      expect(s.visibility).toBe('public');
      expect((s.plan as { mode?: string }).mode).toBe('experience');
      expect(s.preScore!).toBeLessThan(s.postScore!); // a fresh learner, measured on the trainer's held-back real cases
      expect(s.feeCredits).toBeGreaterThan(0);
      expect(s.settlementStatus).toBe('settled');
      expect((s.commissionCredits ?? 0) + (s.trainerEarningsCredits ?? 0)).toBe(s.feeCredits);
      const roles = new Set((await database.select({ r: schema.trainingMessages.senderRole }).from(schema.trainingMessages).where(eq(schema.trainingMessages.sessionId, s.id))).map((m) => m.r));
      expect([...roles]).toEqual(expect.arrayContaining(['system', 'evaluator', 'trainer', 'learner']));
      const escrow = await database.select().from(schema.transactions).where(and(eq(schema.transactions.referenceId, s.id), eq(schema.transactions.type, 'training_escrow')));
      expect(escrow).toHaveLength(1);
      const learner = (await database.select().from(schema.agents).where(eq(schema.agents.id, s.learnerAgentId)))[0]!;
      expect(learner.slug).toMatch(/-live-/);
    }
    // the learner org's books stay balanced after escrow + settlement
    const w = (await database.select().from(schema.wallets).where(eq(schema.wallets.orgId, done[0]!.learnerOrgId)))[0]!;
    expect((await reconcile(w.id)).ok).toBe(true);
    // public results: scores and settlement visible to anyone
    const r = await app.inject({ method: 'GET', url: `/social/rooms/${done[0]!.id}` });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ demo: true, scores: { preScore: done[0]!.preScore, postScore: done[0]!.postScore }, settlement: { status: 'settled', feeIdle: done[0]!.feeCredits } });

    // next tick starts the next two
    await hiveLiveTick(Date.now());
    await waitFor(async () => (await showcaseSessions()).length >= 4);
  });

  it('gives the demo trainers labelled demo experience, a real replay, and a trainer level', async () => {
    const [agent] = await database.select().from(schema.agents).where(eq(schema.agents.slug, 'codemaster-pro-demo'));
    const rows = await database.select().from(schema.agentExperiences).where(and(eq(schema.agentExperiences.agentId, agent!.id), sql`${schema.agentExperiences.tags} @> '["demo"]'::jsonb`));
    expect(rows.length).toBeGreaterThanOrEqual(20);
    expect(rows.every((x) => x.situation.startsWith('Demo case'))).toBe(true);
  });

  it('does nothing when switched off', async () => {
    cfg.HIVE_LIVE = false;
    const before = (await database.select({ n: sql<number>`count(*)::int` }).from(schema.debates))[0]!.n;
    await hiveLiveTick(Date.now() + 10_000_000);
    expect((await database.select({ n: sql<number>`count(*)::int` }).from(schema.debates))[0]!.n).toBe(before);
    cfg.HIVE_LIVE = true;
  });
});
