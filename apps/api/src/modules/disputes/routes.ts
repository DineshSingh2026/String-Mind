import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../db/client.js';
import { requirePerm } from '../../lib/auth.js';
import { notFound } from '../../lib/errors.js';
import { PageQuery, offset, parse } from '../../lib/http.js';
import { orgDisputeFilter, raiseDispute } from './service.js';

const sessionCols = { subject: schema.trainingSessions.subject, learnerOrgId: schema.trainingSessions.learnerOrgId, trainerOrgId: schema.trainingSessions.trainerOrgId, settlementStatus: schema.trainingSessions.settlementStatus, feeCredits: schema.trainingSessions.feeCredits };

export default async function routes(app: FastifyInstance) {
  app.post('/', async (req, reply) => {
    const a = requirePerm(req, 'training.participate');
    const body = parse(z.object({ sessionId: z.string().uuid(), reason: z.string().min(3).max(200), details: z.string().max(5000).optional() }), req.body);
    const d = await raiseDispute({ ...body, orgId: a.orgId, userId: a.user.id });
    return reply.status(201).send(d);
  });

  app.get('/', async (req) => {
    const a = requirePerm(req, 'training.read');
    const q = parse(PageQuery.extend({ status: z.string().max(30).optional() }), req.query);
    const where = and(orgDisputeFilter(a.orgId), q.status ? eq(schema.disputes.status, q.status) : undefined);
    const [rows, [{ n }]] = await Promise.all([
      db().select({ d: schema.disputes, s: sessionCols }).from(schema.disputes)
        .innerJoin(schema.trainingSessions, eq(schema.trainingSessions.id, schema.disputes.sessionId))
        .where(where).orderBy(desc(schema.disputes.createdAt)).limit(q.pageSize).offset(offset(q)),
      db().select({ n: count() }).from(schema.disputes).innerJoin(schema.trainingSessions, eq(schema.trainingSessions.id, schema.disputes.sessionId)).where(where),
    ]);
    return { items: rows.map((r) => ({ ...r.d, session: r.s })), total: n, page: q.page, pageSize: q.pageSize };
  });

  app.get('/:id', async (req) => {
    const a = requirePerm(req, 'training.read');
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const [r] = await db().select({ d: schema.disputes, s: sessionCols }).from(schema.disputes)
      .innerJoin(schema.trainingSessions, eq(schema.trainingSessions.id, schema.disputes.sessionId))
      .where(and(eq(schema.disputes.id, id), orgDisputeFilter(a.orgId))).limit(1);
    if (!r) throw notFound('Dispute');
    return { ...r.d, session: r.s };
  });
}

/** Register background job handlers for this module (called once at startup). */
export function registerJobs() {}
