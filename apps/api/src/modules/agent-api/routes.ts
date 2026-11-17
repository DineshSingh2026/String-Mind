/**
 * Agent API (pull model) — used by agents connected via prompt. See docs/API.md#connect-via-prompt and GET /public/connect.md.
 *
 * Auth: `Authorization: Bearer sm_at_…` (agent token from POST /agent-api/claim). User sessions and API keys are NOT
 * accepted here, and agent tokens are not accepted on the user API. Everything an agent sends is untrusted text.
 */
import { maybeAutoEvaluate } from '../../engine/pro-exam/auto.js'; // [pro-exams] auto-evaluation hook
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db/client.js';
import { config } from '../../lib/config.js';
import { sha256 } from '../../lib/crypto.js';
import { AppError, badRequest, conflict, forbidden, notFound, unauthorized } from '../../lib/errors.js';
import { parse } from '../../lib/http.js';
import { notify } from '../../lib/notify.js';
import { emitEvent } from '../../lib/webhooks.js';
import {
  MAX_RESULT_CHARS, ONLINE_WINDOW_MS, POLL_SECONDS, PROMPT_METHOD, VERIFY_MAX_ATTEMPTS, agentApiBase, cleanText, connectUrl, computeState,
  countPendingTasks, enqueueVerifyTask, expireOpenTasks, inboxEvents, isOnline, isShuttingDown, newAgentToken, newNonce,
  normaliseClaimCode, patchConnConfig, promptConfig, publishConnectionState, resetShutdown, runTaskAnswerHandler, signalShutdown, takeNextTask, takeTasks, waitSignal,
} from '../../lib/agent-inbox.js';
import { handleAsyncTaskAnswer } from '../../engine/assessment.js';
import { ensureHealthCheckScheduled } from '../agents/service.js';
import { consumeAgentTokenRequest } from '../../lib/agent-rate-limit.js';
import { recordVerdict } from '../hive-learning/verdicts.js';

type Agent = typeof schema.agents.$inferSelect;
type Connection = typeof schema.agentConnections.$inferSelect;
interface AgentCtx { agent: Agent; conn: Connection; tokenHash: string }

declare module 'fastify' {
  interface FastifyRequest { agentCtx: AgentCtx | null }
}

const TOUCH_THROTTLE_MS = 5_000;
const SWEEP_INTERVAL_MS = 30_000;

const gone = (msg: string) => new AppError(410, 'gone', msg);

function bearerToken(req: FastifyRequest): string {
  const h = req.headers.authorization ?? '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

/** Resolve the agent token → agent + prompt connection, or throw 401. */
async function agentAuth(req: FastifyRequest): Promise<AgentCtx> {
  const token = bearerToken(req);
  if (!token.startsWith('sm_at_')) throw unauthorized('Agent token required: send "Authorization: Bearer sm_at_…" (from POST /agent-api/claim)');
  const tokenHash = sha256(token);
  const [row] = await db().select({ agent: schema.agents, conn: schema.agentConnections }).from(schema.agentConnections)
    .innerJoin(schema.agents, eq(schema.agents.id, schema.agentConnections.agentId))
    .where(and(eq(schema.agentConnections.method, PROMPT_METHOD), sql`${schema.agentConnections.config}->>'agentTokenHash' = ${tokenHash}`))
    .limit(1);
  if (!row || row.agent.deletedAt || row.conn.status === 'disconnected') throw unauthorized('Invalid or revoked agent token — ask your owner for a new connection prompt');
  if (row.agent.status === 'suspended') throw forbidden('This agent is suspended on Hive Mind');
  return { ...row, tokenHash };
}

/**
 * Fresh check during a long-poll: is this token still the connection's token, and is the agent paused?
 * A rotated/revoked token must never pick up a task (e.g. the new link's verification task) after the rotation.
 */
async function pollState(agentId: string, tokenHash: string): Promise<{ valid: boolean; paused: boolean }> {
  const [row] = await db().select({
    pausedAt: schema.agents.pausedAt, deletedAt: schema.agents.deletedAt, status: schema.agents.status, connStatus: schema.agentConnections.status,
  }).from(schema.agentConnections).innerJoin(schema.agents, eq(schema.agents.id, schema.agentConnections.agentId))
    .where(and(eq(schema.agentConnections.agentId, agentId), eq(schema.agentConnections.method, PROMPT_METHOD),
      sql`${schema.agentConnections.config}->>'agentTokenHash' = ${tokenHash}`)).limit(1);
  if (!row || row.deletedAt || row.status === 'suspended' || row.connStatus === 'disconnected') return { valid: false, paused: false };
  return { valid: true, paused: !!row.pausedAt };
}

const PAUSED_MESSAGE = 'Your owner has paused this agent on Hive Mind. No tasks are delivered while paused; keep polling (slowly) and work resumes automatically when the owner resumes the agent.';

/** Record activity (throttled to one DB write per 5s); flips an offline-but-verified agent back to connected. */
async function touch(ctx: AgentCtx) {
  const cfg = promptConfig(ctx.conn);
  const now = Date.now();
  const last = cfg.lastSeenAt ? Date.parse(cfg.lastSeenAt) : 0;
  if (now - last < TOUCH_THROTTLE_MS) return;
  const wasOnline = isOnline(cfg, now);
  const back = !!cfg.verifiedAt && (ctx.conn.status !== 'connected' || !wasOnline);
  await patchConnConfig(ctx.conn.id, { lastSeenAt: new Date(now).toISOString() }, back ? { status: 'connected', lastError: null } : {});
  if (back) {
    await db().update(schema.agents).set({ health: 'healthy', lastHealthCheckAt: new Date(now), updatedAt: new Date(now) }).where(eq(schema.agents.id, ctx.agent.id));
    await publishConnectionState(ctx.agent.id, ctx.agent.orgId, 'connected');
  }
}

/** Mark verified prompt agents that stopped polling as offline (connection 'error', health 'down') and notify the UI. */
export async function sweepOfflinePromptAgents() {
  const cutoff = new Date(Date.now() - ONLINE_WINDOW_MS).toISOString();
  const rows = await db().select({ conn: schema.agentConnections, agent: schema.agents }).from(schema.agentConnections)
    .innerJoin(schema.agents, eq(schema.agents.id, schema.agentConnections.agentId))
    .where(and(eq(schema.agentConnections.method, PROMPT_METHOD), eq(schema.agentConnections.status, 'connected'),
      sql`${schema.agentConnections.config}->>'verifiedAt' IS NOT NULL`,
      sql`coalesce((${schema.agentConnections.config}->>'lastSeenAt')::timestamptz, 'epoch'::timestamptz) < ${cutoff}::timestamptz`));
  for (const { conn, agent } of rows) {
    const now = new Date();
    const [u] = await db().update(schema.agentConnections).set({ status: 'error', lastError: 'Agent stopped polling Hive Mind (offline)', updatedAt: now })
      .where(and(eq(schema.agentConnections.id, conn.id), eq(schema.agentConnections.status, 'connected'))).returning({ id: schema.agentConnections.id });
    if (!u) continue;
    await db().update(schema.agents).set({ health: 'down', updatedAt: now }).where(eq(schema.agents.id, agent.id));
    await publishConnectionState(agent.id, agent.orgId, 'offline');
  }
  return rows.length;
}

const ClaimBody = z.object({
  claimCode: z.string().max(64),
  agent: z.object({
    name: z.string().max(200).optional(),
    model: z.string().max(200).optional(),
    framework: z.string().max(200).optional(),
    description: z.string().max(4000).optional(),
  }).optional(),
});

const ResultBody = z.object({ text: z.string().max(MAX_RESULT_CHARS, `text must be at most ${MAX_RESULT_CHARS} characters`) });
const MAX_BATCH_RESULTS = 100;
const BatchResultBody = z.object({
  results: z.array(z.object({ id: z.string().max(64), text: z.string() })).min(1).max(MAX_BATCH_RESULTS, `at most ${MAX_BATCH_RESULTS} results per request`),
});
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Task = typeof schema.agentTasks.$inferSelect;
const taskView = (task: Task) => ({
  id: task.id, kind: task.kind, messages: task.request.messages, system: task.request.system ?? null, deadline: task.deadline.toISOString(),
});

/** Record the first poll (any task endpoint) so the owner sees "Agent is polling for tasks". */
async function markFirstSeen(agent: Agent, conn: Connection) {
  const cfg = promptConfig(conn);
  if (cfg.firstSeenAt) return;
  await patchConnConfig(conn.id, { firstSeenAt: new Date().toISOString() });
  await publishConnectionState(agent.id, agent.orgId, cfg.verifiedAt ? 'connected' : 'verifying');
}

/** Accept one answer (shared by the single and batch endpoints). Throws AppError (404/409) when it can't be accepted. */
async function submitResult(agent: Agent, id: string, raw: string): Promise<{ task: Task; verify?: { verified: boolean; message: string } }> {
  const text = cleanText(raw, MAX_RESULT_CHARS);
  const [task] = await db().select().from(schema.agentTasks).where(and(eq(schema.agentTasks.id, id), eq(schema.agentTasks.agentId, agent.id))).limit(1);
  if (!task) throw notFound('Task');
  if (task.status === 'answered') throw conflict('This task was already answered');
  if (task.status === 'expired') throw conflict('This task has expired (its deadline passed or the connection was re-keyed)');
  if (task.deadline.getTime() <= Date.now()) {
    await db().update(schema.agentTasks).set({ status: 'expired' }).where(eq(schema.agentTasks.id, id));
    inboxEvents.emit(`task:${id}`);
    throw conflict('This task has expired (its deadline passed)');
  }
  const [answered] = await db().update(schema.agentTasks).set({ status: 'answered', response: text, answeredAt: new Date() })
    .where(and(eq(schema.agentTasks.id, id), sql`${schema.agentTasks.status} IN ('pending', 'delivered')`)).returning();
  if (!answered) throw conflict('This task was already answered or has expired');
  inboxEvents.emit(`task:${id}`);
  // Async assessment answers are graded on arrival (and the assessment finalized once all are in).
  if (answered.kind === 'assessment' && answered.meta) {
    await handleAsyncTaskAnswer(answered).catch((e) => console.error(`[agent-api] grading task ${id} failed`, e));
  }
  // Feature-owned async kinds (pro exams, live checks, ...) are dispatched to their registered handler.
  await runTaskAnswerHandler(answered).catch((e) => console.error(`[agent-api] ${answered.kind} answer handler for task ${id} failed`, e));
  if (task.kind !== 'verify') return { task: answered };
  return { task: answered, verify: await handleVerifyAnswer(agent, text) };
}

/** Single-line, capped, control-char-free text for agent self-reported fields. */
const line = (s: string | undefined, max: number) => {
  if (s === undefined) return undefined;
  const t = cleanText(s, max * 2).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
  return t || undefined;
};

export default async function routes(app: FastifyInstance) {
  app.decorateRequest('agentCtx', null);
  let sweepTimer: NodeJS.Timeout | undefined;

  app.addHook('onReady', async () => {
    resetShutdown();
    if (!config.isTest && !config.DISABLE_JOBS) {
      sweepTimer = setInterval(() => { void sweepOfflinePromptAgents().catch((e) => console.error('[agent-api] offline sweep failed', e)); }, SWEEP_INTERVAL_MS);
      sweepTimer.unref();
    }
  });
  // Release long-polls immediately so graceful shutdown / tsx-watch reloads aren't held up for 25s.
  app.addHook('preClose', async () => { signalShutdown(); if (sweepTimer) clearInterval(sweepTimer); });

  app.addHook('preHandler', async (req, reply) => {
    if (req.routeOptions.config && (req.routeOptions.config as { public?: boolean }).public) return;
    // Per-token rate limit, checked before the DB lookup so floods of invalid tokens are throttled too.
    const token = bearerToken(req);
    if (token) {
      const d = consumeAgentTokenRequest(sha256(token));
      reply.header('x-ratelimit-limit', d.limit);
      reply.header('x-ratelimit-remaining', d.remaining);
      if (!d.allowed) {
        reply.header('retry-after', d.retryAfterSec);
        throw new AppError(429, 'rate_limited', `Agent token rate limit exceeded (${d.limit} requests/min). Retry in ${d.retryAfterSec}s.`);
      }
    }
    const ctx = await agentAuth(req);
    req.agentCtx = ctx;
    await touch(ctx);
  });

  /* ───────────── claim (no auth) ───────────── */

  app.post('/claim', {
    config: { public: true, rateLimit: { max: config.isTest ? 1000 : 10, timeWindow: '1 minute', keyGenerator: (req: FastifyRequest) => `claim:${req.ip}` } },
  }, async (req) => {
    const body = parse(ClaimBody, req.body);
    const code = normaliseClaimCode(body.claimCode);
    if (!code) throw badRequest('claimCode must look like SM-XXXX-XXXX (from the connection prompt your owner gave you)');
    const hash = sha256(code);
    const [row] = await db().select({ agent: schema.agents, conn: schema.agentConnections }).from(schema.agentConnections)
      .innerJoin(schema.agents, eq(schema.agents.id, schema.agentConnections.agentId))
      .where(and(eq(schema.agentConnections.method, PROMPT_METHOD), sql`${schema.agentConnections.config}->>'claimCodeHash' = ${hash}`))
      .limit(1);
    if (!row || row.agent.deletedAt || row.conn.status === 'disconnected') throw new AppError(404, 'not_found', 'Unknown claim code — it may have been replaced by a newer one. Ask your owner for a new connection prompt.');
    if (row.agent.status === 'suspended') throw forbidden('This agent is suspended on Hive Mind');
    const cfg = promptConfig(row.conn);
    if (cfg.claimedAt) throw gone('This claim code has already been used. Ask your owner for a new connection prompt.');
    if (!cfg.claimExpiresAt || Date.parse(cfg.claimExpiresAt) <= Date.now()) throw gone('This claim code has expired. Ask your owner for a new connection prompt.');

    const token = newAgentToken();
    const nonce = newNonce();
    const now = new Date().toISOString();
    const reported = body.agent ? {
      name: line(body.agent.name, 80), model: line(body.agent.model, 120),
      framework: line(body.agent.framework, 80), description: line(body.agent.description, 1000),
    } : null;
    const patch = {
      claimedAt: now, lastSeenAt: now, firstSeenAt: null, verifiedAt: null, agentTokenHash: sha256(token),
      verifyNonce: nonce, verifyAttempts: 1, ...(reported ? { agentReported: reported } : {}),
    };
    // Single use: only succeeds while this exact code is still unclaimed (concurrent claims → one winner).
    const [won] = await db().update(schema.agentConnections)
      .set({ config: sql`${schema.agentConnections.config} || ${JSON.stringify(patch)}::jsonb`, status: 'pending', lastError: null, updatedAt: new Date() })
      .where(and(eq(schema.agentConnections.id, row.conn.id), sql`${schema.agentConnections.config}->>'claimCodeHash' = ${hash}`,
        sql`${schema.agentConnections.config}->>'claimedAt' IS NULL`))
      .returning({ id: schema.agentConnections.id });
    if (!won) throw gone('This claim code has already been used. Ask your owner for a new connection prompt.');

    if (reported?.model && row.agent.modelName === 'self-hosted') {
      await db().update(schema.agents).set({ modelName: reported.model, updatedAt: new Date() }).where(eq(schema.agents.id, row.agent.id));
    }
    await expireOpenTasks(row.agent.id);
    await enqueueVerifyTask(row.agent.id, row.agent.orgId, nonce);
    await publishConnectionState(row.agent.id, row.agent.orgId, 'claimed');

    const base = agentApiBase();
    return {
      agentToken: token,
      agentId: row.agent.id,
      agentName: row.agent.name,
      endpoints: {
        tasks: `${base}/tasks?limit=50`,
        results: `${base}/tasks/results`,
        next: `${base}/tasks/next?wait=${POLL_SECONDS}`,
        result: `${base}/tasks/{taskId}/result`,
        heartbeat: `${base}/heartbeat`,
        me: `${base}/me`,
      },
      pollSeconds: POLL_SECONDS,
      instructions: 'Check-in mode (any chat assistant): whenever your owner asks you to check Hive Mind, GET endpoints.tasks, '
        + 'answer every task, POST all answers to endpoints.results, and repeat until no tasks remain. Tasks wait up to 24 hours, '
        + 'so you do not need to stay online. Always-on mode: long-poll endpoints.next and POST each answer to endpoints.result. '
        + `Your first task is a verification task. Full guide: ${connectUrl()}`,
    };
  });

  /* ───────────── batch check-in (chat assistants) ───────────── */

  app.get('/tasks', async (req) => {
    const { agent, conn } = req.agentCtx!;
    const { limit } = parse(z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }), req.query);
    await markFirstSeen(agent, conn);
    if (agent.pausedAt) return { tasks: [], remaining: await countPendingTasks(agent.id), paused: true, message: PAUSED_MESSAGE };
    const tasks = await takeTasks(agent.id, limit);
    return { tasks: tasks.map(taskView), remaining: await countPendingTasks(agent.id) };
  });

  app.post('/tasks/results', { bodyLimit: 4 * 1024 * 1024 }, async (req) => {
    const { agent } = req.agentCtx!;
    const { results } = parse(BatchResultBody, req.body);
    let accepted = 0;
    const rejected: { id: string; reason: string }[] = [];
    let verification: { verified: boolean; message: string } | undefined;
    for (const r of results) {
      if (!UUID_RE.test(r.id)) { rejected.push({ id: r.id, reason: 'invalid task id' }); continue; }
      if (r.text.length > MAX_RESULT_CHARS) { rejected.push({ id: r.id, reason: `text must be at most ${MAX_RESULT_CHARS} characters` }); continue; }
      try {
        const out = await submitResult(agent, r.id, r.text);
        accepted++;
        if (out.verify) verification = out.verify;
      } catch (e) {
        rejected.push({ id: r.id, reason: e instanceof Error ? e.message : String(e) });
      }
    }
    return { accepted, rejected, remaining: await countPendingTasks(agent.id), ...(verification ? { verification } : {}) };
  });

  /* ───────────── tasks ───────────── */

  app.get('/tasks/next', async (req, reply) => {
    const { agent, conn, tokenHash } = req.agentCtx!;
    const { wait } = parse(z.object({ wait: z.coerce.number().int().min(0).max(POLL_SECONDS).default(POLL_SECONDS) }), req.query);
    await markFirstSeen(agent, conn);
    let aborted = false;
    reply.raw.once('close', () => { if (!reply.raw.writableEnded) aborted = true; });
    const until = Date.now() + wait * 1000;
    let paused = !!agent.pausedAt;
    for (;;) {
      if (aborted) return reply; // client went away — never mark a task delivered to a dead socket
      // re-checked every iteration: the owner may pause/resume or rotate the link while we wait
      const st = await pollState(agent.id, tokenHash);
      if (!st.valid) throw unauthorized('Invalid or revoked agent token — ask your owner for a new connection prompt');
      // paused while this poll was waiting → answer right away so the agent learns about it immediately
      // (an agent that was already paused when it asked keeps a held poll, which is gentler on the server)
      if (st.paused && !agent.pausedAt) { paused = true; break; }
      paused = st.paused;
      const task = paused ? null : await takeNextTask(agent.id);
      if (task) {
        return { task: taskView(task) };
      }
      const left = until - Date.now();
      if (left <= 0 || isShuttingDown()) break;
      // woken by a new task for this agent; 2s DB re-check covers multi-instance deployments
      await waitSignal(`agent:${agent.id}`, Math.min(2_000, left));
    }
    // Paused agents get an empty poll plus a header, so runners can show "paused" and slow down.
    if (paused) reply.header('x-hive-paused', 'true');
    return reply.status(204).send();
  });

  app.post('/tasks/:id/result', async (req) => {
    const { agent } = req.agentCtx!;
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const { text } = parse(ResultBody, req.body);
    const out = await submitResult(agent, id, text);
    return out.verify ? { ok: true, ...out.verify } : { ok: true };
  });

  app.post('/heartbeat', async (req) => {
    const { agent } = req.agentCtx!;
    // `paused` is only present while paused (keeps the long-standing response shape for active agents)
    return { ok: true, pendingTasks: await countPendingTasks(agent.id), ...(agent.pausedAt ? { paused: true, message: PAUSED_MESSAGE } : {}) };
  });

  /**
   * The agent itself confirms or disputes a piece of hive knowledge (a hive lesson, another org's verified
   * knowledge listing, or a visible approved lesson). Same rules as owners recording it in the app: no
   * self-confirmation, one verdict per agent per item (a new call changes it). Attributed to the agent's owner.
   */
  app.post('/verdicts', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const { agent } = req.agentCtx!;
    const body = parse(z.object({
      targetType: z.enum(['hive_lesson', 'listing', 'artefact']),
      targetId: z.string().uuid(),
      verdict: z.enum(['confirm', 'dispute']),
      note: z.string().max(1000).default(''),
    }), req.body);
    return recordVerdict({ orgId: agent.orgId, userId: agent.ownerId, agentId: agent.id, ...body });
  });

  app.get('/me', async (req) => {
    const { agent } = req.agentCtx!;
    const [conn] = await db().select().from(schema.agentConnections).where(eq(schema.agentConnections.agentId, agent.id)).limit(1);
    const cfg = promptConfig(conn);
    return {
      agentId: agent.id, name: agent.name, slug: agent.slug, description: agent.description, modelName: agent.modelName,
      status: agent.status, health: agent.health,
      paused: !!agent.pausedAt, pausedAt: agent.pausedAt ? agent.pausedAt.toISOString() : null,
      connection: { state: computeState(cfg), claimedAt: cfg.claimedAt, verifiedAt: cfg.verifiedAt, lastSeenAt: cfg.lastSeenAt },
      pendingTasks: await countPendingTasks(agent.id),
      pollSeconds: POLL_SECONDS,
    };
  });
}

/** Grade a verify-task answer: success → connected/active/healthy + owner notified; failure → new verify task (max 3). */
async function handleVerifyAnswer(agent: Agent, text: string): Promise<{ verified: boolean; message: string }> {
  const [conn] = await db().select().from(schema.agentConnections).where(eq(schema.agentConnections.agentId, agent.id)).limit(1);
  if (!conn) return { verified: false, message: 'Connection not found' };
  const cfg = promptConfig(conn);
  if (cfg.verifiedAt) return { verified: true, message: 'Already verified' };
  const now = new Date();
  if (cfg.verifyNonce && text.includes(`STRINGMIND-OK-${cfg.verifyNonce}`)) {
    await patchConnConfig(conn.id, { verifiedAt: now.toISOString(), verifyNonce: null, lastSeenAt: now.toISOString() },
      { status: 'connected', lastError: null, lastTestedAt: now });
    await db().update(schema.agents).set({
      status: agent.status === 'draft' || agent.status === 'disconnected' ? 'active' : agent.status,
      health: 'healthy', lastHealthCheckAt: now, updatedAt: now,
    }).where(eq(schema.agents.id, agent.id));
    await notify(agent.ownerId, 'system', `${agent.name} connected via prompt`,
      `${agent.name} claimed its connection code and passed verification. It is now polling Hive Mind for tasks.`, `/app/agents/${agent.id}`);
    await emitEvent(agent.orgId, 'agent.connected', { agentId: agent.id, name: agent.name, method: PROMPT_METHOD });
    await publishConnectionState(agent.id, agent.orgId, 'connected');
    await ensureHealthCheckScheduled().catch(() => undefined);
    // [pro-exams] auto-evaluation on connect: start the screening right away (non-blocking; never throws).
    void maybeAutoEvaluate(agent.id, 'connect');
    return { verified: true, message: 'Verified — you are connected. Keep polling for tasks.' };
  }
  if (cfg.verifyAttempts < VERIFY_MAX_ATTEMPTS) {
    const nonce = newNonce();
    await patchConnConfig(conn.id, { verifyNonce: nonce, verifyAttempts: cfg.verifyAttempts + 1 });
    await enqueueVerifyTask(agent.id, agent.orgId, nonce);
    return { verified: false, message: 'Verification failed — reply with EXACTLY the requested text. A new verification task has been queued.' };
  }
  await patchConnConfig(conn.id, { verifyNonce: null }, { status: 'error', lastError: 'Agent failed verification 3 times' });
  return { verified: false, message: 'Verification failed 3 times. Ask your owner for a new connection prompt.' };
}
