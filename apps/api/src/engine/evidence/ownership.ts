/**
 * Ownership proof for linked evidence. The owner places a per-submission token where only someone who controls
 * the artifact can put it:
 *
 *   website / link  — any ONE of:
 *       <meta name="hive-mind-verification" content="TOKEN">   on the submitted page (or the site's home page)
 *       https://<host>/.well-known/hive-mind.txt               containing the token
 *       DNS TXT record  hive-mind-verification=TOKEN            on the host (or its parent domain without "www.")
 *   git_repo (GitHub / GitLab, public)
 *       a file HIVE_MIND.txt containing the token on the default branch
 *
 *   pdf / document / image — 'not_applicable' (no way to prove control of a file; lower trust instead).
 *
 * All fetches go through net.ts (SSRF guard, timeouts, size caps). Tokens are random, per submission, and only ever
 * compared — never executed or rendered.
 */
import { randomBytes } from 'node:crypto';
import { parseRepoUrl, rawFileUrl } from './checks.js';
import { FetchFailure, safeFetch, safeResolveTxt } from './net.js';

export const META_NAME = 'hive-mind-verification';
export const WELL_KNOWN_PATH = '/.well-known/hive-mind.txt';
export const REPO_FILE = 'HIVE_MIND.txt';
export const DNS_PREFIX = 'hive-mind-verification=';

export const newOwnershipToken = () => `hm-${randomBytes(16).toString('hex')}`;

export function ownershipInstructions(kind: string, url: string | null, token: string | null) {
  if (!token || !url) return null;
  if (kind === 'git_repo') {
    return {
      methods: [{ key: 'repo_file', label: `Add a file ${REPO_FILE} to the default branch`, value: token, detail: `File name: ${REPO_FILE} (repository root). Contents: the token only.` }],
    };
  }
  let host = '';
  try { host = new URL(url).hostname; } catch { /* ignore */ }
  return {
    methods: [
      { key: 'meta', label: 'Add a meta tag to the page <head>', value: `<meta name="${META_NAME}" content="${token}">` },
      { key: 'well_known', label: `Or upload a file at https://${host}${WELL_KNOWN_PATH}`, value: token },
      { key: 'dns', label: `Or add a DNS TXT record on ${host}`, value: `${DNS_PREFIX}${token}` },
    ],
  };
}

export interface OwnershipResult { verified: boolean; method: string | null; attempts: { method: string; ok: boolean; detail: string }[] }

const hasToken = (text: string, token: string) => text.includes(token);

/** Find <meta name="hive-mind-verification" content="…"> values in HTML (attribute order independent). */
export function metaTokens(html: string): string[] {
  const out: string[] = [];
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!new RegExp(`name\\s*=\\s*["']?${META_NAME}["'\\s>/]`, 'i').test(tag)) continue;
    const m = /content\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    if (m) out.push((m[1] ?? m[2] ?? m[3] ?? '').trim());
  }
  return out;
}

async function attempt(method: string, fn: () => Promise<{ ok: boolean; detail: string }>) {
  try { return { method, ...(await fn()) }; } catch (e) {
    const detail = e instanceof FetchFailure ? `${e.reason}: ${e.message}` : e instanceof Error ? e.message : String(e);
    return { method, ok: false, detail };
  }
}

export async function verifyWebsiteOwnership(url: string, token: string): Promise<OwnershipResult> {
  const u = new URL(url);
  const attempts: OwnershipResult['attempts'] = [];
  const pages = [...new Set([url, `${u.origin}/`])];
  for (const page of pages) {
    const a = await attempt(`meta:${page}`, async () => {
      const r = await safeFetch(page, { maxBytes: 1_000_000, timeoutMs: 10_000 });
      if (!r.ok) return { ok: false, detail: `HTTP ${r.status}` };
      const found = metaTokens(r.text);
      return found.includes(token) ? { ok: true, detail: 'meta tag found' } : { ok: false, detail: found.length ? 'meta tag present with a different token' : 'meta tag not found' };
    });
    attempts.push(a);
    if (a.ok) return { verified: true, method: 'meta', attempts };
  }
  const wk = await attempt('well_known', async () => {
    const r = await safeFetch(`${u.origin}${WELL_KNOWN_PATH}`, { maxBytes: 4_096, timeoutMs: 8_000 });
    if (!r.ok) return { ok: false, detail: `HTTP ${r.status}` };
    return hasToken(r.text, token) ? { ok: true, detail: 'token found in well-known file' } : { ok: false, detail: 'file found but token missing' };
  });
  attempts.push(wk);
  if (wk.ok) return { verified: true, method: 'well_known', attempts };
  const hosts = [...new Set([u.hostname, u.hostname.replace(/^www\./, '')])];
  for (const h of hosts) {
    const d = await attempt(`dns:${h}`, async () => {
      const records = await safeResolveTxt(h);
      return records.some((r) => r.trim() === `${DNS_PREFIX}${token}`)
        ? { ok: true, detail: 'TXT record found' } : { ok: false, detail: records.length ? 'TXT records found, none match' : 'no TXT records' };
    });
    attempts.push(d);
    if (d.ok) return { verified: true, method: 'dns', attempts };
  }
  return { verified: false, method: null, attempts };
}

export async function verifyRepoOwnership(url: string, token: string, defaultBranch?: string | null): Promise<OwnershipResult> {
  const ref = parseRepoUrl(url);
  if (!ref) return { verified: false, method: null, attempts: [{ method: 'repo_file', ok: false, detail: 'unsupported repository URL' }] };
  const attempts: OwnershipResult['attempts'] = [];
  const branches = [...new Set([defaultBranch, 'HEAD'].filter((b): b is string => !!b))];
  for (const b of branches) {
    const a = await attempt(`repo_file:${b}`, async () => {
      const r = await safeFetch(rawFileUrl(ref, b, REPO_FILE), { maxBytes: 4_096, timeoutMs: 10_000 });
      if (!r.ok) return { ok: false, detail: `HTTP ${r.status}` };
      return hasToken(r.text, token) ? { ok: true, detail: `${REPO_FILE} contains the token` } : { ok: false, detail: `${REPO_FILE} found but token missing` };
    });
    attempts.push(a);
    if (a.ok) return { verified: true, method: 'repo_file', attempts };
  }
  return { verified: false, method: null, attempts };
}
