/**
 * Idempotent benchmark seeding: upserts datasets by (domain, version, visibility) and inserts
 * questions only when a dataset is empty (published versions are immutable — add a new version
 * to change content via DomainBenchmark.version; older versions of that domain/visibility are then retired). Checksum = sha256 over the canonical question content.
 */
import { createHash } from 'node:crypto';
import { and, eq, ne, sql } from 'drizzle-orm';
import { schema, type DB } from '../../db/client.js';
import { BENCHMARKS } from './data/index.js';
import type { BenchQuestion } from './types.js';

export const BENCHMARK_VERSION = 'v1';

export function datasetChecksum(qs: BenchQuestion[]): string {
  const canon = qs.map((q) => [q.key, q.skill, q.difficulty, q.kind, q.prompt, q.answerType, q.groundTruth, q.choices ?? null, q.rubric ?? {}]);
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex');
}

export async function seedBenchmarks(db: DB) {
  const domains = await db.select().from(schema.capabilityDomains);
  const skills = await db.select().from(schema.capabilitySkills);
  for (const domain of domains) {
    const bench = BENCHMARKS[domain.slug];
    if (!bench) continue;
    const version = bench.version ?? BENCHMARK_VERSION;
    for (const [visibility, qs] of [['held_out', bench.heldOut], ['practice', bench.practice]] as const) {
      const checksum = datasetChecksum(qs);
      const [ds] = await db.insert(schema.benchmarkDatasets).values({
        domainId: domain.id, name: `${domain.name} — ${visibility === 'held_out' ? 'held-out evaluation' : 'practice'} set`,
        version, visibility, status: 'active', checksum,
      }).onConflictDoUpdate({
        target: [schema.benchmarkDatasets.domainId, schema.benchmarkDatasets.version, schema.benchmarkDatasets.visibility],
        set: { name: sql`excluded.name` },
      }).returning();
      // A newer published version supersedes older ones: retire them so only the current version is used.
      await db.update(schema.benchmarkDatasets).set({ status: 'retired' }).where(and(
        eq(schema.benchmarkDatasets.domainId, domain.id), eq(schema.benchmarkDatasets.visibility, visibility),
        ne(schema.benchmarkDatasets.version, version), eq(schema.benchmarkDatasets.status, 'active')));
      const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.benchmarkQuestions).where(eq(schema.benchmarkQuestions.datasetId, ds!.id));
      if (!n && qs.length) {
        await db.insert(schema.benchmarkQuestions).values(qs.map((q) => ({
          datasetId: ds!.id,
          skillId: skills.find((s) => s.domainId === domain.id && s.slug === q.skill)?.id ?? null,
          difficulty: q.difficulty, kind: q.kind, prompt: q.prompt, answerType: q.answerType, groundTruth: q.groundTruth,
          choices: q.choices ?? null, rubric: { ...(q.rubric ?? {}), key: q.key }, tags: q.tags ?? [], humanReviewed: !!q.humanReviewed,
        })));
      }
      const [counts] = await db.select({
        total: sql<number>`count(*)::int`, reviewed: sql<number>`count(*) filter (where ${schema.benchmarkQuestions.humanReviewed})::int`,
      }).from(schema.benchmarkQuestions).where(eq(schema.benchmarkQuestions.datasetId, ds!.id));
      await db.update(schema.benchmarkDatasets).set({ questionCount: counts!.total, humanReviewedCount: counts!.reviewed, ...(n ? {} : { checksum }) })
        .where(and(eq(schema.benchmarkDatasets.id, ds!.id)));
    }
  }
}
