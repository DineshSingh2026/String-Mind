/**
 * Auto-evaluation on connect.
 *
 * The moment an agent is connected and verified (prompt-connect verification, or the first successful connection
 * test of an API agent), Hive Mind starts a SCREENING exam: 2 reviewed private items in each of up to 6 domains,
 * all sent at once. Domains: the agent's claimed domains (a hint for WHERE to look, never scored), domains whose
 * name/skills match its description/role, plus 2 random others — only domains with ≥ 2 unseen reviewed questions.
 * When the screening is graded, a full adaptive exam starts in the best 1–2 domains (engine.ts startFollowUp).
 *
 * Rules: owner controls respected (assertAgentActive), at most one auto-run per agent per 24 h (idempotent under
 * concurrent triggers), owner opt-out per agent (agents.permissions.autoEvaluate = false), admin kill-switch
 * (system_settings 'pro_auto_evaluate' { enabled: false }).
 */
import { randomInt } from 'node:crypto';
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import { DOMAINS } from '@aix/shared';
import { db, schema } from '../../db/client.js';
import { notify } from '../../lib/notify.js';
import { assertAgentActive } from '../../modules/owner-controls/service.js';
import { SCREENING_ITEMS_PER_DOMAIN, SCREENING_MAX_DOMAINS, examLink, seenQuestionIds, startScreening, withLock } from './engine.js';

export const AUTO_SETTING_KEY = 'pro_auto_evaluate';
export const AUTO_COOLDOWN_MS = 24 * 3_600_000;

type Agent = typeof schema.agents.$inferSelect;

export async function globalAutoEnabled(): Promise<boolean> {
  const [row] = await db().select().from(schema.systemSettings).where(eq(schema.systemSettings.key, AUTO_SETTING_KEY)).limit(1);
  const v = row?.value as { enabled?: unknown } | undefined;
  return v?.enabled !== false;
}

export async function setGlobalAuto(enabled: boolean, userId: string | null) {
  await db().insert(schema.systemSettings).values({ key: AUTO_SETTING_KEY, value: { enabled }, updatedBy: userId })
    .onConflictDoUpdate({ target: schema.systemSettings.key, set: { value: { enabled }, updatedBy: userId, updatedAt: new Date() } });
}

export const agentAutoEnabled = (agent: Pick<Agent, 'permissions'>) => (agent.permissions as { autoEvaluate?: unknown } | null)?.autoEvaluate !== false;

export async function setAgentAuto(agentId: string, enabled: boolean) {
  await db().update(schema.agents).set({ permissions: sql`${schema.agents.permissions} || ${JSON.stringify({ autoEvaluate: enabled })}::jsonb`, updatedAt: new Date() })
    .where(eq(schema.agents.id, agentId));
}

const STOP = new Set(['with', 'that', 'this', 'from', 'your', 'have', 'will', 'into', 'about', 'agent', 'agents', 'assistant', 'helps', 'help', 'using', 'based',
  'their', 'they', 'them', 'what', 'when', 'which', 'also', 'more', 'than', 'such', 'other', 'tasks', 'task', 'answer', 'answers', 'questions', 'general', 'expert', 'specialist']);
export const tokens = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOP.has(w)).map((w) => w.replace(/(ing|ers|er|s)$/, '')));

/** Domains (slug) with ≥ 2 unseen active private questions for this agent. */
async function eligibleDomains(agentId: string): Promise<Set<string>> {
  const rows = await db().select({ id: schema.proQuestions.id, d: schema.proQuestions.domainSlug }).from(schema.proQuestions)
    .where(and(eq(schema.proQuestions.status, 'active'), eq(schema.proQuestions.visibility, 'private')));
  const seen = await seenQuestionIds(agentId);
  const counts = new Map<string, number>();
  for (const r of rows) if (r.d && !seen.has(r.id)) counts.set(r.d, (counts.get(r.d) ?? 0) + 1);
  return new Set([...counts].filter(([, n]) => n >= SCREENING_ITEMS_PER_DOMAIN).map(([d]) => d));
}

/** Screening domains: claimed (hint) → description/role matches → 2 random others; up to 6, eligible only. */
export async function suggestScreeningDomains(agent: Pick<Agent, 'id' | 'claimedDomains' | 'description' | 'role' | 'name'>, max = SCREENING_MAX_DOMAINS): Promise<string[]> {
  const eligible = await eligibleDomains(agent.id);
  const known = DOMAINS.filter((d) => eligible.has(d.slug));
  const out: string[] = [];
  const add = (s: string) => { if (out.length < max && eligible.has(s) && !out.includes(s)) out.push(s); };
  for (const s of agent.claimedDomains ?? []) if (out.length < max - 2) add(s);
  const text = tokens(`${agent.description} ${agent.role} ${agent.name}`);
  const matches = known.map((d) => {
    const dt = tokens(`${d.name} ${d.slug} ${d.skills.join(' ')}`);
    let n = 0; for (const t of dt) if (text.has(t)) n++;
    return { slug: d.slug, n };
  }).filter((m) => m.n > 0).sort((a, b) => b.n - a.n);
  for (const m of matches) if (out.length < max - 2) add(m.slug);
  const rest = known.map((d) => d.slug).filter((s) => !out.includes(s));
  for (let i = 0; i < 2 && rest.length; i++) add(rest.splice(randomInt(rest.length), 1)[0]!);
  // still room (few claims/matches): fill with more random eligible domains up to 3 total so the screen is meaningful
  while (out.length < Math.min(3, max) && rest.length) add(rest.splice(randomInt(rest.length), 1)[0]!);
  return out;
}

export type AutoResult = { started: true; examId: string; domains: string[] } | { started: false; reason: string };

/**
 * Start the automatic screening if every rule allows it. Never throws (safe to call from connect hooks).
 * `force` (owner's manual "run now") skips only the per-agent opt-out, never the cooldown or the admin switch.
 */
export async function maybeAutoEvaluate(agentId: string, trigger: string, opts: { force?: boolean; requestedBy?: string | null } = {}): Promise<AutoResult> {
  return withLock(`auto:${agentId}`, async (): Promise<AutoResult> => {
    try {
      if (!(await globalAutoEnabled())) return { started: false, reason: 'Automatic evaluation is switched off by the administrator.' };
      const [agent] = await db().select().from(schema.agents).where(eq(schema.agents.id, agentId)).limit(1);
      if (!agent || agent.deletedAt) return { started: false, reason: 'Agent not found.' };
      if (!opts.force && !agentAutoEnabled(agent)) return { started: false, reason: 'Automatic evaluation is switched off for this agent.' };
      try { await assertAgentActive(agentId); } catch (e) { return { started: false, reason: e instanceof Error ? e.message : String(e) }; }
      const since = new Date(Date.now() - AUTO_COOLDOWN_MS);
      const [recent] = await db().select({ id: schema.proExams.id }).from(schema.proExams)
        .where(and(eq(schema.proExams.agentId, agentId), eq(schema.proExams.mode, 'screening'), gt(schema.proExams.createdAt, since))).limit(1);
      if (recent) return { started: false, reason: 'A screening already ran for this agent in the last 24 hours.' };
      const [busy] = await db().select({ id: schema.proExams.id }).from(schema.proExams)
        .where(and(eq(schema.proExams.agentId, agentId), inArray(schema.proExams.status, ['queued', 'running', 'grading']))).limit(1);
      if (busy) return { started: false, reason: 'An exam is already in progress for this agent.' };
      const domains = await suggestScreeningDomains(agent);
      if (!domains.length) return { started: false, reason: 'No domain has enough reviewed questions for a screening yet.' };
      const exam = await startScreening(agent, domains, { trigger, requestedBy: opts.requestedBy ?? null });
      await notify(agent.ownerId, 'evaluation_result', `Evaluating ${agent.name}`,
        `Hive Mind started a quick screening in ${domains.length} domains (2 questions each). A full professional exam follows in the strongest domains.`, examLink(exam.id)).catch(() => undefined);
      return { started: true, examId: exam.id, domains };
    } catch (e) {
      console.error(`[pro-exam] auto-evaluation for ${agentId} not started`, e);
      return { started: false, reason: e instanceof Error ? e.message : String(e) };
    }
  });
}
