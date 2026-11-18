/**
 * Demo experience for the demo trainer agents, so Experience scores, replays, trainer levels and "You can train in" are
 * populated on a demo instance. Built from each agent's own domain knowledge pack (the same reference statements the
 * sandbox agent answers from); every record is tagged "demo" and says "Demo case" in its situation — never presented as
 * real history. Each statement yields two cases (a question and a follow-up), so the replay can test one case while the
 * agent decides from its sibling — the same mechanics as real experience. Idempotent (checksum-deduplicated).
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { getKnowledgePack } from '../../engine/benchmarks/index.js';
import { addExperiences } from '../../engine/experience/ledger.js';
import { createReplay, runReplay } from '../../engine/experience/replay.js';
import { recomputeExperienceScores } from '../../engine/experience/score.js';

const TRAINERS: [slug: string, domain: string][] = [
  ['taxexpert-demo', 'finance'], ['codemaster-pro-demo', 'programming'], ['researchmind-demo', 'research'],
  ['cybersentinel-demo', 'cybersecurity'], ['mathpro-demo', 'mathematics'], ['healthguru-ai-demo', 'healthcare'],
];
const PER_AGENT = 24; // statements → 48 cases

const topicOf = (fact: string) => fact.split(/[.;:]/)[0]!.split(/\s+/).slice(0, 14).join(' ');

export async function ensureDemoExperience(): Promise<number> {
  const agents = await db().select().from(schema.agents).where(inArray(schema.agents.slug, TRAINERS.map((t) => t[0])));
  let seeded = 0;
  for (const [slug, domain] of TRAINERS) {
    const agent = agents.find((a) => a.slug === slug && !a.deletedAt);
    if (!agent) continue;
    const [have] = await db().select({ n: sql<number>`count(*)::int` }).from(schema.agentExperiences)
      .where(and(eq(schema.agentExperiences.agentId, agent.id), sql`${schema.agentExperiences.tags} @> '["demo"]'::jsonb`));
    if (Number(have?.n ?? 0) >= PER_AGENT) continue;
    const facts = getKnowledgePack(domain).filter((f) => f.length > 30).slice(0, PER_AGENT);
    const day = 86_400_000; const now = Date.now();
    const items = facts.flatMap((fact, i) => {
      const topic = topicOf(fact);
      const at = (k: number) => new Date(now - (facts.length * 2 - (i * 2 + k)) * 11 * day).toISOString();
      return [
        { domain, situation: `Demo case: "${topic}" (a learner agent asked)`, action: fact, reasoning: 'Answered from verified reference knowledge rather than guessing.', outcome: 'The learner applied it correctly in the follow-up exercise.', lesson: fact, result: 'success', occurredAt: at(0), tags: ['demo'] },
        { domain, situation: `Demo case: "${topic}" (a client agent double-checked)`, action: fact, reasoning: 'Confirmed the rule before the agent acted on it.', outcome: 'The client agent acted on the confirmed rule; no correction was needed.', lesson: fact, result: 'success', occurredAt: at(1), tags: ['demo'] },
      ];
    });
    const r = await addExperiences(agent, items, 'import');
    seeded += r.created.length;
    await recomputeExperienceScores(agent.id);
    // a real replay over the demo cases (the sandbox agent decides from its other cases)
    const [done] = await db().select({ id: schema.experienceReplays.id }).from(schema.experienceReplays)
      .where(and(eq(schema.experienceReplays.agentId, agent.id), eq(schema.experienceReplays.domainSlug, domain), eq(schema.experienceReplays.status, 'completed'))).limit(1);
    if (!done) {
      try { const rp = await createReplay({ agentId: agent.id, domainSlug: domain, purpose: 'self' }); await runReplay(rp.id, { sync: true }); }
      catch (e) { console.error(`[hive-live] demo replay for ${slug} failed:`, e instanceof Error ? e.message : e); }
    }
  }
  return seeded;
}
