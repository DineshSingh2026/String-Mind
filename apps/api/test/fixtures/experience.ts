/**
 * Test fixture: a realistic, clustered work history for an agent (several real-looking variants of each kind of
 * situation, with outcomes and lessons). Clustered on purpose: replays hide a case and the agent must decide from
 * the OTHER cases it lived through — exactly what real experience is.
 */
import { eq } from 'drizzle-orm';
import { schema } from '../../src/db/client.js';
import { embed } from '../../src/engine/embeddings.js';
import { embeddingText, experienceChecksum } from '../../src/engine/experience/ledger.js';
import { recomputeExperienceScores } from '../../src/engine/experience/score.js';
import { database } from '../helpers.js';

interface Template { situation: (i: number) => string; action: string; reasoning: string; outcome: string; lesson: string; result: 'success' | 'failure' }

export const HISTORY_TEMPLATES: Template[] = [
  {
    situation: (i) => `Production checkout API latency jumped from 120 ms to ${900 + i * 37} ms within minutes of deploy v${40 + i}; error rate also rising.`,
    action: 'Rolled back the deploy immediately, confirmed latency recovered, then bisected the release on staging to find the slow query.',
    reasoning: 'Customers were affected right now; restoring service comes before diagnosis.',
    outcome: 'Latency back to normal within 4 minutes; root cause was an unindexed join added in the release.',
    lesson: 'When latency spikes right after a deploy, roll back first and debug second on staging.',
    result: 'success',
  },
  {
    situation: (i) => `The integration test for the payments service fails intermittently in CI, about ${3 + i} times out of 50 runs, blocking merges.`,
    action: 'Added automatic retries to the flaky test so the pipeline would pass.',
    reasoning: 'Wanted to unblock the team quickly.',
    outcome: 'The flakiness came from a race condition in shared fixture state that later caused a double-charge in production.',
    lesson: 'Never paper over flaky tests with retries: isolate the shared state, reproduce the race and fix the ordering.',
    result: 'failure',
  },
  {
    situation: (i) => `Schema migration needed on the orders table with ${20 + i * 5} million rows; a plain ALTER TABLE would lock writes for a long time.`,
    action: 'Ran the migration online: added the column nullable, backfilled in small batches with a background job during low traffic, then added the constraint.',
    reasoning: 'Batching keeps locks short and lets us pause if load rises.',
    outcome: 'Zero downtime; the backfill finished overnight.',
    lesson: 'Big-table migrations go online in batches with a backfill job, never as one locking ALTER.',
    result: 'success',
  },
  {
    situation: (i) => `Worker pool node ${i + 1} memory grows about ${40 + i * 6} MB per hour until the process is OOM-killed every night.`,
    action: 'Took two heap snapshots an hour apart and diffed the retained objects, which pointed to an unbounded in-memory cache.',
    reasoning: 'Diffing snapshots shows what accumulates instead of guessing.',
    outcome: 'Capped the cache with an LRU limit; memory flat for weeks after.',
    lesson: 'For slow memory growth, diff heap snapshots taken apart in time to find what is retained.',
    result: 'success',
  },
  {
    situation: (i) => `A customer (account ${1000 + i}) reports their document lost edits after two teammates edited it at the same time.`,
    action: 'Told the customer it was probably user error and closed the ticket.',
    reasoning: 'Could not reproduce it on the first try.',
    outcome: 'Three more customers reported the same lost-update bug the following week.',
    lesson: 'Reproduce concurrent writes deliberately and add optimistic locking with version checks before answering the customer.',
    result: 'failure',
  },
];

/**
 * Insert `perTemplate` variants of each template as resolved experience of the agent in the domain, spread over
 * `months` months (newest today). Returns the inserted rows.
 */
export async function seedHistory(agent: { id: string; orgId: string }, domainSlug: string, opts: { perTemplate?: number; months?: number; source?: string; templates?: Template[] } = {}) {
  const [d] = await database.select().from(schema.capabilityDomains).where(eq(schema.capabilityDomains.slug, domainSlug)).limit(1);
  if (!d) throw new Error(`unknown domain ${domainSlug}`);
  const per = opts.perTemplate ?? 6;
  const months = opts.months ?? 26;
  const templates = opts.templates ?? HISTORY_TEMPLATES;
  const rows: (typeof schema.agentExperiences.$inferInsert)[] = [];
  const total = per * templates.length;
  let k = 0;
  for (let i = 0; i < per; i++) {
    for (const t of templates) {
      const occurredAt = new Date(Date.now() - Math.round((months * 30.44 * 86_400_000 * (total - 1 - k)) / Math.max(1, total - 1)) - 86_400_000);
      k++;
      const situation = t.situation(i);
      rows.push({
        agentId: agent.id, orgId: agent.orgId, domainId: d.id, situation, action: t.action, reasoning: t.reasoning, outcome: t.outcome, lesson: t.lesson,
        result: t.result, occurredAt, outcomeRecordedAt: occurredAt, source: opts.source ?? 'import', witnessed: false,
        checksum: experienceChecksum(situation, t.action, occurredAt),
        embedding: embed(embeddingText({ situation, action: t.action, outcome: t.outcome, lesson: t.lesson })),
      });
    }
  }
  const out = await database.insert(schema.agentExperiences).values(rows).returning();
  await recomputeExperienceScores(agent.id);
  return out;
}

/**
 * Make an agent a qualified trainer in a domain the honest way the gate demands: real (fixture) history plus a
 * completed self replay. The replay row is recorded directly (score given) — use the API flow in tests that are
 * about replays themselves.
 */
export async function qualifyTrainer(agent: { id: string; orgId: string }, domainSlug: string, replayScore = 80) {
  const rows = await seedHistory(agent, domainSlug);
  await database.insert(schema.experienceReplays).values({
    agentId: agent.id, orgId: agent.orgId, sourceAgentId: agent.id, domainSlug, purpose: 'self', status: 'completed', mode: 'sync',
    score: replayScore, itemsTotal: 10, itemsGraded: 10, method: 'deterministic', startedAt: new Date(), completedAt: new Date(),
  });
  await recomputeExperienceScores(agent.id);
  return rows;
}
