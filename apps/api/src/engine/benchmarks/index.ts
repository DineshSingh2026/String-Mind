/** Benchmark content access + admin helpers (used by admin module and demo seeding). */
import { asc, eq, sql } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { BENCHMARKS } from './data/index.js';

export { BENCHMARKS };
export type { BenchQuestion, DomainBenchmark } from './types.js';

/** Knowledge pack (reference statements) for a domain — teaching material, never question copies. */
export function getKnowledgePack(domainSlug: string): string[] {
  return [...(BENCHMARKS[domainSlug]?.facts ?? [])];
}

export async function listBenchmarkDatasets() {
  return db().select({ dataset: schema.benchmarkDatasets, domain: { slug: schema.capabilityDomains.slug, name: schema.capabilityDomains.name } })
    .from(schema.benchmarkDatasets).innerJoin(schema.capabilityDomains, eq(schema.capabilityDomains.id, schema.benchmarkDatasets.domainId))
    .orderBy(asc(schema.capabilityDomains.sortOrder), asc(schema.benchmarkDatasets.visibility));
}

/** Admin only — includes ground truth. */
export async function listBenchmarkQuestions(datasetId: string) {
  return db().select().from(schema.benchmarkQuestions).where(eq(schema.benchmarkQuestions.datasetId, datasetId)).orderBy(asc(schema.benchmarkQuestions.id));
}

export async function setQuestionReviewed(questionId: string, humanReviewed: boolean) {
  const [q] = await db().update(schema.benchmarkQuestions).set({ humanReviewed }).where(eq(schema.benchmarkQuestions.id, questionId)).returning();
  if (!q) return null;
  await db().update(schema.benchmarkDatasets).set({
    humanReviewedCount: sql`(select count(*)::int from benchmark_questions where dataset_id = ${q.datasetId} and human_reviewed)`,
  }).where(eq(schema.benchmarkDatasets.id, q.datasetId));
  return q;
}
