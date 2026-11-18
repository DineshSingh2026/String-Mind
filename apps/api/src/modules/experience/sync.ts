/**
 * Memory sync on connect: the moment a prompt-connected agent passes verification, its FIRST real task is to connect
 * its memory (send its real past experience to the Experience Ledger) — before any assessment task. When it answers,
 * Hive Mind recomputes its Experience Score, notifies the owner and starts a self replay if there are enough cases.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { enqueue } from '../../jobs/queue.js';
import { enqueueTask } from '../../lib/agent-inbox.js';
import { notify } from '../../lib/notify.js';
import { REPLAY_JOB, REPLAY_MIN_ITEMS, createReplay, gradableCases } from '../../engine/experience/replay.js';
import { recomputeExperienceScores } from '../../engine/experience/score.js';
import { memorySyncPrompt } from './prompts.js';

export const MEMORY_SYNC_KIND = 'memory_sync';
const SYNC_TTL_MS = 24 * 3_600_000;

type Agent = typeof schema.agents.$inferSelect;
type Task = typeof schema.agentTasks.$inferSelect;

/** Queue the memory-sync task (idempotent: one open sync task per agent). */
export async function enqueueMemorySync(agent: Pick<Agent, 'id' | 'orgId' | 'name'>): Promise<void> {
  // on by default; MEMORY_SYNC_ON_CONNECT=false disables it (legacy tests that count inbox tasks exactly)
  if (process.env.MEMORY_SYNC_ON_CONNECT === 'false') return;
  const open = await db().select({ id: schema.agentTasks.id }).from(schema.agentTasks).where(and(
    eq(schema.agentTasks.agentId, agent.id), eq(schema.agentTasks.kind, MEMORY_SYNC_KIND), inArray(schema.agentTasks.status, ['pending', 'delivered']),
  )).limit(1);
  if (open.length) return;
  const content = `${memorySyncPrompt(agent.name)}\n\n` +
    'This is your first task after connecting: do STEP 1 now (send your real history), then reply to THIS task with a short ' +
    'summary — how many entries you sent, how many were created and rejected — or exactly "NO HISTORY" if you have no real ' +
    'past experience. Keep doing STEP 2 from now on.';
  await enqueueTask(agent.id, agent.orgId, MEMORY_SYNC_KIND, { messages: [{ role: 'user', content }], system: null }, SYNC_TTL_MS);
}

/** Answer handler: recompute, notify the owner, start a self replay when the agent now has enough real cases. */
export async function handleMemorySyncAnswer(task: Task): Promise<void> {
  if (task.status !== 'answered') return;
  const [agent] = await db().select().from(schema.agents).where(eq(schema.agents.id, task.agentId)).limit(1);
  if (!agent || agent.deletedAt) return;
  const rows = await recomputeExperienceScores(agent.id);
  const all = rows.find((r) => r.domainSlug === 'all');
  const cases = await gradableCases(agent.id, 'all');
  let replayStarted = false;
  if (cases.length >= REPLAY_MIN_ITEMS) {
    const busy = await db().select({ id: schema.experienceReplays.id }).from(schema.experienceReplays).where(and(
      eq(schema.experienceReplays.agentId, agent.id), eq(schema.experienceReplays.purpose, 'self'), inArray(schema.experienceReplays.status, ['queued', 'running']),
    )).limit(1);
    if (!busy.length) {
      const r = await createReplay({ agentId: agent.id, domainSlug: 'all', purpose: 'self' });
      await enqueue(REPLAY_JOB, { replayId: r.id }, { maxAttempts: 1 });
      replayStarted = true;
    }
  }
  const summary = (task.response ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  await notify(agent.ownerId, 'system', `${agent.name} connected its memory`,
    `${all?.totalCount ?? 0} experience record(s) on Hive Mind (${all?.resolvedCount ?? 0} with a known outcome). ` +
    (replayStarted ? 'An experience replay has started on its real past cases. ' : cases.length ? `Needs ${REPLAY_MIN_ITEMS}+ cases with a known outcome for a replay. ` : 'No real history was sent — its Experience Score stays 0 until it records real work. ') +
    (summary ? `Agent's report: "${summary}"` : ''), `/app/agents/${agent.id}`).catch(() => undefined);
}
