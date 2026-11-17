/**
 * Database client. Uses embedded PGlite (real Postgres compiled to WASM, with pgvector)
 * for zero-install local development, or a PostgreSQL server when DATABASE_URL is set.
 * Both expose the same Drizzle API, typed as `DB`.
 *
 * Driver differences to keep in mind (see rowsOf / docs/DEPLOY_RENDER.md):
 *   - `db.execute(sql)` resolves to `{ rows }` on PGlite but to a row ARRAY on postgres-js → always use `rowsOf(res)`.
 *   - int8/bigint and numeric come back as strings on postgres-js → cast counts with `::int` or wrap in Number().
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { drizzle as drizzlePglite, type PgliteDatabase } from 'drizzle-orm/pglite';
import { config } from '../lib/config.js';
import * as schema from './schema.js';

export type DB = PgliteDatabase<typeof schema>;
/** Transaction handle — same query API as DB. */
export type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];
export type DbOrTx = DB | Tx;

let _db: DB | null = null;
let _pglite: PGlite | null = null;
let _close: (() => Promise<void>) | null = null;
let _driver: 'pglite' | 'postgres' | null = null;
let _url: string | null = null;

/** Which driver backs the current connection (null before initDb). */
export function dbDriver() { return _driver; }

/** Postgres connection URL in use (null for PGlite). */
export function dbUrl() { return _url; }

/** Normalises a raw `db.execute()` result: PGlite → `{ rows }`, postgres-js → array. */
export function rowsOf<T = Record<string, unknown>>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[];
  const rows = (res as { rows?: T[] } | null | undefined)?.rows;
  return Array.isArray(rows) ? rows : [];
}

/**
 * postgres-js `ssl` option from DATABASE_SSL (or an `sslmode=` query param, which postgres-js reads itself).
 *   require | true  → TLS, certificate not verified (managed Postgres with provider certs, e.g. Render external URL)
 *   verify-full     → TLS with full verification
 *   disable | false → no TLS (Render internal URL, local Postgres)
 */
export function sslOption(): false | 'require' | 'verify-full' | undefined {
  const v = config.DATABASE_SSL?.toLowerCase();
  if (!v) return undefined; // let the URL (?sslmode=...) decide
  if (v === 'disable' || v === 'false' || v === '0') return false;
  if (v === 'verify-full') return 'verify-full';
  return 'require';
}

export async function initDb(opts: { memory?: boolean; url?: string } = {}): Promise<DB> {
  if (_db) return _db;
  const url = opts.url ?? (opts.memory ? undefined : config.DATABASE_URL);
  if (url) {
    const { default: postgres } = await import('postgres');
    const { drizzle } = await import('drizzle-orm/postgres-js');
    const ssl = sslOption();
    const sql = postgres(url, {
      max: config.DB_POOL_MAX,
      ...(ssl !== undefined ? { ssl } : {}),
      idle_timeout: 30,
      connect_timeout: 30,
      onnotice: () => undefined, // "extension already exists" etc.
    });
    _db = drizzle(sql, { schema }) as unknown as DB;
    _close = async () => { await sql.end({ timeout: 5 }); };
    _driver = 'postgres';
    _url = url;
  } else {
    let dir: string | undefined;
    if (!opts.memory) {
      dir = resolve(process.cwd(), config.PGLITE_DIR);
      mkdirSync(dir, { recursive: true });
    }
    // NB: PGlite ignores options when dataDir is undefined — use explicit memory:// for in-memory DBs.
    _pglite = new PGlite(dir ?? 'memory://', { extensions: { vector } });
    await _pglite.waitReady;
    _db = drizzlePglite(_pglite, { schema });
    _close = async () => { await _pglite?.close(); };
    _driver = 'pglite';
  }
  return _db;
}

export function db(): DB {
  if (!_db) throw new Error('Database not initialised — call initDb() first');
  return _db;
}

export async function closeDb() {
  await _close?.();
  _db = null; _pglite = null; _close = null; _driver = null; _url = null;
}

export { schema };
