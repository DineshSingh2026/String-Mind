#!/usr/bin/env node
/**
 * Upload your local knowledge-library data to a Hive Mind server (e.g. the live site) and import it.
 * The knowledge-library folder is gitignored, so deployments don't have it — this copies it over the API.
 *
 *   node tools/question-bank/push-question-bank.mjs --url https://<your-api-host> --email <admin email> --password <admin password>
 *   (or env HIVE_URL, HIVE_ADMIN_EMAIL, HIVE_ADMIN_PASSWORD)  [--dir knowledge-library/_inbox]
 *
 * Node 20+, no dependencies. Files are sent one per request (server limit 20 MB per file); the import runs once at the end.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const url = (arg('url', process.env.HIVE_URL) || '').replace(/\/+$/, '');
const email = arg('email', process.env.HIVE_ADMIN_EMAIL);
const password = arg('password', process.env.HIVE_ADMIN_PASSWORD);
const dir = arg('dir', 'knowledge-library/_inbox');
if (!url || !email || !password) { console.error('Usage: --url <api base> --email <admin> --password <pw>'); process.exit(1); }

const files = [];
const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/\.(jsonl|json|csv|md)$/i.test(n)) files.push(p); } };
walk(dir);
if (!files.length) { console.error(`No data files in ${dir}`); process.exit(1); }

const login = await fetch(`${url}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
if (!login.ok) { console.error(`Login failed: ${login.status} ${await login.text()}`); process.exit(1); }
const cookie = (login.headers.getSetCookie?.() ?? [login.headers.get('set-cookie') ?? '']).map((c) => c.split(';')[0]).join('; ');

for (const [i, f] of files.entries()) {
  const last = i === files.length - 1;
  const form = new FormData();
  form.append('file', new Blob([readFileSync(f)]), basename(f));
  const r = await fetch(`${url}/pro-bank/upload?import=${last ? 'true' : 'false'}`, { method: 'POST', headers: { cookie }, body: form });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) { console.error(`✗ ${basename(f)}: ${r.status} ${JSON.stringify(body)}`); process.exit(1); }
  console.log(`✓ uploaded ${basename(f)}`);
  if (last && body.summary) {
    for (const s of body.summary.sources ?? []) console.log(`  ${s.source}: read ${s.read ?? '?'} · imported ${s.imported} · updated ${s.updated ?? 0} · flagged ${s.flagged ?? 0} · duplicates ${s.duplicates ?? 0}`);
  }
}
console.log('Done. Check Admin → Question bank on the server.');
