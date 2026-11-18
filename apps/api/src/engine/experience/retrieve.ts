/**
 * Retrieval over an agent's Experience Ledger (kept free of heavy imports: used by engine/context.ts on every call).
 */
import { sql } from 'drizzle-orm';
import { db, rowsOf } from '../../db/client.js';
import { embed } from '../embeddings.js';

/* ───────────── retrieval ───────────── */

export interface ExperienceHit { id: string; agentId: string; situation: string; action: string; reasoning: string; outcome: string; lesson: string; result: string; occurredAt: Date; witnessed: boolean; score: number }

/** Semantic search over one agent's own experience (resolved records rank first on ties). */
export async function searchExperiences(agentId: string, query: string, opts: { limit?: number; excludeIds?: string[]; domainId?: string | null } = {}): Promise<ExperienceHit[]> {
  const vec = `[${embed(query).join(',')}]`;
  const exclude = (opts.excludeIds ?? []).filter(Boolean);
  const rows = await db().execute(sql`
    SELECT id, agent_id, situation, action, reasoning, outcome, lesson, result, occurred_at, witnessed, 1 - (embedding <=> ${vec}::vector) AS score
    FROM agent_experiences
    WHERE agent_id = ${agentId}::uuid
      ${opts.domainId ? sql`AND domain_id = ${opts.domainId}::uuid` : sql``}
      ${exclude.length ? sql`AND id NOT IN (${sql.join(exclude.map((x) => sql`${x}::uuid`), sql`, `)})` : sql``}
    ORDER BY embedding <=> ${vec}::vector, occurred_at DESC
    LIMIT ${opts.limit ?? 6}`);
  const list = rowsOf<Record<string, unknown>>(rows);
  return list.map((r) => ({
    id: String(r.id), agentId: String(r.agent_id), situation: String(r.situation), action: String(r.action), reasoning: String(r.reasoning ?? ''),
    outcome: String(r.outcome ?? ''), lesson: String(r.lesson ?? ''), result: String(r.result), occurredAt: new Date(String(r.occurred_at)),
    witnessed: r.witnessed === true || r.witnessed === 't', score: Number(r.score),
  }));
}

/** Compact, model-facing rendering of one experience (used for context, training and memories). */
export function renderExperience(e: Pick<ExperienceHit, 'situation' | 'action' | 'reasoning' | 'outcome' | 'lesson' | 'result' | 'occurredAt'>, opts: { max?: number } = {}): string {
  const max = opts.max ?? 1200;
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const parts = [
    `Past case (${e.occurredAt.toISOString().slice(0, 10)}, result: ${e.result})`,
    `Situation: ${cut(e.situation, 500)}`,
    `Decision: ${cut(e.action, 400)}`,
    e.reasoning ? `Why: ${cut(e.reasoning, 300)}` : '',
    e.outcome ? `What happened: ${cut(e.outcome, 300)}` : '',
    e.lesson ? `Lesson: ${cut(e.lesson, 300)}` : '',
  ].filter(Boolean);
  return cut(parts.join('\n'), max);
}

