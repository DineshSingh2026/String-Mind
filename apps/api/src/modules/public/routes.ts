/** Public (unauthenticated) endpoints. Every number is a real count — nothing is fabricated or padded. */
import type { FastifyInstance } from 'fastify';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db/client.js';
import { audit } from '../../lib/audit.js';
import { parse } from '../../lib/http.js';
import { notify } from '../../lib/notify.js';
import { webOrigin } from '../../lib/agent-inbox.js';
import { connectMarkdown } from '../agent-api/connect-md.js';
import { buildCards, publicAgentWhere, selectPublicAgents } from '../marketplace/cards.js';

export default async function routes(app: FastifyInstance) {
  /** Agent-facing "Connect via prompt" instructions (also served by the web app at /connect.md). */
  app.get('/connect.md', async (_req, reply) => {
    reply.header('content-type', 'text/markdown; charset=utf-8');
    reply.header('cache-control', 'public, max-age=300');
    return connectMarkdown(webOrigin());
  });

  app.get('/stats', async () => {
    const d = db();
    const [agents] = await d.select({ n: sql<number>`count(*)::int` }).from(schema.agents)
      .innerJoin(schema.organisations, eq(schema.organisations.id, schema.agents.orgId)).where(publicAgentWhere());
    const [verified] = await d.select({ n: sql<number>`count(distinct ${schema.agents.id})::int`, domains: sql<number>`count(distinct ${schema.agentCapabilities.domainId})::int` })
      .from(schema.agents)
      .innerJoin(schema.organisations, eq(schema.organisations.id, schema.agents.orgId))
      .innerJoin(schema.agentCapabilities, and(eq(schema.agentCapabilities.agentId, schema.agents.id), eq(schema.agentCapabilities.verified, true)))
      .where(publicAgentWhere());
    const [sessions] = await d.select({ n: sql<number>`count(*)::int` }).from(schema.trainingSessions).where(eq(schema.trainingSessions.status, 'completed'));
    const [domains] = await d.select({ n: sql<number>`count(*)::int` }).from(schema.capabilityDomains).where(eq(schema.capabilityDomains.active, true));
    const [kl] = await d.select({ n: sql<number>`count(*)::int` }).from(schema.knowledgeListings)
      .where(and(eq(schema.knowledgeListings.moderation, 'visible'), eq(schema.knowledgeListings.verificationStatus, 'verified'), eq(schema.knowledgeListings.status, 'active')));
    // lessons = learning artefacts an owner approved into the hive (pending/rejected never count)
    const [lessons] = await d.select({ n: sql<number>`count(*)::int` }).from(schema.learningArtefacts)
      .where(inArray(schema.learningArtefacts.status, ['approved', 'applied']));
    return {
      agents: Number(agents?.n ?? 0),
      lessons: Number(lessons?.n ?? 0),
      verifiedAgents: Number(verified?.n ?? 0),
      completedSessions: Number(sessions?.n ?? 0),
      /** active benchmark domains offered for assessment */
      domains: Number(domains?.n ?? 0),
      /** domains in which at least one public agent holds a verified capability */
      domainsWithVerifiedAgents: Number(verified?.domains ?? 0),
      knowledgeListings: Number(kl?.n ?? 0),
      generatedAt: new Date().toISOString(),
    };
  });

  /**
   * Live data for the public site's visualisations (network graph, domain constellation, activity ticker).
   * Only public agents are named; private learners are anonymised. Everything is a real DB value.
   */
  app.get('/network', async () => {
    const d = db();
    const domains = await d.select().from(schema.capabilityDomains).where(eq(schema.capabilityDomains.active, true)).orderBy(schema.capabilityDomains.sortOrder);
    const domainById = new Map(domains.map((x) => [x.id, x]));
    const agents = await selectPublicAgents();
    const ids = agents.map((a) => a.id);
    const caps = ids.length ? await d.select().from(schema.agentCapabilities).where(and(inArray(schema.agentCapabilities.agentId, ids), eq(schema.agentCapabilities.verified, true))) : [];
    const listings = ids.length ? await d.select({ agentId: schema.marketplaceListings.agentId }).from(schema.marketplaceListings)
      .where(and(inArray(schema.marketplaceListings.agentId, ids), eq(schema.marketplaceListings.status, 'active'), eq(schema.marketplaceListings.moderation, 'visible'))) : [];
    const trainerIds = new Set(listings.map((l) => l.agentId));
    const done = await d.select().from(schema.trainingSessions).where(eq(schema.trainingSessions.status, 'completed')).orderBy(sql`${schema.trainingSessions.endedAt} desc nulls last`).limit(200);
    const publicIds = new Set(ids);

    const nodes = agents.map((a) => {
      const mine = caps.filter((c) => c.agentId === a.id);
      const score = mine.length ? Math.round((mine.reduce((s, c) => s + c.score, 0) / mine.length) * 10) / 10 : null;
      return {
        id: a.id, slug: a.slug, name: a.name,
        domains: mine.map((c) => domainById.get(c.domainId)?.slug).filter(Boolean),
        score, role: trainerIds.has(a.id) ? 'trainer' : 'agent',
        sessionsAsTrainer: done.filter((s) => s.trainerAgentId === a.id).length,
      };
    });
    // links only between two public agents (no private agent is ever revealed)
    const links = done.filter((s) => publicIds.has(s.trainerAgentId) && publicIds.has(s.learnerAgentId))
      .map((s) => ({ source: s.trainerAgentId, target: s.learnerAgentId, improvement: s.improvement }));

    const constellation = domains.map((dm) => {
      const dc = caps.filter((c) => c.domainId === dm.id);
      const ds = done.filter((s) => s.domainId === dm.id);
      const imps = ds.map((s) => s.improvement).filter((x): x is number => typeof x === 'number');
      return {
        slug: dm.slug, name: dm.name, icon: dm.icon, highImpact: dm.highImpact,
        verifiedAgents: new Set(dc.map((c) => c.agentId)).size,
        bestScore: dc.length ? Math.max(...dc.map((c) => c.score)) : null,
        completedSessions: ds.length,
        avgImprovement: imps.length ? Math.round((imps.reduce((a, b) => a + b, 0) / imps.length) * 10) / 10 : null,
      };
    });

    // Activity: completed assessments of public agents + completed training sessions (learner anonymised unless public)
    const agentName = new Map(agents.map((a) => [a.id, a.name]));
    const assess = ids.length ? await d.select().from(schema.capabilityAssessments)
      .where(and(inArray(schema.capabilityAssessments.agentId, ids), eq(schema.capabilityAssessments.status, 'completed')))
      .orderBy(sql`${schema.capabilityAssessments.completedAt} desc`).limit(15) : [];
    const activity = [
      ...assess.map((x) => ({
        type: 'assessment' as const, at: x.completedAt, agent: agentName.get(x.agentId) ?? 'An agent',
        domain: (x.domainSlugs as string[]).map((s) => domains.find((dm) => dm.slug === s)?.name ?? s).join(', '),
        score: x.overallScore,
      })),
      ...done.slice(0, 15).map((s) => ({
        type: 'training' as const, at: s.endedAt, agent: agentName.get(s.trainerAgentId) ?? 'A trainer agent',
        learner: agentName.get(s.learnerAgentId) ?? 'a learner agent',
        domain: domainById.get(s.domainId)?.name ?? '', improvement: s.improvement,
      })),
    ].filter((e) => e.at).sort((a, b) => new Date(b.at!).getTime() - new Date(a.at!).getTime()).slice(0, 20);

    return { nodes, links, constellation, activity, generatedAt: new Date().toISOString() };
  });

  app.get('/featured-agents', async (req) => {
    const { limit } = parse(z.object({ limit: z.coerce.number().int().min(1).max(24).default(6) }), req.query);
    const verifiedIds = db().select({ id: schema.agentCapabilities.agentId }).from(schema.agentCapabilities).where(eq(schema.agentCapabilities.verified, true));
    const agents = await selectPublicAgents(inArray(schema.agents.id, verifiedIds));
    const { cards } = await buildCards(agents);
    const items = cards
      .sort((a, b) => b.reputationScore - a.reputationScore || (b.overallScore ?? 0) - (a.overallScore ?? 0) || a.name.localeCompare(b.name))
      .slice(0, limit);
    return { items };
  });

  app.post('/contact', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = parse(z.object({
      name: z.string().trim().min(1).max(120),
      email: z.string().trim().email().max(254),
      company: z.string().trim().max(160).optional().nullable(),
      topic: z.string().trim().min(1).max(80),
      message: z.string().trim().min(10).max(5000),
    }), req.body);
    const [row] = await db().insert(schema.contactMessages).values({ ...body, company: body.company ?? null }).returning();
    const admins = await db().select({ id: schema.users.id, email: schema.users.email }).from(schema.users)
      .where(and(or(eq(schema.users.platformRole, 'admin'), eq(schema.users.platformRole, 'super_admin')), eq(schema.users.status, 'active'), isNull(schema.users.deletedAt)));
    const title = `Contact: ${body.topic} — ${body.name}`;
    const text = `From ${body.name} <${body.email}>${body.company ? ` (${body.company})` : ''}\n\n${body.message}`;
    for (const a of admins) {
      // notify() writes in-app (+ email if the admin opted in); guarantee exactly one email either way.
      const outboxCount = async () => Number((await db().select({ n: sql<number>`count(*)::int` }).from(schema.emailOutbox).where(eq(schema.emailOutbox.to, a.email)))[0]?.n ?? 0);
      const before = await outboxCount();
      await notify(a.id, 'system', title, text.slice(0, 500), '/admin/contact');
      if ((await outboxCount()) === before) await db().insert(schema.emailOutbox).values({ to: a.email, subject: `[Hive Mind] ${title}`, body: text });
    }
    await audit({ action: 'public.contact', targetType: 'contact_message', targetId: row!.id, actorType: 'system', metadata: { topic: body.topic } }, null);
    return reply.status(201).send({ id: row!.id, status: 'received' });
  });
}

/** Register background job handlers for this module (called once at startup). */
export function registerJobs() {}
