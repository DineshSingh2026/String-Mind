/**
 * Question-bank CLI (run from apps/api):
 *   npx tsx src/engine/pro-bank/cli.ts import [--dir ../../knowledge-library/_inbox] [--dry-run] [--force]
 *   npx tsx src/engine/pro-bank/cli.ts validate <file> [--all]
 *
 * `import` opens the configured database (DATABASE_URL or embedded PGlite). Embedded PGlite cannot be shared between
 * processes: if the API dev server is running, the CLI refuses (use the admin "Run import" button / POST /pro-bank/import).
 */
import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import { parseSourceFile } from './parse.js';

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (n: string) => args.includes(n);
const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

function portOpen(port: number) {
  return new Promise<boolean>((res) => {
    const s = createConnection({ port, host: '127.0.0.1' });
    s.once('connect', () => { s.destroy(); res(true); });
    s.once('error', () => res(false));
    s.setTimeout(800, () => { s.destroy(); res(false); });
  });
}

async function doImport() {
  const { config } = await import('../../lib/config.js');
  if (!config.DATABASE_URL && !flag('--force') && await portOpen(Number(config.PORT))) {
    console.error(`The API server is listening on :${config.PORT} and holds the embedded PGlite database.\n`
      + 'Run the import from the admin UI (Question bank → Run import) or POST /pro-bank/import, or stop the server first (--force to override).');
    process.exit(2);
  }
  const { initDb, closeDb } = await import('../../db/client.js');
  const { migrate } = await import('../../db/migrate.js');
  const { runImport, formatSummary } = await import('./import.js');
  const database = await initDb();
  await migrate(database);
  try {
    const dir = opt('--dir');
    const s = await runImport({ dir: dir ? resolve(dir) : undefined, dryRun: flag('--dry-run'), log: (l) => console.log(l) });
    console.log('\n' + formatSummary(s));
    if (s.sampleIssues.length) {
      console.log('\nSample validation issues:');
      for (const x of s.sampleIssues.slice(0, 10)) console.log(`  ${x.source}/${x.externalId}: ${x.issues.join(' | ')}`);
    }
  } finally {
    await closeDb();
  }
}

function doValidate() {
  const file = args[1];
  if (!file) { console.error('usage: cli.ts validate <file> [--all]'); process.exit(1); }
  const p = parseSourceFile(resolve(file));
  if (!p) { console.error(`Not a recognised bank source file: ${file}`); process.exit(1); }
  const bad = p.items.filter((i) => i.validationIssues.length);
  const calBad = p.calibrations.filter((c) => c.issues.length);
  const show = flag('--all') ? bad : bad.slice(0, 40);
  for (const it of show) {
    console.log(`✗ ${it.externalId} [${it.domainName} · ${it.difficulty} · ${it.gradingMode}]`);
    for (const i of it.validationIssues) console.log(`    - ${i}`);
  }
  if (show.length < bad.length) console.log(`  … ${bad.length - show.length} more (use --all)`);
  // issue histogram (numbers stripped so similar messages group together)
  const hist = new Map<string, number>();
  for (const it of bad) for (const i of it.validationIssues) { const k = i.replace(/'[^']*'/g, "'…'").replace(/-?\d+(\.\d+)?/g, '#'); hist.set(k, (hist.get(k) ?? 0) + 1); }
  console.log(`\n${p.source}: ${p.read} records · ${p.items.length} items · ${bad.length} with issues · ${p.duplicates} duplicates · `
    + `${p.calibrations.length} calibrations (${calBad.length} with issues) · ${p.twists.length} twists · ${p.proof.length} proof records · ${p.parseErrors.length} parse errors`);
  for (const [k, n] of [...hist].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${String(n).padStart(6)}  ${k}`);
  for (const e of p.parseErrors.slice(0, 10)) console.log(`  parse: ${e}`);
  process.exitCode = bad.length || calBad.length || p.parseErrors.length ? 1 : 0;
}

if (cmd === 'import') await doImport();
else if (cmd === 'validate') doValidate();
else {
  console.log('usage:\n  cli.ts import [--dir <inbox>] [--dry-run] [--force]\n  cli.ts validate <file> [--all]');
  process.exit(cmd ? 1 : 0);
}
