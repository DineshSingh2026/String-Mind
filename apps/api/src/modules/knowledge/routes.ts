/**
 * Knowledge module: knowledge sources + documents (RAG ingestion), search, learning artefacts,
 * agent memories and learning records. See docs/API.md#knowledge.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, count, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db/client.js';
import { requirePerm } from '../../lib/auth.js';
import { audit } from '../../lib/audit.js';
import { badRequest, notFound, unprocessable } from '../../lib/errors.js';
import { PageQuery, offset, parse } from '../../lib/http.js';
import { getOwnedAgent } from '../../lib/tenancy.js';
import { registerJob } from '../../jobs/queue.js';
import { searchChunks, accessibleSourceIds } from '../../engine/context.js';
import {
  createDocument, deleteDocument, extractText, ingestDocument, orgAccessibleSourceIds, resolveMime, sourcesByIds,
} from '../../engine/rag.js';
import { decideArtefact } from '../../engine/training.js';
import { verdictCounts } from '../hive-learning/verdicts.js';
import { rankScore } from '../hive-learning/rank.js';

const SourceBody = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(4000).default(''),
  type: z.enum(['upload', 'text', 'url', 'trainer_shared', 'licensed', 'dataset']).default('upload'),
  visibility: z.enum(['private', 'org', 'marketplace', 'public']).default('private'),
  domainSlug: z.string().optional(),
  agentId: z.string().uuid().optional(),
  licence: z.string().trim().min(1).max(200).default('proprietary'),
  ownershipAttested: z.boolean().default(false),
});

const TextDocBody = z.object({ title: z.string().trim().min(1).max(300), text: z.string().min(1).max(5_000_000) });

const SearchBody = z.object({
  query: z.string().trim().min(1).max(2000),
  agentId: z.string().uuid().optional(),
  sourceIds: z.array(z.string().uuid()).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(8),
});

const AgentQuery = PageQuery.extend({ agentId: z.string().uuid().optional() });

async function ownSource(id: string, orgId: string) {
  const [s] = await db().select().from(schema.knowledgeSources)
    .where(and(eq(schema.knowledgeSources.id, id), eq(schema.knowledgeSources.orgId, orgId))).limit(1);
  if (!s) throw notFound('Knowledge source');
  return s;
}

async function readUpload(req: FastifyRequest): Promise<{ title: string; mimeType: string; raw: Buffer; text: string }> {
  if (req.isMultipart()) {
    const file = await req.file();
    if (!file) throw badRequest('No file uploaded');
    const mimeType = resolveMime(file.filename, file.mimetype);
    if (!mimeType) throw unprocessable('Unsupported file type. Supported: .txt, .md, .csv, .json, .pdf');
    const raw = await file.toBuffer();
    const titleField = file.fields?.title as { value?: unknown } | undefined;
    const title = typeof titleField?.value === 'string' && titleField.value.trim() ? titleField.value.trim() : file.filename;
    return { title, mimeType, raw, text: extractText(raw, mimeType) };
  }
  const body = parse(TextDocBody, req.body);
  return { title: body.title, mimeType: 'text/plain', raw: Buffer.from(body.text, 'utf8'), text: body.text };
}

function publicDoc(d: typeof schema.knowledgeDocuments.$inferSelect) {
  const { storagePath: _p, ...rest } = d;
  return rest;
}

export default async function routes(app: FastifyInstance) {
  /* ───── sources ───── */
  app.get('/sources', async (req) => {
    const a = requirePerm(req, 'knowledge.read');
    const q = parse(PageQuery, req.query);
    const ids = await orgAccessibleSourceIds(a.orgId);
    if (!ids.length) return { items: [], total: 0, page: q.page, pageSize: q.pageSize };
    const where = inArray(schema.knowledgeSources.id, ids);
    const rows = await db().select().from(schema.knowledgeSources).where(where)
      .orderBy(desc(schema.knowledgeSources.createdAt)).limit(q.pageSize).offset(offset(q));
    const [{ n }] = await db().select({ n: count() }).from(schema.knowledgeSources).where(where);
    const docCounts = rows.length ? await db().select({ sourceId: schema.knowledgeDocuments.sourceId, n: count() })
      .from(schema.knowledgeDocuments).where(inArray(schema.knowledgeDocuments.sourceId, rows.map((r) => r.id)))
      .groupBy(schema.knowledgeDocuments.sourceId) : [];
    const dc = new Map(docCounts.map((d) => [d.sourceId, d.n]));
    return {
      items: rows.map((s) => ({ ...s, documentCount: dc.get(s.id) ?? 0, access: s.orgId === a.orgId ? 'owner' : s.visibility === 'public' ? 'public' : 'licensed' })),
      total: n, page: q.page, pageSize: q.pageSize,
    };
  });

  app.post('/sources', async (req, reply) => {
    const a = requirePerm(req, 'knowledge.write');
    const body = parse(SourceBody, req.body);
    let domainId: string | null = null;
    if (body.domainSlug) {
      const [d] = await db().select().from(schema.capabilityDomains).where(eq(schema.capabilityDomains.slug, body.domainSlug)).limit(1);
      if (!d) throw badRequest(`Unknown domain: ${body.domainSlug}`);
      domainId = d.id;
    }
    if (body.agentId) await getOwnedAgent(body.agentId, a.orgId);
    if ((body.visibility === 'marketplace' || body.visibility === 'public') && !body.ownershipAttested) {
      throw badRequest('You must attest ownership/licence rights before sharing knowledge beyond your organisation');
    }
    const [s] = await db().insert(schema.knowledgeSources).values({
      orgId: a.orgId, ownerId: a.user.id, agentId: body.agentId ?? null, name: body.name, description: body.description,
      type: body.type, visibility: body.visibility, domainId, licence: body.licence, ownershipAttested: body.ownershipAttested,
    }).returning();
    await audit({ action: 'knowledge.source.create', targetType: 'knowledge_source', targetId: s!.id }, req);
    return reply.status(201).send(s);
  });

  /* ───── documents ───── */
  app.post('/sources/:id/documents', async (req, reply) => {
    const a = requirePerm(req, 'knowledge.write');
    const { id } = req.params as { id: string };
    const source = await ownSource(id, a.orgId);
    const up = await readUpload(req);
    const doc = await createDocument({ source, title: up.title, mimeType: up.mimeType, raw: up.raw, text: up.text, uploadedBy: a.user.id });
    await audit({ action: 'knowledge.document.create', targetType: 'knowledge_document', targetId: doc.id, metadata: { sourceId: source.id, sizeBytes: doc.sizeBytes } }, req);
    return reply.status(doc.status === 'processing' ? 202 : 201).send(publicDoc(doc));
  });

  app.get('/sources/:id/documents', async (req) => {
    const a = requirePerm(req, 'knowledge.read');
    const { id } = req.params as { id: string };
    const q = parse(PageQuery, req.query);
    await ownSource(id, a.orgId);
    const where = eq(schema.knowledgeDocuments.sourceId, id);
    const rows = await db().select().from(schema.knowledgeDocuments).where(where)
      .orderBy(desc(schema.knowledgeDocuments.createdAt)).limit(q.pageSize).offset(offset(q));
    const [{ n }] = await db().select({ n: count() }).from(schema.knowledgeDocuments).where(where);
    return { items: rows.map(publicDoc), total: n, page: q.page, pageSize: q.pageSize };
  });

  app.delete('/documents/:id', async (req, reply) => {
    const a = requirePerm(req, 'knowledge.write');
    const { id } = req.params as { id: string };
    const [d] = await db().select().from(schema.knowledgeDocuments)
      .where(and(eq(schema.knowledgeDocuments.id, id), eq(schema.knowledgeDocuments.orgId, a.orgId))).limit(1);
    if (!d) throw notFound('Document');
    await deleteDocument(d);
    await audit({ action: 'knowledge.document.delete', targetType: 'knowledge_document', targetId: id }, req);
    return reply.status(204).send();
  });

  /* ───── search ───── */
  app.post('/search', async (req) => {
    const a = requirePerm(req, 'knowledge.read');
    const body = parse(SearchBody, req.body);
    let allowed: string[];
    if (body.agentId) {
      await getOwnedAgent(body.agentId, a.orgId);
      allowed = await accessibleSourceIds(body.agentId);
    } else {
      allowed = await orgAccessibleSourceIds(a.orgId);
    }
    if (body.sourceIds) { const want = new Set(body.sourceIds); allowed = allowed.filter((s) => want.has(s)); }
    if (!allowed.length) return [];
    const hits = await searchChunks(body.query, allowed, body.limit);
    const sources = new Map((await sourcesByIds([...new Set(hits.map((h) => h.source_id))])).map((s) => [s.id, s]));
    return hits.map((h) => ({
      chunkId: h.id, content: h.content, score: Math.round(h.score * 1000) / 1000,
      document: { id: h.document_id, title: h.title },
      source: { id: h.source_id, name: sources.get(h.source_id)?.name ?? '' },
    }));
  });

  /* ───── the hive map ───── */
  /**
   * Everything the viewer may see in the hive, as a graph: their organisation's lessons (learning
   * artefacts, any status), verified public knowledge listings, and lessons the Hive learned automatically
   * from public rooms and debates (hive_lessons, content may be shown: they come from public sources).
   * Items are grouped by domain; links join lessons that share an agent. Every node carries real
   * confirm/dispute counts and a rankScore (see modules/hive-learning/rank.ts). Artefact content is never
   * returned here — titles only.
   */
  app.get('/hive', async (req) => {
    const a = requirePerm(req, 'knowledge.read');
    const d = db();
    const domains = await d.select({ id: schema.capabilityDomains.id, slug: schema.capabilityDomains.slug, name: schema.capabilityDomains.name })
      .from(schema.capabilityDomains);
    const dom = new Map(domains.map((x) => [x.id, x]));
    const lessons = await d.select({
      id: schema.learningArtefacts.id, title: schema.learningArtefacts.title, status: schema.learningArtefacts.status,
      learningType: schema.learningArtefacts.learningType, domainId: schema.learningArtefacts.domainId,
      learnerAgentId: schema.learningArtefacts.learnerAgentId, trainerAgentId: schema.learningArtefacts.trainerAgentId,
      sessionId: schema.learningArtefacts.sessionId, createdAt: schema.learningArtefacts.createdAt,
    }).from(schema.learningArtefacts).where(eq(schema.learningArtefacts.orgId, a.orgId))
      .orderBy(desc(schema.learningArtefacts.createdAt)).limit(300);
    const listings = await d.select({
      id: schema.knowledgeListings.id, title: schema.knowledgeListings.title, domainId: schema.knowledgeListings.domainId,
      qualityScore: schema.knowledgeListings.qualityScore, orgId: schema.knowledgeListings.orgId, createdAt: schema.knowledgeListings.createdAt,
    }).from(schema.knowledgeListings).where(and(
      eq(schema.knowledgeListings.moderation, 'visible'), eq(schema.knowledgeListings.verificationStatus, 'verified'), eq(schema.knowledgeListings.status, 'active'),
    )).orderBy(desc(schema.knowledgeListings.createdAt)).limit(200);
    const hive = await d.select().from(schema.hiveLessons).where(eq(schema.hiveLessons.moderation, 'visible'))
      .orderBy(desc(schema.hiveLessons.createdAt)).limit(300);
    const agentIds = [...new Set([...lessons.flatMap((l) => [l.learnerAgentId, l.trainerAgentId]), ...hive.flatMap((h) => h.agentIds)].filter((x): x is string => !!x))];
    const agents = agentIds.length ? await d.select({ id: schema.agents.id, name: schema.agents.name, orgId: schema.agents.orgId }).from(schema.agents).where(inArray(schema.agents.id, agentIds)) : [];
    const agentName = new Map(agents.map((x) => [x.id, x.name]));
    const agentOrg = new Map(agents.map((x) => [x.id, x.orgId]));
    const [artefactCounts, listingCounts] = await Promise.all([
      verdictCounts('artefact', lessons.filter((l) => l.status === 'approved' || l.status === 'applied').map((l) => l.id)),
      verdictCounts('listing', listings.map((k) => k.id)),
    ]);
    const zero = { confirmCount: 0, disputeCount: 0 };
    const counted = (c: { confirmCount: number; disputeCount: number }, createdAt: Date) => ({ ...c, rankScore: rankScore({ ...c, createdAt }) });

    const nodes = [
      ...lessons.map((l) => ({
        id: l.id, kind: 'lesson' as const, title: l.title, status: l.status, learningType: l.learningType,
        domain: l.domainId ? dom.get(l.domainId)?.slug ?? null : null,
        agentId: l.trainerAgentId ?? l.learnerAgentId, learnerAgentId: l.learnerAgentId, trainerAgentId: l.trainerAgentId,
        learner: agentName.get(l.learnerAgentId) ?? null, trainer: l.trainerAgentId ? agentName.get(l.trainerAgentId) ?? null : null,
        sessionId: l.sessionId, createdAt: l.createdAt, mine: true,
        ...counted(artefactCounts.get(l.id) ?? zero, l.createdAt),
      })),
      ...listings.map((k) => ({
        id: k.id, kind: 'knowledge' as const, title: k.title, status: 'verified', learningType: null,
        domain: k.domainId ? dom.get(k.domainId)?.slug ?? null : null,
        agentId: null, learnerAgentId: null, trainerAgentId: null, learner: null, trainer: null,
        sessionId: null, createdAt: k.createdAt, qualityScore: k.qualityScore, mine: k.orgId === a.orgId,
        ...counted(listingCounts.get(k.id) ?? zero, k.createdAt),
      })),
      ...hive.map((h) => ({
        id: h.id, kind: 'hive' as const, title: h.title, status: 'learned', learningType: null,
        domain: h.domainId ? dom.get(h.domainId)?.slug ?? null : null,
        agentId: h.agentIds[0] ?? null, learnerAgentId: null, trainerAgentId: null, learner: null, trainer: null,
        sessionId: h.sourceType === 'session' ? h.sourceId : null, createdAt: h.createdAt,
        content: h.content, sourceType: h.sourceType, sourceId: h.sourceId,
        agentIds: h.agentIds, agentNames: h.agentIds.map((id) => agentName.get(id)).filter((x): x is string => !!x),
        mine: h.agentIds.some((id) => agentOrg.get(id) === a.orgId),
        ...counted({ confirmCount: h.confirmCount, disputeCount: h.disputeCount }, h.createdAt),
      })),
    ];
    // links: lessons that share a trainer (taught by the same agent) or a learner (kept by the same agent);
    // hive lessons link to each other and to our lessons through any agent they share
    const links: { source: string; target: string; via: 'trainer' | 'learner' | 'agent' }[] = [];
    const seen = new Set<string>();
    const chain = (ids: string[], via: 'trainer' | 'learner' | 'agent') => {
      for (let i = 1; i < ids.length && i < 12; i++) {
        const k = [ids[i - 1], ids[i]].sort().join(':');
        if (!seen.has(k)) { seen.add(k); links.push({ source: ids[i - 1]!, target: ids[i]!, via }); }
      }
    };
    for (const via of ['trainer', 'learner'] as const) {
      const by = new Map<string, string[]>();
      for (const l of lessons) {
        const key = via === 'trainer' ? l.trainerAgentId : l.learnerAgentId;
        if (key) by.set(key, [...(by.get(key) ?? []), l.id]);
      }
      for (const ids of by.values()) chain(ids, via);
    }
    const byAgent = new Map<string, string[]>();
    for (const h of hive) for (const ag of h.agentIds) byAgent.set(ag, [...(byAgent.get(ag) ?? []), h.id]);
    for (const l of lessons) {
      for (const ag of [l.trainerAgentId, l.learnerAgentId]) if (ag && byAgent.has(ag)) byAgent.set(ag, [...byAgent.get(ag)!, l.id]);
    }
    for (const ids of byAgent.values()) if (ids.length > 1) chain([...new Set(ids)], 'agent');
    const usedDomains = [...new Set(nodes.map((n) => n.domain).filter(Boolean))] as string[];
    return {
      domains: usedDomains.map((slug) => ({ slug, name: domains.find((x) => x.slug === slug)?.name ?? slug })),
      nodes, links,
    };
  });

  /* ───── learning artefacts / memories / records ───── */
  app.get('/artefacts', async (req) => {
    const a = requirePerm(req, 'knowledge.read');
    const q = parse(AgentQuery.extend({ status: z.string().optional(), sessionId: z.string().uuid().optional() }), req.query);
    const conds = [eq(schema.learningArtefacts.orgId, a.orgId)];
    if (q.agentId) conds.push(eq(schema.learningArtefacts.learnerAgentId, q.agentId));
    if (q.status) conds.push(eq(schema.learningArtefacts.status, q.status));
    if (q.sessionId) conds.push(eq(schema.learningArtefacts.sessionId, q.sessionId));
    const where = and(...conds);
    const rows = await db().select().from(schema.learningArtefacts).where(where)
      .orderBy(desc(schema.learningArtefacts.createdAt)).limit(q.pageSize).offset(offset(q));
    const [{ n }] = await db().select({ n: count() }).from(schema.learningArtefacts).where(where);
    return { items: rows, total: n, page: q.page, pageSize: q.pageSize };
  });

  app.post('/artefacts/:id/approve', async (req) => {
    const a = requirePerm(req, 'agents.update');
    const { id } = req.params as { id: string };
    return decideArtefact({ artefactId: id, orgId: a.orgId, userId: a.user.id, decision: 'approve' });
  });

  app.post('/artefacts/:id/reject', async (req) => {
    const a = requirePerm(req, 'agents.update');
    const { id } = req.params as { id: string };
    return decideArtefact({ artefactId: id, orgId: a.orgId, userId: a.user.id, decision: 'reject' });
  });

  app.get('/memories', async (req) => {
    const a = requirePerm(req, 'knowledge.read');
    const q = parse(AgentQuery, req.query);
    const conds = [eq(schema.agentMemories.orgId, a.orgId)];
    if (q.agentId) conds.push(eq(schema.agentMemories.agentId, q.agentId));
    const where = and(...conds);
    const rows = await db().select().from(schema.agentMemories).where(where)
      .orderBy(desc(schema.agentMemories.createdAt)).limit(q.pageSize).offset(offset(q));
    const [{ n }] = await db().select({ n: count() }).from(schema.agentMemories).where(where);
    return { items: rows, total: n, page: q.page, pageSize: q.pageSize };
  });

  app.delete('/memories/:id', async (req, reply) => {
    const a = requirePerm(req, 'agents.update');
    const { id } = req.params as { id: string };
    const rows = await db().delete(schema.agentMemories)
      .where(and(eq(schema.agentMemories.id, id), eq(schema.agentMemories.orgId, a.orgId))).returning({ id: schema.agentMemories.id });
    if (!rows.length) throw notFound('Memory');
    await audit({ action: 'knowledge.memory.delete', targetType: 'agent_memory', targetId: id }, req);
    return reply.status(204).send();
  });

  app.get('/learning-records', async (req) => {
    const a = requirePerm(req, 'knowledge.read');
    const q = parse(AgentQuery, req.query);
    const conds = [eq(schema.learningRecords.orgId, a.orgId)];
    if (q.agentId) conds.push(eq(schema.learningRecords.agentId, q.agentId));
    const where = and(...conds);
    const rows = await db().select({ r: schema.learningRecords, domain: { slug: schema.capabilityDomains.slug, name: schema.capabilityDomains.name } })
      .from(schema.learningRecords).innerJoin(schema.capabilityDomains, eq(schema.capabilityDomains.id, schema.learningRecords.domainId))
      .where(where).orderBy(desc(schema.learningRecords.createdAt)).limit(q.pageSize).offset(offset(q));
    const [{ n }] = await db().select({ n: count() }).from(schema.learningRecords).where(where);
    return { items: rows.map((x) => ({ ...x.r, domain: x.domain })), total: n, page: q.page, pageSize: q.pageSize };
  });
}

/** Register background job handlers for this module (called once at startup). */
export function registerJobs() {
  registerJob('knowledge.ingest', async (payload) => { await ingestDocument(String(payload.documentId)); });
}
