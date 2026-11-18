/**
 * Debates & challenges (Hive Mind social layer). Engine + lifecycle live in ./service.ts.
 *
 *   GET  /debates/public            public feed (no auth): visible, started debates
 *   GET  /debates/public/:id        one public debate + transcript (no auth)
 *   GET  /debates/leaderboard       debate wins of public agents (no auth, real closed debates only)
 *   GET  /debates/candidates        agents the caller can field (mine) and challenge (opponents)
 *   GET  /debates?filter=live|voting|closed|mine
 *   GET  /debates/:id               debate + transcript + viewer flags (myVote, canVote, canAccept…)
 *   POST /debates                   create {kind, title, prompt, agentAId, agentBId, rounds, votingMinutes, domainSlug?, autoStart?}
 *   POST /debates/:id/accept|decline|start|cancel
 *   POST /debates/:id/vote          {agentId}  one vote per user, changeable until voting closes
 *
 * Realtime: channel `debate:<id>` (any signed-in user may subscribe to a visible, started debate).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, count, desc, eq, gte, ilike, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db/client.js';
import { requireAuth, requirePerm, type AuthContext } from '../../lib/auth.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { PageQuery, offset, parse } from '../../lib/http.js';
import { notifyOrg } from '../../lib/notify.js';
import { config } from '../../lib/config.js';
import { registerJob } from '../../jobs/queue.js';
import { registerChannelGuard } from '../../ws/hub.js';
import { closeOpenDebate, speak } from './open.js';
import { assertAgentActive } from '../owner-controls/service.js';
import {
  DEBATE_ADVANCE_JOB, DEBATE_CLOSE_JOB, DEBATE_SWEEP_JOB, DEFAULT_VOTING_MINUTES, MAX_VOTING_MINUTES, MIN_VOTING_MINUTES,
  advanceDebate, cancelDebate, closeDebate, debateMessages, ensureSweepScheduled, hiveMessage, loadDebate, nextTurns, openDebateTasks,
  publishDebate, recountVotes, startDebate, sweepDebates, votingDurationMs, type Debate, type DebateMessage,
} from './service.js';

type Agent = typeof schema.agents.$inferSelect;
const isAdmin = (a: AuthContext) => a.user.platformRole === 'admin' || a.user.platformRole === 'super_admin';
const rl = (max: number) => ({ config: { rateLimit: { max: config.isTest ? 10_000 : max, timeWindow: '1 minute' } } });
const PUBLIC_STATUSES = ['live', 'voting', 'closed'];

const CreateBody = z.object({
  kind: z.enum(['open', 'debate', 'challenge']).default('debate'),
  title: z.string().trim().min(3).max(140),
  prompt: z.string().trim().min(10).max(2000),
  agentAId: z.string().uuid(),
  /** required for 1-vs-1 debates/challenges; omitted for open debates */
  agentBId: z.string().uuid().optional(),
  rounds: z.coerce.number().int().min(1).max(5).default(3),
  votingMinutes: z.coerce.number().int().min(MIN_VOTING_MINUTES).max(MAX_VOTING_MINUTES).default(DEFAULT_VOTING_MINUTES),
  domainSlug: z.string().trim().min(1).optional(),
  autoStart: z.boolean().default(true),
});

/* ───────────── read models ───────────── */

interface AgentRef { id: string; name: string; slug: string; avatar: string | null; orgName: string | null; isPublic: boolean }

async function agentRefs(ids: string[]): Promise<Map<string, AgentRef & { orgId: string }>> {
  if (!ids.length) return new Map();
  const rows = await db().select({
    id: schema.agents.id, name: schema.agents.name, slug: schema.agents.slug, avatar: schema.agents.avatar, orgId: schema.agents.orgId,
    isPublic: schema.agents.isPublic, orgName: schema.organisations.name,
  }).from(schema.agents).leftJoin(schema.organisations, eq(schema.organisations.id, schema.agents.orgId))
    .where(inArray(schema.agents.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, r]));
}

async function domainRefs(ids: (string | null)[]) {
  const clean = [...new Set(ids.filter((x): x is string => !!x))];
  if (!clean.length) return new Map<string, { id: string; slug: string; name: string }>();
  const rows = await db().select({ id: schema.capabilityDomains.id, slug: schema.capabilityDomains.slug, name: schema.capabilityDomains.name })
    .from(schema.capabilityDomains).where(inArray(schema.capabilityDomains.id, clean));
  return new Map(rows.map((r) => [r.id, r]));
}

const publicAgent = (a: (AgentRef & { orgId: string }) | undefined) => (a ? { id: a.id, name: a.name, slug: a.slug, avatar: a.avatar, orgName: a.orgName, isPublic: a.isPublic } : null);

async function views(rows: Debate[]) {
  const agents = await agentRefs(rows.flatMap((d) => [d.agentAId, d.agentBId]));
  const domains = await domainRefs(rows.map((d) => d.domainId));
  const counts = rows.length ? await db().select({ id: schema.debateMessages.debateId, n: sql<number>`count(*)::int` }).from(schema.debateMessages)
    .where(and(inArray(schema.debateMessages.debateId, rows.map((d) => d.id)), eq(schema.debateMessages.role, 'agent'), eq(schema.debateMessages.moderation, 'visible')))
    .groupBy(schema.debateMessages.debateId) : [];
  const byId = new Map(counts.map((c) => [c.id, Number(c.n)]));
  return rows.map((d) => ({
    id: d.id, kind: d.kind, title: d.title, prompt: d.prompt, rounds: d.rounds, status: d.status,
    agentA: publicAgent(agents.get(d.agentAId)), agentB: publicAgent(agents.get(d.agentBId)), agentBAccepted: d.agentBAccepted,
    domain: d.domainId ? domains.get(d.domainId) ?? null : null,
    winnerAgentId: d.winnerAgentId, votesA: d.votesA, votesB: d.votesB,
    // while pending/live votingEndsAt only encodes the chosen duration (see service.ts) — never expose it as a time
    votingEndsAt: d.status === 'voting' || d.status === 'closed' ? d.votingEndsAt : null,
    votingMinutes: Math.round(votingDurationMs(d) / 60_000),
    argumentCount: byId.get(d.id) ?? 0, totalTurns: d.rounds * 2,
    startedAt: d.startedAt, closedAt: d.closedAt, createdAt: d.createdAt,
  }));
}

const messageView = (m: DebateMessage, names?: Map<string, string>) => ({ id: m.id, agentId: m.agentId, agentName: m.agentId ? names?.get(m.agentId) ?? null : null, role: m.role, round: m.round, content: m.content, flagged: m.flagged, flagReason: m.flagReason, createdAt: m.createdAt });
/** Agent names for a transcript (open debates have many speakers). */
async function speakerNames(msgs: DebateMessage[]): Promise<Map<string, string>> {
  const ids = [...new Set(msgs.map((m) => m.agentId).filter((x): x is string => !!x))];
  if (!ids.length) return new Map();
  const rows = await db().select({ id: schema.agents.id, name: schema.agents.name }).from(schema.agents).where(inArray(schema.agents.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Live state for the typing / waiting indicator. */
async function liveState(d: Debate, msgs: DebateMessage[]) {
  if (d.status !== 'live') return { nextTurns: [], waiting: [] };
  const open = await openDebateTasks(d.id);
  return { nextTurns: nextTurns(d, msgs).map((t) => ({ agentId: t.agentId, round: t.round, side: t.side })), waiting: open };
}

async function userOrgIds(userId: string): Promise<string[]> {
  const rows = await db().select({ orgId: schema.memberships.orgId }).from(schema.memberships).where(eq(schema.memberships.userId, userId));
  return rows.map((r) => r.orgId);
}

async function getAgent(id: string): Promise<Agent | null> {
  const [a] = await db().select().from(schema.agents).where(and(eq(schema.agents.id, id), isNull(schema.agents.deletedAt))).limit(1);
  return a ?? null;
}

async function isPrivateOrg(orgId: string) {
  const [o] = await db().select({ p: schema.organisations.privateNetwork }).from(schema.organisations).where(eq(schema.organisations.id, orgId)).limit(1);
  return !!o?.p;
}

/** A debate is publicly readable once it has started and was not removed by moderation. */
const publiclyVisible = (d: Debate) => d.moderation === 'visible' && PUBLIC_STATUSES.includes(d.status);

export default async function routes(app: FastifyInstance) {
  app.addHook('onReady', async () => {
    if (config.isTest) return;
    const [open] = await db().select({ n: count() }).from(schema.debates).where(inArray(schema.debates.status, ['live', 'voting']));
    if (Number(open?.n ?? 0) > 0) await ensureSweepScheduled().catch((e) => console.error('[debates] could not schedule sweep', e));
  });

  /* ───────────── public (no auth) ───────────── */

  app.get('/public', async (req) => {
    const q = parse(PageQuery.extend({ status: z.enum(['live', 'voting', 'closed']).optional(), pageSize: z.coerce.number().int().min(1).max(50).default(24) }), req.query);
    const where = and(eq(schema.debates.moderation, 'visible'), q.status ? eq(schema.debates.status, q.status) : inArray(schema.debates.status, PUBLIC_STATUSES));
    const rows = await db().select().from(schema.debates).where(where).orderBy(desc(schema.debates.updatedAt)).limit(q.pageSize).offset(offset(q));
    const [{ n }] = await db().select({ n: count() }).from(schema.debates).where(where);
    return { items: await views(rows), total: Number(n), page: q.page, pageSize: q.pageSize };
  });

  app.get('/public/:id', async (req) => {
    const d = await loadDebate((req.params as { id: string }).id).catch(() => null);
    if (!d || !publiclyVisible(d)) throw notFound('Debate');
    const msgs = await debateMessages(d.id);
    const [view] = await views([d]);
    const names = await speakerNames(msgs);
    return { ...view, messages: msgs.map((m) => messageView(m, names)), live: await liveState(d, msgs) };
  });

  app.get('/leaderboard', async (req) => {
    const q = parse(z.object({ period: z.enum(['30d', 'all']).default('all'), limit: z.coerce.number().int().min(1).max(100).default(50) }), req.query);
    const conds: SQL[] = [eq(schema.debates.status, 'closed'), eq(schema.debates.moderation, 'visible')];
    if (q.period === '30d') conds.push(gte(schema.debates.closedAt, new Date(Date.now() - 30 * 86_400_000)));
    const rows = await db().select({ a: schema.debates.agentAId, b: schema.debates.agentBId, w: schema.debates.winnerAgentId })
      .from(schema.debates).where(and(...conds)).limit(10_000);
    const stats = new Map<string, { wins: number; losses: number; ties: number }>();
    const bump = (id: string, k: 'wins' | 'losses' | 'ties') => { const s = stats.get(id) ?? { wins: 0, losses: 0, ties: 0 }; s[k]++; stats.set(id, s); };
    for (const r of rows) {
      for (const id of [r.a, r.b]) bump(id, !r.w ? 'ties' : r.w === id ? 'wins' : 'losses');
    }
    const agents = await agentRefs([...stats.keys()]);
    const ranked = [...stats.entries()]
      .map(([id, s]) => ({ agent: agents.get(id), ...s, debates: s.wins + s.losses + s.ties }))
      .filter((r) => r.agent && r.agent.isPublic)
      .map((r) => ({ ...r, winRate: r.debates ? Math.round((r.wins / r.debates) * 1000) / 10 : 0 }))
      .sort((x, y) => y.wins - x.wins || y.winRate - x.winRate || y.debates - x.debates || x.agent!.name.localeCompare(y.agent!.name))
      .slice(0, q.limit);
    return ranked.map((r, i) => ({ rank: i + 1, agent: publicAgent(r.agent), wins: r.wins, losses: r.losses, ties: r.ties, debates: r.debates, winRate: r.winRate }));
  });

  /* ───────────── signed-in ───────────── */

  app.get('/candidates', async (req) => {
    const a = requirePerm(req, 'training.read');
    const q = parse(z.object({ q: z.string().trim().max(80).optional() }), req.query);
    const mine = await db().select({ id: schema.agents.id, name: schema.agents.name, slug: schema.agents.slug, avatar: schema.agents.avatar, status: schema.agents.status, pausedAt: schema.agents.pausedAt })
      .from(schema.agents).where(and(eq(schema.agents.orgId, a.orgId), isNull(schema.agents.deletedAt), ne(schema.agents.status, 'suspended')))
      .orderBy(schema.agents.name).limit(100);
    const oppConds: SQL[] = [isNull(schema.agents.deletedAt), isNull(schema.agents.pausedAt), eq(schema.agents.status, 'active'),
      or(eq(schema.agents.orgId, a.orgId), and(eq(schema.agents.isPublic, true), eq(schema.organisations.privateNetwork, false)))!];
    if (q.q) oppConds.push(ilike(schema.agents.name, `%${q.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`));
    const opponents = await db().select({ id: schema.agents.id, name: schema.agents.name, slug: schema.agents.slug, avatar: schema.agents.avatar, orgId: schema.agents.orgId, orgName: schema.organisations.name })
      .from(schema.agents).innerJoin(schema.organisations, eq(schema.organisations.id, schema.agents.orgId))
      .where(and(...oppConds)).orderBy(schema.agents.name).limit(100);
    return {
      mine: mine.map((m) => ({ id: m.id, name: m.name, slug: m.slug, avatar: m.avatar, status: m.status, paused: !!m.pausedAt })),
      opponents: opponents.map(({ orgId, ...o }) => ({ ...o, sameOrg: orgId === a.orgId })),
    };
  });

  app.get('/', async (req) => {
    const a = requireAuth(req);
    const q = parse(PageQuery.extend({ filter: z.enum(['live', 'voting', 'closed', 'mine', 'all']).default('all') }), req.query);
    let where: SQL;
    if (q.filter === 'mine') {
      if (!a.orgId) return { items: [], total: 0, page: q.page, pageSize: q.pageSize };
      const myAgents = db().select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.orgId, a.orgId));
      where = or(eq(schema.debates.orgId, a.orgId), inArray(schema.debates.agentBId, myAgents), inArray(schema.debates.agentAId, myAgents))!;
    } else {
      where = and(eq(schema.debates.moderation, 'visible'), q.filter === 'all' ? inArray(schema.debates.status, PUBLIC_STATUSES) : eq(schema.debates.status, q.filter))!;
    }
    const rows = await db().select().from(schema.debates).where(where).orderBy(desc(schema.debates.updatedAt)).limit(q.pageSize).offset(offset(q));
    const [{ n }] = await db().select({ n: count() }).from(schema.debates).where(where);
    const items = await views(rows);
    const agentOrg = await agentRefs(rows.flatMap((d) => [d.agentAId, d.agentBId]));
    return {
      items: items.map((v, i) => {
        const d = rows[i]!;
        const bOrg = agentOrg.get(d.agentBId)?.orgId;
        return { ...v, viewer: { isCreatorOrg: d.orgId === a.orgId, isInvited: !!a.orgId && bOrg === a.orgId && !d.agentBAccepted && d.status === 'pending' } };
      }),
      total: Number(n), page: q.page, pageSize: q.pageSize,
    };
  });

  /** Load a debate the caller may see: started + visible, or any state for participant orgs and admins. */
  async function loadForViewer(id: string, a: AuthContext) {
    const d = await loadDebate(id).catch(() => null);
    if (!d) throw notFound('Debate');
    if (publiclyVisible(d) || isAdmin(a)) return d;
    const refs = await agentRefs([d.agentAId, d.agentBId]);
    const orgs = new Set([d.orgId, refs.get(d.agentAId)?.orgId, refs.get(d.agentBId)?.orgId]);
    if (a.orgId && orgs.has(a.orgId) && d.moderation === 'visible') return d;
    throw notFound('Debate');
  }

  app.get('/:id', async (req) => {
    const a = requireAuth(req);
    const d = await loadForViewer((req.params as { id: string }).id, a);
    const msgs = await debateMessages(d.id);
    const speakers = await speakerNames(msgs);
    const [view] = await views([d]);
    const refs = await agentRefs([d.agentAId, d.agentBId]);
    const aOrg = refs.get(d.agentAId)?.orgId, bOrg = refs.get(d.agentBId)?.orgId;
    const myOrgs = new Set(await userOrgIds(a.user.id));
    const [vote] = await db().select({ agentId: schema.debateVotes.agentId }).from(schema.debateVotes)
      .where(and(eq(schema.debateVotes.debateId, d.id), eq(schema.debateVotes.userId, a.user.id))).limit(1);
    const votingOpen = d.status === 'voting' && !!d.votingEndsAt && d.votingEndsAt.getTime() > Date.now();
    const canWrite = !!a.orgId && !!a.orgRole && (a.orgRole === 'owner' || a.orgRole === 'admin' || a.orgRole === 'developer' || a.orgRole === 'trainer' || a.orgRole === 'member');
    return {
      ...view,
      messages: msgs.map((m) => messageView(m, speakers)),
      live: await liveState(d, msgs),
      viewer: {
        myVote: vote?.agentId ?? null,
        canVoteFor: {
          [d.agentAId]: votingOpen && !a.apiKeyId && !(aOrg && myOrgs.has(aOrg)),
          [d.agentBId]: votingOpen && !a.apiKeyId && !(bOrg && myOrgs.has(bOrg)),
        },
        canAccept: canWrite && d.status === 'pending' && !d.agentBAccepted && bOrg === a.orgId,
        canStart: canWrite && d.status === 'pending' && d.agentBAccepted && d.orgId === a.orgId,
        canSpeak: canWrite && d.kind === 'open' && d.status === 'live',
        canClose: d.kind === 'open' && d.status === 'live' && ((canWrite && d.orgId === a.orgId) || isAdmin(a)),
        canCancel: d.kind !== 'open' && ((canWrite && ['pending', 'live'].includes(d.status) && (d.orgId === a.orgId || (d.status === 'live' && bOrg === a.orgId))) || (isAdmin(a) && ['pending', 'live', 'voting'].includes(d.status))),
        side: d.kind === 'open' ? null : aOrg === a.orgId ? 'A' : bOrg === a.orgId ? 'B' : null,
      },
    };
  });

  app.post('/', rl(10), async (req, reply) => {
    const a = requirePerm(req, 'training.participate');
    const body = parse(CreateBody, req.body);
    if (body.kind === 'open') {
      // OPEN debate: no opponent — any owner can bring an agent in with POST /debates/:id/speak
      const starter = await getAgent(body.agentAId);
      if (!starter || starter.orgId !== a.orgId) throw notFound('Your agent');
      if (starter.status !== 'active') throw badRequest(`${starter.name} is ${starter.status} — only active agents can debate`);
      await assertAgentActive(starter.id);
      let openDomainId: string | null = null;
      if (body.domainSlug) {
        const [dom] = await db().select({ id: schema.capabilityDomains.id }).from(schema.capabilityDomains).where(eq(schema.capabilityDomains.slug, body.domainSlug)).limit(1);
        openDomainId = dom?.id ?? null;
      }
      const now = new Date();
      const [od] = await db().insert(schema.debates).values({
        kind: 'open', title: body.title, prompt: body.prompt, domainId: openDomainId, createdBy: a.user.id, orgId: a.orgId,
        agentAId: starter.id, agentBId: starter.id, agentBAccepted: true, rounds: 0, status: 'live', startedAt: now, createdAt: now, updatedAt: now,
      }).returning();
      await hiveMessage(od!.id, `Open debate started by ${starter.name}. Any agent can join: owners bring their agents in with "Add my agent". Every reply passes the Hive Mind safety filter.`);
      await audit({ action: 'debate.create', targetType: 'debate', targetId: od!.id, metadata: { kind: 'open', agentAId: starter.id } }, req);
      speak(od!, starter.id).catch((e) => req.log.warn({ err: e }, 'open debate: first contribution failed'));
      const [ov] = await views([od!]);
      return reply.status(201).send(ov);
    }
    if (!body.agentBId) throw badRequest('Pick an opponent for a 1-vs-1 debate, or choose an open debate');
    if (body.agentAId === body.agentBId) throw badRequest('An agent cannot debate itself — pick a different opponent');
    const agentA = await getAgent(body.agentAId);
    if (!agentA || agentA.orgId !== a.orgId) throw notFound('Your agent');
    if (agentA.status !== 'active') throw badRequest(`${agentA.name} is ${agentA.status} — only active agents can debate`);
    const agentB = await getAgent(body.agentBId);
    const sameOrg = agentB?.orgId === a.orgId;
    if (!agentB || agentB.status !== 'active' || (!sameOrg && (!agentB.isPublic || (await isPrivateOrg(agentB.orgId))))) throw notFound('Opponent agent');
    if (agentB.pausedAt) throw conflict(`${agentB.name} is paused by its owner and is not taking on debates right now`);
    await assertAgentActive(agentA.id);
    await assertAgentActive(agentB.id);
    let domainId: string | null = null;
    if (body.domainSlug) {
      const [dom] = await db().select({ id: schema.capabilityDomains.id }).from(schema.capabilityDomains).where(eq(schema.capabilityDomains.slug, body.domainSlug)).limit(1);
      if (!dom) throw badRequest('Unknown domain');
      domainId = dom.id;
    }
    const rounds = body.kind === 'challenge' ? Math.min(2, body.rounds) : body.rounds;
    const now = new Date();
    const [d] = await db().insert(schema.debates).values({
      kind: body.kind, title: body.title, prompt: body.prompt, domainId, createdBy: a.user.id, orgId: a.orgId,
      agentAId: agentA.id, agentBId: agentB.id, agentBAccepted: sameOrg, rounds, status: 'pending',
      createdAt: now, updatedAt: now,
      // stores the chosen voting duration until voting opens (see service.ts header)
      votingEndsAt: new Date(now.getTime() + body.votingMinutes * 60_000),
    }).returning();
    await audit({ action: 'debate.create', targetType: 'debate', targetId: d!.id, metadata: { kind: body.kind, agentAId: agentA.id, agentBId: agentB.id, crossOrg: !sameOrg } }, req);
    let out: Debate = d!;
    if (sameOrg) {
      if (body.autoStart) out = (await startDebate(d!)) ?? d!;
    } else {
      await hiveMessage(d!.id, `${agentA.name} challenged ${agentB.name}. Waiting for ${agentB.name}'s owner to accept.`);
      await notifyOrg(agentB.orgId, 'debate_invite', `${agentA.name} challenged ${agentB.name} to a ${body.kind}`, `"${body.title}" — accept or decline in Debates.`, `/app/debates/${d!.id}`);
    }
    const [view] = await views([out]);
    return reply.status(201).send(view);
  });

  /** OPEN debates: bring one of your active agents into the discussion. */
  app.post('/:id/speak', rl(20), async (req) => {
    const a = requirePerm(req, 'training.participate');
    const d = await loadDebate((req.params as { id: string }).id).catch(() => null);
    if (!d || d.moderation === 'removed') throw notFound('Debate');
    if (d.kind !== 'open') throw badRequest('Only open debates accept contributions from any agent');
    if (d.status !== 'live') throw conflict('This debate is closed');
    const { agentId } = parse(z.object({ agentId: z.string().uuid() }), req.body);
    const ag = await getAgent(agentId);
    if (!ag || ag.orgId !== a.orgId) throw notFound('Your agent');
    if (ag.status !== 'active') throw badRequest(`${ag.name} is ${ag.status} — only active agents can join`);
    await assertAgentActive(ag.id);
    const result = await speak(d, ag.id);
    return { ok: true, result, message: result === 'waiting' ? `${ag.name} is connected via prompt — its reply appears when it next checks in.` : `${ag.name} joined the debate.` };
  });

  app.post('/:id/close', rl(20), async (req) => {
    const a = requirePerm(req, 'training.participate');
    const d = await loadDebate((req.params as { id: string }).id).catch(() => null);
    if (!d) throw notFound('Debate');
    if (d.kind !== 'open') throw badRequest('Only open debates are closed this way');
    if (d.orgId !== a.orgId && !isAdmin(a)) throw forbidden('Only the debate creator can close it');
    const u = await closeOpenDebate(d);
    if (!u) throw conflict('This debate is already closed');
    await audit({ action: 'debate.close', targetType: 'debate', targetId: d.id, metadata: { kind: 'open' } }, req);
    const [v] = await views([u]);
    return v;
  });

  async function loadForWrite(req: FastifyRequest) {
    const a = requirePerm(req, 'training.participate');
    const d = await loadDebate((req.params as { id: string }).id).catch(() => null);
    if (!d) throw notFound('Debate');
    const refs = await agentRefs([d.agentAId, d.agentBId]);
    return { a, d, bOrg: refs.get(d.agentBId)?.orgId ?? null };
  }

  app.post('/:id/accept', rl(30), async (req) => {
    const { a, d, bOrg } = await loadForWrite(req);
    if (bOrg !== a.orgId) throw notFound('Debate');
    if (d.status !== 'pending' || d.agentBAccepted) throw conflict(`This ${d.kind} is no longer waiting for acceptance`);
    await assertAgentActive(d.agentAId);
    await assertAgentActive(d.agentBId);
    const [u] = await db().update(schema.debates).set({ agentBAccepted: true, updatedAt: new Date() })
      .where(and(eq(schema.debates.id, d.id), eq(schema.debates.status, 'pending'), eq(schema.debates.agentBAccepted, false))).returning();
    if (!u) throw conflict('The debate changed; try again');
    await audit({ action: 'debate.accept', targetType: 'debate', targetId: d.id }, req);
    await notifyOrg(d.orgId, 'debate_update', `Challenge accepted: "${d.title}"`, 'The debate is starting now.', `/app/debates/${d.id}`);
    const started = await startDebate(u);
    const [view] = await views([started ?? u]);
    return view;
  });

  app.post('/:id/decline', rl(30), async (req) => {
    const { a, d, bOrg } = await loadForWrite(req);
    if (bOrg !== a.orgId) throw notFound('Debate');
    if (d.status !== 'pending' || d.agentBAccepted) throw conflict(`This ${d.kind} is no longer waiting for acceptance`);
    const u = await cancelDebate(d, 'The invited agent\'s owner declined the challenge.');
    if (!u) throw conflict('The debate changed; try again');
    await audit({ action: 'debate.decline', targetType: 'debate', targetId: d.id }, req);
    await notifyOrg(d.orgId, 'debate_update', `Challenge declined: "${d.title}"`, '', `/app/debates/${d.id}`);
    const [view] = await views([u]);
    return view;
  });

  app.post('/:id/start', rl(30), async (req) => {
    const { a, d } = await loadForWrite(req);
    if (d.orgId !== a.orgId) throw notFound('Debate');
    if (d.status !== 'pending') throw conflict(`This ${d.kind} is ${d.status}`);
    if (!d.agentBAccepted) throw conflict('The opponent has not accepted yet');
    await assertAgentActive(d.agentAId);
    await assertAgentActive(d.agentBId);
    const u = await startDebate(d);
    if (!u) throw conflict('The debate changed; try again');
    await audit({ action: 'debate.start', targetType: 'debate', targetId: d.id }, req);
    const [view] = await views([u]);
    return view;
  });

  app.post('/:id/cancel', rl(30), async (req) => {
    const a = requireAuth(req);
    const d = await loadDebate((req.params as { id: string }).id).catch(() => null);
    if (!d) throw notFound('Debate');
    if (!isAdmin(a)) {
      const { bOrg } = await loadForWrite(req);
      const mayCancel = d.orgId === a.orgId || (d.status === 'live' && bOrg === a.orgId);
      if (!mayCancel) throw notFound('Debate');
      if (!['pending', 'live'].includes(d.status)) throw conflict(`This ${d.kind} is ${d.status} and can no longer be cancelled`);
    }
    const u = await cancelDebate(d, `Cancelled by ${isAdmin(a) && d.orgId !== a.orgId ? 'a Hive Mind administrator' : 'a participant'}.`);
    if (!u) throw conflict(`This ${d.kind} is ${d.status}`);
    await audit({ action: 'debate.cancel', targetType: 'debate', targetId: d.id }, req);
    const [view] = await views([u]);
    return view;
  });

  app.post('/:id/vote', rl(30), async (req) => {
    const a = requireAuth(req);
    if (a.apiKeyId) throw forbidden('Votes must be cast by a signed-in person, not an API key');
    const body = parse(z.object({ agentId: z.string().uuid() }), req.body);
    const d = await loadDebate((req.params as { id: string }).id).catch(() => null);
    if (!d || !publiclyVisible(d)) throw notFound('Debate');
    if (d.status !== 'voting' || !d.votingEndsAt || d.votingEndsAt.getTime() <= Date.now()) throw conflict('Voting is not open for this debate');
    if (body.agentId !== d.agentAId && body.agentId !== d.agentBId) throw badRequest('You can only vote for one of the two agents in this debate');
    const agent = await getAgent(body.agentId);
    const myOrgs = await userOrgIds(a.user.id);
    if (agent && myOrgs.includes(agent.orgId)) throw forbidden('You cannot vote for an agent your own organisation owns');
    await db().insert(schema.debateVotes).values({ debateId: d.id, userId: a.user.id, agentId: body.agentId })
      .onConflictDoUpdate({ target: [schema.debateVotes.debateId, schema.debateVotes.userId], set: { agentId: body.agentId, createdAt: new Date() } });
    const tally = await recountVotes(d);
    publishDebate(d.id, 'votes', tally);
    return { ...tally, myVote: body.agentId };
  });
}

/** Register background job handlers + realtime channel guard (called once at startup). */
export function registerJobs() {
  registerJob(DEBATE_ADVANCE_JOB, async (payload) => { await advanceDebate(String(payload.debateId)); });
  registerJob(DEBATE_CLOSE_JOB, async (payload) => {
    const id = String(payload.debateId);
    const d = await loadDebate(id);
    // ran early (clock skew / queue delay): re-queue for the real end time
    if (d?.status === 'voting' && d.votingEndsAt && d.votingEndsAt.getTime() > Date.now() + 1000) {
      const { enqueue } = await import('../../jobs/queue.js');
      await enqueue(DEBATE_CLOSE_JOB, { debateId: id }, { delayMs: d.votingEndsAt.getTime() - Date.now(), maxAttempts: 3 });
      return;
    }
    await closeDebate(id);
  });
  registerJob(DEBATE_SWEEP_JOB, async () => {
    await sweepDebates();
    const [open] = await db().select({ n: count() }).from(schema.debates).where(inArray(schema.debates.status, ['live', 'voting']));
    if (Number(open?.n ?? 0) > 0) await ensureSweepScheduled();
  });
  registerChannelGuard('debate', async (auth, id) => {
    const d = await loadDebate(id).catch(() => null);
    if (!d) return false;
    if (publiclyVisible(d) || auth.user.platformRole === 'admin' || auth.user.platformRole === 'super_admin') return true;
    const orgs = await userOrgIds(auth.user.id);
    const [b] = await db().select({ orgId: schema.agents.orgId }).from(schema.agents).where(eq(schema.agents.id, d.agentBId)).limit(1);
    return orgs.includes(d.orgId) || (!!b && orgs.includes(b.orgId));
  });
}

