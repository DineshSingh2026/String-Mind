/**
 * "Connect via prompt" core: claim codes, connection state, and the pull-model task inbox shared by
 * the owner endpoints (modules/agents), the agent API (modules/agent-api) and the `inbox` adapter.
 *
 * Connection state lives in agent_connections (method 'prompt') → `config` jsonb (PromptConfig below).
 * Secrets (claim code, agent token) are stored only as sha256 hashes and never returned to clients.
 * Every write to `config` is a jsonb merge (`config || patch`) so concurrent writers never lose fields.
 */
import { EventEmitter } from 'node:events';
import { randomBytes, randomInt } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { publish } from '../ws/hub.js';
import { config } from './config.js';
import { sha256 } from './crypto.js';

export const PROMPT_METHOD = 'prompt';
export const ONLINE_WINDOW_MS = 90_000;
export const CLAIM_TTL_MS = 24 * 60 * 60_000;
export const VERIFY_MAX_ATTEMPTS = 3;
export const VERIFY_TASK_TTL_MS = 24 * 60 * 60_000;
export const POLL_SECONDS = 25;
export const MAX_RESULT_CHARS = 20_000;

/** Default time an inbox task may wait for the agent's answer (env INBOX_TASK_TIMEOUT_MS, read per call). */
export function inboxTimeoutMs(): number {
  const v = Number(process.env.INBOX_TASK_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 120_000;
}

export type ConnectionState = 'awaiting_claim' | 'claimed' | 'verifying' | 'connected' | 'offline' | 'expired';

export interface PromptConfig {
  claimCodeHash: string | null;
  claimIssuedAt: string | null;
  claimExpiresAt: string | null;
  claimedAt: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  verifiedAt: string | null;
  verifyNonce: string | null;
  verifyAttempts: number;
  agentTokenHash: string | null;
  agentReported: { name?: string; model?: string; framework?: string; description?: string } | null;
}

type Connection = typeof schema.agentConnections.$inferSelect;
type Task = typeof schema.agentTasks.$inferSelect;

export function promptConfig(c: Pick<Connection, 'config'> | null | undefined): PromptConfig {
  const x = (c?.config ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof x[k] === 'string' ? (x[k] as string) : null);
  return {
    claimCodeHash: s('claimCodeHash'), claimIssuedAt: s('claimIssuedAt'), claimExpiresAt: s('claimExpiresAt'),
    claimedAt: s('claimedAt'), firstSeenAt: s('firstSeenAt'), lastSeenAt: s('lastSeenAt'), verifiedAt: s('verifiedAt'),
    verifyNonce: s('verifyNonce'), verifyAttempts: typeof x.verifyAttempts === 'number' ? x.verifyAttempts : 0,
    agentTokenHash: s('agentTokenHash'),
    agentReported: x.agentReported && typeof x.agentReported === 'object' ? x.agentReported as PromptConfig['agentReported'] : null,
  };
}

const ms = (iso: string | null) => (iso ? Date.parse(iso) : NaN);

export function isOnline(cfg: PromptConfig, now = Date.now()): boolean {
  return !!cfg.verifiedAt && now - ms(cfg.lastSeenAt) < ONLINE_WINDOW_MS;
}

export function computeState(cfg: PromptConfig, now = Date.now()): ConnectionState {
  if (!cfg.claimedAt || !cfg.agentTokenHash) {
    if (!cfg.claimCodeHash || !(ms(cfg.claimExpiresAt) > now)) return 'expired';
    return 'awaiting_claim';
  }
  if (cfg.verifiedAt) return isOnline(cfg, now) ? 'connected' : 'offline';
  return cfg.firstSeenAt ? 'verifying' : 'claimed';
}

/** Client-safe view of the prompt connection config (no hashes, no nonce). */
export function promptConfigView(cfg: PromptConfig) {
  return {
    claimExpiresAt: cfg.claimExpiresAt, claimedAt: cfg.claimedAt, firstSeenAt: cfg.firstSeenAt,
    lastSeenAt: cfg.lastSeenAt, verifiedAt: cfg.verifiedAt, agentReported: cfg.agentReported,
  };
}

export function connectionStatusView(cfg: PromptConfig, now = Date.now()) {
  const state = computeState(cfg, now);
  return {
    method: PROMPT_METHOD,
    state,
    ...promptConfigView(cfg),
    steps: [
      { key: 'prompt', label: 'Connection prompt generated', done: !!cfg.claimIssuedAt, at: cfg.claimIssuedAt },
      { key: 'claimed', label: 'Agent claimed the code', done: !!cfg.claimedAt, at: cfg.claimedAt },
      { key: 'polling', label: 'Agent is polling for tasks', done: !!cfg.firstSeenAt, at: cfg.firstSeenAt },
      { key: 'verified', label: 'Verification task answered correctly', done: !!cfg.verifiedAt, at: cfg.verifiedAt },
    ],
  };
}

/* ───────────── claim codes & tokens ───────────── */

/** Unambiguous uppercase base32 alphabet (no I, L, O, 0, 1). */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateClaimCode(): string {
  const pick = () => Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
  return `SM-${pick()}-${pick()}`;
}

/** Normalise user input ("sm xxxx-xxxx", "SMXXXXXXXX") → "SM-XXXX-XXXX", or null if malformed. */
export function normaliseClaimCode(input: string): string | null {
  const t = input.toUpperCase().replace(/[\s-]/g, '');
  const m = /^SM([A-Z0-9]{4})([A-Z0-9]{4})$/.exec(t);
  return m ? `SM-${m[1]}-${m[2]}` : null;
}

export const newAgentToken = () => `sm_at_${randomBytes(32).toString('base64url')}`;
export const newNonce = () => randomBytes(6).toString('hex').toUpperCase();

/** Public web origin (first WEB_ORIGIN) — used for absolute URLs in prompts and connect.md. */
export const webOrigin = () => config.WEB_ORIGINS[0] ?? 'http://localhost:3700';
export const agentApiBase = () => `${webOrigin()}/api/agent-api`;
export const connectUrl = () => `${webOrigin()}/connect.md`;

/** A fresh claim: the plaintext code (returned once) + the full config that resets the connection. */
export function freshClaim(previous?: PromptConfig | null) {
  const claimCode = generateClaimCode();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CLAIM_TTL_MS).toISOString();
  const cfg: PromptConfig = {
    claimCodeHash: sha256(claimCode), claimIssuedAt: now.toISOString(), claimExpiresAt: expiresAt,
    claimedAt: null, firstSeenAt: null, lastSeenAt: null, verifiedAt: null, verifyNonce: null, verifyAttempts: 0,
    agentTokenHash: null, agentReported: previous?.agentReported ?? null,
  };
  return { claimCode, expiresAt, config: cfg as unknown as Record<string, unknown> };
}

export function buildConnectPrompt(claimCode: string, expiresAt: string) {
  const prompt = [
    'You are being connected to StringMind — Agent Intelligence Exchange.',
    `Read ${connectUrl()} and follow the instructions exactly.`,
    `Your one-time claim code is: ${claimCode} (valid for 24 hours, until ${humanUtc(expiresAt)}).`,
    'Keep the agent token you receive secret.',
  ].join('\n');
  return { prompt, claimCode, expiresAt, connectUrl: connectUrl() };
}

/** Atomic jsonb merge into agent_connections.config. */
export async function patchConnConfig(connId: string, patch: Partial<PromptConfig>, extra: Partial<Connection> = {}) {
  await db().update(schema.agentConnections)
    .set({ ...extra, config: sql`${schema.agentConnections.config} || ${JSON.stringify(patch)}::jsonb`, updatedAt: new Date() })
    .where(eq(schema.agentConnections.id, connId));
}

/** Push `agent.connection` { agentId, state } to every member of the owning org (`user:<id>` channels). */
export async function publishConnectionState(agentId: string, orgId: string, state: ConnectionState) {
  try {
    const members = await db().select({ userId: schema.memberships.userId }).from(schema.memberships).where(eq(schema.memberships.orgId, orgId));
    for (const m of members) publish(`user:${m.userId}`, 'agent.connection', { agentId, state });
  } catch (err) {
    console.error(`[agent-inbox] publish state failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/* ───────────── task inbox ───────────── */

/** In-process signals: `agent:<id>` (task enqueued), `task:<id>` (task answered/expired), `shutdown`. DB is the source of truth. */
export const inboxEvents = new EventEmitter();
inboxEvents.setMaxListeners(0);

/** Strip NUL (Postgres text cannot hold it) and cap length — agent input is untrusted text. */
export function cleanText(s: string, max: number): string {
  return s.replace(/\u0000/g, '').slice(0, max);
}

export type TaskKind = 'verify' | 'assessment' | 'training' | 'playground' | 'health';

export async function enqueueTask(agentId: string, orgId: string, kind: TaskKind, request: Task['request'], ttlMs: number): Promise<Task> {
  const [t] = await db().insert(schema.agentTasks).values({
    agentId, orgId, kind, request, status: 'pending', deadline: new Date(Date.now() + ttlMs),
  }).returning();
  inboxEvents.emit(`agent:${agentId}`);
  return t!;
}

export const verifyInstruction = (nonce: string) => `Reply with exactly this text and nothing else: STRINGMIND-OK-${nonce}`;

export async function enqueueVerifyTask(agentId: string, orgId: string, nonce: string) {
  return enqueueTask(agentId, orgId, 'verify', {
    system: 'StringMind connection verification. Follow the instruction literally.',
    messages: [{ role: 'user', content: verifyInstruction(nonce) }],
  }, VERIFY_TASK_TTL_MS);
}

/** Expire every open (pending/delivered) task of an agent — used on re-key / disconnect. Wakes adapter waiters. */
export async function expireOpenTasks(agentId: string) {
  const rows = await db().update(schema.agentTasks).set({ status: 'expired' })
    .where(and(eq(schema.agentTasks.agentId, agentId), inArray(schema.agentTasks.status, ['pending', 'delivered'])))
    .returning({ id: schema.agentTasks.id });
  for (const r of rows) inboxEvents.emit(`task:${r.id}`);
}

/** A task delivered but not answered within this window is offered again (the agent may have crashed mid-task). */
const REDELIVER_AFTER_MS = 60_000;

/** Atomically take the oldest deliverable task for an agent (marks it delivered). */
export async function takeNextTask(agentId: string): Promise<Task | null> {
  for (let i = 0; i < 5; i++) {
    const now = new Date();
    const redeliverBefore = new Date(now.getTime() - REDELIVER_AFTER_MS).toISOString();
    const [cand] = await db().select().from(schema.agentTasks).where(and(
      eq(schema.agentTasks.agentId, agentId),
      sql`${schema.agentTasks.deadline} > ${now.toISOString()}::timestamptz`,
      sql`(${schema.agentTasks.status} = 'pending' OR (${schema.agentTasks.status} = 'delivered' AND ${schema.agentTasks.deliveredAt} < ${redeliverBefore}::timestamptz))`,
    )).orderBy(schema.agentTasks.createdAt).limit(1);
    if (!cand) return null;
    const [taken] = await db().update(schema.agentTasks).set({ status: 'delivered', deliveredAt: now })
      .where(and(eq(schema.agentTasks.id, cand.id), eq(schema.agentTasks.status, cand.status),
        cand.deliveredAt ? eq(schema.agentTasks.deliveredAt, cand.deliveredAt) : sql`${schema.agentTasks.deliveredAt} IS NULL`))
      .returning();
    if (taken) return taken;
  }
  return null;
}

/** Resolves after `ms`, on `event`, or on server shutdown — whichever first. */
export function waitSignal(event: string, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); inboxEvents.off(event, done); inboxEvents.off('shutdown', done); resolve(); };
    const t = setTimeout(done, Math.max(0, ms));
    inboxEvents.once(event, done);
    inboxEvents.once('shutdown', done);
  });
}

let shuttingDown = false;
export function signalShutdown() { shuttingDown = true; inboxEvents.emit('shutdown'); }
export function resetShutdown() { shuttingDown = false; }
export const isShuttingDown = () => shuttingDown;

/** DB fallback poll interval while waiting (covers multi-instance deployments where the in-process signal can't reach). */
const DB_POLL_MS = 500;

/**
 * Wait until the task is answered. Returns the answered row, or null on timeout/expiry
 * (on timeout the task is marked expired so a late answer gets 409).
 */
export async function waitForAnswer(taskId: string, timeoutMs: number): Promise<Task | null> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const [t] = await db().select().from(schema.agentTasks).where(eq(schema.agentTasks.id, taskId)).limit(1);
    if (!t || t.status === 'expired') return null;
    if (t.status === 'answered') return t;
    const left = until - Date.now();
    if (left <= 0 || shuttingDown) break;
    await waitSignal(`task:${taskId}`, Math.min(DB_POLL_MS, left));
  }
  const [expired] = await db().update(schema.agentTasks).set({ status: 'expired' })
    .where(and(eq(schema.agentTasks.id, taskId), inArray(schema.agentTasks.status, ['pending', 'delivered']))).returning();
  if (expired) return null;
  // answered in the last instant
  const [t] = await db().select().from(schema.agentTasks).where(eq(schema.agentTasks.id, taskId)).limit(1);
  return t?.status === 'answered' ? t : null;
}

export async function countPendingTasks(agentId: string): Promise<number> {
  const [r] = await db().select({ n: sql<number>`count(*)::int` }).from(schema.agentTasks).where(and(
    eq(schema.agentTasks.agentId, agentId), eq(schema.agentTasks.status, 'pending'),
    sql`${schema.agentTasks.deadline} > ${new Date().toISOString()}::timestamptz`,
  ));
  return Number(r?.n ?? 0);
}

/** Owner-triggered ping ("Test connection") for an inbox agent. */
export async function pingInboxAgent(agentId: string, orgId: string, timeoutMs = 30_000): Promise<{ ok: boolean; latencyMs: number; error?: string; sample?: string }> {
  const [conn] = await db().select().from(schema.agentConnections).where(eq(schema.agentConnections.agentId, agentId)).limit(1);
  const cfg = promptConfig(conn);
  if (!cfg.verifiedAt) return { ok: false, latencyMs: 0, error: 'Agent has not completed the connection handshake yet — give it the connection prompt.' };
  if (!isOnline(cfg)) return { ok: false, latencyMs: 0, error: 'Agent offline — it has not polled StringMind in the last 90 seconds.' };
  const nonce = newNonce();
  const started = Date.now();
  const task = await enqueueTask(agentId, orgId, 'health', {
    system: 'StringMind connection check. Follow the instruction literally.',
    messages: [{ role: 'user', content: `Reply with exactly this text and nothing else: STRINGMIND-PING-${nonce}` }],
  }, timeoutMs);
  const done = await waitForAnswer(task.id, timeoutMs);
  const latencyMs = Date.now() - started;
  if (!done) return { ok: false, latencyMs, error: `Agent did not answer the ping within ${Math.round(timeoutMs / 1000)}s — is it running and polling?` };
  const text = done.response ?? '';
  return text.includes(`STRINGMIND-PING-${nonce}`)
    ? { ok: true, latencyMs, sample: text.slice(0, 200) }
    : { ok: false, latencyMs, error: 'Agent answered the ping but not with the requested text.', sample: text.slice(0, 200) };
}

/** "18 Nov 2026, 07:06 UTC" — readable in a prompt for humans and agents alike. */
function humanUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}
