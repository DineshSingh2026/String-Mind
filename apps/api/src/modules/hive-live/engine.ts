/**
 * Hive Live — keeps a demo instance alive: two technology debates and two public training rooms between the demo agents
 * are always in progress, one message landing every ~20–40 seconds, pushed to viewers over the same WebSocket channels
 * real conversations use. When one finishes (debates move to real visitor voting, rooms complete) the next starts.
 *
 * Honest by construction: titles say "Live demo", content is authored showcase material (content.ts), no score or vote is
 * ever invented. Showcase debates carry debates.demo = true so the debate engine never drives them; showcase rooms carry
 * plan.live = true and are never handed to the training engine. Older showcase items are hidden (moderation) so lists
 * stay fresh without deleting history.
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { enqueue } from '../../jobs/queue.js';
import { config } from '../../lib/config.js';
import { publish } from '../../ws/hub.js';
import { publishDebate } from '../debates/service.js';
import { LIVE_DEBATES, LIVE_ROOMS } from './content.js';
import { ensureDemoExperience } from './experience.js';

export const HIVE_LIVE_JOB = 'hive_live.tick';
const TICK_MS = 12_000;
const MAX_LIVE_DEBATES = 2;
const MAX_LIVE_ROOMS = 2;
const KEEP_VISIBLE = 24;
const STATE_KEY = 'hive_live';

export const hiveLiveEnabled = () => config.HIVE_LIVE ?? config.SEED_DEMO;

/** 18–38 s between messages, varied per conversation and position so it never looks mechanical. */
const gapMs = (seed: string, n: number) => { let h = n * 2654435761; for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return 18_000 + (h % 20_000); };

async function state(): Promise<{ debate: number; room: number; experience?: boolean }> {
  const [row] = await db().select().from(schema.systemSettings).where(eq(schema.systemSettings.key, STATE_KEY)).limit(1);
  const v = (row?.value ?? {}) as { debate?: number; room?: number; experience?: boolean };
  return { debate: v.debate ?? 0, room: v.room ?? 0, experience: v.experience };
}
async function saveState(s: { debate: number; room: number; experience?: boolean }) {
  await db().insert(schema.systemSettings).values({ key: STATE_KEY, value: s }).onConflictDoUpdate({ target: schema.systemSettings.key, set: { value: s, updatedAt: new Date() } });
}

async function demoAgents() {
  const slugs = [...new Set([...LIVE_DEBATES.flatMap((d) => [d.a, d.b]), ...LIVE_ROOMS.flatMap((r) => [r.trainer, r.learner])])];
  const rows = await db().select().from(schema.agents).where(inArray(schema.agents.slug, slugs));
  return new Map(rows.filter((a) => !a.deletedAt).map((a) => [a.slug, a]));
}

/* ───────────── debates ───────────── */

async function streamDebates(agents: Map<string, typeof schema.agents.$inferSelect>, st: { debate: number; room: number }, now: number) {
  const live = await db().select().from(schema.debates).where(and(eq(schema.debates.demo, true), eq(schema.debates.status, 'live')));
  for (const d of live) {
    const script = LIVE_DEBATES.find((s) => s.title === d.title);
    const msgs = await db().select().from(schema.debateMessages).where(eq(schema.debateMessages.debateId, d.id)).orderBy(asc(schema.debateMessages.createdAt));
    const spoken = msgs.filter((m) => m.role === 'agent').length;
    const last = msgs.at(-1)?.createdAt.getTime() ?? d.startedAt?.getTime() ?? now;
    if (!script || spoken >= script.turns.length) {
      const [v] = await db().update(schema.debates).set({ status: 'voting', votingEndsAt: new Date(now + 2 * 3_600_000), updatedAt: new Date() })
        .where(and(eq(schema.debates.id, d.id), eq(schema.debates.status, 'live'))).returning();
      if (v) {
        const [m] = await db().insert(schema.debateMessages).values({ debateId: d.id, agentId: null, role: 'system', round: 0, content: 'All rounds are in. Voting is open for two hours — every vote is a real visitor vote.' }).returning();
        publishDebate(d.id, 'message', m); publishDebate(d.id, 'status', { status: 'voting' });
      }
      continue;
    }
    if (now - last < gapMs(d.id, spoken)) continue;
    const [side, round, text] = script.turns[spoken]!;
    const [m] = await db().insert(schema.debateMessages).values({ debateId: d.id, agentId: side === 'a' ? d.agentAId : d.agentBId, role: 'agent', round, content: text }).returning();
    publishDebate(d.id, 'message', m);
  }
  for (let open = live.length; open < MAX_LIVE_DEBATES; open++) {
    let started = false;
    for (let tries = 0; tries < LIVE_DEBATES.length && !started; tries++) {
      const script = LIVE_DEBATES[st.debate % LIVE_DEBATES.length]!; st.debate++;
      if (live.some((d) => d.title === script.title)) continue;
      const a = agents.get(script.a); const b = agents.get(script.b);
      if (!a || !b) continue;
      const [domain] = await db().select({ id: schema.capabilityDomains.id }).from(schema.capabilityDomains).where(eq(schema.capabilityDomains.slug, script.domain)).limit(1);
      const [d] = await db().insert(schema.debates).values({
        kind: 'debate', title: script.title, prompt: script.prompt, domainId: domain?.id ?? null, createdBy: a.ownerId, orgId: a.orgId,
        agentAId: a.id, agentBId: b.id, agentBAccepted: true, rounds: Math.max(...script.turns.map((t) => t[1])), status: 'live', demo: true, startedAt: new Date(now),
      }).returning();
      await db().insert(schema.debateMessages).values({ debateId: d!.id, agentId: null, role: 'system', round: 1, content: 'The Hive opened this live demo debate. Agents alternate turns; when the rounds are done, visitors vote.' });
      live.push(d!); started = true;
    }
    if (!started) break;
  }
}

/* ───────────── training rooms ───────────── */

async function streamRooms(agents: Map<string, typeof schema.agents.$inferSelect>, st: { debate: number; room: number }, now: number) {
  const live = await db().select().from(schema.trainingSessions).where(and(eq(schema.trainingSessions.status, 'active'), sql`${schema.trainingSessions.plan}->>'live' = 'true'`));
  for (const s of live) {
    const script = LIVE_ROOMS.find((r) => r.subject === s.subject);
    const msgs = await db().select().from(schema.trainingMessages).where(eq(schema.trainingMessages.sessionId, s.id)).orderBy(asc(schema.trainingMessages.createdAt));
    const last = msgs.at(-1)?.createdAt.getTime() ?? s.startedAt?.getTime() ?? now;
    if (!script || msgs.length >= script.messages.length) {
      const ended = new Date(now);
      const [done] = await db().update(schema.trainingSessions).set({ status: 'completed', stage: 'completion', endedAt: ended, durationSeconds: Math.round((now - (s.startedAt?.getTime() ?? now)) / 1000), updatedAt: ended })
        .where(and(eq(schema.trainingSessions.id, s.id), eq(schema.trainingSessions.status, 'active'))).returning();
      if (done) { publish(`session:${s.id}`, 'stage', { stage: 'completion' }); publish(`session:${s.id}`, 'status', { status: 'completed' }); }
      continue;
    }
    if (now - last < gapMs(s.id, msgs.length)) continue;
    const [role, stage, text] = script.messages[msgs.length]!;
    const agentId = role === 'trainer' ? s.trainerAgentId : role === 'learner' ? s.learnerAgentId : null;
    const [m] = await db().insert(schema.trainingMessages).values({ sessionId: s.id, senderAgentId: agentId, senderRole: role, stage, content: text, metadata: { demo: true } }).returning();
    if (s.stage !== stage) { await db().update(schema.trainingSessions).set({ stage, updatedAt: new Date() }).where(eq(schema.trainingSessions.id, s.id)); publish(`session:${s.id}`, 'stage', { stage }); }
    publish(`session:${s.id}`, 'message', m);
  }
  for (let open = live.length; open < MAX_LIVE_ROOMS; open++) {
    let started = false;
    for (let tries = 0; tries < LIVE_ROOMS.length && !started; tries++) {
      const script = LIVE_ROOMS[st.room % LIVE_ROOMS.length]!; st.room++;
      if (live.some((s) => s.subject === script.subject)) continue;
      const t = agents.get(script.trainer); const l = agents.get(script.learner);
      if (!t || !l) continue;
      const [domain] = await db().select({ id: schema.capabilityDomains.id }).from(schema.capabilityDomains).where(eq(schema.capabilityDomains.slug, script.domain)).limit(1);
      if (!domain) continue;
      const [s] = await db().insert(schema.trainingSessions).values({
        learnerAgentId: l.id, trainerAgentId: t.id, learnerOrgId: l.orgId, trainerOrgId: t.orgId, domainId: domain.id, subject: script.subject,
        stage: 'introduction', status: 'active', visibility: 'public', startedAt: new Date(now), plan: { demo: true, live: true },
      }).returning();
      live.push(s!); started = true;
    }
    if (!started) break;
  }
}

/** Hide older finished showcase items so lists always lead with the newest (history is kept). */
async function tidy() {
  const oldDebates = await db().select({ id: schema.debates.id }).from(schema.debates).where(and(eq(schema.debates.demo, true), eq(schema.debates.moderation, 'visible')))
    .orderBy(desc(schema.debates.createdAt)).offset(KEEP_VISIBLE);
  if (oldDebates.length) await db().update(schema.debates).set({ moderation: 'removed' }).where(and(inArray(schema.debates.id, oldDebates.map((d) => d.id)), sql`${schema.debates.status} <> 'live'`));
  const oldRooms = await db().select({ id: schema.trainingSessions.id }).from(schema.trainingSessions).where(and(sql`${schema.trainingSessions.plan}->>'live' = 'true'`, eq(schema.trainingSessions.moderation, 'visible')))
    .orderBy(desc(schema.trainingSessions.createdAt)).offset(KEEP_VISIBLE);
  if (oldRooms.length) await db().update(schema.trainingSessions).set({ moderation: 'removed' }).where(and(inArray(schema.trainingSessions.id, oldRooms.map((r) => r.id)), sql`${schema.trainingSessions.status} <> 'active'`));
}

export async function hiveLiveTick(now = Date.now()): Promise<void> {
  if (!hiveLiveEnabled()) return;
  const agents = await demoAgents();
  if (!agents.size) return; // demo agents not present on this instance
  const st = await state();
  if (!st.experience) { await ensureDemoExperience().catch((e) => console.error('[hive-live] demo experience failed:', e instanceof Error ? e.message : e)); st.experience = true; }
  await streamDebates(agents, st, now);
  await streamRooms(agents, st, now);
  await tidy();
  await saveState(st);
}

export async function ensureHiveLiveScheduled(): Promise<void> {
  if (!hiveLiveEnabled()) return;
  const [q] = await db().select({ id: schema.jobs.id }).from(schema.jobs).where(and(eq(schema.jobs.type, HIVE_LIVE_JOB), eq(schema.jobs.status, 'queued'))).limit(1);
  if (!q) await enqueue(HIVE_LIVE_JOB, {}, { delayMs: TICK_MS, maxAttempts: 1 });
}
