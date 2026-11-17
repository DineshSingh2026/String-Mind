import type { FastifyRequest } from 'fastify';
import type { DbOrTx } from '../db/client.js';
import { db, schema } from '../db/client.js';

export interface AuditInput {
  action: string; targetType?: string; targetId?: string | null; orgId?: string | null;
  metadata?: Record<string, unknown>; actorType?: 'user' | 'admin' | 'system' | 'api_key' | 'agent'; actorUserId?: string | null;
}

/** Writes an append-only audit log row. Pass `req` to capture actor + ip automatically. */
export async function audit(input: AuditInput, req?: FastifyRequest | null, tx?: DbOrTx) {
  const a = req?.auth;
  const actorType = input.actorType
    ?? (a?.apiKeyId ? 'api_key' : a ? (req?.url.startsWith('/admin') ? 'admin' : 'user') : 'system');
  await (tx ?? db()).insert(schema.auditLogs).values({
    actorUserId: input.actorUserId ?? a?.user.id ?? null,
    actorType,
    orgId: input.orgId ?? a?.orgId ?? null,
    action: input.action,
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    ip: req?.ip ?? null,
    metadata: { ...(input.metadata ?? {}), ...(a?.apiKeyId ? { apiKeyId: a.apiKeyId } : {}) },
  });
}
