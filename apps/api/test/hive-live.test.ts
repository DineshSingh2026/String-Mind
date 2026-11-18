/** Hive Live: showcase debates and public training rooms stream continuously between the demo agents. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { app, database, setup, teardown } from './helpers.js';
import { schema } from '../src/db/client.js';
import { config } from '../src/lib/config.js';
import { hiveLiveTick } from '../src/modules/hive-live/engine.js';
import { advanceDebate } from '../src/modules/debates/service.js';
import { LIVE_DEBATES, LIVE_ROOMS } from '../src/modules/hive-live/content.js';

const cfg = config as Record<string, unknown>;
beforeAll(async () => { await setup({ demo: true }); cfg.HIVE_LIVE = true; });
afterAll(async () => { cfg.HIVE_LIVE = undefined; await teardown(); });

const liveDebates = () => database.select().from(schema.debates).where(and(eq(schema.debates.demo, true), eq(schema.debates.status, 'live')));
const liveRooms = () => database.select().from(schema.trainingSessions).where(and(eq(schema.trainingSessions.status, 'active'), sql`${schema.trainingSessions.plan}->>'live' = 'true'`));

describe('Hive Live showcase stream', () => {
  it('keeps two debates and two public rooms in progress, streams messages, and rolls on when they finish', async () => {
    let now = Date.now();
    await hiveLiveTick(now);
    expect(await liveDebates()).toHaveLength(2);
    const rooms = await liveRooms();
    expect(rooms).toHaveLength(2);
    expect(rooms.every((r) => r.visibility === 'public' && r.subject.startsWith('Live demo room'))).toBe(true);

    // the real debate engine never drives a showcase debate
    const [d0] = await liveDebates();
    await advanceDebate(d0!.id);
    expect((await database.select().from(schema.debateMessages).where(and(eq(schema.debateMessages.debateId, d0!.id), eq(schema.debateMessages.role, 'agent'))))).toHaveLength(0);

    // a message lands only after its gap — no burst
    await hiveLiveTick(now + 1000);
    expect(await database.select().from(schema.trainingMessages).where(eq(schema.trainingMessages.sessionId, rooms[0]!.id))).toHaveLength(0);

    const maxSteps = Math.max(...LIVE_DEBATES.map((d) => d.turns.length), ...LIVE_ROOMS.map((r) => r.messages.length)) + 3;
    for (let i = 0; i < maxSteps; i++) { now += 40_000; await hiveLiveTick(now); }
    const firstRoom = (await database.select().from(schema.trainingSessions).where(eq(schema.trainingSessions.id, rooms[0]!.id)))[0]!;
    expect(firstRoom.status).toBe('completed');
    const msgs = await database.select().from(schema.trainingMessages).where(eq(schema.trainingMessages.sessionId, firstRoom.id));
    expect(msgs.length).toBe(LIVE_ROOMS.find((r) => r.subject === firstRoom.subject)!.messages.length);
    const firstDebate = (await database.select().from(schema.debates).where(eq(schema.debates.id, d0!.id)))[0]!;
    expect(firstDebate.status).toBe('voting'); // visitors vote — no invented votes
    expect(firstDebate.votesA + firstDebate.votesB).toBe(0);
    // new ones started to replace them
    expect(await liveDebates()).toHaveLength(2);
    expect(await liveRooms()).toHaveLength(2);

    const status = await app.inject({ method: 'GET', url: '/hive-live/status' });
    expect(status.json()).toMatchObject({ enabled: true, liveDebates: 2, liveRooms: 2 });
  });

  it('gives the demo trainers labelled demo experience, a real replay, and a trainer level', async () => {
    const [agent] = await database.select().from(schema.agents).where(eq(schema.agents.slug, 'codemaster-pro-demo'));
    const rows = await database.select().from(schema.agentExperiences).where(eq(schema.agentExperiences.agentId, agent!.id));
    expect(rows.length).toBeGreaterThanOrEqual(20);
    expect(rows.every((r) => r.tags.includes('demo') && r.situation.startsWith('Demo case'))).toBe(true);
    const opp = await database.select().from(schema.agentExperienceScores).where(and(eq(schema.agentExperienceScores.agentId, agent!.id), eq(schema.agentExperienceScores.domainSlug, 'programming')));
    expect(opp[0]!.replayScore).not.toBeNull();
    expect(opp[0]!.level).not.toBe('none');
  });

  it('does nothing when switched off', async () => {
    cfg.HIVE_LIVE = false;
    const before = (await database.select({ n: sql<number>`count(*)::int` }).from(schema.debates))[0]!.n;
    await hiveLiveTick(Date.now() + 10_000_000);
    expect((await database.select({ n: sql<number>`count(*)::int` }).from(schema.debates))[0]!.n).toBe(before);
    cfg.HIVE_LIVE = true;
  });
});
