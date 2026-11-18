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
   * Fiat money rails (token purchases, invoices, payouts, provider webhooks). Hive Mind is a pure IDLE Token economy,
   * so this is OFF by default and the fiat endpoints answer 410 fiat_disabled. Dormant code kept for the future.
   */
  FIAT_ENABLED: envBool(false),
  /** Payment provider for the dormant fiat path (only used when FIAT_ENABLED=true): sandbox | razorpay | stripe */
  PAYMENT_PROVIDER: z.enum(['sandbox', 'razorpay', 'stripe']).default('sandbox'),
  /** Optional platform-level evaluator LLM keys (used for rubric grading of open-ended answers). */
  EVALUATOR_PROVIDER: z.string().optional(),
  EVALUATOR_API_KEY: z.string().optional(),
  EVALUATOR_MODEL: z.string().optional(),
  EVALUATOR_BASE_URL: z.string().optional(),
  /** Hive Judge optional local LLM tier (OpenAI-compatible, e.g. Ollama http://127.0.0.1:11434/v1 + qwen3:4b). Unset → scorer only. */
  HIVE_JUDGE_LLM_URL: z.string().optional(),
  HIVE_JUDGE_LLM_MODEL: z.string().optional(),
  HIVE_JUDGE_LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).default(120_000),
  JOB_POLL_MS: z.coerce.number().default(750),
  DISABLE_JOBS: envBool(false),
  SEED_DEMO: envBool(true),
  /**
   * Allow agent endpoints / webhooks on loopback, private and link-local networks (SSRF guard, see lib/net-guard.ts).
   * Unset → true in development/test (local Ollama/Llama), false in production.
   */
  ALLOW_PRIVATE_NETWORK_URLS: z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1').optional(),

  /* ── On-chain wallets & payment gateway (Solana). Off by default; see docs/ONCHAIN_GATEWAY.md ───────────────────────
   * Wallet topology: every agent has its own permanent deposit wallet (AGENT) → deposits are swept into the Treasury
   * (MID: the operational wallet that holds the funds, pays gas and pays withdrawals) → platform fees go Treasury →
   * Revenue (ADMIN: only ever receives fees, its key is never loaded by this app). */
  ONCHAIN_ENABLED: envBool(false),
  /** solana-mainnet | solana-devnet | solana-testnet. Must match the RPC's cluster (verified by genesis hash before the first call). */
  SOLANA_NETWORK: z.enum(['solana-mainnet', 'solana-devnet', 'solana-testnet']).default('solana-mainnet'),
  /** Full RPC URL including its API key (Helius or any provider). Never logged. */
  SOLANA_RPC_URL: z.string().default(''),
  /** PUBLIC addresses. MID = Treasury (its key comes from the secret provider). ADMIN = Revenue (key never loaded). */
  MID_WALLET_ADDRESS: z.string().default(''),
  ADMIN_WALLET_ADDRESS: z.string().default(''),
  /** Addresses/keys of retired wallets that must still count as platform-controlled (a transfer from them is never a deposit). */
  LEGACY_FEE_PAYER_ADDRESS: z.string().default(''),
  IDLEMINE_MINT: z.string().default('BjcRmwm8e25RgjkyaFE56fc7bxRgGPw96JUkXRJFEroT'),
  IDLEMINE_DECIMALS: z.coerce.number().int().min(0).max(18).default(9),
  USDC_MINT: z.string().default('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  USDC_DECIMALS: z.coerce.number().int().min(0).max(18).default(6),
  USDT_MINT: z.string().default('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'),
  USDT_DECIMALS: z.coerce.number().int().min(0).max(18).default(6),
  /** Test networks only: test mints have no market, so fixed USD prices are used (refused on mainnet). */
  TEST_IDLEMINE_USD_PRICE: z.string().default(''),
  TEST_SOL_USD_PRICE: z.string().default(''),
  /** Where wallet secrets live: "aws" (AWS Secrets Manager — production) or "env" (DEV_* values — refused in production). */
  SECRET_PROVIDER: z.enum(['aws', 'env']).default('aws'),
  AWS_REGION: z.string().default(''),
  SECRET_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(300),
  WALLET_MASTER_SEED_SECRET_ID: z.string().default('hivemind/wallet-master-seed'),
  MID_WALLET_KEY_SECRET_ID: z.string().default('hivemind/mid-wallet-private-key'),
  DEV_WALLET_MASTER_SEED_HEX: z.string().default(''),
  DEV_MID_WALLET_PRIVATE_KEY: z.string().default(''),
  SOLANA_RPC_MAX_CONCURRENCY: z.coerce.number().int().min(1).default(8),
  SOLANA_COMPUTE_UNIT_PRICE_MICROLAMPORTS: z.coerce.number().int().min(0).default(0),
  SOLANA_COMPUTE_UNIT_LIMIT: z.coerce.number().int().min(0).default(100_000),
  ONCHAIN_WORKER_INTERVAL_SECONDS: z.coerce.number().min(1).default(15),
  DEPOSIT_SCAN_INTERVAL_SECONDS: z.coerce.number().min(1).default(600),
  DEPOSIT_VERIFY_WAIT_SECONDS: z.coerce.number().min(0).default(45),
  RECONCILIATION_INTERVAL_SECONDS: z.coerce.number().min(1).default(600),
  /** A sweep/fee/payout whose transaction expired this many times is parked as 'failed' and raised as a reconciliation issue. */
  ONCHAIN_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(8),
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
    throw new Error(`Hive Mind API refused to start — production configuration is incomplete:\n  - ${problems.join('\n  - ')}`);
  }
}

// On-chain gateway guards (same rules as the reference gateway): a test network never touches mainnet assets or production.
export const SOLANA_GENESIS_HASHES: Record<string, string> = {
  'solana-mainnet': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  'solana-devnet': 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  'solana-testnet': '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
};
const MAINNET_MINTS = new Set([
  'BjcRmwm8e25RgjkyaFE56fc7bxRgGPw96JUkXRJFEroT', // IDLEMINE
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);
{
  const testNet = parsed.SOLANA_NETWORK !== 'solana-mainnet';
  const problems: string[] = [];
  if (testNet) {
    if (parsed.NODE_ENV === 'production') problems.push('A Solana test network cannot be used with NODE_ENV=production');
    const used = [parsed.IDLEMINE_MINT, parsed.USDC_MINT, parsed.USDT_MINT].filter((m) => MAINNET_MINTS.has(m));
    if (parsed.ONCHAIN_ENABLED && used.length) problems.push(`${parsed.SOLANA_NETWORK} is configured with mainnet mint(s) ${used.join(', ')}`);
    if (/mainnet/i.test(parsed.SOLANA_RPC_URL)) problems.push(`${parsed.SOLANA_NETWORK} is configured with a mainnet RPC URL`);
  } else if (parsed.TEST_IDLEMINE_USD_PRICE || parsed.TEST_SOL_USD_PRICE) {
    problems.push('TEST_*_USD_PRICE fixed prices are only allowed on a Solana test network');
  }
  if (parsed.ONCHAIN_ENABLED && parsed.NODE_ENV === 'production') {
    if (parsed.SECRET_PROVIDER === 'env') problems.push('SECRET_PROVIDER=env is refused in production: keep the wallet master seed and the Treasury key in AWS Secrets Manager (SECRET_PROVIDER=aws)');
    for (const k of ['SOLANA_RPC_URL', 'MID_WALLET_ADDRESS', 'ADMIN_WALLET_ADDRESS'] as const) if (!parsed[k]) problems.push(`${k} is required when ONCHAIN_ENABLED=true`);
    if (parsed.MID_WALLET_ADDRESS && parsed.MID_WALLET_ADDRESS === parsed.ADMIN_WALLET_ADDRESS) problems.push('MID_WALLET_ADDRESS (Treasury) and ADMIN_WALLET_ADDRESS (Revenue) must be different wallets');
  }
  if (problems.length) throw new Error(`Hive Mind API refused to start — on-chain wallet configuration is invalid:\n  - ${problems.join('\n  - ')}`);
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
  isTestNetwork: parsed.SOLANA_NETWORK !== 'solana-mainnet',
};
