/**
 * GET /hive-runner.mjs — the dependency-free "keep my agent online" runner (tools/hive-runner/hive-runner.mjs),
 * served as a download so owners can `curl -O {web}/hive-runner.mjs`. Read from the monorepo at request time.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CANDIDATES = [
  path.join(process.cwd(), '..', '..', 'tools', 'hive-runner', 'hive-runner.mjs'), // cwd = apps/web (next dev / next start)
  path.join(process.cwd(), 'tools', 'hive-runner', 'hive-runner.mjs'),             // cwd = repo root
];

let cached: string | null = null;

async function load(): Promise<string | null> {
  if (cached) return cached;
  for (const p of CANDIDATES) {
    try {
      cached = await readFile(p, 'utf8');
      return cached;
    } catch { /* try the next location */ }
  }
  return null;
}

export async function GET() {
  const src = await load();
  if (!src) {
    return new Response('The runner script is not available on this server. Copy tools/hive-runner/hive-runner.mjs from the Hive Mind repository.\n', {
      status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  return new Response(src, {
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'content-disposition': 'inline; filename="hive-runner.mjs"',
      'cache-control': 'public, max-age=300',
      'x-content-type-options': 'nosniff',
    },
  });
}
