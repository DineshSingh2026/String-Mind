/**
 * Test harness: fresh in-memory Postgres (PGlite) per test file, migrated + seeded,
 * with the full Fastify app. Use `api()` for authenticated requests.
 */
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closeDb, initDb, type DB } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';
import { registerAllJobs } from '../src/modules/index.js';

export let app: FastifyInstance;
export let database: DB;

export async function setup(opts: { demo?: boolean } = {}) {
  process.env.NODE_ENV = 'test';
  // Default: fresh in-memory PGlite. Set TEST_DATABASE_URL to run the suite against a real Postgres server over the
  // wire protocol (postgres-js driver) — the database is WIPED (public + drizzle schemas) before each test file.
  const pgUrl = process.env.TEST_DATABASE_URL;
  if (pgUrl) {
    // short-lived connection (the pool opens lazily afterwards; single-connection test servers stay happy)
    const { default: postgres } = await import('postgres');
    const wipe = postgres(pgUrl, { max: 1, onnotice: () => undefined });
    await wipe.unsafe('DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    await wipe.end();
  }
  database = await initDb(pgUrl ? { url: pgUrl } : { memory: true });
  await migrate(database);
  await seed(database, { demo: opts.demo ?? false });
  registerAllJobs();
  app = await buildApp({ logger: false });
  await app.ready();
  return app;
}

export async function teardown() {
  await app?.close();
  await closeDb();
}

export interface Client { cookie: string; orgId?: string; request: (method: string, url: string, body?: unknown) => Promise<{ status: number; body: any }> }

/** Register a fresh user and return a client carrying its session cookie. */
export async function registerUser(email = `u${Math.random().toString(36).slice(2, 8)}@test.dev`, persona = 'agent_owner', password = 'Str0ng!Passw0rd'): Promise<Client> {
  const res = await app.inject({ method: 'POST', url: '/auth/register', payload: { email, password, name: 'Test User', persona } });
  if (res.statusCode >= 300) throw new Error(`register failed ${res.statusCode} ${res.body}`);
  const cookie = String(res.headers['set-cookie']).split(';')[0]!;
  const c: Client = {
    cookie,
    request: async (method, url, body) => {
      const r = await app.inject({ method: method as never, url, payload: body as never, headers: { cookie, ...(c.orgId ? { 'x-aix-org': c.orgId } : {}) } });
      return { status: r.statusCode, body: r.body ? safeJson(r.body) : null };
    },
  };
  return c;
}

export async function loginAdmin(): Promise<Client> {
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'admin@aix.local', password: 'AixAdmin!2026' } });
  if (res.statusCode >= 300) throw new Error(`admin login failed ${res.statusCode} ${res.body}`);
  const cookie = String(res.headers['set-cookie']).split(';')[0]!;
  return {
    cookie,
    request: async (method, url, body) => {
      const r = await app.inject({ method: method as never, url, payload: body as never, headers: { cookie } });
      return { status: r.statusCode, body: r.body ? safeJson(r.body) : null };
    },
  };
}

function safeJson(s: string) { try { return JSON.parse(s); } catch { return s; } }

/**
 * Create user + personal org + owner membership + session directly in the DB (no dependency on
 * the auth module). Returns a Client with cookie + orgId. Use in non-auth module tests.
 */
export async function createUserDirect(opts: { email?: string; name?: string; role?: string; platformRole?: string; orgName?: string; orgType?: string } = {}): Promise<Client & { userId: string; orgId: string }> {
  const { randomBytes, createHash } = await import('node:crypto');
  const { schema } = await import('../src/db/client.js');
  const email = opts.email ?? `d${randomBytes(4).toString('hex')}@test.dev`;
  const [org] = await database.insert(schema.organisations).values({ name: opts.orgName ?? `${email} org`, slug: `org-${randomBytes(5).toString('hex')}`, type: opts.orgType ?? 'personal' }).returning();
  const [user] = await database.insert(schema.users).values({ email, name: opts.name ?? 'Direct User', passwordHash: 'x', platformRole: opts.platformRole ?? 'user', defaultOrgId: org!.id, emailVerifiedAt: new Date() }).returning();
  await database.insert(schema.memberships).values({ orgId: org!.id, userId: user!.id, role: opts.role ?? 'owner' });
  const token = randomBytes(32).toString('base64url');
  await database.insert(schema.sessions).values({ userId: user!.id, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 86400_000) });
  const cookie = `aix_session=${token}`;
  const c = {
    cookie, orgId: org!.id, userId: user!.id,
    request: async (method: string, url: string, body?: unknown) => {
      const r = await app.inject({ method: method as never, url, payload: body as never, headers: { cookie, 'x-aix-org': c.orgId } });
      return { status: r.statusCode, body: r.body ? safeJson(r.body) : null };
    },
  };
  return c;
}
