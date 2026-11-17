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
