/**
 * Hive Judge tier 4 — admin expert review (OFF by default; enable with settings.reviewEnabled).
 *
 * Storage: JSON files under HIVE_JUDGE_DATA_DIR (default ./.data/hive-judge/reviews/) because no table may be added
 * yet; reviews are idempotent per (refKind, refId). Resolved outcomes for question-backed items are ALSO written to
 * pro_calibration_answers with provenance 'human_authored' so the scorer learns from admins.
 * Proposed table: hive_judge_reviews(id, ref_kind, ref_id, question_id, status, payload jsonb, suggested jsonb,
 * resolution jsonb, resolved_by, created_at, resolved_at).
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { db, schema } from '../../db/client.js';
import type { JudgeInput, JudgeResult } from '../pro-judge.js';

export type RefKind = 'exam_item' | 'evidence' | 'live_check';
type Resolver = (refId: string, result: JudgeResult) => Promise<void>;
const resolvers = new Map<RefKind, Resolver>();

/** Exam / evidence engineers register how a resolved review is written back to their row. */
export function registerReviewResolver(refKind: RefKind, fn: Resolver) { resolvers.set(refKind, fn); }

export interface ReviewItem {
  id: string; refKind: RefKind | null; refId: string | null; questionId: string | null; domain: string; status: 'open' | 'resolved';
  createdAt: string; reasons: string[]; input: JudgeInput; suggested: JudgeResult;
  resolution?: { scores: Record<string, number>; redFlagsFired: string[]; note: string; by: string; at: string; total: number };
}

let dir = resolve(process.env.HIVE_JUDGE_DATA_DIR ?? './.data/hive-judge', 'reviews');
export function setReviewDirForTests(d: string) { dir = d; }
const ensure = () => { mkdirSync(dir, { recursive: true }); return dir; };
const fileOf = (id: string) => join(ensure(), `${id.replace(/[^a-z0-9-]/gi, '')}.json`);

export function listReviews(filter: { status?: string; domain?: string } = {}): ReviewItem[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => { try { return JSON.parse(readFileSync(join(dir, f), 'utf8')) as ReviewItem; } catch { return null; } })
    .filter((r): r is ReviewItem => !!r && (!filter.status || r.status === filter.status) && (!filter.domain || r.domain === filter.domain))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function getReview(id: string): ReviewItem | null {
  try { return JSON.parse(readFileSync(fileOf(id), 'utf8')) as ReviewItem; } catch { return null; }
}

export function openedToday(): number {
  const day = new Date().toISOString().slice(0, 10);
  return listReviews().filter((r) => r.createdAt.startsWith(day)).length;
}

export function createReview(input: JudgeInput & { refKind?: RefKind; refId?: string; questionId?: string }, suggested: JudgeResult, reasons: string[]): ReviewItem {
  const existing = input.refKind && input.refId ? listReviews({ status: 'open' }).find((r) => r.refKind === input.refKind && r.refId === input.refId) : null;
  const item: ReviewItem = {
    id: existing?.id ?? randomUUID(), refKind: input.refKind ?? null, refId: input.refId ?? null, questionId: input.questionId ?? null, domain: input.domain,
    status: 'open', createdAt: existing?.createdAt ?? new Date().toISOString(), reasons, input, suggested,
  };
  writeFileSync(fileOf(item.id), JSON.stringify(item));
  return item;
}

let resolutionsSinceTrain = 0;
export function resolutionsCount() { return resolutionsSinceTrain; }
export function resetResolutionsCount() { resolutionsSinceTrain = 0; }

/** Admin resolution: clamp scores, write back via the resolver, store a human_authored calibration example. */
export async function resolveReview(id: string, body: { scores: Record<string, number>; redFlagsFired?: string[]; note?: string }, adminId: string): Promise<ReviewItem> {
  const r = getReview(id);
  if (!r) throw new Error('review_not_found');
  if (r.status === 'resolved') throw new Error('review_already_resolved');
  const scores: Record<string, number> = {};
  let raw = 0, max = 0;
  for (const c of r.input.rubric) { const v = Math.max(0, Math.min(c.points, Number(body.scores[c.id] ?? 0) || 0)); scores[c.id] = v; raw += v; max += c.points; }
  const flags = (body.redFlagsFired ?? []).filter(Boolean);
  const total = flags.length ? 0 : max ? Math.round((raw / max) * 1000) / 10 : 0;
  const result: JudgeResult = { status: 'done', scores, total, redFlagsFired: flags, rationale: body.note?.trim() || 'Resolved by an admin expert.', model: 'hive-judge:admin', confidence: 1, tier: 'admin', reviewId: r.id };
  r.status = 'resolved';
  r.resolution = { scores, redFlagsFired: flags, note: body.note ?? '', by: adminId, at: new Date().toISOString(), total };
  writeFileSync(fileOf(r.id), JSON.stringify(r));
  if (r.questionId) {
    await db().insert(schema.proCalibrationAnswers).values({
      questionId: r.questionId, level: 'other', answer: r.input.answer, scores, total, redFlagsFired: flags,
      rationale: `admin review ${r.id}: ${body.note ?? ''}`.slice(0, 2000), provenance: 'human_authored', verifiedBy: adminId,
    });
  }
  resolutionsSinceTrain++;
  const fn = r.refKind ? resolvers.get(r.refKind) : undefined;
  if (fn && r.refId) await fn(r.refId, result);
  return r;
}
