/** Agents: CRUD, connections, health, versions, permissions, limits, publish, playground. See docs/API.md#agents. */
import type { FastifyInstance } from 'fastify';
import { and, avg, count, desc, eq, ilike, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db/client.js';
import { invokeAgent } from '../../adapters/index.js';
import { getDailyCallCount } from '../../adapters/usage.js';
import { audit } from '../../lib/audit.js';
import { requirePerm } from '../../lib/auth.js';
import { badRequest, conflict, notFound, unprocessable } from '../../lib/errors.js';
import { PageQuery, offset, parse } from '../../lib/http.js';
import { getOwnedAgent } from '../../lib/tenancy.js';
import { registerJob } from '../../jobs/queue.js';
import {
  ConnectionSchema, DEFAULT_PERMISSIONS, PermissionsSchema, ProfileFields, adapterHttpError, agentView, ensureHealthCheckScheduled,
  getProviderById, getProviderBySlug, healthCheckAll, newAgentSlug, prepareConnection, runHealthCheck, validateKnowledgeSources,
} from './service.js';

const IdParam = z.object({ id: z.string().uuid() });

const CreateBody = z.object({
  name: ProfileFields.name,
  description: ProfileFields.description.default(''),
  avatar: ProfileFields.avatar.optional(),
  providerSlug: z.string().min(1).max(60),
  modelName: ProfileFields.modelName,
  modelVersion: ProfileFields.modelVersion.optional(),
  instructions: ProfileFields.instructions.default(''),
  role: ProfileFields.role.default(''),
  tools: ProfileFields.tools.default([]),
  languages: ProfileFields.languages.default(['en']),
  claimedDomains: ProfileFields.claimedDomains.default([]),
  inputFormats: ProfileFields.inputFormats.optional(),
  outputFormats: ProfileFields.outputFormats.optional(),
  knowledgeSourceIds: ProfileFields.knowledgeSourceIds.default([]),
  connection: ConnectionSchema,
});

const PatchBody = z.object({
  name: ProfileFields.name, description: ProfileFields.description, avatar: ProfileFields.avatar,
  modelName: ProfileFields.modelName, modelVersion: ProfileFields.modelVersion,
  instructions: ProfileFields.instructions, role: ProfileFields.role, tools: ProfileFields.tools,
  languages: ProfileFields.languages, claimedDomains: ProfileFields.claimedDomains,
  inputFormats: ProfileFields.inputFormats, outputFormats: ProfileFields.outputFormats,
  knowledgeSourceIds: ProfileFields.knowledgeSourceIds,
  changeNote: z.string().max(500),
}).partial().strict();

async function loadDetail(agentId: string, orgId: string) {
  const a = await getOwnedAgent(agentId, orgId);
  const provider = await getProviderById(a.providerId);
  const [conn] = await db().select().from(schema.agentConnections).where(eq(schema.agentConnections.agentId, a.id)).limit(1);
  const [rep] = await db().select().from(schema.agentReputation).where(eq(schema.agentReputation.agentId, a.id)).limit(1);
  const [{ versions }] = await db().select({ versions: count() }).from(schema.agentVersions).where(eq(schema.agentVersions.agentId, a.id));
  const caps = await db().select({ c: schema.agentCapabilities, d: schema.capabilityDomains }).from(schema.agentCapabilities)
    .innerJoin(schema.capabilityDomains, eq(schema.capabilityDomains.id, schema.agentCapabilities.domainId))
    .where(eq(schema.agentCapabilities.agentId, a.id));
  const [lr] = await db().select({ n: count(), avgImp: avg(schema.learningRecords.improvement) }).from(schema.learningRecords).where(eq(schema.learningRecords.agentId, a.id));
  const [mem] = await db().select({ n: count() }).from(schema.agentMemories).where(eq(schema.agentMemories.agentId, a.id));
  const [pend] = await db().select({ n: count() }).from(schema.learningArtefacts)
    .where(and(eq(schema.learningArtefacts.learnerAgentId, a.id), eq(schema.learningArtefacts.status, 'pending')));
  return {
    ...agentView(a, provider, conn, rep),
    permissions: { ...DEFAULT_PERMISSIONS, ...a.permissions },
    versionsCount: Number(versions),
    usageToday: { calls: getDailyCallCount(a.id) },
    capabilities: caps.map(({ c, d }) => ({
      domainSlug: d.slug, domainName: d.name, score: c.score, accuracy: c.accuracy, confidence: c.confidence,
      sampleSize: c.sampleSize, verified: c.verified, assessedAt: c.assessedAt,
    })),
    learning: {
      records: Number(lr?.n ?? 0), avgImprovement: lr?.avgImp == null ? null : Number(lr.avgImp),
      memories: Number(mem?.n ?? 0), pendingArtefacts: Number(pend?.n ?? 0),
    },
  };
}

async function hasCompletedAssessment(agentId: string) {
  const [r] = await db().select({ id: schema.capabilityAssessments.id }).from(schema.capabilityAssessments)
    .where(and(eq(schema.capabilityAssessments.agentId, agentId), eq(schema.capabilityAssessments.status, 'completed'))).limit(1);
  return !!r;
}

export default async function routes(app: FastifyInstance) {
  app.addHook('onReady', async () => {
    // schedule the periodic health check (idempotent; no-op if one is queued)
    await ensureHealthCheckScheduled().catch((e) => console.error('[agents] could not schedule health check', e));
  });

  app.get('/providers', async () => {
    const rows = await db().select().from(schema.agentProviders).orderBy(schema.agentProviders.createdAt);
    return rows.filter((p) => p.status !== 'disabled').map((p) => ({
      id: p.id, slug: p.slug, name: p.name, adapter: p.adapter, defaultBaseUrl: p.defaultBaseUrl,
      defaultModels: p.defaultModels, capabilities: p.capabilities, status: p.status, docsUrl: p.docsUrl,
    }));
  });

  app.get('/', async (req) => {
    const a = requirePerm(req, 'agents.read');
    const q = parse(PageQuery.extend({ pageSize: z.coerce.number().int().min(1).max(100).default(50), status: z.string().max(20).optional(), q: z.string().max(100).optional() }), req.query);
    const where = and(eq(schema.agents.orgId, a.orgId), isNull(schema.agents.deletedAt),
      q.status ? eq(schema.agents.status, q.status) : undefined,
      q.q ? ilike(schema.agents.name, `%${q.q.replace(/[%_]/g, '')}%`) : undefined);
    const [{ n }] = await db().select({ n: count() }).from(schema.agents).where(where);
    const rows = await db().select({ a: schema.agents, p: schema.agentProviders, c: schema.agentConnections, r: schema.agentReputation })
      .from(schema.agents)
      .innerJoin(schema.agentProviders, eq(schema.agentProviders.id, schema.agents.providerId))
      .leftJoin(schema.agentConnections, eq(schema.agentConnections.agentId, schema.agents.id))
      .leftJoin(schema.agentReputation, eq(schema.agentReputation.agentId, schema.agents.id))
      .where(where).orderBy(desc(schema.agents.createdAt)).limit(q.pageSize).offset(offset(q));
    return { items: rows.map((r) => agentView(r.a, r.p, r.c, r.r)), total: Number(n), page: q.page, pageSize: q.pageSize };
  });

  app.post('/', async (req, reply) => {
    const a = requirePerm(req, 'agents.create');
    const body = parse(CreateBody, req.body);
    const provider = await getProviderBySlug(body.providerSlug);
    await validateKnowledgeSources(a.orgId, body.knowledgeSourceIds);
    const prepared = await prepareConnection(provider, body.connection);
    const agent = await db().transaction(async (tx) => {
      const [agent] = await tx.insert(schema.agents).values({
        orgId: a.orgId, ownerId: a.user.id, providerId: provider.id, slug: newAgentSlug(body.name), name: body.name,
        description: body.description, avatar: body.avatar ?? null, modelName: body.modelName, modelVersion: body.modelVersion ?? null,
        instructions: body.instructions, role: body.role, tools: body.tools, languages: body.languages, claimedDomains: body.claimedDomains,
        ...(body.inputFormats ? { inputFormats: body.inputFormats } : {}), ...(body.outputFormats ? { outputFormats: body.outputFormats } : {}),
        knowledgeSourceIds: body.knowledgeSourceIds, permissions: { ...DEFAULT_PERMISSIONS }, status: 'draft', currentVersion: 1,
      }).returning();
      await tx.insert(schema.agentVersions).values({
        agentId: agent!.id, version: 1, instructions: body.instructions, role: body.role,
        config: { modelName: body.modelName, modelVersion: body.modelVersion ?? null }, changeNote: 'Initial version', source: 'manual', createdBy: a.user.id,
      });
      await tx.insert(schema.agentConnections).values({ agentId: agent!.id, ...prepared.values, status: 'pending' });
      return agent!;
    });
    await audit({ action: 'agent.create', targetType: 'agent', targetId: agent.id, metadata: { provider: provider.slug, method: body.connection.method } }, req);
    const detail = await loadDetail(agent.id, a.orgId);
    return reply.status(201).send({ ...detail, ...(prepared.webhookSecret ? { webhookSecret: prepared.webhookSecret } : {}) });
  });

  app.get('/:id', async (req) => {
    const a = requirePerm(req, 'agents.read');
    const { id } = parse(IdParam, req.params);
    return loadDetail(id, a.orgId);
  });

  app.patch('/:id', async (req) => {
    const a = requirePerm(req, 'agents.update');
    const { id } = parse(IdParam, req.params);
    const body = parse(PatchBody, req.body);
    const agent = await getOwnedAgent(id, a.orgId);
    const { changeNote, ...fields } = body;
    if (!Object.keys(fields).length) throw badRequest('Nothing to update');
    if (fields.knowledgeSourceIds) await validateKnowledgeSources(a.orgId, fields.knowledgeSourceIds);
    const instructionsChanged = (fields.instructions !== undefined && fields.instructions !== agent.instructions)
      || (fields.role !== undefined && fields.role !== agent.role);
    await db().transaction(async (tx) => {
      let currentVersion = agent.currentVersion;
      if (instructionsChanged) {
        const [last] = await tx.select({ v: schema.agentVersions.version }).from(schema.agentVersions)
          .where(eq(schema.agentVersions.agentId, id)).orderBy(desc(schema.agentVersions.version)).limit(1);
        currentVersion = (last?.v ?? 0) + 1;
        await tx.insert(schema.agentVersions).values({
          agentId: id, version: currentVersion, instructions: fields.instructions ?? agent.instructions, role: fields.role ?? agent.role,
          config: { modelName: fields.modelName ?? agent.modelName, modelVersion: fields.modelVersion ?? agent.modelVersion },
          changeNote: changeNote ?? '', source: 'manual', createdBy: a.user.id,
        });
      }
      await tx.update(schema.agents).set({ ...fields, currentVersion, updatedAt: new Date() }).where(eq(schema.agents.id, id));
    });
    await audit({ action: 'agent.update', targetType: 'agent', targetId: id, metadata: { fields: Object.keys(fields), newVersion: instructionsChanged } }, req);
    return loadDetail(id, a.orgId);
  });

  app.delete('/:id', async (req, reply) => {
    const a = requirePerm(req, 'agents.delete');
    const { id } = parse(IdParam, req.params);
    await getOwnedAgent(id, a.orgId);
    const now = new Date();
    await db().update(schema.agents).set({ deletedAt: now, isPublic: false, updatedAt: now }).where(eq(schema.agents.id, id));
    await db().update(schema.agentConnections).set({ credentialEnc: null, credentialLast4: null, webhookSecretEnc: null, status: 'disconnected', updatedAt: now })
      .where(eq(schema.agentConnections.agentId, id));
    await audit({ action: 'agent.delete', targetType: 'agent', targetId: id }, req);
    return reply.status(204).send();
  });

  app.post('/:id/connection', async (req) => {
    const a = requirePerm(req, 'agents.connect');
    const { id } = parse(IdParam, req.params);
    const body = parse(ConnectionSchema, req.body);
    const agent = await getOwnedAgent(id, a.orgId);
    if (agent.status === 'suspended') throw conflict('Suspended agents cannot be reconnected');
    const provider = await getProviderById(agent.providerId);
    const [existing] = await db().select().from(schema.agentConnections).where(eq(schema.agentConnections.agentId, id)).limit(1);
    const prepared = await prepareConnection(provider, body, existing);
    const now = new Date();
    if (existing) {
      await db().update(schema.agentConnections).set({ ...prepared.values, status: 'pending', lastError: null, updatedAt: now }).where(eq(schema.agentConnections.id, existing.id));
    } else {
      await db().insert(schema.agentConnections).values({ agentId: id, ...prepared.values, status: 'pending' });
    }
    await db().update(schema.agents).set({ health: 'unknown', status: agent.status === 'disconnected' ? 'draft' : agent.status, updatedAt: now }).where(eq(schema.agents.id, id));
    await audit({ action: 'agent.connection_update', targetType: 'agent', targetId: id, metadata: { method: body.method, credentialRotated: !!body.apiKey } }, req);
    const detail = await loadDetail(id, a.orgId);
    return { ...detail, ...(prepared.webhookSecret ? { webhookSecret: prepared.webhookSecret } : {}) };
  });

  app.post('/:id/test', async (req) => {
    const a = requirePerm(req, 'agents.connect');
    const { id } = parse(IdParam, req.params);
    const agent = await getOwnedAgent(id, a.orgId);
    if (agent.status === 'suspended') throw conflict('Agent is suspended');
    const r = await runHealthCheck(id, { source: 'manual' });
    await audit({ action: 'agent.test', targetType: 'agent', targetId: id, metadata: { ok: r.ok, latencyMs: r.latencyMs, errorKind: r.kind ?? null } }, req);
    return { ok: r.ok, latencyMs: r.latencyMs, ...(r.error ? { error: r.error, errorKind: r.kind ?? null } : {}), ...(r.sample !== undefined ? { sample: r.sample } : {}) };
  });

  app.post('/:id/disconnect', async (req) => {
    const a = requirePerm(req, 'agents.connect');
    const { id } = parse(IdParam, req.params);
    const agent = await getOwnedAgent(id, a.orgId);
    const now = new Date();
    await db().update(schema.agentConnections).set({ credentialEnc: null, credentialLast4: null, webhookSecretEnc: null, status: 'disconnected', updatedAt: now })
      .where(eq(schema.agentConnections.agentId, id));
    await db().update(schema.agents).set({ status: agent.status === 'suspended' ? 'suspended' : 'disconnected', health: 'unknown', updatedAt: now }).where(eq(schema.agents.id, id));
    await audit({ action: 'agent.disconnect', targetType: 'agent', targetId: id }, req);
    return loadDetail(id, a.orgId);
  });

  app.get('/:id/versions', async (req) => {
    const a = requirePerm(req, 'agents.read');
    const { id } = parse(IdParam, req.params);
    const agent = await getOwnedAgent(id, a.orgId);
    const rows = await db().select().from(schema.agentVersions).where(eq(schema.agentVersions.agentId, id)).orderBy(desc(schema.agentVersions.version));
    const items = rows.map((v) => ({ ...v, current: v.version === agent.currentVersion }));
    return { items, total: items.length, page: 1, pageSize: items.length };
  });

  app.post('/:id/versions/:version/rollback', async (req) => {
    const a = requirePerm(req, 'agents.update');
    const { id, version } = parse(z.object({ id: z.string().uuid(), version: z.coerce.number().int().min(1) }), req.params);
    const agent = await getOwnedAgent(id, a.orgId);
    const [target] = await db().select().from(schema.agentVersions)
      .where(and(eq(schema.agentVersions.agentId, id), eq(schema.agentVersions.version, version))).limit(1);
    if (!target) throw notFound('Version');
    if (version === agent.currentVersion) throw conflict(`Version ${version} is already the current version`);
    const newVersion = await db().transaction(async (tx) => {
      const [last] = await tx.select({ v: schema.agentVersions.version }).from(schema.agentVersions)
        .where(eq(schema.agentVersions.agentId, id)).orderBy(desc(schema.agentVersions.version)).limit(1);
      const next = (last?.v ?? 0) + 1;
      await tx.insert(schema.agentVersions).values({
        agentId: id, version: next, instructions: target.instructions, role: target.role, config: target.config,
        changeNote: `Rollback to v${version}`, source: 'rollback', createdBy: a.user.id,
      });
      await tx.update(schema.agents).set({ instructions: target.instructions, role: target.role, currentVersion: next, updatedAt: new Date() })
        .where(eq(schema.agents.id, id));
      return next;
    });
    await audit({ action: 'agent.rollback', targetType: 'agent', targetId: id, metadata: { toVersion: version, newVersion } }, req);
    return loadDetail(id, a.orgId);
  });

  app.put('/:id/permissions', async (req) => {
    const a = requirePerm(req, 'agents.update');
    const { id } = parse(IdParam, req.params);
    const perms = parse(PermissionsSchema, req.body);
    const agent = await getOwnedAgent(id, a.orgId);
    // publicProfile mirrors isPublic; turning it on goes through the same rule as publish.
    if (perms.publicProfile && !agent.isPublic && !(await hasCompletedAssessment(id))) {
      throw unprocessable('A public profile requires at least one completed capability assessment');
    }
    await db().update(schema.agents).set({ permissions: perms, isPublic: perms.publicProfile, updatedAt: new Date() }).where(eq(schema.agents.id, id));
    await audit({ action: 'agent.permissions_update', targetType: 'agent', targetId: id, metadata: { permissions: perms } }, req);
    return loadDetail(id, a.orgId);
  });

  app.put('/:id/limits', async (req) => {
    const a = requirePerm(req, 'agents.update');
    const { id } = parse(IdParam, req.params);
    const body = parse(z.object({
      maxCallsPerDay: z.number().int().min(1).max(1_000_000).nullable().optional(),
      maxCreditsPerDay: z.number().int().min(0).max(100_000_000).nullable().optional(),
    }).strict(), req.body);
    await getOwnedAgent(id, a.orgId);
    const limits: { maxCallsPerDay?: number; maxCreditsPerDay?: number } = {};
    if (body.maxCallsPerDay != null) limits.maxCallsPerDay = body.maxCallsPerDay;
    if (body.maxCreditsPerDay != null) limits.maxCreditsPerDay = body.maxCreditsPerDay;
    await db().update(schema.agents).set({ usageLimits: limits, updatedAt: new Date() }).where(eq(schema.agents.id, id));
    await audit({ action: 'agent.limits_update', targetType: 'agent', targetId: id, metadata: limits }, req);
    return loadDetail(id, a.orgId);
  });

  app.post('/:id/publish', async (req) => {
    const a = requirePerm(req, 'marketplace.publish');
    const { id } = parse(IdParam, req.params);
    const { isPublic } = parse(z.object({ isPublic: z.boolean() }), req.body);
    const agent = await getOwnedAgent(id, a.orgId);
    if (isPublic) {
      if (agent.status === 'suspended') throw conflict('Suspended agents cannot be published');
      if (!(await hasCompletedAssessment(id))) throw unprocessable('Run at least one capability assessment before publishing this agent');
    }
    await db().update(schema.agents).set({ isPublic, permissions: { ...DEFAULT_PERMISSIONS, ...agent.permissions, publicProfile: isPublic }, updatedAt: new Date() })
      .where(eq(schema.agents.id, id));
    await audit({ action: isPublic ? 'agent.publish' : 'agent.unpublish', targetType: 'agent', targetId: id }, req);
    return loadDetail(id, a.orgId);
  });

  app.post('/:id/playground', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const a = requirePerm(req, 'agents.update');
    const { id } = parse(IdParam, req.params);
    const body = parse(z.object({
      message: z.string().trim().min(1).max(8000),
      history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(8000) })).max(20).default([]),
    }), req.body);
    await getOwnedAgent(id, a.orgId);
    try {
      const r = await invokeAgent(id, { messages: [...body.history, { role: 'user', content: body.message }], purpose: 'playground' }, { withContext: true });
      return {
        reply: r.text, latencyMs: r.latencyMs, usage: r.usage ?? null,
        context: r.context ? r.context.items.map((i) => ({ kind: i.kind, id: i.id, title: i.title ?? null, score: Math.round(i.score * 1000) / 1000 })) : [],
      };
    } catch (err) {
      throw adapterHttpError(err);
    }
  });
}

/** Register background job handlers for this module (called once at startup). */
export function registerJobs() {
  registerJob('agents.health_check', async () => { await healthCheckAll(); });
}
