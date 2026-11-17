import type { FastifyInstance } from 'fastify';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { REPUTATION_LEVELS } from '@aix/shared';
import { db, schema } from '../../db/client.js';
import { parse } from '../../lib/http.js';
import { getVisibleAgent } from '../../lib/tenancy.js';
import { buildCards, selectPublicAgents, round1 } from '../marketplace/cards.js';
import { computeReputation, LEVEL_MIN_SESSIONS } from './service.js';

const LeaderboardQuery = z.object({
  type: z.enum(['trainers', 'learners', 'active']).default('trainers'),
  domain: z.string().optional(),
  period: z.enum(['30d', 'all']).default('all'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export default async function routes(app: FastifyInstance) {
  app.get('/agents/:id', async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const agent = await getVisibleAgent(id, req.auth?.orgId ?? null);
    const r = (await computeReputation(agent.id))!;
    const [stored] = await db().select().from(schema.agentReputation).where(eq(schema.agentReputation.agentId, agent.id)).limit(1);
    const idx = REPUTATION_LEVELS.findIndex((l) => l.slug === r.level);
    const next = REPUTATION_LEVELS[idx + 1];
    return {
      agentId: agent.id,
      score: r.score,
      level: r.level,
      levelName: REPUTATION_LEVELS[idx]?.name ?? r.level,
      components: r.components,
      breakdown: r.breakdown,
      nextLevel: next ? { slug: next.slug, name: next.name, minScore: next.min, minCompletedSessions: LEVEL_MIN_SESSIONS[next.slug] ?? 0, requiresVerifiedCapability: true } : null,
      updatedAt: stored?.updatedAt ?? null,
    };
  });

  app.get('/leaderboard', async (req) => {
    const q = parse(LeaderboardQuery, req.query);
    const T = schema.trainingSessions;
    let domainId: string | null = null;
    if (q.domain) {
      const [d] = await db().select().from(schema.capabilityDomains).where(eq(schema.capabilityDomains.slug, q.domain)).limit(1);
      if (!d) return { items: [], type: q.type, period: q.period, domain: q.domain };
      domainId = d.id;
    }
    const conds = [eq(T.status, 'completed')];
    if (q.period === '30d') conds.push(sql`coalesce(${T.endedAt}, ${T.updatedAt}) >= ${new Date(Date.now() - 30 * 86400_000).toISOString()}::timestamptz`);
    if (domainId) conds.push(eq(T.domainId, domainId));

    // Aggregate verified session outcomes per agent
    const stats = new Map<string, { sessions: number; improvementSum: number; improvementN: number }>();
    const bump = (id: string, imp: number | null) => {
      const s = stats.get(id) ?? { sessions: 0, improvementSum: 0, improvementN: 0 };
      s.sessions++;
      if (imp != null) { s.improvementSum += imp; s.improvementN++; }
      stats.set(id, s);
    };
    const rows = await db().select({ trainer: T.trainerAgentId, learner: T.learnerAgentId, improvement: T.improvement }).from(T).where(and(...conds));
    for (const r of rows) {
      if (q.type === 'trainers') bump(r.trainer, r.improvement);
      else if (q.type === 'learners') { if (r.improvement != null) bump(r.learner, r.improvement); }
      else { bump(r.trainer, null); bump(r.learner, r.improvement); }
    }
    if (!stats.size) return { items: [], type: q.type, period: q.period, domain: q.domain ?? null };
    const agents = await selectPublicAgents(inArray(schema.agents.id, [...stats.keys()]));
    const { cards } = await buildCards(agents);
    const ranked = cards.map((c) => {
      const s = stats.get(c.id)!;
      const avgImprovement = s.improvementN ? round1(s.improvementSum / s.improvementN) : null;
      const metric = q.type === 'trainers' ? c.reputationScore : q.type === 'learners' ? (avgImprovement ?? 0) : s.sessions;
      return { agent: { id: c.id, slug: c.slug, name: c.name, avatar: c.avatar, owner: c.owner, provider: c.provider }, reputationScore: c.reputationScore, reputationLevel: c.reputationLevel, verifiedScore: c.overallScore, sessions: s.sessions, avgImprovement, metric };
    }).sort((a, b) => b.metric - a.metric || b.reputationScore - a.reputationScore || b.sessions - a.sessions)
      .slice(0, q.limit)
      .map((r, i) => ({ rank: i + 1, ...r }));
    return { items: ranked, type: q.type, period: q.period, domain: q.domain ?? null };
  });
}

/** Register background job handlers for this module (called once at startup). */
export function registerJobs() {}

