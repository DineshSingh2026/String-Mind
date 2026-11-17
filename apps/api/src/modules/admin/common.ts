import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../../lib/audit.js';
import { requireAdmin } from '../../lib/auth.js';

export const IdParam = z.object({ id: z.string().uuid() });

/** Admin actor (throws 401/403 for non-admins). */
export const actor = (req: FastifyRequest) => requireAdmin(req);

/** Audit an admin mutation (actorType always 'admin'). */
export function adminAudit(req: FastifyRequest, action: string, targetType: string, targetId: string | null, metadata: Record<string, unknown> = {}, orgId?: string | null) {
  return audit({ action: `admin.${action}`, targetType, targetId, metadata, actorType: 'admin', orgId: orgId ?? null }, req);
}

/** Strip secrets from a user row. */
export function publicUser(u: { id: string; email: string; name: string; platformRole: string; status: string; persona: string; mfaEnabled: boolean; createdAt: Date; lastLoginAt: Date | null; deletedAt: Date | null; defaultOrgId: string | null }) {
  const { id, email, name, platformRole, status, persona, mfaEnabled, createdAt, lastLoginAt, deletedAt, defaultOrgId } = u;
  return { id, email, name, platformRole, status, persona, mfaEnabled, createdAt, lastLoginAt, deletedAt, defaultOrgId };
}
