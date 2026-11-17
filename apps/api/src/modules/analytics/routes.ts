/**
 * Org analytics. Every number is computed from real rows for the caller's active org — nothing is estimated.
 * All amounts are IDLE Tokens (no fiat; platform commission is in IDLE too).
 * Earnings: training = trainerEarningsCredits of settled sessions where the org was the trainer;
 *           knowledge = net positive credit to the org wallet on knowledge_* ledger transactions.
 * Spend:    training = IDLE actually paid on settled sessions where the org was the learner
 *           (trainer earnings + commission; falls back to the fee).
 */
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gte, inArray, isNull, like, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { CREDIT_CURRENCY } from '@aix/shared';
import { db, schema } from '../../db/client.js';
import { requirePerm } from '../../lib/auth.js';
import { parse } from '../../lib/http.js';
import { buildCards, loadCapabilities, loadReputation, mean, round1, selectPublicAgents, verifiedScore } from '../marketplace/cards.js';
import { toCsv } from './csv.js';

const DAY = 86400_000;
const T = schema.trainingSessions;
type Session = typeof T.$inferSelect;

const PeriodQuery = z.object({ period: z.string().regex(/^(\d{1,3}d|all)$/).default('30d') });

export function parsePeriod(p: string): number | null {
  if (p === 'all') return null;
  return Math.min(Math.max(Number(p.slice(0, -1)), 1), 730);
}

const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const endAt = (s: Session) => s.endedAt ?? s.updatedAt;
const inWin = (d: Date, from: Date | null, to: Date) => (!from || d >= from) && d < to;

function days(from: Date, to: Date): string[] {
  const out: string[] = [];
  for (let t = startOfUtcDay(from).getTime(); t < to.getTime(); t += DAY) out.push(dayKey(new Date(t)));
  return out;
}

async function orgSessions(orgId: string) {
  return db().select().from(T).where(or(eq(T.learnerOrgId, orgId), eq(T.trainerOrgId, orgId)));
}

/** Net credit to the org wallet per knowledge transaction (positive = earned). */
async function knowledgeNets(orgId: string) {
  return db().select({ tx: schema.transactions.id, createdAt: schema.transactions.createdAt, net: sql<string>`sum(${schema.ledgerEntries.amount})` })
    .from(schema.ledgerEntries)
    .innerJoin(schema.wallets, eq(schema.wallets.id, schema.ledgerEntries.walletId))
    .innerJoin(schema.transactions, eq(schema.transactions.id, schema.ledgerEntries.transactionId))
    .where(and(eq(schema.wallets.orgId, orgId), eq(schema.wallets.kind, 'org'), like(schema.transactions.type, 'knowledge%')))
    .groupBy(schema.transactions.id, schema.transactions.createdAt);
}

const paid = (s: Session) => (s.trainerEarningsCredits != null ? s.trainerEarningsCredits + (s.commissionCredits ?? 0) : s.feeCredits);

function totalsFor(orgId: string, sessions: Session[], kn: { createdAt: Date; net: string }[], from: Date | null, to: Date) {
  const created = sessions.filter((s) => inWin(s.createdAt, from, to));
  const ended = sessions.filter((s) => inWin(endAt(s), from, to));
  const completed = ended.filter((s) => s.status === 'completed');
  const finished = ended.filter((s) => s.status === 'completed' || s.status === 'failed');
  const imps = completed.filter((s) => s.learnerOrgId === orgId && s.improvement != null).map((s) => s.improvement!);
  const trainingEarnings = ended.filter((s) => s.trainerOrgId === orgId && s.settlementStatus === 'settled').reduce((a, s) => a + (s.trainerEarningsCredits ?? 0), 0);
  const knowledgeEarnings = kn.filter((k) => inWin(k.createdAt, from, to) && Number(k.net) > 0).reduce((a, k) => a + Number(k.net), 0);
  const trainingSpend = ended.filter((s) => s.learnerOrgId === orgId && s.settlementStatus === 'settled').reduce((a, s) => a + paid(s), 0);
  return {
    sessions: created.length,
    completedSessions: completed.length,
    avgImprovement: round1(mean(imps)),
    totalEarnings: trainingEarnings + knowledgeEarnings,
    trainingEarnings, knowledgeEarnings,
    trainingSpend,
    successRate: finished.length ? round1((finished.filter((s) => s.status === 'completed' && (s.improvement ?? 0) > 0).length / finished.length) * 100) : null,
  };
}

const diff = (a: number | null, b: number | null) => (a == null || b == null ? null : round1(a - b));

export default async function routes(app: FastifyInstance) {
  app.get('/dashboard', async (req) => {
    const a = requirePerm(req, 'analytics.read');
    const { period } = parse(PeriodQuery, req.query);
    const nDays = parsePeriod(period);
    const now = new Date();
    const from = nDays ? new Date(now.getTime() - nDays * DAY) : null;
    const prevFrom = nDays ? new Date(now.getTime() - 2 * nDays * DAY) : null;

    const [agents, sessions, kn, [wallet]] = await Promise.all([
      db().select().from(schema.agents).where(and(eq(schema.agents.orgId, a.orgId), isNull(schema.agents.deletedAt))),
      orgSessions(a.orgId),
      knowledgeNets(a.orgId),
      db().select().from(schema.wallets).where(and(eq(schema.wallets.orgId, a.orgId), eq(schema.wallets.kind, 'org'))).limit(1),
    ]);

    const cur = totalsFor(a.orgId, sessions, kn, from, now);
    const totals = {
      agents: agents.length,
      activeAgents: agents.filter((x) => x.status === 'active').length,
      sessions: cur.sessions,
      completedSessions: cur.completedSessions,
      avgImprovement: cur.avgImprovement,
      totalEarnings: cur.totalEarnings,
      availableCredits: wallet?.available ?? 0,
      trainingSpend: cur.trainingSpend,
      successRate: cur.successRate,
    };

    // Deltas only when there is data from before the current period.
    let deltas: Record<string, number | null> | null = null;
    const nullDeltas = Object.fromEntries(Object.keys(totals).map((k) => [k, null])) as Record<string, number | null>;
    if (from && prevFrom) {
      const hasPrior = sessions.some((s) => s.createdAt < from) || agents.some((x) => x.createdAt < from) || kn.some((k) => k.createdAt < from);
      if (hasPrior) {
        const prev = totalsFor(a.orgId, sessions, kn, prevFrom, from);
        deltas = {
          agents: agents.length - agents.filter((x) => x.createdAt < from).length,
          activeAgents: null,
          sessions: cur.sessions - prev.sessions,
          completedSessions: cur.completedSessions - prev.completedSessions,
          avgImprovement: diff(cur.avgImprovement, prev.avgImprovement),
          totalEarnings: cur.totalEarnings - prev.totalEarnings,
          availableCredits: null,
          trainingSpend: cur.trainingSpend - prev.trainingSpend,
          successRate: diff(cur.successRate, prev.successRate),
        };
      }
    }
    deltas ??= nullDeltas;

    // Growth series, zero-filled per UTC day
    const earliest = [...sessions.map((s) => s.createdAt), ...kn.map((k) => k.createdAt), ...agents.map((x) => x.createdAt)].sort((x, y) => x.getTime() - y.getTime())[0];
    const gFrom = nDays ? new Date(startOfUtcDay(now).getTime() - (nDays - 1) * DAY) : (earliest && earliest.getTime() > now.getTime() - 365 * DAY ? earliest : new Date(now.getTime() - 365 * DAY));
    const growthMap = new Map(days(gFrom, now).map((d) => [d, { date: d, earnings: 0, sessions: 0 }]));
    for (const s of sessions) {
      const g = growthMap.get(dayKey(s.createdAt));
      if (g) g.sessions++;
      if (s.trainerOrgId === a.orgId && s.settlementStatus === 'settled') {
        const e = growthMap.get(dayKey(endAt(s)));
        if (e) e.earnings += s.trainerEarningsCredits ?? 0;
      }
    }
    for (const k of kn) { const g = growthMap.get(dayKey(k.createdAt)); if (g && Number(k.net) > 0) g.earnings += Number(k.net); }
    const growth = [...growthMap.values()];

    // Top agents (by verified capability, then reputation)
    const ids = agents.map((x) => x.id);
    const [caps, rep] = await Promise.all([loadCapabilities(ids), loadReputation(ids)]);
    const topAgents = agents.map((x) => ({
      id: x.id, slug: x.slug, name: x.name, avatar: x.avatar, status: x.status, health: x.health,
      overallScore: verifiedScore(caps.get(x.id)), reputationScore: rep.get(x.id)?.score ?? 0, reputationLevel: rep.get(x.id)?.level ?? 'new_contributor',
      sessionsCompleted: sessions.filter((s) => s.status === 'completed' && (s.trainerAgentId === x.id || s.learnerAgentId === x.id)).length,
    })).sort((p, q) => (q.overallScore ?? -1) - (p.overallScore ?? -1) || q.reputationScore - p.reputationScore).slice(0, 5);

    // Recent activity
    const agentName = new Map(agents.map((x) => [x.id, x.name]));
    const recentSessions = [...sessions].sort((x, y) => y.updatedAt.getTime() - x.updatedAt.getTime()).slice(0, 10);
    const recentAssess = await db().select().from(schema.capabilityAssessments).where(eq(schema.capabilityAssessments.orgId, a.orgId))
      .orderBy(desc(schema.capabilityAssessments.createdAt)).limit(10);
    const recentTx = await db().select().from(schema.transactions).where(eq(schema.transactions.orgId, a.orgId)).orderBy(desc(schema.transactions.createdAt)).limit(10);
    const recentActivity = [
      ...recentSessions.map((s) => ({ type: 'training_session', title: `Training “${s.subject}” ${s.status}`, createdAt: s.updatedAt, link: `/training/sessions/${s.id}` })),
      ...recentAssess.map((x) => ({ type: 'assessment', title: `Assessment of ${agentName.get(x.agentId) ?? 'agent'} ${x.status}${x.overallScore != null ? ` — ${round1(x.overallScore)}` : ''}`, createdAt: x.completedAt ?? x.createdAt, link: `/assessments/${x.id}` })),
      ...recentTx.map((t) => ({ type: 'transaction', title: t.description || t.type.replace(/_/g, ' '), createdAt: t.createdAt, link: '/wallet' })),
    ].sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime()).slice(0, 10);

    // Recommendations from capability gaps
    const gaps: { agentId: string; agentName: string; domainId: string; domainSlug: string; domainName: string; score: number }[] = [];
    for (const x of agents) for (const c of caps.get(x.id) ?? []) if (c.score < 70) gaps.push({ agentId: x.id, agentName: x.name, domainId: c.domainId, domainSlug: c.slug, domainName: c.name, score: round1(c.score)! });
    gaps.sort((p, q) => p.score - q.score);
    const recommendations = [];
    for (const g of gaps.slice(0, 5)) {
      const trainers = await db().select({ agentId: schema.agents.id, name: schema.agents.name, score: schema.agentCapabilities.score, price: sql<number>`min(${schema.marketplaceListings.priceCredits})::int` })
        .from(schema.agentCapabilities)
        .innerJoin(schema.agents, eq(schema.agents.id, schema.agentCapabilities.agentId))
        .innerJoin(schema.organisations, eq(schema.organisations.id, schema.agents.orgId))
        .innerJoin(schema.marketplaceListings, and(eq(schema.marketplaceListings.agentId, schema.agents.id), eq(schema.marketplaceListings.domainId, g.domainId), eq(schema.marketplaceListings.status, 'active'), eq(schema.marketplaceListings.moderation, 'visible')))
        .where(and(eq(schema.agentCapabilities.domainId, g.domainId), eq(schema.agentCapabilities.verified, true), gte(schema.agentCapabilities.score, 70),
          eq(schema.agents.isPublic, true), eq(schema.agents.status, 'active'), isNull(schema.agents.deletedAt), eq(schema.organisations.privateNetwork, false),
          sql`${schema.agents.orgId} <> ${a.orgId}`))
        .groupBy(schema.agents.id, schema.agents.name, schema.agentCapabilities.score)
        .orderBy(desc(schema.agentCapabilities.score)).limit(3);
      recommendations.push({
        agentId: g.agentId, agentName: g.agentName, domainSlug: g.domainSlug, domainName: g.domainName, score: g.score,
        reason: `${g.agentName} scores ${g.score} in ${g.domainName}, below the 70 trainer threshold.`,
        suggestedTrainers: trainers.map((t) => ({ agentId: t.agentId, name: t.name, score: round1(t.score), priceCredits: Number(t.price) })),
      });
    }

    const [{ pending }] = await db().select({ pending: sql<number>`count(*)::int` }).from(schema.trainingRequests)
      .where(and(eq(schema.trainingRequests.trainerOrgId, a.orgId), eq(schema.trainingRequests.status, 'pending')));

    // Platform top trainers (verified data only)
    const topRep = await db().select().from(schema.agentReputation).where(sql`${schema.agentReputation.sessionsCompleted} > 0`)
      .orderBy(desc(schema.agentReputation.score)).limit(50);
    let topTrainers: unknown[] = [];
    if (topRep.length) {
      const pub = await selectPublicAgents(inArray(schema.agents.id, topRep.map((r) => r.agentId)));
      const { cards } = await buildCards(pub);
      topTrainers = cards.sort((p, q) => q.reputationScore - p.reputationScore).slice(0, 5)
        .map((c) => ({ id: c.id, slug: c.slug, name: c.name, avatar: c.avatar, reputationScore: c.reputationScore, reputationLevel: c.reputationLevel, sessionsCompleted: c.sessionsCompleted, rating: c.rating, verifiedDomains: c.verifiedDomains }));
    }

    return { period, currency: CREDIT_CURRENCY, totals, deltas, growth, topAgents, recentActivity, recommendations, pendingRequests: Number(pending), topTrainers };
  });

  app.get('/performance', async (req) => {
    const a = requirePerm(req, 'analytics.read');
    const { period } = parse(PeriodQuery, req.query);
    const nDays = parsePeriod(period);
    const now = new Date();
    const from = nDays ? new Date(now.getTime() - nDays * DAY) : null;
    const [sessions, kn, domains] = await Promise.all([orgSessions(a.orgId), knowledgeNets(a.orgId), db().select().from(schema.capabilityDomains)]);
    const dName = new Map(domains.map((d) => [d.id, d]));
    const ended = sessions.filter((s) => inWin(endAt(s), from, now));
    const learnerDone = ended.filter((s) => s.learnerOrgId === a.orgId && s.status === 'completed');
    const earliest = sessions.map((s) => s.createdAt).sort((x, y) => x.getTime() - y.getTime())[0];
    const sFrom = nDays ? new Date(startOfUtcDay(now).getTime() - (nDays - 1) * DAY) : (earliest && earliest.getTime() > now.getTime() - 365 * DAY ? earliest : new Date(now.getTime() - 365 * DAY));

    const series = new Map(days(sFrom, now).map((d) => [d, { date: d, sessions: 0, imps: [] as number[], earnings: 0, costs: 0 }]));
    for (const s of learnerDone) { const p = series.get(dayKey(endAt(s))); if (p) { p.sessions++; if (s.improvement != null) p.imps.push(s.improvement); } }
    for (const s of ended) {
      const p = series.get(dayKey(endAt(s)));
      if (!p || s.settlementStatus !== 'settled') continue;
      if (s.trainerOrgId === a.orgId) p.earnings += s.trainerEarningsCredits ?? 0;
      if (s.learnerOrgId === a.orgId) p.costs += paid(s);
    }
    for (const k of kn) { const p = series.get(dayKey(k.createdAt)); if (p && Number(k.net) > 0) p.earnings += Number(k.net); }

    const byDomainMap = new Map<string, { sessions: number; imps: number[] }>();
    for (const s of learnerDone) {
      const e = byDomainMap.get(s.domainId) ?? { sessions: 0, imps: [] };
      e.sessions++; if (s.improvement != null) e.imps.push(s.improvement);
      byDomainMap.set(s.domainId, e);
    }

    const learnerIds = learnerDone.map((s) => s.id);
    const objectives = learnerIds.length ? await db().select({ o: schema.trainingObjectives, skill: schema.capabilitySkills.name }).from(schema.trainingObjectives)
      .leftJoin(schema.capabilitySkills, eq(schema.capabilitySkills.id, schema.trainingObjectives.skillId))
      .where(and(inArray(schema.trainingObjectives.sessionId, learnerIds), eq(schema.trainingObjectives.achieved, true))) : [];
    const skillCount = new Map<string, number>();
    for (const o of objectives) { const k = o.skill ?? o.o.description; skillCount.set(k, (skillCount.get(k) ?? 0) + 1); }

    const learnerAll = sessions.filter((s) => s.learnerOrgId === a.orgId && inWin(s.createdAt, from, now));
    const pairs = new Map<string, number>();
    for (const s of learnerAll) { const k = `${s.learnerAgentId}|${s.domainId}`; pairs.set(k, (pairs.get(k) ?? 0) + 1); }
    const repeats = [...pairs.entries()].filter(([, n]) => n > 1);
    const failed = ended.filter((s) => s.status === 'failed');
    const settledLearner = ended.filter((s) => s.learnerOrgId === a.orgId && s.settlementStatus === 'settled');
    const totalCost = settledLearner.reduce((x, s) => x + paid(s), 0);
    const pts = [...series.values()];

    return {
      period,
      improvementSeries: pts.map((p) => ({ date: p.date, sessions: p.sessions, avgImprovement: round1(mean(p.imps)) })),
      byDomain: [...byDomainMap.entries()].map(([id, e]) => ({ domainSlug: dName.get(id)?.slug ?? id, domainName: dName.get(id)?.name ?? id, sessions: e.sessions, avgImprovement: round1(mean(e.imps)) }))
        .sort((x, y) => y.sessions - x.sessions),
      topSkillsAcquired: [...skillCount.entries()].map(([skill, n]) => ({ skill, count: n })).sort((x, y) => y.count - x.count).slice(0, 10),
      earningsTrend: pts.map((p) => ({ date: p.date, earnings: p.earnings })),
      trainingCosts: { total: totalCost, sessions: settledLearner.length, avgPerSession: settledLearner.length ? Math.round(totalCost / settledLearner.length) : null, series: pts.map((p) => ({ date: p.date, costs: p.costs })) },
      repeatTraining: {
        count: repeats.length,
        items: repeats.map(([k, n]) => { const [agentId, domainId] = k.split('|'); return { agentId, domainSlug: dName.get(domainId!)?.slug ?? domainId, sessions: n }; }),
      },
      failedSessions: {
        count: failed.length,
        rate: ended.length ? round1((failed.length / ended.length) * 100) : null,
        items: failed.slice(0, 20).map((s) => ({ id: s.id, subject: s.subject, failureReason: s.failureReason, endedAt: endAt(s), role: s.learnerOrgId === a.orgId ? 'learner' : 'trainer' })),
      },
    };
  });

  app.get('/export', async (req, reply) => {
    const a = requirePerm(req, 'analytics.read');
    const q = parse(z.object({ report: z.enum(['sessions', 'transactions', 'assessments']), format: z.enum(['csv']).default('csv'), period: z.string().regex(/^(\d{1,3}d|all)$/).default('all') }), req.query);
    const nDays = parsePeriod(q.period);
    const from = nDays ? new Date(Date.now() - nDays * DAY) : new Date(0);
    let csv: string;
    if (q.report === 'sessions') {
      const rows = await db().select({ s: T, d: schema.capabilityDomains.slug }).from(T).innerJoin(schema.capabilityDomains, eq(schema.capabilityDomains.id, T.domainId))
        .where(and(or(eq(T.learnerOrgId, a.orgId), eq(T.trainerOrgId, a.orgId)), gte(T.createdAt, from))).orderBy(desc(T.createdAt)).limit(50_000);
      const ids = [...new Set(rows.flatMap((r) => [r.s.learnerAgentId, r.s.trainerAgentId]))];
      const names = new Map((ids.length ? await db().select({ id: schema.agents.id, name: schema.agents.name }).from(schema.agents).where(inArray(schema.agents.id, ids)) : []).map((x) => [x.id, x.name]));
      csv = toCsv(
        ['id', 'created_at', 'role', 'subject', 'domain', 'learner_agent', 'trainer_agent', 'status', 'pre_score', 'post_score', 'improvement', 'fee_credits', 'settlement_status', 'ended_at'],
        rows.map(({ s, d }) => [s.id, s.createdAt, s.learnerOrgId === a.orgId ? 'learner' : 'trainer', s.subject, d, names.get(s.learnerAgentId) ?? '', names.get(s.trainerAgentId) ?? '', s.status, s.preScore, s.postScore, s.improvement, s.feeCredits, s.settlementStatus, s.endedAt]),
      );
    } else if (q.report === 'transactions') {
      const rows = await db().select().from(schema.transactions).where(and(eq(schema.transactions.orgId, a.orgId), gte(schema.transactions.createdAt, from)))
        .orderBy(desc(schema.transactions.createdAt)).limit(50_000);
      csv = toCsv(['id', 'created_at', 'type', 'status', 'description', 'amount', 'reference_type', 'reference_id'],
        rows.map((t) => [t.id, t.createdAt, t.type, t.status, t.description, t.amount, t.referenceType, t.referenceId]));
    } else {
      const rows = await db().select({ x: schema.capabilityAssessments, name: schema.agents.name }).from(schema.capabilityAssessments)
        .innerJoin(schema.agents, eq(schema.agents.id, schema.capabilityAssessments.agentId))
        .where(and(eq(schema.capabilityAssessments.orgId, a.orgId), gte(schema.capabilityAssessments.createdAt, from)))
        .orderBy(desc(schema.capabilityAssessments.createdAt)).limit(50_000);
      csv = toCsv(['id', 'created_at', 'agent', 'purpose', 'domains', 'status', 'overall_score', 'confidence', 'tests_completed', 'completed_at'],
        rows.map(({ x, name }) => [x.id, x.createdAt, name, x.purpose, x.domainSlugs.join(';'), x.status, x.overallScore, x.confidence, x.testsCompleted, x.completedAt]));
    }
    const filename = `aix-${q.report}-${new Date().toISOString().slice(0, 10)}.csv`;
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${filename}"`)
      .header('cache-control', 'no-store')
      .send(csv);
  });
}

/** Register background job handlers for this module (called once at startup). */
export function registerJobs() {}

