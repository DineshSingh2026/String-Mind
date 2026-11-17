import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { dbDriver, dbUrl, sslOption, type DB } from './client.js';

const MIGRATIONS = resolve(import.meta.dirname, '../../drizzle');
/** Arbitrary constant key for the migration advisory lock (serialises overlapping deploys). */
const MIGRATION_LOCK_KEY = 470_001;

/** Applies extensions, Drizzle migrations, and DB-level integrity rules (append-only tables). */
export async function migrate(db: DB) {
  if (!existsSync(MIGRATIONS)) throw new Error(`No migrations at ${MIGRATIONS}. Run: npm run db:generate -w @aix/api`);
  if (dbDriver() === 'postgres') {
    // Real Postgres: use a dedicated single connection so a session-level advisory lock covers the whole run
    // (Render zero-downtime deploys briefly run old + new instance; both may boot-migrate at once).
    const { default: postgres } = await import('postgres');
    const { drizzle } = await import('drizzle-orm/postgres-js');
    const { migrate: run } = await import('drizzle-orm/postgres-js/migrator');
    const ssl = sslOption();
    const client = postgres(dbUrl()!, { max: 1, onnotice: () => undefined, ...(ssl !== undefined ? { ssl } : {}) });
    try {
      await client`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
      const mdb = drizzle(client) as unknown as DB;
      await applyExtensions(mdb);
      await run(drizzle(client), { migrationsFolder: MIGRATIONS });
      await applyIntegrityRules(mdb);
      await client`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
    } finally {
      await client.end({ timeout: 5 });
    }
    return;
  }
  await applyExtensions(db);
  const { migrate: run } = await import('drizzle-orm/pglite/migrator');
  await run(db, { migrationsFolder: MIGRATIONS });
  await applyIntegrityRules(db);
}

async function applyExtensions(db: DB) {
  // pgvector is required (embeddings). On managed Postgres the app user must own the DB (Render: yes).
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`).catch(() => undefined);
}

async function applyIntegrityRules(db: DB) {
  // Append-only enforcement: ledger + audit can never be updated or deleted.
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION aix_forbid_mutation() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME; END; $$ LANGUAGE plpgsql;
  `);
  for (const t of ['ledger_entries', 'audit_logs']) {
    await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${t}_append_only ON ${t}`));
    await db.execute(sql.raw(`CREATE TRIGGER ${t}_append_only BEFORE UPDATE OR DELETE ON ${t} FOR EACH ROW EXECUTE FUNCTION aix_forbid_mutation()`));
  }
  // Double-entry integrity: each transaction's entries must sum to zero (checked at commit).
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION aix_check_tx_balanced() RETURNS trigger AS $$
    DECLARE s bigint;
    BEGIN
      SELECT COALESCE(SUM(amount),0) INTO s FROM ledger_entries WHERE transaction_id = NEW.transaction_id;
      IF s <> 0 THEN RAISE EXCEPTION 'ledger transaction % is unbalanced (sum=%)', NEW.transaction_id, s; END IF;
      RETURN NULL;
    END; $$ LANGUAGE plpgsql;
  `);
  await db.execute(sql`DROP TRIGGER IF EXISTS ledger_entries_balanced ON ledger_entries`);
  await db.execute(sql`CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON ledger_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION aix_check_tx_balanced()`);
  // Vector index for RAG (HNSW cosine).
  await db.execute(sql`CREATE INDEX IF NOT EXISTS embeddings_hnsw_idx ON embeddings USING hnsw (embedding vector_cosine_ops)`);
}
