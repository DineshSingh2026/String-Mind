import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, count, desc, eq, inArray, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db/client.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { PageQuery, offset, parse } from '../../lib/http.js';
import { notify, notifyOrg } from '../../lib/notify.js';
import { recomputeReputation } from '../reputation/service.js';
import { IdParam, actor, adminAudit } from './common.js';
import { suspendAgent } from './core.js';

/* ───────────── Reported content: previews + removal (social layer) ───────────── */

/** Content admins can remove / restore via the `moderation` column ('visible' | 'removed'). */
export const REMOVABLE_TYPES = ['session', 'debate', 'debate_message', 'hive_lesson', 'verdict'] as const;
type Removable = (typeof REMOVABLE_TYPES)[number];
const isRemovable = (t: string): t is Removable => (REMOVABLE_TYPES as readonly string[]).includes(t);

const LABEL: Record<string, string> = {
  agent: 'agent', listing: 'training listing', knowledge: 'knowledge listing', review: 'review', user: 'user',
  session: 'public room', debate: 'debate', debate_message: 'debate message', hive_lesson: 'hive lesson', verdict: 'knowledge verdict',
};

export interface ContentInfo {
  title: string; excerpt: string; link: string | null; moderation: string | null; createdAt: Date | null;
  /** organisations that own the content (notified on removal / restore) */
  orgIds: string[];
}

const clip = (s: string | null | undefined, n = 280) => { const t = (s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const uniq = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))];

/** Preview of reported / moderated content for a batch of ids of one type. Content is untrusted text: render as text only. */
export async function contentInfo(type: string, ids: string[]): Promise<Map<string, ContentInfo>> {
  const out = new Map<string, ContentInfo>();
  if (!ids.length) return out;
  const s = schema;
  switch (type) {
    case 'agent': {
      const rows = await db().select().from(s.agents).where(inArray(s.agents.id, ids));
      for (const r of rows) out.set(r.id, { title: r.name, excerpt: clip(r.description), link: r.isPublic ? `/marketplace/${r.slug}` : null, moderation: r.deletedAt ? 'deleted' : r.isPublic ? 'visible' : 'hidden', createdAt: r.createdAt, orgIds: [r.orgId] });
      break;
    }
    case 'listing': {
      const rows = await db().select().from(s.marketplaceListings).where(inArray(s.marketplaceListings.id, ids));
      for (const r of rows) out.set(r.id, { title: r.title, excerpt: clip(r.description), link: null, moderation: r.moderation, createdAt: r.createdAt, orgIds: [r.orgId] });
      break;
    }
    case 'knowledge': {
      const rows = await db().select().from(s.knowledgeListings).where(inArray(s.knowledgeListings.id, ids));
      for (const r of rows) out.set(r.id, { title: r.title, excerpt: clip(r.description), link: null, moderation: r.moderation, createdAt: r.createdAt, orgIds: [r.orgId] });
      break;
    }
    case 'review': {
      const rows = await db().select({ r: s.reviews, orgId: s.agents.orgId, agentName: s.agents.name }).from(s.reviews)
        .innerJoin(s.agents, eq(s.agents.id, s.reviews.agentId)).where(inArray(s.reviews.id, ids));
      for (const { r, orgId, agentName } of rows) out.set(r.id, { title: `${r.rating}★ review of ${agentName}`, excerpt: clip(r.body), link: null, moderation: r.status === 'hidden' ? 'hidden' : 'visible', createdAt: r.createdAt, orgIds: [orgId] });
      break;
    }
    case 'user': {
      const rows = await db().select({ id: s.users.id, name: s.users.name, email: s.users.email, status: s.users.status, createdAt: s.users.createdAt }).from(s.users).where(inArray(s.users.id, ids));
      for (const r of rows) out.set(r.id, { title: r.name, excerpt: r.email, link: null, moderation: r.status, createdAt: r.createdAt, orgIds: [] });
      break;
    }
    case 'session': {
      const rows = await db().select().from(s.trainingSessions).where(inArray(s.trainingSessions.id, ids));
      for (const r of rows) out.set(r.id, { title: r.subject, excerpt: `${r.visibility} room · ${r.status}`, link: `/app/training/${r.id}`, moderation: r.moderation, createdAt: r.createdAt, orgIds: uniq([r.learnerOrgId, r.trainerOrgId]) });
      break;
    }
    case 'debate': {
      const rows = await db().select().from(s.debates).where(inArray(s.debates.id, ids));
      for (const r of rows) out.set(r.id, { title: r.title, excerpt: clip(r.prompt), link: `/app/debates/${r.id}`, moderation: r.moderation, createdAt: r.createdAt, orgIds: [r.orgId] });
      break;
    }
    case 'debate_message': {
      const rows = await db().select({ m: s.debateMessages, debateTitle: s.debates.title, debateOrg: s.debates.orgId, agentOrg: s.agents.orgId, agentName: s.agents.name })
        .from(s.debateMessages).innerJoin(s.debates, eq(s.debates.id, s.debateMessages.debateId))
        .leftJoin(s.agents, eq(s.agents.id, s.debateMessages.agentId)).where(inArray(s.debateMessages.id, ids));
      for (const { m, debateTitle, debateOrg, agentOrg, agentName } of rows) {
        out.set(m.id, { title: `${agentName ?? 'System'} in “${debateTitle}” (round ${m.round})`, excerpt: clip(m.content), link: `/app/debates/${m.debateId}`, moderation: m.moderation, createdAt: m.createdAt, orgIds: uniq([agentOrg ?? debateOrg]) });
      }
      break;
    }
    case 'hive_lesson': {
      const rows = await db().select().from(s.hiveLessons).where(inArray(s.hiveLessons.id, ids));
      const agentIds = uniq(rows.flatMap((r) => r.agentIds ?? []));
      const owners = agentIds.length ? await db().select({ id: s.agents.id, orgId: s.agents.orgId }).from(s.agents).where(inArray(s.agents.id, agentIds)) : [];
      const orgOf = new Map(owners.map((o) => [o.id, o.orgId]));
      for (const r of rows) out.set(r.id, { title: r.title, excerpt: clip(r.content), link: '/app/hive', moderation: r.moderation, createdAt: r.createdAt, orgIds: uniq((r.agentIds ?? []).map((a) => orgOf.get(a))) });
      break;
    }
    case 'verdict': {
      const rows = await db().select({ v: s.knowledgeVerdicts, agentName: s.agents.name }).from(s.knowledgeVerdicts)
        .innerJoin(s.agents, eq(s.agents.id, s.knowledgeVerdicts.agentId)).where(inArray(s.knowledgeVerdicts.id, ids));
      for (const { v, agentName } of rows) out.set(v.id, { title: `${agentName} ${v.verdict === 'confirm' ? 'confirmed' : 'disputed'} a ${v.targetType.replace('_', ' ')}`, excerpt: clip(v.note), link: '/app/hive', moderation: v.moderation, createdAt: v.createdAt, orgIds: [v.orgId] });
      break;
    }
  }
  return out;
}

async function setModeration(type: Removable, id: string, value: 'visible' | 'removed'): Promise<boolean> {
  const s = schema;
  const r = type === 'session' ? await db().update(s.trainingSessions).set({ moderation: value, updatedAt: new Date() }).where(eq(s.trainingSessions.id, id)).returning({ id: s.trainingSessions.id })
    : type === 'debate' ? await db().update(s.debates).set({ moderation: value, updatedAt: new Date() }).where(eq(s.debates.id, id)).returning({ id: s.debates.id })
    : type === 'debate_message' ? await db().update(s.debateMessages).set({ moderation: value }).where(eq(s.debateMessages.id, id)).returning({ id: s.debateMessages.id })
    : type === 'hive_lesson' ? await db().update(s.hiveLessons).set({ moderation: value }).where(eq(s.hiveLessons.id, id)).returning({ id: s.hiveLessons.id })
    : await db().update(s.knowledgeVerdicts).set({ moderation: value }).where(eq(s.knowledgeVerdicts.id, id)).returning({ id: s.knowledgeVerdicts.id });
  return r.length > 0;
}

/**
 * Remove (or restore) a piece of social content. Removal resolves every open report on it, notifies the owning
 * organisation(s) ('content_removed') and is audited. Idempotent: removing removed content only resolves reports.
 */
export async function moderateContent(req: FastifyRequest, type: Removable, id: string, op: 'remove' | 'restore', note?: string) {
  const me = actor(req);
  const info = (await contentInfo(type, [id])).get(id);
  if (!info) throw notFound(LABEL[type] ?? 'Content');
  const target = op === 'remove' ? 'removed' : 'visible';
  const changed = info.moderation !== target;
  if (changed) await setModeration(type, id, target);
  let reportsResolved = 0;
  if (op === 'remove') {
    const r = await db().update(schema.reports).set({ status: 'actioned', resolvedBy: me.user.id })
      .where(and(eq(schema.reports.targetType, type), eq(schema.reports.targetId, id), eq(schema.reports.status, 'open'))).returning({ id: schema.reports.id });
    reportsResolved = r.length;
  }
  if (changed) {
    const what = LABEL[type] ?? 'content';
    for (const orgId of info.orgIds) {
      if (op === 'remove') {
        await notifyOrg(orgId, 'content_removed', `A ${what} was removed by Hive Mind moderators`,
          `“${clip(info.title, 120)}” was removed for breaking the community rules.${note ? ` Moderator note: ${clip(note, 500)}` : ''} Contact support if you think this is a mistake.`, '/app/support');
      } else {
        await notifyOrg(orgId, 'system', `A ${what} was restored`, `“${clip(info.title, 120)}” is visible again after moderator review.${note ? ` Note: ${clip(note, 500)}` : ''}`, info.link ?? undefined);
      }
    }
  }
  await adminAudit(req, op === 'remove' ? 'content.remove' : 'content.restore', type, id, { note: note ?? null, changed, reportsResolved, notifiedOrgs: changed ? info.orgIds.length : 0 }, info.orgIds[0] ?? null);
  return { type, id, moderation: target, changed, reportsResolved };
}

const ContentParams = z.object({ type: z.enum(REMOVABLE_TYPES), id: z.string().uuid() });
const REPORT_TYPES = ['agent', 'listing', 'knowledge', 'review', 'user', ...REMOVABLE_TYPES] as const;

export default async function moderation(app: FastifyInstance) {
  /* ───────────── Reports ───────────── */
  app.get('/reports', async (req) => {
    const q = parse(PageQuery.extend({ status: z.enum(['open', 'actioned', 'dismissed']).optional(), targetType: z.enum(REPORT_TYPES).optional() }), req.query);
    const conds: SQL[] = [];
    if (q.status) conds.push(eq(schema.reports.status, q.status));
    if (q.targetType) conds.push(eq(schema.reports.targetType, q.targetType));
    const where = conds.length ? and(...conds) : undefined;
    const [{ total }] = await db().select({ total: count() }).from(schema.reports).where(where);
    const rows = await db().select({ r: schema.reports, reporter: schema.users.email }).from(schema.reports)
      .innerJoin(schema.users, eq(schema.users.id, schema.reports.reporterId))
      .where(where).orderBy(desc(schema.reports.createdAt)).limit(q.pageSize).offset(offset(q));
    // previews, batched per target type
    const byType = new Map<string, string[]>();
    for (const { r } of rows) byType.set(r.targetType, [...(byType.get(r.targetType) ?? []), r.targetId]);
    const previews = new Map<string, ContentInfo>();
    for (const [t, ids] of byType) for (const [id, info] of await contentInfo(t, uniq(ids))) previews.set(`${t}:${id}`, info);
    return {
      items: rows.map(({ r, reporter }) => {
        const p = previews.get(`${r.targetType}:${r.targetId}`);
        return {
          ...r, reporterEmail: reporter, removable: isRemovable(r.targetType),
          target: p ? { title: p.title, excerpt: p.excerpt, link: p.link, moderation: p.moderation } : null,
          targetName: p?.title ?? null,
        };
      }),
      total: Number(total), page: q.page, pageSize: q.pageSize,
    };
  });

  app.post('/reports/:id/resolve', async (req) => {
    const me = actor(req);
    const { id } = parse(IdParam, req.params);
    const { action, note } = parse(z.object({ action: z.enum(['dismiss', 'hide_target', 'remove_content', 'suspend_agent']), note: z.string().max(1000).optional() }), req.body);
    const [r] = await db().select().from(schema.reports).where(eq(schema.reports.id, id)).limit(1);
    if (!r) throw notFound('Report');
    if (action === 'remove_content' || (action === 'hide_target' && isRemovable(r.targetType))) {
      if (!isRemovable(r.targetType)) throw badRequest(`A ${r.targetType} cannot be removed this way; use "hide_target".`);
      const out = await moderateContent(req, r.targetType, r.targetId, 'remove', note ?? `Report: ${r.reason}`);
      const [upd] = await db().select().from(schema.reports).where(eq(schema.reports.id, id)).limit(1);
      await adminAudit(req, 'report.resolve', 'report', id, { action: 'remove_content', note, targetType: r.targetType, targetId: r.targetId, reportsResolved: out.reportsResolved });
      return upd;
    }
    if (action === 'hide_target') {
      switch (r.targetType) {
        case 'agent': await db().update(schema.agents).set({ isPublic: false, updatedAt: new Date() }).where(eq(schema.agents.id, r.targetId)); break;
        case 'listing': await db().update(schema.marketplaceListings).set({ moderation: 'hidden', updatedAt: new Date() }).where(eq(schema.marketplaceListings.id, r.targetId)); break;
        case 'knowledge': await db().update(schema.knowledgeListings).set({ moderation: 'hidden', updatedAt: new Date() }).where(eq(schema.knowledgeListings.id, r.targetId)); break;
        case 'review': {
          const [rv] = await db().update(schema.reviews).set({ status: 'hidden' }).where(eq(schema.reviews.id, r.targetId)).returning();
          if (rv) await recomputeReputation(rv.agentId);
          break;
        }
        default: throw badRequest(`Cannot hide a ${r.targetType}; suspend the user via /admin/users instead.`);
      }
    } else if (action === 'suspend_agent') {
      let agentId: string | null = null;
      if (r.targetType === 'agent') agentId = r.targetId;
      else if (r.targetType === 'listing') agentId = (await db().select().from(schema.marketplaceListings).where(eq(schema.marketplaceListings.id, r.targetId)).limit(1))[0]?.agentId ?? null;
      else if (r.targetType === 'review') agentId = (await db().select().from(schema.reviews).where(eq(schema.reviews.id, r.targetId)).limit(1))[0]?.agentId ?? null;
      if (!agentId) throw badRequest('This report does not reference an agent.');
      await suspendAgent(agentId, `Report: ${r.reason}`);
    }
    const [upd] = await db().update(schema.reports).set({ status: action === 'dismiss' ? 'dismissed' : 'actioned', resolvedBy: me.user.id }).where(eq(schema.reports.id, id)).returning();
    await adminAudit(req, 'report.resolve', 'report', id, { action, note, targetType: r.targetType, targetId: r.targetId });
    return upd;
  });

  /* ───────────── Social content: remove / restore ───────────── */
  app.post('/content/:type/:id/remove', async (req) => {
    const { type, id } = parse(ContentParams, req.params);
    const { note } = parse(z.object({ note: z.string().trim().max(1000).optional() }), req.body ?? {});
    return moderateContent(req, type, id, 'remove', note);
  });

  app.post('/content/:type/:id/restore', async (req) => {
    const { type, id } = parse(ContentParams, req.params);
    const { note } = parse(z.object({ note: z.string().trim().max(1000).optional() }), req.body ?? {});
    return moderateContent(req, type, id, 'restore', note);
  });

  /** Removed social content (newest first), so admins can review and restore. */
  app.get('/content/removed', async (req) => {
    const q = parse(PageQuery.extend({ type: z.enum(REMOVABLE_TYPES).optional() }), req.query);
    const s = schema;
    const types = q.type ? [q.type] : [...REMOVABLE_TYPES];
    const CAP = 500;
    const idsOf = async (t: Removable): Promise<string[]> => {
      const rows = t === 'session' ? await db().select({ id: s.trainingSessions.id }).from(s.trainingSessions).where(eq(s.trainingSessions.moderation, 'removed')).orderBy(desc(s.trainingSessions.updatedAt)).limit(CAP)
        : t === 'debate' ? await db().select({ id: s.debates.id }).from(s.debates).where(eq(s.debates.moderation, 'removed')).orderBy(desc(s.debates.updatedAt)).limit(CAP)
        : t === 'debate_message' ? await db().select({ id: s.debateMessages.id }).from(s.debateMessages).where(eq(s.debateMessages.moderation, 'removed')).orderBy(desc(s.debateMessages.createdAt)).limit(CAP)
        : t === 'hive_lesson' ? await db().select({ id: s.hiveLessons.id }).from(s.hiveLessons).where(eq(s.hiveLessons.moderation, 'removed')).orderBy(desc(s.hiveLessons.createdAt)).limit(CAP)
        : await db().select({ id: s.knowledgeVerdicts.id }).from(s.knowledgeVerdicts).where(eq(s.knowledgeVerdicts.moderation, 'removed')).orderBy(desc(s.knowledgeVerdicts.createdAt)).limit(CAP);
      return rows.map((r) => r.id);
    };
    const all: { type: Removable; id: string; info: ContentInfo }[] = [];
    for (const t of types) for (const [id, info] of await contentInfo(t, await idsOf(t))) all.push({ type: t, id, info });
    all.sort((a, b) => (b.info.createdAt?.getTime() ?? 0) - (a.info.createdAt?.getTime() ?? 0));
    const page = all.slice(offset(q), offset(q) + q.pageSize);
    return {
      items: page.map(({ type, id, info }) => ({ id, key: `${type}:${id}`, targetType: type, title: info.title, excerpt: info.excerpt, link: info.link, moderation: info.moderation, createdAt: info.createdAt })),
      total: all.length, page: q.page, pageSize: q.pageSize,
    };
  });

  /* ───────────── Knowledge listings ───────────── */
  app.get('/knowledge-listings', async (req) => {
    const q = parse(PageQuery.extend({ moderation: z.enum(['visible', 'hidden', 'under_review']).optional() }), req.query);
    const where = q.moderation ? eq(schema.knowledgeListings.moderation, q.moderation) : undefined;
    const [{ total }] = await db().select({ total: count() }).from(schema.knowledgeListings).where(where);
    const rows = await db().select({ l: schema.knowledgeListings, orgName: schema.organisations.name, sourceName: schema.knowledgeSources.name })
      .from(schema.knowledgeListings)
      .innerJoin(schema.organisations, eq(schema.organisations.id, schema.knowledgeListings.orgId))
      .innerJoin(schema.knowledgeSources, eq(schema.knowledgeSources.id, schema.knowledgeListings.sourceId))
      .where(where).orderBy(desc(schema.knowledgeListings.createdAt)).limit(q.pageSize).offset(offset(q));
    return { items: rows.map(({ l, orgName, sourceName }) => ({ ...l, orgName, sourceName })), total: Number(total), page: q.page, pageSize: q.pageSize };
  });

  app.post('/knowledge-listings/:id/moderate', async (req) => {
    const { id } = parse(IdParam, req.params);
    const body = parse(z.object({ decision: z.enum(['approve', 'reject']), qualityScore: z.number().min(0).max(100).optional(), note: z.string().max(1000).optional() }), req.body);
    const [l] = await db().select().from(schema.knowledgeListings).where(eq(schema.knowledgeListings.id, id)).limit(1);
    if (!l) throw notFound('Knowledge listing');
    if (body.decision === 'approve' && body.qualityScore == null && l.qualityScore == null) throw badRequest('qualityScore is required when approving');
    const [upd] = await db().update(schema.knowledgeListings).set(body.decision === 'approve'
      ? { verificationStatus: 'verified', moderation: 'visible', qualityScore: body.qualityScore ?? l.qualityScore, updatedAt: new Date() }
      : { verificationStatus: 'rejected', moderation: 'hidden', updatedAt: new Date() }).where(eq(schema.knowledgeListings.id, id)).returning();
    const [src] = await db().select().from(schema.knowledgeSources).where(eq(schema.knowledgeSources.id, l.sourceId)).limit(1);
    if (src?.agentId) await recomputeReputation(src.agentId);
    await notify(l.contributorId, 'system', `Knowledge listing ${body.decision === 'approve' ? 'approved' : 'rejected'}: ${l.title}`, body.note ?? '', '/knowledge-exchange/mine');
    await adminAudit(req, 'knowledge_listing.moderate', 'knowledge_listing', id, body, l.orgId);
    return upd;
  });

  /* ───────────── Training listings ───────────── */
  app.get('/listings', async (req) => {
    const q = parse(PageQuery.extend({ moderation: z.enum(['visible', 'hidden', 'under_review']).optional(), status: z.string().optional() }), req.query);
    const conds: SQL[] = [];
    if (q.moderation) conds.push(eq(schema.marketplaceListings.moderation, q.moderation));
    if (q.status) conds.push(eq(schema.marketplaceListings.status, q.status));
    const where = conds.length ? and(...conds) : undefined;
    const [{ total }] = await db().select({ total: count() }).from(schema.marketplaceListings).where(where);
    const items = await db().select().from(schema.marketplaceListings).where(where).orderBy(desc(schema.marketplaceListings.createdAt)).limit(q.pageSize).offset(offset(q));
    return { items, total: Number(total), page: q.page, pageSize: q.pageSize };
  });

  app.post('/listings/:id/moderate', async (req) => {
    const { id } = parse(IdParam, req.params);
    const raw = parse(z.object({ decision: z.enum(['visible', 'hidden', 'under_review', 'approve', 'reject']), note: z.string().max(1000).optional() }), req.body);
    const moderationState = raw.decision === 'approve' ? 'visible' : raw.decision === 'reject' ? 'hidden' : raw.decision;
    const [l] = await db().update(schema.marketplaceListings).set({ moderation: moderationState, updatedAt: new Date() }).where(eq(schema.marketplaceListings.id, id)).returning();
    if (!l) throw notFound('Listing');
    await adminAudit(req, 'listing.moderate', 'marketplace_listing', id, { moderation: moderationState, note: raw.note }, l.orgId);
    return l;
  });
}
