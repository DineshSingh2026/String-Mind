import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../lib/config.js';

if (config.DATABASE_URL) {
  console.error('db:reset only resets the embedded PGlite database. For Postgres, drop/recreate the database manually.');
  process.exit(1);
}
const dir = resolve(process.cwd(), config.PGLITE_DIR);
rmSync(dir, { recursive: true, force: true });
console.log(`Removed ${dir}. It will be re-created, migrated and seeded on next API start.`);
