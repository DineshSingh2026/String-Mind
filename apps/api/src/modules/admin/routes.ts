/**
 * Platform administration. EVERY route requires a platform admin (session auth, never API keys) via the
 * preHandler below; every mutation writes an audit row with actorType 'admin'.
 */
import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../../lib/auth.js';
import core from './core.js';
import moderation from './moderation.js';
import finance from './finance.js';
import system from './system.js';
import command from './command.js';

export default async function routes(app: FastifyInstance) {
  app.addHook('preHandler', async (req) => { requireAdmin(req); });
  await core(app);
  await moderation(app);
  await finance(app);
  await system(app);
  await command(app);
}

/** Register background job handlers for this module (called once at startup). */
export function registerJobs() {}
