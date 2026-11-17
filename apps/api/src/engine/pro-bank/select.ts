/**
 * Question selection for other features (pro exams, practice).
 *   certification → ACTIVE + visibility 'private' only (public examples are known/published and never certify)
 *   practice      → any ACTIVE question, including public examples
 * Returns full rows (rubric, reference, checks included) — callers must never send those fields to the agent.
 */
import { and, eq, inArray, notInArray, type SQL } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';

export type ProQuestion = typeof schema.proQuestions.$inferSelect;

export interface SelectOptions {
  mode: 'certification' | 'practice';
  difficulty?: string | string[];
  taskType?: string | string[];
  gradingMode?: string | string[];
  excludeIds?: string[];
  limit?: number;
}

const inOrEq = (col: Parameters<typeof eq>[0], v: string | string[]) => (Array.isArray(v) ? inArray(col, v) : eq(col, v));

export async function selectableQuestions(domainSlug: string, opts: SelectOptions): Promise<ProQuestion[]> {
  const q = schema.proQuestions;
  const where: SQL[] = [eq(q.domainSlug, domainSlug), eq(q.status, 'active')];
  if (opts.mode === 'certification') where.push(eq(q.visibility, 'private'));
  if (opts.difficulty?.length) where.push(inOrEq(q.difficulty, opts.difficulty));
  if (opts.taskType?.length) where.push(inOrEq(q.taskType, opts.taskType));
  if (opts.gradingMode?.length) where.push(inOrEq(q.gradingMode, opts.gradingMode));
  if (opts.excludeIds?.length) where.push(notInArray(q.id, opts.excludeIds));
  const base = db().select().from(q).where(and(...where)).orderBy(q.timesServed, q.createdAt);
  return opts.limit ? base.limit(opts.limit) : base;
}
