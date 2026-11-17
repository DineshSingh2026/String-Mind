/**
 * Certification module (Professional Evaluation), mounted at /certifications.
 *
 *   GET  /certifications?agentId=          org: certifications of the org's agents; with agentId also a per-domain
 *                                           overview of all three evaluation paths (quick assessment, pro exam, proof)
 *   GET  /certifications/rules             public: the exact rules (CERTIFICATION_RULES)
 *   GET  /certifications/agents/:slug      public: active certifications of a PUBLIC agent
 *   POST /certifications/:agentId/:domainSlug/recompute   owner (agents.update) or platform admin
 *   POST /certifications/:id/revoke        platform admin; audited; notifies the owner org
 *
 * Certifications are only ever derived from real completed results (see service.ts).
 */
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db/client.js';
import { enqueue, registerJob } from '../../jobs/queue.js';
import { audit } from '../../lib/audit.js';
import { requireAdmin, requireAuth, requirePerm } from '../../lib/auth.js';
import { conflict, notFound, unprocessable } from '../../lib/errors.js';
import { parse } from '../../lib/http.js';
import { getOwnedAgent } from '../../lib/tenancy.js';
import { publicAgentWhere } from '../marketplace/cards.js';
import {
  CERTIFICATION_RULES, activeCertifications, evidenceTotal, levelLabel, recomputeCertificationRow, revokeCertification, sweepCertifications,
} from './service.js';

export const CERT_SWEEP_JOB = 'certification.sweep';
const DAY_MS = 24 * 3600_000;

type CertRow = typeof schema.agentCertifications.$inferSelect;

const certView = (c: CertRow, domainName?: string) => ({
  id: c.id, agentId: c.agentId, domainSlug: c.domainSlug, domainName: domainName ?? c.domainSlug,
  level: c.level, label: levelLabel(c.level), score: c.score, examScore: c.examScore, evidenceScore: c.evidenceScore,
  liveCheckScore: c.liveCheckScore, confidence: c.confidence, examId: c.examId, status: c.status,
  breakdown: c.breakdown, issuedAt: c.issuedAt, expiresAt: c.expiresAt, updatedAt: c.updatedAt,
});

async function domainNames() {
  const rows = await db().select({ slug: schema.capabilityDomains.slug, name: schema.capabilityDomains.name }).from(schema.capabilityDomains);
  return new Map(rows.map((r) => [r.slug, r.name]));
}

/** Per-domain overview of every evaluation path for one agent (real rows only; nothing estimated). */
async function agentOverview(agent: typeof schema.agents.$inferSelect) {
  const S = schema;
  const [names, caps, exams, evidence, lives, certs] = await Promise.all([
    domainNames(),
    db().select({ c: S.agentCapabilities, slug: S.capabilityDomains.slug }).from(S.agentCapabilities)
      .innerJoin(S.capabilityDomains, eq(S.capabilityDomains.id, S.agentCapabilities.domainId)).where(eq(S.agentCapabilities.agentId, agent.id)),
    db().select().from(S.proExams).where(eq(S.proExams.agentId, agent.id)).orderBy(desc(S.proExams.createdAt)),
    db().select().from(S.evidenceSubmissions).where(eq(S.evidenceSubmissions.agentId, agent.id)),
    db().select().from(S.evidenceLiveChecks).where(eq(S.evidenceLiveChecks.agentId, agent.id)).orderBy(desc(S.evidenceLiveChecks.updatedAt)),
    db().select().from(S.agentCertifications).where(eq(S.agentCertifications.agentId, agent.id)),
  ]);
  const slugs = new Set<string>([
    ...caps.map((c) => c.slug), ...exams.map((e) => e.domainSlug), ...evidence.map((e) => e.domainSlug),
    ...lives.map((l) => l.domainSlug), ...certs.map((c) => c.domainSlug), ...((agent.claimedDomains ?? []) as string[]),
  ]);
  const examView = (e: typeof exams[number] | undefined) => e ? {
    id: e.id, status: e.status, mode: e.mode, score: e.score, confidence: e.confidence, completedAt: e.completedAt, createdAt: e.createdAt,
    counts: e.status === 'completed' && e.mode === 'certification' && e.score != null && (e.confidence ?? 0) >= CERTIFICATION_RULES.exam.minConfidence,
  } : null;
  return [...slugs].map((slug) => {
    const cap = caps.find((c) => c.slug === slug)?.c;
    const dExams = exams.filter((e) => e.domainSlug === slug);
    const dEv = evidence.filter((e) => e.domainSlug === slug);
    const scored = dEv.filter((e) => e.status === 'scored' && e.moderation !== 'removed' && e.evidenceScore != null);
    const live = lives.find((l) => l.domainSlug === slug);
    const cert = certs.find((c) => c.domainSlug === slug);
    return {
      domainSlug: slug, domainName: names.get(slug) ?? slug,
      claimedOnly: !cap && !dExams.length && !dEv.length && !live && !cert,
      quick: cap ? { score: cap.score, verified: cap.verified, confidence: cap.confidence, sampleSize: cap.sampleSize, assessedAt: cap.assessedAt } : null,
      exam: {
        latest: examView(dExams[0]),
        latestCounting: examView(dExams.find((e) => e.status === 'completed' && e.mode === 'certification' && e.score != null && (e.confidence ?? 0) >= CERTIFICATION_RULES.exam.minConfidence)),
        total: dExams.length,
      },
      proof: {
        submissions: dEv.length, scored: scored.length, removed: dEv.filter((e) => e.moderation === 'removed').length,
        pending: dEv.filter((e) => ['submitted', 'checking', 'awaiting_judge'].includes(e.status)).length,
        evidenceTotal: scored.length ? evidenceTotal(scored.map((e) => e.evidenceScore!)).total : null,
        liveCheck: live ? { id: live.id, status: live.status, score: live.score, updatedAt: live.updatedAt } : null,
      },
      certification: cert ? certView(cert, names.get(slug)) : null,
    };
  }).sort((a, b) => (b.certification?.score ?? -1) - (a.certification?.score ?? -1) || Number(a.claimedOnly) - Number(b.claimedOnly) || a.domainName.localeCompare(b.domainName));
}

export default async function routes(app: FastifyInstance) {
  app.addHook('onReady', async () => {
    await ensureSweepScheduled().catch((e) => console.error('[certification] could not schedule sweep', e));
  });

  app.get('/rules', async () => ({ rules: CERTIFICATION_RULES }));

  app.get('/', async (req) => {
    const a = requirePerm(req, 'agents.read');
    const q = parse(z.object({ agentId: z.string().uuid().optional() }), req.query);
    const names = await domainNames();
    if (q.agentId) {
      const agent = await getOwnedAgent(q.agentId, a.orgId);
      const rows = await db().select().from(schema.agentCertifications).where(eq(schema.agentCertifications.agentId, agent.id));
      return { items: rows.map((r) => certView(r, names.get(r.domainSlug))), domains: await agentOverview(agent), rules: CERTIFICATION_RULES };
    }
    const agents = await db().select({ id: schema.agents.id }).from(schema.agents)
      .where(and(eq(schema.agents.orgId, a.orgId), isNull(schema.agents.deletedAt)));
    const ids = agents.map((x) => x.id);
    const rows = ids.length ? await db().select().from(schema.agentCertifications).where(inArray(schema.agentCertifications.agentId, ids)) : [];
    return { items: rows.map((r) => certView(r, names.get(r.domainSlug))) };
  });

  app.get('/agents/:slug', async (req) => {
    const { slug } = parse(z.object({ slug: z.string().min(1).max(200) }), req.params);
    const [row] = await db().select({ id: schema.agents.id, name: schema.agents.name }).from(schema.agents)
      .innerJoin(schema.organisations, eq(schema.organisations.id, schema.agents.orgId))
      .where(and(publicAgentWhere(), eq(schema.agents.slug, slug))).limit(1);
    if (!row) throw notFound('Agent');
    const names = await domainNames();
    const certs = await activeCertifications([row.id]);
    return {
      agent: { slug, name: row.name },
      items: certs.sort((x, y) => y.score - x.score).map((c) => ({
        domainSlug: c.domainSlug, domainName: names.get(c.domainSlug) ?? c.domainSlug, level: c.level, label: levelLabel(c.level),
        score: c.score, confidence: c.confidence, paths: { exam: c.examScore != null, proof: c.evidenceScore != null, liveCheck: c.liveCheckScore != null },
        issuedAt: c.issuedAt, expiresAt: c.expiresAt,
      })),
    };
  });

  app.post('/:agentId/:domainSlug/recompute', async (req) => {
    const p = parse(z.object({ agentId: z.string().uuid(), domainSlug: z.string().min(1).max(100) }), req.params);
    const auth = requireAuth(req);
    const isAdmin = !auth.apiKeyId && (auth.user.platformRole === 'admin' || auth.user.platformRole === 'super_admin');
    let agent: typeof schema.agents.$inferSelect | undefined;
    if (isAdmin) {
      [agent] = await db().select().from(schema.agents).where(eq(schema.agents.id, p.agentId)).limit(1);
      if (!agent) throw notFound('Agent');
    } else {
      const a = requirePerm(req, 'agents.update');
      agent = await getOwnedAgent(p.agentId, a.orgId);
    }
    const names = await domainNames();
    if (!names.has(p.domainSlug)) throw unprocessable(`Unknown domain "${p.domainSlug}"`);
    const row = await recomputeCertificationRow(agent.id, p.domainSlug);
    await audit({ action: 'certification.recompute', targetType: 'agent', targetId: agent.id, orgId: agent.orgId, metadata: { domainSlug: p.domainSlug, level: row?.level ?? null, status: row?.status ?? null } }, req);
    return { certification: row ? certView(row, names.get(p.domainSlug)) : null };
  });

  app.post('/:id/revoke', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const body = parse(z.object({ reason: z.string().trim().min(3).max(1000) }), req.body ?? {});
    const [existing] = await db().select().from(schema.agentCertifications).where(eq(schema.agentCertifications.id, id)).limit(1);
    if (!existing) throw notFound('Certification');
    if (existing.status === 'revoked') throw conflict('This certification is already revoked');
    const row = await revokeCertification(id, body.reason, admin.user.id);
    const [agent] = await db().select({ orgId: schema.agents.orgId }).from(schema.agents).where(eq(schema.agents.id, existing.agentId)).limit(1);
    await audit({ action: 'certification.revoke', actorType: 'admin', targetType: 'agent_certification', targetId: id, orgId: agent?.orgId ?? null, metadata: { agentId: existing.agentId, domainSlug: existing.domainSlug, previousLevel: existing.level, reason: body.reason } }, req);
    return { certification: row ? certView(row) : null };
  });
}

/* ───────────── jobs ───────────── */

async function ensureSweepScheduled() {
  const [q] = await db().select({ id: schema.jobs.id }).from(schema.jobs)
    .where(and(eq(schema.jobs.type, CERT_SWEEP_JOB), inArray(schema.jobs.status, ['queued', 'running']))).limit(1);
  // first run shortly after boot (catches expiries missed while the server was down), then daily
  if (!q) await enqueue(CERT_SWEEP_JOB, {}, { delayMs: 5 * 60_000, maxAttempts: 1 });
}

export function registerJobs() {
  registerJob(CERT_SWEEP_JOB, async () => {
    try {
      await sweepCertifications();
      await db().delete(schema.jobs).where(and(eq(schema.jobs.type, CERT_SWEEP_JOB), inArray(schema.jobs.status, ['completed', 'failed'])));
    } finally {
      await enqueue(CERT_SWEEP_JOB, {}, { delayMs: DAY_MS, maxAttempts: 1 });
    }
  });
}
