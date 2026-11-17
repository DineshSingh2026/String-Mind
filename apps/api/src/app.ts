import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { ZodError } from 'zod';
import { config } from './lib/config.js';
import { AppError } from './lib/errors.js';
import { SESSION_COOKIE, authenticate, registerAuth } from './lib/auth.js';
import { sha256 } from './lib/crypto.js';
import { authenticateWsToken } from './lib/ws-token.js';
import { sql } from 'drizzle-orm';
import { db, schema } from './db/client.js';
import { subscribe } from './ws/hub.js';
import { MODULES } from './modules/index.js';

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger === false ? false : {
      level: config.LOG_LEVEL,
      // never write WebSocket tokens (/ws?token=…) to the logs
      serializers: {
        req: (req: { method?: string; url?: string; hostname?: string; ip?: string }) => ({
          method: req.method, url: req.url?.replace(/([?&]token=)[^&]*/g, '$1[redacted]'), host: req.hostname, remoteAddress: req.ip,
        }),
      },
    },
    bodyLimit: 5 * 1024 * 1024,
    // Behind Render's router and the Next.js /api proxy (which forwards the incoming X-Forwarded-For unchanged).
    trustProxy: config.TRUST_PROXY as boolean, // number = hop count (supported at runtime, missing from the typings)
  });

  await app.register(cors, { origin: config.WEB_ORIGINS, credentials: true });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 5 } });
  await app.register(rateLimit, {
    max: config.isTest ? 100_000 : 600,
    timeWindow: '1 minute',
    // Prefer a per-principal key (API key / session) so users behind one NAT or proxy don't share a bucket;
    // anonymous traffic falls back to the client IP (X-Forwarded-For via trustProxy).
    keyGenerator: (req) => {
      if (req.headers.authorization) return `k:${sha256(req.headers.authorization)}`;
      const s = req.cookies?.[SESSION_COOKIE];
      if (s) return `s:${sha256(s)}`;
      try { return `ip:${req.ip}`; } catch { return 'ip:unknown'; } // injected (test) requests have no socket
    },
  });
  await app.register(websocket);

  // Security headers
  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  });

  registerAuth(app);

  // API request logs for developer console (API-key traffic + org traffic), fire-and-forget.
  app.addHook('onResponse', async (req, reply) => {
    if (req.url.startsWith('/health') || req.method === 'OPTIONS') return;
    if (!req.auth?.orgId) return;
    void db().insert(schema.apiRequestLogs).values({
      orgId: req.auth.orgId, apiKeyId: req.auth.apiKeyId, userId: req.auth.user.id,
      method: req.method, path: req.routeOptions.url ?? req.url.split('?')[0]!, statusCode: reply.statusCode,
      latencyMs: Math.round(reply.elapsedTime),
    }).catch(() => undefined);
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'bad_request', message: 'Validation failed', details: err.flatten() } });
    const e = err as Error & { statusCode?: number; code?: string };
    const status = e.statusCode ?? 500;
    if (status < 500) return reply.status(status).send({ error: { code: e.code ?? 'error', message: e.message } });
    req.log.error(err);
    console.error('[api] unhandled error', err);
    return reply.status(500).send({ error: { code: 'internal', message: 'Something went wrong on our side. The error has been logged.' } });
  });

  app.setNotFoundHandler((req, reply) => reply.status(404).send({ error: { code: 'not_found', message: `Route ${req.method} ${req.url} not found` } }));

  app.get('/health', async () => {
    await db().execute(sql`select 1`).catch(() => { throw new AppError(503, 'db_down', 'Database unavailable'); });
    return { status: 'ok', time: new Date().toISOString(), database: config.DATABASE_URL ? 'postgres' : 'pglite' };
  });

  app.register(async (scope) => {
    scope.get('/ws', {
      websocket: true,
      // Cross-site WebSocket hijacking guard: browsers always send Origin; it must be the web app in production.
      preValidation: async (req, reply) => {
        const origin = req.headers.origin;
        if (config.isProd && origin && !config.WEB_ORIGINS.includes(origin.replace(/\/+$/, ''))) {
          return reply.status(403).send({ error: { code: 'forbidden_origin', message: 'WebSocket origin not allowed' } });
        }
      },
    }, async (socket, req) => {
      // Auth: `?token=` (short-lived, from GET /auth/ws-token — needed when web and API are on different hosts),
      // else the session cookie (same-origin / local development).
      const token = (req.query as { token?: string } | undefined)?.token;
      const auth = token ? await authenticateWsToken(token).catch(() => null) : await authenticate(req).catch(() => null);
      if (!auth) { socket.send(JSON.stringify({ event: 'error', data: 'unauthorized' })); socket.close(4401, 'unauthorized'); return; }
      await subscribe(socket, auth, `user:${auth.user.id}`);
      socket.on('message', async (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString()) as { type?: string; channel?: string };
          if (msg.type === 'subscribe' && msg.channel) {
            const ok = await subscribe(socket, auth, msg.channel);
            socket.send(JSON.stringify({ event: ok ? 'subscribed' : 'subscribe_denied', channel: msg.channel }));
          } else if (msg.type === 'ping') socket.send(JSON.stringify({ event: 'pong' }));
        } catch { socket.send(JSON.stringify({ event: 'error', data: 'bad message' })); }
      });
      socket.send(JSON.stringify({ event: 'ready', data: { userId: auth.user.id } }));
    });
  });

  for (const m of MODULES) await app.register(m.plugin, { prefix: m.prefix });

  return app;
}
