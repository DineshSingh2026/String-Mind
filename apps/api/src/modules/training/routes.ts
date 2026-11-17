/**
 * Training module: requests, sessions, orchestration control, artefact approval.
 * See docs/API.md#training. Orchestration lives in engine/training.ts.
 */
import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, gte, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db/client.js';
import { requirePerm } from '../../lib/auth.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, forbidden, insufficientFunds, notFound, unprocessable } from '../../lib/errors.js';
import { PageQuery, offset, parse } from '../../lib/http.js';
import { notifyOrg } from '../../lib/notify.js';
import { emitEvent } from '../../lib/webhooks.js';
import { getOwnedAgent } from '../../lib/tenancy.js';
import { enqueue, registerJob } from '../../jobs/queue.js';
import { registerChannelGuard } from '../../ws/hub.js';
import { cosine, embed } from '../../engine/embeddings.js';
import {
  TRAINING_RETENTION_JOB, TRAINING_RUN_JOB, cancelSession, decideArtefact, logMessage, patchPlan, publishSession,
  runRetentionCheck, runTrainingSession,
} from '../../engine/training.js';
import { escrowTraining, getCommissionBps } from '../wallet/ledger.js';

type Agent = typeof schema.agents.$inferSelect;
type Session = typeof schema.trainingSessions.$inferSelect;

const RequestBody = z.object({
  learnerAgentId: z.string().uuid(),
  trainerAgentId: z.string().uuid(),
  domainSlug: z.string().min(1),
  objectives: z.array(z.string().trim().min(3).max(500)).max(10).default([]),
  message: z.string().max(4000).default(''),
  listingId: z.string().uuid().optional(),
});

const permOf = (a: Agent) => a.permissions as Record<string, unknown>;
const isAdmin = (role: string) => role === 'admin' || role === 'super_admin';

async function availableCredits(orgId: string): Promise<number> {
  const [w] = await db().select({ available: schema.wallets.available }).from(schema.wallets)
    .where(and(eq(schema.wallets.orgId, orgId), eq(schema.wallets.kind, 'org'))).limit(1);
  return w?.available ?? 0;
}

/**
 * Credits committed today (UTC) for a learner agent, for usageLimits.maxCreditsPerDay:
 * fees of sessions created today + prices of still-pending requests created today
 * (accepted requests become sessions, so they are not double-counted).
 */
async function learnerCreditsSpentToday(learnerAgentId: string): Promise<number> {
  const since = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
  const [s] = await db().select({ n: sql<number>`coalesce(sum(${schema.trainingSessions.feeCredits}), 0)::float8` }).from(schema.trainingSessions)
    .where(and(eq(schema.trainingSessions.learnerAgentId, learnerAgentId), gte(schema.trainingSessions.createdAt, since)));
  const [r] = await db().select({ n: sql<number>`coalesce(sum(${schema.trainingRequests.priceCredits}), 0)::float8` }).from(schema.trainingRequests)
    .where(and(eq(schema.trainingRequests.learnerAgentId, learnerAgentId), eq(schema.trainingRequests.status, 'pending'), gte(schema.trainingRequests.createdAt, since)));
  return Number(s?.n ?? 0) + Number(r?.n ?? 0);
}

async function getAgent(id: string) {
  const [a] = await db().select().from(schema.agents).where(and(eq(schema.agents.id, id), isNull(schema.agents.deletedAt))).limit(1);
  return a ?? null;
}

/** Validates the trainer is usable by `orgId`. */
async function assertTrainerUsable(trainer: Agent | null, orgId: string): Promise<Agent> {
  if (!trainer) throw notFound('Trainer agent');
  if (trainer.status === 'suspended') throw badRequest('Trainer agent is suspended');
  if (trainer.orgId === orgId) {
    if (trainer.status === 'disconnected') throw badRequest('Trainer agent is disconnected');
    return trainer;
  }
  if (!trainer.isPublic || trainer.status !== 'active') throw notFound('Trainer agent');
  const [org] = await db().select().from(schema.organisations).where(eq(schema.organisations.id, trainer.orgId)).limit(1);
  if (org?.privateNetwork) throw notFound('Trainer agent');
  if (permOf(trainer).allowTraining !== true) throw forbidden('This agent does not accept training sessions');
  return trainer;
}

async function loadSessionForOrg(id: string, orgId: string, platformRole: string): Promise<Session> {
  const [s] = await db().select().from(schema.trainingSessions).where(eq(schema.trainingSessions.id, id)).limit(1);
  if (!s || (s.learnerOrgId !== orgId && s.trainerOrgId !== orgId && !isAdmin(platformRole))) throw notFound('Training session');
  return s;
}

async function agentSummaries(ids: string[]) {
  if (!ids.length) return new Map<string, { id: string; name: string; slug: string; avatar: string | null; orgId: string }>();
  const rows = await db().select({ id: schema.agents.id, name: schema.agents.name, slug: schema.agents.slug, avatar: schema.agents.avatar, orgId: schema.agents.orgId })
    .from(schema.agents).where(inArray(schema.agents.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, r]));
}

async function domainMap(ids: string[]) {
  if (!ids.length) return new Map<string, { id: string; slug: string; name: string }>();
  const rows = await db().select({ id: schema.capabilityDomains.id, slug: schema.capabilityDomains.slug, name: schema.capabilityDomains.name })
    .from(schema.capabilityDomains).where(inArray(schema.capabilityDomains.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, r]));
}

/** Create session + participants + objectives, then escrow. If escrow fails the session is removed. */
async function acceptRequest(req: typeof schema.trainingRequests.$inferSelect, userId: string) {
  const learner = await getAgent(req.learnerAgentId);
  const trainer = await getAgent(req.trainerAgentId);
  if (!learner || !trainer) throw conflict('An agent in this request no longer exists');
  if (trainer.status === 'suspended' || learner.status === 'suspended') throw conflict('An agent in this request is suspended');
  const [domain] = await db().select().from(schema.capabilityDomains).where(eq(schema.capabilityDomains.id, req.domainId)).limit(1);
  const skills = await db().select().from(schema.capabilitySkills).where(eq(schema.capabilitySkills.domainId, req.domainId));
  let settlementTerms: { mode: string; minImprovement?: number } = { mode: 'on_completion' };
  if (req.listingId) {
    const [l] = await db().select().from(schema.marketplaceListings).where(eq(schema.marketplaceListings.id, req.listingId)).limit(1);
    if (l) settlementTerms = l.settlementMode === 'on_improvement' ? { mode: 'on_improvement', minImprovement: l.minImprovement ?? 1 } : { mode: l.settlementMode || 'on_completion' };
  }
  const commissionRateBps = await getCommissionBps({ orgId: req.trainerOrgId, domainId: req.domainId });
  const lp = permOf(learner), tp = permOf(trainer);
  const objectives = req.objectives.length ? req.objectives : skills.map((s) => `Improve ${s.name}`);

  const session = await db().transaction(async (tx) => {
    const [s] = await tx.insert(schema.trainingSessions).values({
      requestId: req.id, learnerAgentId: learner.id, trainerAgentId: trainer.id, learnerOrgId: req.learnerOrgId, trainerOrgId: req.trainerOrgId,
      domainId: req.domainId, subject: `${domain?.name ?? 'Training'}: ${trainer.name} → ${learner.name}`.slice(0, 300),
      feeCredits: req.priceCredits, commissionRateBps, settlementTerms, plan: {},
    }).returning();
    const participants: (typeof schema.trainingParticipants.$inferInsert)[] = [
      { sessionId: s!.id, agentId: learner.id, role: 'learner', permissions: { allowLearning: lp.allowLearning === true, storeArtefacts: (lp.dataSharing ?? 'artefacts_only') !== 'none', shareTranscript: lp.dataSharing === 'full_session', autoApproveArtefacts: lp.autoApproveArtefacts === true } },
      { sessionId: s!.id, agentId: trainer.id, role: 'trainer', permissions: { shareKnowledge: tp.shareKnowledge !== false, readLearnerMemory: false, sendMessages: true } },
      { sessionId: s!.id, userId: learner.ownerId, role: 'owner_observer', permissions: { observe: true, intervene: lp.allowOwnerIntervention === true, approveArtefacts: true } },
    ];
    if (trainer.ownerId !== learner.ownerId) participants.push({ sessionId: s!.id, userId: trainer.ownerId, role: 'owner_observer', permissions: { observe: true, intervene: tp.allowOwnerIntervention === true, approveArtefacts: false } });
    await tx.insert(schema.trainingParticipants).values(participants);
    await tx.insert(schema.trainingObjectives).values(objectives.map((o) => {
      const v = embed(o);
      let best: { id: string; s: number } | null = null;
      for (const sk of skills) {
        const sc = Math.max(cosine(v, embed(`${sk.name} ${sk.slug.replace(/-/g, ' ')}`)), o.toLowerCase().includes(sk.slug.replace(/-/g, ' ')) || o.toLowerCase().includes(sk.name.toLowerCase()) ? 1 : 0);
        if (!best || sc > best.s) best = { id: sk.id, s: sc };
      }
      return { sessionId: s!.id, description: o, skillId: best && best.s >= 0.2 ? best.id : null };
    }));
    return s!;
  });

  try {
    if (session.feeCredits > 0) await escrowTraining(session.id);
  } catch (e) {
    await db().delete(schema.trainingSessions).where(eq(schema.trainingSessions.id, session.id));
    throw e;
  }
  const upd = await db().update(schema.trainingRequests).set({ status: 'accepted', sessionId: session.id, respondedBy: userId, respondedAt: new Date() })
    .where(and(eq(schema.trainingRequests.id, req.id), eq(schema.trainingRequests.status, 'pending'))).returning({ id: schema.trainingRequests.id });
  if (!upd.length) {
    // lost a race with cancel/decline: undo (refund escrow first)
    const { settleTraining } = await import('../wallet/ledger.js');
    if (session.feeCredits > 0) await settleTraining(session.id, { outcome: 'refund' }).catch(() => undefined);
    await db().update(schema.trainingSessions).set({ status: 'cancelled', failureReason: 'Request no longer pending' }).where(eq(schema.trainingSessions.id, session.id));
    throw conflict('Request is no longer pending');
  }
  await logMessage({ sessionId: session.id, senderRole: 'system', stage: 'introduction', senderUserId: userId, content: `Request accepted. Fee ${session.feeCredits} credits ${session.feeCredits > 0 ? 'held in escrow' : '(free session)'}; settlement ${settlementTerms.mode}${settlementTerms.minImprovement != null ? ` (min improvement ${settlementTerms.minImprovement})` : ''}.` });
  const [fresh] = await db().select().from(schema.trainingSessions).where(eq(schema.trainingSessions.id, session.id));
  return fresh!;
}

export default async function routes(app: FastifyInstance) {
  /* ───────────── requests ───────────── */
  app.post('/requests', async (req, reply) => {
    const a = requirePerm(req, 'training.request');
    const body = parse(RequestBody, req.body);
    if (body.learnerAgentId === body.trainerAgentId) throw badRequest('An agent cannot train itself');
    const learner = await getOwnedAgent(body.learnerAgentId, a.orgId);
    if (learner.status === 'suspended') throw badRequest('Learner agent is suspended');
    if (permOf(learner).allowLearning !== true) throw forbidden('Learner agent does not allow learning — enable "allowLearning" in its permissions');
    const trainer = await assertTrainerUsable(await getAgent(body.trainerAgentId), a.orgId);
    const [domain] = await db().select().from(schema.capabilityDomains).where(eq(schema.capabilityDomains.slug, body.domainSlug)).limit(1);
    if (!domain) throw badRequest(`Unknown domain: ${body.domainSlug}`);
    const allowed = permOf(trainer).allowedDomains;
    if (trainer.orgId !== a.orgId && Array.isArray(allowed) && allowed.length && !allowed.includes(domain.slug)) throw forbidden('Trainer does not train in this domain');

    let price = 0;
    if (body.listingId) {
      const [l] = await db().select().from(schema.marketplaceListings).where(eq(schema.marketplaceListings.id, body.listingId)).limit(1);
      if (!l || l.agentId !== trainer.id || l.status !== 'active' || l.moderation === 'hidden') throw notFound('Listing');
      if (l.domainId !== domain.id) throw badRequest('Listing is for a different domain');
      price = l.pricingModel === 'free' ? 0 : l.priceCredits;
    } else if (trainer.orgId !== a.orgId) {
      throw badRequest('listingId is required to train with an agent from another organisation');
    }
    if (price > 0 && (await availableCredits(a.orgId)) < price) throw insufficientFunds(`Insufficient IDLE: this training costs ${price} IDLE`);
    const maxPerDay = learner.usageLimits?.maxCreditsPerDay;
    if (price > 0 && typeof maxPerDay === 'number') {
      const spent = await learnerCreditsSpentToday(learner.id);
      if (spent + price > maxPerDay) {
        throw unprocessable(`Daily credit limit for ${learner.name} would be exceeded: ${spent} of ${maxPerDay} IDLE already committed today (UTC); this training costs ${price}. Raise maxCreditsPerDay in the agent's limits settings.`);
      }
    }

    const [r] = await db().insert(schema.trainingRequests).values({
      learnerAgentId: learner.id, trainerAgentId: trainer.id, learnerOrgId: a.orgId, trainerOrgId: trainer.orgId, requestedBy: a.user.id,
      listingId: body.listingId ?? null, domainId: domain.id, objectives: body.objectives, message: body.message, priceCredits: price,
    }).returning();
    await audit({ action: 'training.request.create', targetType: 'training_request', targetId: r!.id, metadata: { price } }, req);
    await notifyOrg(trainer.orgId, 'training_request', `Training request for ${trainer.name}`, `${learner.name} wants training in ${domain.name}${price ? ` (${price} IDLE)` : ''}.`, '/training/requests?direction=incoming');
    await emitEvent(trainer.orgId, 'training.requested', { requestId: r!.id, learnerAgentId: learner.id, trainerAgentId: trainer.id, domain: domain.slug, priceCredits: price });
    return reply.status(201).send(r);
  });

  app.get('/requests', async (req) => {
    const a = requirePerm(req, 'training.read');
    const q = parse(PageQuery.extend({ direction: z.enum(['incoming', 'outgoing']).optional(), status: z.string().optional() }), req.query);
    const side: SQL = q.direction === 'incoming' ? eq(schema.trainingRequests.trainerOrgId, a.orgId)
      : q.direction === 'outgoing' ? eq(schema.trainingRequests.learnerOrgId, a.orgId)
        : or(eq(schema.trainingRequests.trainerOrgId, a.orgId), eq(schema.trainingRequests.learnerOrgId, a.orgId))!;
    const where = q.status ? and(side, eq(schema.trainingRequests.status, q.status)) : side;
    const rows = await db().select().from(schema.trainingRequests).where(where).orderBy(desc(schema.trainingRequests.createdAt)).limit(q.pageSize).offset(offset(q));
    const [{ n }] = await db().select({ n: count() }).from(schema.trainingRequests).where(where);
    const agents = await agentSummaries(rows.flatMap((r) => [r.learnerAgentId, r.trainerAgentId]));
    const domains = await domainMap(rows.map((r) => r.domainId));
    return {
      items: rows.map((r) => ({ ...r, direction: r.trainerOrgId === a.orgId ? 'incoming' : 'outgoing', learner: agents.get(r.learnerAgentId) ?? null, trainer: agents.get(r.trainerAgentId) ?? null, domain: domains.get(r.domainId) ?? null })),
      total: n, page: q.page, pageSize: q.pageSize,
    };
  });

  async function pendingRequest(id: string) {
    const [r] = await db().select().from(schema.trainingRequests).where(eq(schema.trainingRequests.id, id)).limit(1);
    if (!r) throw notFound('Training request');
    return r;
  }

  app.post('/requests/:id/accept', async (req) => {
    const a = requirePerm(req, 'training.respond');
    const r = await pendingRequest((req.params as { id: string }).id);
    if (r.trainerOrgId !== a.orgId) throw notFound('Training request');
    if (r.status !== 'pending') throw conflict(`Request is ${r.status}`);
    const session = await acceptRequest(r, a.user.id);
    await audit({ action: 'training.request.accept', targetType: 'training_request', targetId: r.id, metadata: { sessionId: session.id } }, req);
    const link = `/training/sessions/${session.id}`;
    await notifyOrg(r.learnerOrgId, 'training_accepted', 'Training request accepted', `Your training request was accepted. Start the session when ready.`, link);
    if (r.trainerOrgId !== r.learnerOrgId) await notifyOrg(r.trainerOrgId, 'training_accepted', 'Training session scheduled', session.subject, link);
    const payload = { requestId: r.id, sessionId: session.id, feeCredits: session.feeCredits };
    await emitEvent(r.learnerOrgId, 'training.accepted', payload);
    if (r.trainerOrgId !== r.learnerOrgId) await emitEvent(r.trainerOrgId, 'training.accepted', payload);
    return { request: { ...r, status: 'accepted', sessionId: session.id }, session };
  });

  app.post('/requests/:id/decline', async (req) => {
    const a = requirePerm(req, 'training.respond');
    const r = await pendingRequest((req.params as { id: string }).id);
    if (r.trainerOrgId !== a.orgId) throw notFound('Training request');
    if (r.status !== 'pending') throw conflict(`Request is ${r.status}`);
    const [u] = await db().update(schema.trainingRequests).set({ status: 'declined', respondedBy: a.user.id, respondedAt: new Date() })
      .where(and(eq(schema.trainingRequests.id, r.id), eq(schema.trainingRequests.status, 'pending'))).returning();
    if (!u) throw conflict('Request is no longer pending');
    await audit({ action: 'training.request.decline', targetType: 'training_request', targetId: r.id }, req);
    await notifyOrg(r.learnerOrgId, 'training_declined', 'Training request declined', '', '/training/requests?direction=outgoing');
    return u;
  });

  app.post('/requests/:id/cancel', async (req) => {
    const a = requirePerm(req, 'training.request');
    const r = await pendingRequest((req.params as { id: string }).id);
    if (r.learnerOrgId !== a.orgId) throw notFound('Training request');
    if (r.status !== 'pending') throw conflict(`Request is ${r.status}`);
    const [u] = await db().update(schema.trainingRequests).set({ status: 'cancelled', respondedAt: new Date() })
      .where(and(eq(schema.trainingRequests.id, r.id), eq(schema.trainingRequests.status, 'pending'))).returning();
    if (!u) throw conflict('Request is no longer pending');
    await audit({ action: 'training.request.cancel', targetType: 'training_request', targetId: r.id }, req);
    return u;
  });

  /* ───────────── sessions ───────────── */
  app.get('/sessions', async (req) => {
    const a = requirePerm(req, 'training.read');
    const q = parse(PageQuery.extend({ status: z.string().optional(), agentId: z.string().uuid().optional() }), req.query);
    const conds: SQL[] = [or(eq(schema.trainingSessions.learnerOrgId, a.orgId), eq(schema.trainingSessions.trainerOrgId, a.orgId))!];
    if (q.status) conds.push(inArray(schema.trainingSessions.status, q.status.split(',')));
    if (q.agentId) conds.push(or(eq(schema.trainingSessions.learnerAgentId, q.agentId), eq(schema.trainingSessions.trainerAgentId, q.agentId))!);
    const where = and(...conds);
    const rows = await db().select().from(schema.trainingSessions).where(where).orderBy(desc(schema.trainingSessions.createdAt)).limit(q.pageSize).offset(offset(q));
    const [{ n }] = await db().select({ n: count() }).from(schema.trainingSessions).where(where);
    const agents = await agentSummaries(rows.flatMap((r) => [r.learnerAgentId, r.trainerAgentId]));
    const domains = await domainMap(rows.map((r) => r.domainId));
    return {
      items: rows.map((s) => ({ ...publicSession(s), role: s.learnerOrgId === a.orgId ? 'learner' : 'trainer', learner: agents.get(s.learnerAgentId) ?? null, trainer: agents.get(s.trainerAgentId) ?? null, domain: domains.get(s.domainId) ?? null })),
      total: n, page: q.page, pageSize: q.pageSize,
    };
  });

  app.get('/sessions/:id', async (req) => {
    const a = requirePerm(req, 'training.read');
    const s = await loadSessionForOrg((req.params as { id: string }).id, a.orgId, a.user.platformRole);
    const [participants, objectives, exercises, artefacts, agents, domains] = await Promise.all([
      db().select().from(schema.trainingParticipants).where(eq(schema.trainingParticipants.sessionId, s.id)),
      db().select().from(schema.trainingObjectives).where(eq(schema.trainingObjectives.sessionId, s.id)),
      db().select().from(schema.exercises).where(eq(schema.exercises.sessionId, s.id)).orderBy(schema.exercises.createdAt),
      db().select().from(schema.learningArtefacts).where(eq(schema.learningArtefacts.sessionId, s.id)).orderBy(schema.learningArtefacts.createdAt),
      agentSummaries([s.learnerAgentId, s.trainerAgentId]),
      domainMap([s.domainId]),
    ]);
    const isLearnerSide = s.learnerOrgId === a.orgId || isAdmin(a.user.platformRole);
    return {
      ...publicSession(s),
      role: s.learnerOrgId === a.orgId ? 'learner' : s.trainerOrgId === a.orgId ? 'trainer' : 'admin',
      learner: agents.get(s.learnerAgentId) ?? null, trainer: agents.get(s.trainerAgentId) ?? null, domain: domains.get(s.domainId) ?? null,
      participants, objectives,
      exercises: exercises.map(({ expected: _e, ...ex }) => ex),
      // artefacts belong to the learner org; the trainer side sees only metadata
      artefacts: isLearnerSide ? artefacts : artefacts.map(({ content: _c, ...rest }) => rest),
      scores: { preScore: s.preScore, postScore: s.postScore, improvement: s.improvement, retentionScore: s.retentionScore },
      settlement: { feeCredits: s.feeCredits, commissionRateBps: s.commissionRateBps, commissionCredits: s.commissionCredits, trainerEarningsCredits: s.trainerEarningsCredits, terms: s.settlementTerms, status: s.settlementStatus },
    };
  });

  app.get('/sessions/:id/messages', async (req) => {
    const a = requirePerm(req, 'training.read');
    const s = await loadSessionForOrg((req.params as { id: string }).id, a.orgId, a.user.platformRole);
    const q = parse(PageQuery.extend({ pageSize: z.coerce.number().int().min(1).max(500).default(200) }), req.query);
    const where = eq(schema.trainingMessages.sessionId, s.id);
    const rows = await db().select().from(schema.trainingMessages).where(where).orderBy(schema.trainingMessages.createdAt).limit(q.pageSize).offset(offset(q));
    const [{ n }] = await db().select({ n: count() }).from(schema.trainingMessages).where(where);
    return { items: rows, total: n, page: q.page, pageSize: q.pageSize };
  });

  app.post('/sessions/:id/start', async (req) => {
    const a = requirePerm(req, 'training.participate');
    const s = await loadSessionForOrg((req.params as { id: string }).id, a.orgId, 'user');
    if (s.status !== 'scheduled') throw conflict(s.status === 'paused' ? 'Session is paused — use resume' : `Session is ${s.status}`);
    const now = new Date();
    const [u] = await db().update(schema.trainingSessions).set({ status: 'active', startedAt: now, updatedAt: now })
      .where(and(eq(schema.trainingSessions.id, s.id), eq(schema.trainingSessions.status, 'scheduled'))).returning();
    if (!u) throw conflict('Session state changed; try again');
    await enqueue(TRAINING_RUN_JOB, { sessionId: s.id }, { maxAttempts: 1 });
    await audit({ action: 'training.session.start', targetType: 'training_session', targetId: s.id }, req);
    publishSession(s.id, 'status', { status: 'active' });
    return publicSession(u);
  });

  app.post('/sessions/:id/pause', async (req) => {
    const a = requirePerm(req, 'training.participate');
    const s = await loadSessionForOrg((req.params as { id: string }).id, a.orgId, 'user');
    if (s.status !== 'active') throw conflict(`Session is ${s.status}`);
    if (s.stage === 'completion') throw conflict('Session is completing');
    const now = new Date();
    const [u] = await db().update(schema.trainingSessions).set({ status: 'paused', pausedAt: now, updatedAt: now })
      .where(and(eq(schema.trainingSessions.id, s.id), eq(schema.trainingSessions.status, 'active'))).returning();
    if (!u) throw conflict('Session state changed; try again');
    await logMessage({ sessionId: s.id, senderRole: 'system', stage: s.stage, senderUserId: a.user.id, content: 'Session paused.' });
    publishSession(s.id, 'status', { status: 'paused' });
    return publicSession(u);
  });

  app.post('/sessions/:id/resume', async (req) => {
    const a = requirePerm(req, 'training.participate');
    const s = await loadSessionForOrg((req.params as { id: string }).id, a.orgId, 'user');
    if (s.status !== 'paused') throw conflict(`Session is ${s.status}`);
    const now = new Date();
    const pausedFor = s.pausedAt ? Math.round((now.getTime() - s.pausedAt.getTime()) / 1000) : 0;
    const [u] = await db().update(schema.trainingSessions).set({ status: 'active', pausedAt: null, updatedAt: now })
      .where(and(eq(schema.trainingSessions.id, s.id), eq(schema.trainingSessions.status, 'paused'))).returning();
    if (!u) throw conflict('Session state changed; try again');
    await patchPlan(s.id, { pausedSeconds: (Number((s.plan as { pausedSeconds?: number }).pausedSeconds) || 0) + pausedFor });
    await logMessage({ sessionId: s.id, senderRole: 'system', stage: s.stage, senderUserId: a.user.id, content: 'Session resumed.' });
    await enqueue(TRAINING_RUN_JOB, { sessionId: s.id }, { maxAttempts: 1 });
    publishSession(s.id, 'status', { status: 'active' });
    return publicSession(u);
  });

  app.post('/sessions/:id/end', async (req) => {
    const a = requirePerm(req, 'training.participate');
    const s = await loadSessionForOrg((req.params as { id: string }).id, a.orgId, 'user');
    const body = parse(z.object({ reason: z.string().max(500).optional() }), req.body ?? {});
    const out = await cancelSession(s.id, a.user.id, body.reason ?? `Ended by ${s.learnerOrgId === a.orgId ? 'learner' : 'trainer'} side`);
    await audit({ action: 'training.session.end', targetType: 'training_session', targetId: s.id }, req);
    return publicSession(out);
  });

  app.post('/sessions/:id/intervene', async (req) => {
    const a = requirePerm(req, 'training.participate');
    const s = await loadSessionForOrg((req.params as { id: string }).id, a.orgId, 'user');
    const body = parse(z.object({ content: z.string().trim().min(1).max(4000) }), req.body);
    if (!['active', 'paused', 'scheduled'].includes(s.status)) throw conflict(`Session is ${s.status}`);
    const sideAgentId = s.learnerOrgId === a.orgId ? s.learnerAgentId : s.trainerAgentId;
    const agent = await getAgent(sideAgentId);
    const parts = await db().select().from(schema.trainingParticipants)
      .where(and(eq(schema.trainingParticipants.sessionId, s.id), eq(schema.trainingParticipants.role, 'owner_observer')));
    const mine = parts.find((p) => p.userId === a.user.id);
    const allowed = mine ? mine.permissions.intervene === true : agent ? permOf(agent).allowOwnerIntervention === true : false;
    if (!allowed) throw forbidden('Owner intervention is not enabled for this agent (allowOwnerIntervention)');
    const m = await logMessage({ sessionId: s.id, senderRole: 'owner', senderUserId: a.user.id, stage: s.stage, content: body.content, metadata: { side: s.learnerOrgId === a.orgId ? 'learner' : 'trainer', shared: true } });
    await audit({ action: 'training.session.intervene', targetType: 'training_session', targetId: s.id }, req);
    return m;
  });

  /* ───────────── artefacts ───────────── */
  for (const decision of ['approve', 'reject'] as const) {
    app.post(`/sessions/:id/artefacts/:artefactId/${decision}`, async (req) => {
      const a = requirePerm(req, 'agents.update');
      const { id, artefactId } = req.params as { id: string; artefactId: string };
      const s = await loadSessionForOrg(id, a.orgId, 'user');
      if (s.learnerOrgId !== a.orgId) throw forbidden('Only the learner organisation can decide on learning artefacts');
      return decideArtefact({ artefactId, orgId: a.orgId, userId: a.user.id, decision, sessionId: s.id });
    });
  }
}

function publicSession(s: Session) {
  const { plan, ...rest } = s;
  const p = plan as Record<string, unknown>;
  return { ...rest, progress: { topicIndex: p.topicIndex ?? 0, topics: Array.isArray(p.topics) ? p.topics.length : 0, exercises: Array.isArray(p.exerciseIds) ? p.exerciseIds.length : 0 } };
}

/** Register background job handlers for this module (called once at startup). */
export function registerJobs() {
  registerJob(TRAINING_RUN_JOB, async (payload) => { await runTrainingSession(String(payload.sessionId)); });
  registerJob(TRAINING_RETENTION_JOB, async (payload) => { await runRetentionCheck(String(payload.sessionId)); });
  registerChannelGuard('session', async (auth, id) => {
    if (auth.user.platformRole === 'admin' || auth.user.platformRole === 'super_admin') return true;
    const [s] = await db().select({ l: schema.trainingSessions.learnerOrgId, t: schema.trainingSessions.trainerOrgId })
      .from(schema.trainingSessions).where(eq(schema.trainingSessions.id, id)).limit(1);
    if (!s) return false;
    const orgs = await db().select({ orgId: schema.memberships.orgId }).from(schema.memberships).where(eq(schema.memberships.userId, auth.user.id));
    return orgs.some((o) => o.orgId === s.l || o.orgId === s.t);
  });
}

