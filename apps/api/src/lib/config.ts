import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

/** Strict env boolean: 'true'|'1' → true, 'false'|'0' → false (z.coerce.boolean treats "false" as true). */
const envBool = (def: boolean) => z.enum(['true', 'false', '1', '0', '']).optional().transform((v) => (v === undefined || v === '' ? def : v === 'true' || v === '1'));

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Render (and most PaaS) inject PORT. */
  PORT: z.coerce.number().default(4700),
  /** Unset → 0.0.0.0 in production (reachable by the platform router), 127.0.0.1 otherwise. */
  HOST: z.string().optional(),
  /**
   * Browser origin(s) of the web app, comma-separated. Used for CORS and the WebSocket Origin check.
   * Host-only values (e.g. `stringmind-web.onrender.com`, as Render's `fromService` gives) get `https://` prepended.
   */
  WEB_ORIGIN: z.string().default('http://localhost:3700'),
  /** If set, use a real PostgreSQL server (with pgvector). Otherwise embedded PGlite at PGLITE_DIR. Required in production. */
  DATABASE_URL: z.string().optional(),
  /** postgres-js pool size. */
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  /** Optional TLS override: require | verify-full | disable. Unset → decided by `?sslmode=` in DATABASE_URL (Render internal URL: no TLS needed). */
  DATABASE_SSL: z.string().optional(),
  /** pino log level: fatal | error | warn | info | debug | trace | silent. Default: info in production, warn otherwise. */
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  /**
   * Fastify trustProxy: 'true' (default; client IP = left-most X-Forwarded-For), 'false', or a hop count (e.g. 2)
   * to only trust the nearest N proxies (harder to spoof X-Forwarded-For).
   */
  TRUST_PROXY: z.string().default('true'),
  PGLITE_DIR: z.string().default('./.data/pglite'),
  STORAGE_DIR: z.string().default('./storage'),
  /** 32-byte hex key for AES-256-GCM credential encryption. Required in production. */
  ENCRYPTION_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().regex(/^[0-9a-f]{64}$/i, 'ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes). Generate one with: openssl rand -hex 32').optional()),
  SESSION_TTL_HOURS: z.coerce.number().default(24 * 7),
  /** Secure (HTTPS-only) session cookie. Unset → true in production, false otherwise. */
  COOKIE_SECURE: z.enum(['true', 'false', '1', '0', '']).optional(),
  /**
   * Fiat money rails (token purchases, invoices, payouts, provider webhooks). StringMind is a pure IDLE Token economy,
   * so this is OFF by default and the fiat endpoints answer 410 fiat_disabled. Dormant code kept for the future.
   */
  FIAT_ENABLED: envBool(false),
  /** Payment provider for the dormant fiat path (only used when FIAT_ENABLED=true): sandbox | razorpay | stripe */
  PAYMENT_PROVIDER: z.enum(['sandbox', 'razorpay', 'stripe']).default('sandbox'),
  /** Optional platform-level evaluator LLM keys (used for rubric grading of open-ended answers). */
  EVALUATOR_PROVIDER: z.string().optional(),
  EVALUATOR_API_KEY: z.string().optional(),
  EVALUATOR_MODEL: z.string().optional(),
  JOB_POLL_MS: z.coerce.number().default(750),
  DISABLE_JOBS: envBool(false),
  SEED_DEMO: envBool(true),
  /**
   * Allow agent endpoints / webhooks on loopback, private and link-local networks (SSRF guard, see lib/net-guard.ts).
   * Unset → true in development/test (local Ollama/Llama), false in production.
   */
  ALLOW_PRIVATE_NETWORK_URLS: z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1').optional(),
});

const parsed = Env.parse(process.env);

const DEFAULT_ADMIN_PASSWORD = 'AixAdmin!2026';

/** `host` / `host:port` → `https://host`; keeps explicit schemes; strips trailing slashes. */
export function normaliseOrigin(v: string, defaultScheme = 'https'): string {
  const t = v.trim().replace(/\/+$/, '');
  if (!t) return t;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `${defaultScheme}://${t}`;
}

const isProd = parsed.NODE_ENV === 'production';

if (isProd) {
  const problems: string[] = [];
  if (!parsed.DATABASE_URL) problems.push('DATABASE_URL is required in production (PostgreSQL with the pgvector extension). The embedded PGlite database is for local development only.');
  if (!parsed.ENCRYPTION_KEY) problems.push('ENCRYPTION_KEY is required in production: exactly 64 hex characters. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  const adminPw = process.env.ADMIN_PASSWORD;
  if (!adminPw || adminPw === DEFAULT_ADMIN_PASSWORD) problems.push('ADMIN_PASSWORD must be set in production and must not be the development default. It is the password of the seeded super-admin account (ADMIN_EMAIL).');
  if (problems.length) {
    throw new Error(`StringMind API refused to start — production configuration is incomplete:\n  - ${problems.join('\n  - ')}`);
  }
}

const trustProxy: boolean | number = (() => {
  const v = parsed.TRUST_PROXY.trim().toLowerCase();
  if (v === 'false' || v === '0' || v === '') return false;
  if (/^\d+$/.test(v)) return Number(v);
  return true;
})();

export const config = {
  ...parsed,
  HOST: parsed.HOST || (isProd ? '0.0.0.0' : '127.0.0.1'),
  WEB_ORIGINS: parsed.WEB_ORIGIN.split(',').map((o) => normaliseOrigin(o)).filter(Boolean),
  COOKIE_SECURE: parsed.COOKIE_SECURE === undefined || parsed.COOKIE_SECURE === '' ? isProd : parsed.COOKIE_SECURE === 'true' || parsed.COOKIE_SECURE === '1',
  LOG_LEVEL: parsed.LOG_LEVEL ?? (isProd ? 'info' : 'warn'),
  TRUST_PROXY: trustProxy,
  // Dev fallback key is derived per-process ONLY when not configured; dev .env created by setup script persists one.
  ENCRYPTION_KEY: parsed.ENCRYPTION_KEY ?? (process.env.__AIX_DEV_KEY ??= randomBytes(32).toString('hex')),
  ALLOW_PRIVATE_NETWORK_URLS: parsed.ALLOW_PRIVATE_NETWORK_URLS ?? !isProd,
  isProd,
  isTest: parsed.NODE_ENV === 'test',
};
