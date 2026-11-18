/**
 * Experience Ledger — the agent's "mind": real situations it faced, what it decided, why, and what happened.
 *
 * Records come from three places:
 *   - 'agent'  : the connected agent itself (POST /agent-api/experiences) — the normal, ongoing path
 *   - 'owner'  : the owner in the app, one at a time
 *   - 'import' : a bulk import of past history (JSON array / JSONL / CSV)
 *
 * Honesty rules
 *   - Everything is untrusted text. It is screened for prompt injection on the way in and is always presented to
 *     models as reference data, never as instructions.
 *   - `witnessed` is set only when Hive Mind recorded the decision BEFORE its outcome: the record was created as
 *     'pending' (not imported) within 48 h of the decision, and the outcome arrived in a later call. Imported history
 *     is always "self-reported". Witnessed decisions that are never resolved count as misses after STALE_PENDING_DAYS
 *     (see score.ts), so an agent cannot report only its wins.
 */
import { and, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db/client.js';
import { sha256 } from '../../lib/crypto.js';
import { conflict, notFound, unprocessable } from '../../lib/errors.js';
import { embed } from '../embeddings.js';
import { sanitizeContent } from '../training.js';

export type Experience = typeof schema.agentExperiences.$inferSelect;
export const EXPERIENCE_RESULTS = ['pending', 'success', 'failure', 'mixed'] as const;
export type ExperienceResult = (typeof EXPERIENCE_RESULTS)[number];
export const RESOLVED_RESULTS: ExperienceResult[] = ['success', 'failure', 'mixed'];

/** Decision must be logged within this window of when it happened to be eligible for "witnessed". */
export const WITNESS_LOG_WINDOW_MS = 48 * 3_600_000;
export const MAX_EXPERIENCES_PER_AGENT = 20_000;
export const MAX_BATCH = 500;

const text = (max: number) => z.string().trim().max(max);

export const ExperienceInput = z.object({
  /** capability domain slug; omit for general experience */
  domain: z.string().trim().max(64).nullish(),
  situation: text(4000).min(10, 'situation must describe what the agent faced (at least 10 characters)'),
  action: text(4000).min(3, 'action must say what the agent decided/did'),
  reasoning: text(4000).default(''),
  outcome: text(4000).default(''),
  lesson: text(2000).default(''),
  result: z.enum(EXPERIENCE_RESULTS).default('pending'),
  occurredAt: z.coerce.date().optional(),
  evidenceUrl: z.string().trim().url().max(500).nullish(),
  tags: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
});
export type ExperienceInputT = z.infer<typeof ExperienceInput>;

export const OutcomeInput = z.object({
  result: z.enum(['success', 'failure', 'mixed']),
  outcome: text(4000).min(3, 'describe what actually happened'),
  lesson: text(2000).optional(),
  evidenceUrl: z.string().trim().url().max(500).nullish(),
});

/** Strip injection attempts / control characters from one free-text field. */
function clean(s: string): { text: string; flags: string[] } {
  // eslint-disable-next-line no-control-regex
  const r = sanitizeContent(s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ''));
  return { text: r.text, flags: r.flags };
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
export const experienceChecksum = (situation: string, action: string, occurredAt: Date) =>
  sha256(`${norm(situation)}|${norm(action)}|${occurredAt.toISOString().slice(0, 10)}`);

export const embeddingText = (e: Pick<Experience, 'situation' | 'action' | 'lesson' | 'outcome'>) =>
  [e.situation, e.action, e.outcome, e.lesson].filter(Boolean).join('\n');

async function domainMap(): Promise<{ bySlug: Map<string, string>; byId: Map<string, string> }> {
  const rows = await db().select({ id: schema.capabilityDomains.id, slug: schema.capabilityDomains.slug }).from(schema.capabilityDomains);
  return { bySlug: new Map(rows.map((r) => [r.slug, r.id])), byId: new Map(rows.map((r) => [r.id, r.slug])) };
}

export interface AddResult { created: Experience[]; duplicates: number; rejected: { index: number; reason: string }[]; flagged: number }

/**
 * Validate, clean and store experiences for one agent. Duplicates (same situation+action+day) are skipped.
 * Invalid items are reported per index; valid ones are stored.
 */
export async function addExperiences(agent: { id: string; orgId: string }, items: unknown[], source: 'agent' | 'owner' | 'import'): Promise<AddResult> {
  if (items.length > MAX_BATCH) throw unprocessable(`At most ${MAX_BATCH} experiences per request.`);
  const [cnt] = await db().select({ n: sql<number>`count(*)::int` }).from(schema.agentExperiences).where(eq(schema.agentExperiences.agentId, agent.id));
  const existing = Number(cnt?.n ?? 0);
  if (existing + items.length > MAX_EXPERIENCES_PER_AGENT) throw unprocessable(`An agent can hold at most ${MAX_EXPERIENCES_PER_AGENT} experiences (this agent has ${existing}).`);

  const { bySlug } = await domainMap();
  const now = Date.now();
  const rejected: AddResult['rejected'] = [];
  const rows: (typeof schema.agentExperiences.$inferInsert)[] = [];
  const seen = new Set<string>();
  let flagged = 0;
  items.forEach((raw, index) => {
    const p = ExperienceInput.safeParse(raw);
    if (!p.success) { rejected.push({ index, reason: p.error.issues.map((i) => `${i.path.join('.') || 'item'}: ${i.message}`).join('; ') }); return; }
    const v = p.data;
    const occurredAt = v.occurredAt ?? new Date(now);
    if (Number.isNaN(occurredAt.getTime())) { rejected.push({ index, reason: 'occurredAt: invalid date' }); return; }
    if (occurredAt.getTime() > now + 3_600_000) { rejected.push({ index, reason: 'occurredAt: cannot be in the future' }); return; }
    if (occurredAt.getUTCFullYear() < 1990) { rejected.push({ index, reason: 'occurredAt: too far in the past' }); return; }
    let domainId: string | null = null;
    if (v.domain) {
      domainId = bySlug.get(v.domain) ?? null;
      if (!domainId) { rejected.push({ index, reason: `domain: unknown domain "${v.domain}"` }); return; }
    }
    if (v.result !== 'pending' && v.outcome.length < 3) { rejected.push({ index, reason: 'outcome: required when result is success, failure or mixed' }); return; }
    const f = { situation: clean(v.situation), action: clean(v.action), reasoning: clean(v.reasoning), outcome: clean(v.outcome), lesson: clean(v.lesson) };
    if (f.situation.text.length < 10 || f.action.text.length < 3) { rejected.push({ index, reason: 'content was removed by the safety filter' }); return; }
    if (Object.values(f).some((x) => x.flags.length)) flagged++;
    const checksum = experienceChecksum(f.situation.text, f.action.text, occurredAt);
    if (seen.has(checksum)) return;
    seen.add(checksum);
    const resolved = v.result !== 'pending';
    const row = {
      agentId: agent.id, orgId: agent.orgId, domainId, situation: f.situation.text, action: f.action.text,
      reasoning: f.reasoning.text, outcome: f.outcome.text, lesson: f.lesson.text, result: v.result, occurredAt,
      outcomeRecordedAt: resolved ? new Date(now) : null, source, evidenceUrl: v.evidenceUrl ?? null,
      tags: [...new Set(v.tags.map((t) => t.toLowerCase()))], witnessed: false, checksum,
      embedding: embed(embeddingText({ situation: f.situation.text, action: f.action.text, outcome: f.outcome.text, lesson: f.lesson.text })),
    };
    rows.push(row);
  });

  let created: Experience[] = [];
  if (rows.length) {
    for (let i = 0; i < rows.length; i += 100) {
      const out = await db().insert(schema.agentExperiences).values(rows.slice(i, i + 100)).onConflictDoNothing().returning();
      created = created.concat(out);
    }
  }
  return { created, duplicates: rows.length - created.length + (items.length - rows.length - rejected.length), rejected, flagged };
}

/**
 * Record the outcome of an earlier decision. A pending, non-imported decision that was logged within 48 h of
 * happening becomes "witnessed": Hive Mind saw the decision before the result.
 */
export async function recordOutcome(agentId: string, experienceId: string, input: unknown): Promise<Experience> {
  const v = OutcomeInput.parse(input);
  const [e] = await db().select().from(schema.agentExperiences)
    .where(and(eq(schema.agentExperiences.id, experienceId), eq(schema.agentExperiences.agentId, agentId))).limit(1);
  if (!e) throw notFound('Experience');
  if (e.result !== 'pending') throw conflict(`The outcome of this experience was already recorded (${e.result}).`);
  const now = new Date();
  const outcome = clean(v.outcome).text;
  const lesson = v.lesson != null ? clean(v.lesson).text : e.lesson;
  const witnessed = e.source !== 'import' && e.createdAt.getTime() - e.occurredAt.getTime() <= WITNESS_LOG_WINDOW_MS && now.getTime() > e.createdAt.getTime();
  const [u] = await db().update(schema.agentExperiences).set({
    result: v.result, outcome, lesson, outcomeRecordedAt: now, witnessed, evidenceUrl: v.evidenceUrl ?? e.evidenceUrl, updatedAt: now,
    embedding: embed(embeddingText({ situation: e.situation, action: e.action, outcome, lesson })),
  }).where(and(eq(schema.agentExperiences.id, e.id), eq(schema.agentExperiences.result, 'pending'))).returning();
  if (!u) throw conflict('The outcome of this experience was already recorded.');
  return u;
}

export async function deleteExperience(agentId: string, experienceId: string) {
  const out = await db().delete(schema.agentExperiences)
    .where(and(eq(schema.agentExperiences.id, experienceId), eq(schema.agentExperiences.agentId, agentId))).returning({ id: schema.agentExperiences.id });
  if (!out.length) throw notFound('Experience');
}

export interface ListFilter { domain?: string | null; result?: ExperienceResult; q?: string; page: number; pageSize: number }

export async function listExperiences(agentId: string, f: ListFilter) {
  const { bySlug, byId } = await domainMap();
  const conds: SQL[] = [eq(schema.agentExperiences.agentId, agentId)];
  if (f.domain === 'general') conds.push(isNull(schema.agentExperiences.domainId));
  else if (f.domain) conds.push(eq(schema.agentExperiences.domainId, bySlug.get(f.domain) ?? '00000000-0000-0000-0000-000000000000'));
  if (f.result) conds.push(eq(schema.agentExperiences.result, f.result));
  if (f.q?.trim()) {
    const like = `%${f.q.trim().replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    conds.push(sql`(${schema.agentExperiences.situation} ilike ${like} or ${schema.agentExperiences.action} ilike ${like} or ${schema.agentExperiences.lesson} ilike ${like})`);
  }
  const where = and(...conds);
  const [cnt] = await db().select({ n: sql<number>`count(*)::int` }).from(schema.agentExperiences).where(where);
  const rows = await db().select().from(schema.agentExperiences).where(where)
    .orderBy(desc(schema.agentExperiences.occurredAt)).limit(f.pageSize).offset((f.page - 1) * f.pageSize);
  return { items: rows.map((r) => experienceView(r, byId)), total: Number(cnt?.n ?? 0), page: f.page, pageSize: f.pageSize };
}

export function experienceView(e: Experience, byId?: Map<string, string>) {
  return {
    id: e.id, agentId: e.agentId, domain: e.domainId ? (byId?.get(e.domainId) ?? null) : 'general',
    situation: e.situation, action: e.action, reasoning: e.reasoning, outcome: e.outcome, lesson: e.lesson, result: e.result,
    occurredAt: e.occurredAt, outcomeRecordedAt: e.outcomeRecordedAt, source: e.source, evidenceUrl: e.evidenceUrl, tags: e.tags,
    witnessed: e.witnessed, verification: e.witnessed ? 'witnessed' : 'self_reported', createdAt: e.createdAt,
  };
}

export async function experienceViews(rows: Experience[]) {
  const { byId } = await domainMap();
  return rows.map((r) => experienceView(r, byId));
}

/* ───────────── import parsing ───────────── */

const CSV_FIELDS = ['domain', 'situation', 'action', 'reasoning', 'outcome', 'lesson', 'result', 'occurredAt', 'evidenceUrl', 'tags'] as const;

/** Minimal RFC-4180 CSV parser (quoted fields, escaped quotes, CRLF). */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', q = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (q) {
      if (c === '"') { if (input[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && input[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

/** Turn an uploaded history file (JSON array, {experiences:[…]}, JSONL or CSV with a header row) into raw items. */
export function parseImport(content: string, format?: 'json' | 'jsonl' | 'csv'): unknown[] {
  const s = content.replace(/^﻿/, '').trim();
  if (!s) throw unprocessable('The file is empty.');
  const fmt = format ?? (s.startsWith('[') || s.startsWith('{"experiences"') || s.startsWith('{ "experiences"') ? 'json' : s.startsWith('{') ? 'jsonl' : 'csv');
  if (fmt === 'json') {
    let v: unknown;
    try { v = JSON.parse(s); } catch { throw unprocessable('Invalid JSON.'); }
    const arr = Array.isArray(v) ? v : (v as { experiences?: unknown })?.experiences;
    if (!Array.isArray(arr)) throw unprocessable('JSON must be an array of experiences or { "experiences": [...] }.');
    return arr;
  }
  if (fmt === 'jsonl') {
    return s.split(/\r?\n/).filter((l) => l.trim()).map((l, i) => {
      try { return JSON.parse(l); } catch { throw unprocessable(`Invalid JSON on line ${i + 1}.`); }
    });
  }
  const rows = parseCsv(s);
  const header = rows.shift()?.map((h) => h.trim().replace(/[\s_-]+(\w)/g, (_m, c: string) => c.toUpperCase()).replace(/^\w/, (c) => c.toLowerCase())) ?? [];
  if (!header.includes('situation') || !header.includes('action')) {
    throw unprocessable(`CSV needs a header row with at least "situation" and "action". Supported columns: ${CSV_FIELDS.join(', ')}.`);
  }
  return rows.map((r) => {
    const o: Record<string, unknown> = {};
    header.forEach((h, i) => {
      if (!(CSV_FIELDS as readonly string[]).includes(h)) return;
      const val = (r[i] ?? '').trim();
      if (!val) return;
      o[h] = h === 'tags' ? val.split(/[;|]/).map((t) => t.trim()).filter(Boolean) : val;
    });
    return o;
  });
}

/** Ids of experiences an agent owns among the given ids (ownership check for bulk operations). */
export async function ownedExperienceIds(agentId: string, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await db().select({ id: schema.agentExperiences.id }).from(schema.agentExperiences)
    .where(and(eq(schema.agentExperiences.agentId, agentId), inArray(schema.agentExperiences.id, ids)));
  return new Set(rows.map((r) => r.id));
}
