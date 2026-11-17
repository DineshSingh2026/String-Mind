/**
 * Static, automated checks per proof kind. NOTHING here clones, builds or executes submitted code — there is no
 * sandbox. Repos are inspected through the public GitHub/GitLab APIs and raw-file URLs; websites through a capped
 * GET of the page and a sample of internal links. All network goes through net.ts (SSRF guard, timeouts, caps).
 *
 * Each check returns { checks, content }: `checks` is stored on the submission, `content` is the untrusted text
 * handed to the judge (truncated by the pipeline).
 */
import { createHash } from 'node:crypto';
import { FetchFailure, safeFetch, type SafeFetchResult } from './net.js';

/* ───────────── URL parsing / normalisation ───────────── */

export interface RepoRef { host: 'github' | 'gitlab'; path: string; owner: string; name: string; canonical: string }

/** Parse a public GitHub/GitLab repository URL. Returns null for other hosts or malformed URLs. */
export function parseRepoUrl(raw: string): RepoRef | null {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const segs = u.pathname.split('/').filter(Boolean);
  if (host === 'github.com') {
    if (segs.length < 2) return null;
    const owner = segs[0]!.toLowerCase();
    const name = segs[1]!.replace(/\.git$/i, '').toLowerCase();
    if (!/^[a-z0-9-]{1,39}$/.test(owner) || !/^[a-z0-9._-]{1,100}$/.test(name)) return null;
    return { host: 'github', path: `${owner}/${name}`, owner, name, canonical: `https://github.com/${owner}/${name}` };
  }
  if (host === 'gitlab.com') {
    const cut = segs.indexOf('-');
    const parts = (cut >= 0 ? segs.slice(0, cut) : segs).map((s) => s.toLowerCase());
    if (parts.length < 2) return null;
    parts[parts.length - 1] = parts[parts.length - 1]!.replace(/\.git$/i, '');
    if (!parts.every((p) => /^[a-z0-9._-]{1,255}$/.test(p))) return null;
    const path = parts.join('/');
    return { host: 'gitlab', path, owner: parts.slice(0, -1).join('/'), name: parts[parts.length - 1]!, canonical: `https://gitlab.com/${path}` };
  }
  return null;
}

/** Canonical form of a web URL for duplicate detection (lower-case host, no default port / hash / trailing slash). */
export function normaliseWebUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  let s = u.toString();
  if (u.pathname !== '/' && s.endsWith('/') && !u.search) s = s.slice(0, -1);
  return s;
}

/** Hash used for duplicate / copy detection: file bytes, or the canonical URL (scheme-insensitive). */
export const fileHash = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');
export const urlHash = (canonical: string) => createHash('sha256').update(`url:${canonical.replace(/^https?:\/\//, '')}`).digest('hex');

/* ───────────── helpers ───────────── */

const now = () => new Date().toISOString();
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function tryFetch(url: string, opts: Parameters<typeof safeFetch>[1] = {}): Promise<SafeFetchResult | { error: string; reason: string }> {
  try { return await safeFetch(url, opts); } catch (e) {
    return { error: errMsg(e), reason: e instanceof FetchFailure ? e.reason : 'network' };
  }
}
const isErr = (r: unknown): r is { error: string; reason: string } => !!r && typeof r === 'object' && 'error' in r;

function jsonOf<T>(r: SafeFetchResult): T | null {
  try { return JSON.parse(r.text) as T; } catch { return null; }
}

/* ───────────── repository checks ───────────── */

const TEST_RE = /(^|\/)(tests?|__tests__|spec|specs)\/|\.(test|spec)\.[a-z0-9]+$|_test\.(go|py|rb|exs?)$|(^|\/)test_[^/]+\.py$|Tests?\.(cs|java|kt|swift)$/i;
const CI_RE = /^(\.github\/workflows\/[^/]+\.ya?ml|\.gitlab-ci\.ya?ml|\.circleci\/config\.ya?ml|Jenkinsfile|azure-pipelines\.ya?ml|\.travis\.ya?ml|bitbucket-pipelines\.ya?ml|\.drone\.ya?ml)$/i;
const MANIFEST_RE = /^(package\.json|requirements\.txt|pyproject\.toml|setup\.py|Pipfile|go\.mod|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?|Gemfile|composer\.json|mix\.exs|pubspec\.yaml|[^/]+\.csproj|[^/]+\.sln|Package\.swift|deno\.json)$/i;
const LICENCE_RE = /^(LICEN[CS]E|COPYING)(\.[a-z]+)?$/i;
const README_RE = /^README(\.[a-z]+)?$/i;
const CODE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|py|go|rs|java|kt|rb|php|cs|swift|scala|ex|exs|c|cc|cpp|h|hpp|sql|sol|vue|svelte|dart)$/i;
const VENDOR_RE = /(^|\/)(node_modules|vendor|dist|build|out|\.next|target|third_party|__pycache__|coverage)\//i;

export interface TreeEntry { path: string; type: 'blob' | 'tree'; size?: number }

export function readmeQuality(md: string) {
  const text = md.replace(/\r/g, '');
  const headings = (text.match(/^#{1,6}\s+\S/gm) ?? []).length + (text.match(/^.+\n[=-]{3,}$/gm) ?? []).length;
  const lower = text.toLowerCase();
  const sections = {
    install: /install|setup|getting started|quick ?start/.test(lower),
    usage: /usage|example|how to use|api/.test(lower),
    tests: /\btest(s|ing)?\b/.test(lower),
    licence: /licen[cs]e/.test(lower),
  };
  const codeBlocks = (text.match(/```/g) ?? []).length / 2 | 0;
  const words = text.split(/\s+/).filter(Boolean).length;
  const score = Math.min(100, Math.round(
    Math.min(words, 800) / 800 * 40 + Math.min(headings, 6) / 6 * 20 + Object.values(sections).filter(Boolean).length * 7.5 + Math.min(codeBlocks, 3) / 3 * 10,
  ));
  return { words, headings, codeBlocks, sections, heuristicScore: score };
}

/** Structural signals from a file tree (pure; exported for tests). */
export function treeSignals(entries: TreeEntry[]) {
  const files = entries.filter((e) => e.type === 'blob');
  const paths = files.map((f) => f.path);
  const root = paths.filter((p) => !p.includes('/'));
  const ext = new Map<string, number>();
  for (const p of paths) {
    const m = /\.([a-z0-9]+)$/i.exec(p);
    if (m) ext.set(m[1]!.toLowerCase(), (ext.get(m[1]!.toLowerCase()) ?? 0) + 1);
  }
  const testFiles = paths.filter((p) => TEST_RE.test(p) && !VENDOR_RE.test(p));
  const topDirs = [...new Set(entries.filter((e) => e.type === 'tree' && !e.path.includes('/')).map((e) => e.path))];
  return {
    fileCount: files.length,
    topLevel: [...new Set([...topDirs.map((d) => `${d}/`), ...root])].slice(0, 40),
    extensions: Object.fromEntries([...ext.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)),
    tests: { present: testFiles.length > 0, count: testFiles.length, sample: testFiles.slice(0, 5) },
    ci: { present: paths.some((p) => CI_RE.test(p)), files: paths.filter((p) => CI_RE.test(p)).slice(0, 5) },
    readme: root.find((p) => README_RE.test(p)) ?? null,
    manifests: paths.filter((p) => MANIFEST_RE.test(p.split('/').pop()!) && p.split('/').length <= 2 && !VENDOR_RE.test(p)).slice(0, 5),
    licenceFile: root.find((p) => LICENCE_RE.test(p)) ?? null,
    vendoredFiles: paths.filter((p) => VENDOR_RE.test(p)).length,
  };
}

/** Choose up to `n` representative source files (not tests, not vendored, prefer src/lib/app). */
export function pickSourceSample(entries: TreeEntry[], n = 5): string[] {
  const cands = entries.filter((e) => e.type === 'blob' && CODE_EXT_RE.test(e.path) && !VENDOR_RE.test(e.path) && !TEST_RE.test(e.path)
    && (e.size == null || (e.size >= 200 && e.size <= 40_000)));
  const rank = (p: string) => (/^(src|lib|app|server|api|pkg|internal|cmd)\//i.test(p) ? 0 : 1) + p.split('/').length * 0.01;
  return cands.sort((a, b) => rank(a.path) - rank(b.path) || (b.size ?? 0) - (a.size ?? 0)).slice(0, n).map((e) => e.path);
}

interface RepoMeta {
  defaultBranch: string; description: string | null; licence: string | null; fork: boolean; archived: boolean;
  stars: number | null; createdAt: string | null; pushedAt: string | null;
}

const ghHeaders = () => ({
  accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
  ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
});

function rateLimited(r: SafeFetchResult) {
  return (r.status === 403 || r.status === 429) && (r.headers['x-ratelimit-remaining'] === '0' || r.status === 429 || /rate limit/i.test(r.text));
}

export function rawFileUrl(ref: RepoRef, branch: string, path: string): string {
  const p = path.split('/').map(encodeURIComponent).join('/');
  return ref.host === 'github'
    ? `https://raw.githubusercontent.com/${ref.path}/${encodeURIComponent(branch)}/${p}`
    : `https://gitlab.com/${ref.path}/-/raw/${encodeURIComponent(branch)}/${p}`;
}

async function fetchRaw(ref: RepoRef, branch: string, path: string, maxBytes: number): Promise<{ text: string; truncated: boolean } | null> {
  const r = await tryFetch(rawFileUrl(ref, branch, path), { maxBytes, timeoutMs: 10_000 });
  if (isErr(r) || !r.ok) return null;
  if (r.body.includes(0)) return null; // binary
  return { text: r.text, truncated: r.truncated };
}

async function githubCollect(ref: RepoRef, notes: string[]) {
  const api = (p: string, maxBytes = 3_000_000) => tryFetch(`https://api.github.com/repos/${ref.path}${p}`, { headers: ghHeaders(), maxBytes, timeoutMs: 12_000 });
  let limited = false;
  const guard = (r: Awaited<ReturnType<typeof api>>): SafeFetchResult | null => {
    if (isErr(r)) { notes.push(`GitHub API: ${r.error}`); return null; }
    if (rateLimited(r)) { limited = true; notes.push('GitHub API rate limit reached — some repository metadata could not be collected; use "Recheck" later.'); return null; }
    return r;
  };
  const metaRes = guard(await api(''));
  if (metaRes && metaRes.status === 404) return { exists: false as const, limited };
  const m = metaRes?.ok ? jsonOf<Record<string, any>>(metaRes) : null;
  const meta: RepoMeta | null = m ? {
    defaultBranch: String(m.default_branch ?? 'HEAD'), description: m.description ?? null, licence: m.license?.spdx_id ?? null,
    fork: !!m.fork, archived: !!m.archived, stars: typeof m.stargazers_count === 'number' ? m.stargazers_count : null,
    createdAt: m.created_at ?? null, pushedAt: m.pushed_at ?? null,
  } : null;
  const branch = meta?.defaultBranch ?? 'HEAD';
  let languages: Record<string, number> | null = null;
  let tree: TreeEntry[] = [];
  let treeTruncated = false;
  let commits: { total: number | null; sample: number; authors: number; latestAt: string | null; earliestInSampleAt: string | null } | null = null;
  if (!limited) {
    const l = guard(await api('/languages'));
    if (l?.ok) languages = jsonOf<Record<string, number>>(l);
  }
  if (!limited) {
    const t = guard(await api(`/git/trees/${encodeURIComponent(branch)}?recursive=1`, 6_000_000));
    const tj = t?.ok ? jsonOf<{ tree?: { path: string; type: string; size?: number }[]; truncated?: boolean }>(t) : null;
    if (tj?.tree) {
      tree = tj.tree.slice(0, 20_000).map((e) => ({ path: e.path, type: e.type === 'tree' ? 'tree' : 'blob', size: e.size }));
      treeTruncated = !!tj.truncated || (t?.truncated ?? false);
    }
  }
  if (!limited) {
    const c = guard(await api('/commits?per_page=100'));
    const list = c?.ok ? jsonOf<{ author?: { login?: string } | null; commit?: { author?: { name?: string; date?: string } } }[]>(c) : null;
    if (Array.isArray(list)) {
      let total: number | null = list.length < 100 ? list.length : null;
      if (total == null && !limited) {
        const one = guard(await api('/commits?per_page=1', 200_000));
        const last = one?.headers.link?.match(/[?&]page=(\d+)>;\s*rel="last"/);
        total = last ? Number(last[1]) : null;
      }
      const authors = new Set(list.map((x) => x.author?.login ?? x.commit?.author?.name ?? '').filter(Boolean));
      const dates = list.map((x) => x.commit?.author?.date).filter((d): d is string => !!d).sort();
      commits = { total, sample: list.length, authors: authors.size, latestAt: dates[dates.length - 1] ?? null, earliestInSampleAt: dates[0] ?? null };
    }
  }
  return { exists: true as const, limited, meta, branch, languages, tree, treeTruncated, commits };
}

async function gitlabCollect(ref: RepoRef, notes: string[]) {
  const enc = encodeURIComponent(ref.path);
  const api = (p: string, maxBytes = 3_000_000) => tryFetch(`https://gitlab.com/api/v4/projects/${enc}${p}`, { maxBytes, timeoutMs: 12_000, headers: { accept: 'application/json' } });
  let limited = false;
  const guard = (r: Awaited<ReturnType<typeof api>>): SafeFetchResult | null => {
    if (isErr(r)) { notes.push(`GitLab API: ${r.error}`); return null; }
    if (r.status === 429) { limited = true; notes.push('GitLab API rate limit reached — some repository metadata could not be collected; use "Recheck" later.'); return null; }
    return r;
  };
  const metaRes = guard(await api('?license=true'));
  if (metaRes && (metaRes.status === 404 || metaRes.status === 401)) return { exists: false as const, limited };
  const m = metaRes?.ok ? jsonOf<Record<string, any>>(metaRes) : null;
  const meta: RepoMeta | null = m ? {
    defaultBranch: String(m.default_branch ?? 'main'), description: m.description ?? null, licence: m.license?.key ?? m.license?.name ?? null,
    fork: !!m.forked_from_project, archived: !!m.archived, stars: typeof m.star_count === 'number' ? m.star_count : null,
    createdAt: m.created_at ?? null, pushedAt: m.last_activity_at ?? null,
  } : null;
  const branch = meta?.defaultBranch ?? 'main';
  let languages: Record<string, number> | null = null;
  const tree: TreeEntry[] = [];
  let treeTruncated = false;
  let commits: { total: number | null; sample: number; authors: number; latestAt: string | null; earliestInSampleAt: string | null } | null = null;
  if (!limited) {
    const l = guard(await api('/languages'));
    if (l?.ok) languages = jsonOf<Record<string, number>>(l);
  }
  for (let page = 1; page <= 5 && !limited; page++) {
    const t = guard(await api(`/repository/tree?recursive=true&per_page=100&page=${page}&ref=${encodeURIComponent(branch)}`));
    const list = t?.ok ? jsonOf<{ path: string; type: string }[]>(t) : null;
    if (!Array.isArray(list)) break;
    for (const e of list) tree.push({ path: e.path, type: e.type === 'tree' ? 'tree' : 'blob' });
    if (!t!.headers['x-next-page']) break;
    if (page === 5) treeTruncated = true;
  }
  if (!limited) {
    const c = guard(await api(`/repository/commits?per_page=100&ref_name=${encodeURIComponent(branch)}`));
    const list = c?.ok ? jsonOf<{ author_name?: string; author_email?: string; created_at?: string }[]>(c) : null;
    if (Array.isArray(list)) {
      const totalHdr = Number(c!.headers['x-total']);
      const authors = new Set(list.map((x) => x.author_name ?? '').filter(Boolean));
      const dates = list.map((x) => x.created_at).filter((d): d is string => !!d).sort();
      commits = {
        total: Number.isFinite(totalHdr) && totalHdr > 0 ? totalHdr : list.length < 100 ? list.length : null,
        sample: list.length, authors: authors.size, latestAt: dates[dates.length - 1] ?? null, earliestInSampleAt: dates[0] ?? null,
      };
    }
  }
  return { exists: true as const, limited, meta, branch, languages, tree, treeTruncated, commits };
}

export interface CheckOutcome { ok: boolean; checks: Record<string, unknown>; content: string; error?: string }

export async function checkRepo(rawUrl: string): Promise<CheckOutcome> {
  const ref = parseRepoUrl(rawUrl);
  if (!ref) return { ok: false, checks: { kind: 'git_repo', checkedAt: now() }, content: '', error: 'Only public GitHub or GitLab repository URLs are supported' };
  const notes: string[] = [];
  const c = ref.host === 'github' ? await githubCollect(ref, notes) : await gitlabCollect(ref, notes);
  if (!c.exists) {
    return { ok: false, checks: { kind: 'git_repo', host: ref.host, repo: ref.path, checkedAt: now(), notes }, content: '', error: 'Repository not found or not public' };
  }
  const signals = c.tree.length ? treeSignals(c.tree) : null;
  // README, manifests and a small source sample via raw URLs (not the rate-limited API).
  const readmeName = signals?.readme ?? 'README.md';
  const readme = await fetchRaw(ref, c.branch, readmeName, 60_000);
  const manifests: { path: string; text: string }[] = [];
  for (const p of signals?.manifests.slice(0, 3) ?? []) {
    const r = await fetchRaw(ref, c.branch, p, 15_000);
    if (r) manifests.push({ path: p, text: r.text });
  }
  const samples: { path: string; text: string; truncated: boolean }[] = [];
  for (const p of pickSourceSample(c.tree)) {
    const r = await fetchRaw(ref, c.branch, p, 20_000);
    if (r) samples.push({ path: p, text: r.text, truncated: r.truncated });
  }
  const langTotal = c.languages ? Object.values(c.languages).reduce((a, b) => a + b, 0) : 0;
  const languages = c.languages && langTotal
    ? Object.fromEntries(Object.entries(c.languages).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => [k, Math.round((v / langTotal) * 1000) / 10]))
    : null;
  const latest = c.commits?.latestAt ?? c.meta?.pushedAt ?? null;
  const daysSince = latest ? Math.round((Date.now() - Date.parse(latest)) / 86_400_000) : null;
  const rq = readme ? readmeQuality(readme.text) : null;
  const checks = {
    kind: 'git_repo', host: ref.host, repo: ref.path, url: ref.canonical, checkedAt: now(), defaultBranch: c.branch,
    rateLimited: c.limited, notes,
    meta: c.meta, languages,
    structure: signals ? { fileCount: signals.fileCount, topLevel: signals.topLevel, extensions: signals.extensions, treeTruncated: c.treeTruncated, vendoredFiles: signals.vendoredFiles } : null,
    tests: signals?.tests ?? null,
    ci: signals?.ci ?? null,
    readme: readme ? { file: readmeName, ...rq, truncated: readme.truncated } : { file: null, present: false },
    manifests: manifests.map((m) => m.path),
    licence: c.meta?.licence ?? signals?.licenceFile ?? null,
    commits: c.commits ? { ...c.commits, daysSinceLast: daysSince, recent: daysSince != null && daysSince <= 180 } : null,
    sourceSample: samples.map((s) => s.path),
    codeExecuted: false,
  };
  const content = [
    `Repository: ${ref.canonical} (${ref.host})`,
    c.meta?.description ? `Description: ${c.meta.description}` : '',
    languages ? `Languages: ${Object.entries(languages).map(([k, v]) => `${k} ${v}%`).join(', ')}` : '',
    signals ? `Files: ${signals.fileCount}${c.treeTruncated ? '+' : ''}; top level: ${signals.topLevel.join(', ')}` : '',
    signals ? `Tests: ${signals.tests.present ? `${signals.tests.count} test files (e.g. ${signals.tests.sample.join(', ')})` : 'none found'}; CI: ${signals.ci.present ? signals.ci.files.join(', ') : 'none found'}; licence: ${checks.licence ?? 'none'}` : '',
    c.commits ? `Commits: ${c.commits.total ?? `${c.commits.sample}+`} total, ${c.commits.authors} author(s) in last ${c.commits.sample}, latest ${c.commits.latestAt ?? 'unknown'}` : '',
    c.meta?.fork ? 'Note: this repository is a FORK.' : '',
    readme ? `\n=== README (${readmeName}) ===\n${readme.text}` : '\n(no README found)',
    ...manifests.map((m) => `\n=== ${m.path} ===\n${m.text}`),
    ...samples.map((s) => `\n=== source: ${s.path}${s.truncated ? ' (truncated)' : ''} ===\n${s.text}`),
  ].filter(Boolean).join('\n');
  const enough = !!(readme || samples.length || signals);
  return { ok: enough, checks, content, error: enough ? undefined : 'Could not read the repository contents (API limits or network); try "Recheck" later' };
}

/* ───────────── website checks ───────────── */

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr|\/section|\/article)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' '; }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t\f\v\r]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

const attr = (tag: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
const attrVal = (tag: string, name: string) => { const m = attr(tag, name); return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null; };

/** Accessibility + SEO signals from HTML (pure; exported for tests). */
export function htmlSignals(html: string, pageUrl: string) {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, ' ').trim() ?? null;
  const metaTags = html.match(/<meta\b[^>]*>/gi) ?? [];
  const metaDescription = metaTags.map((t) => (/name\s*=\s*["']?description/i.test(t) ? attrVal(t, 'content') : null)).find((x) => x != null) ?? null;
  const viewport = metaTags.some((t) => /name\s*=\s*["']?viewport/i.test(t));
  const htmlTag = /<html\b[^>]*>/i.exec(html)?.[0] ?? '';
  const lang = htmlTag ? attrVal(htmlTag, 'lang') : null;
  const imgs = html.match(/<img\b[^>]*>/gi) ?? [];
  const withAlt = imgs.filter((t) => attr(t, 'alt') != null).length;
  const levels = [...html.matchAll(/<h([1-6])\b/gi)].map((m) => Number(m[1]));
  let skipped = 0;
  for (let i = 1; i < levels.length; i++) if (levels[i]! - levels[i - 1]! > 1) skipped++;
  const labelsFor = new Set([...html.matchAll(/<label\b[^>]*\bfor\s*=\s*["']?([^"'\s>]+)/gi)].map((m) => m[1]!));
  const fields = (html.match(/<(input|select|textarea)\b[^>]*>/gi) ?? []).filter((t) => {
    const type = (attrVal(t, 'type') ?? '').toLowerCase();
    return !['hidden', 'submit', 'button', 'image', 'reset'].includes(type);
  });
  const labelled = fields.filter((t) => {
    const id = attrVal(t, 'id');
    return (id && labelsFor.has(id)) || attr(t, 'aria-label') || attr(t, 'aria-labelledby') || attr(t, 'title');
  }).length;
  let origin = '';
  try { origin = new URL(pageUrl).origin; } catch { /* ignore */ }
  const internal = new Set<string>();
  let external = 0;
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const href = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!href || href.startsWith('#') || /^(mailto|tel|javascript|data):/i.test(href)) continue;
    try {
      const u = new URL(href, pageUrl);
      u.hash = '';
      if (u.origin === origin) internal.add(u.toString()); else external++;
    } catch { /* ignore malformed */ }
  }
  return {
    title, metaDescription, viewport, lang,
    images: { total: imgs.length, withAlt, altCoverage: imgs.length ? Math.round((withAlt / imgs.length) * 100) : null },
    headings: { h1: levels.filter((l) => l === 1).length, total: levels.length, skippedLevels: skipped, order: levels.slice(0, 30) },
    forms: { fields: fields.length, labelled, labelCoverage: fields.length ? Math.round((labelled / fields.length) * 100) : null },
    links: { internal: internal.size, external },
    internalLinks: [...internal],
  };
}

export async function checkWebsite(rawUrl: string, opts: { sampleLinks?: number } = {}): Promise<CheckOutcome & { html?: string }> {
  const base = { kind: 'website', url: rawUrl, checkedAt: now() };
  const r = await tryFetch(rawUrl, { maxBytes: 2_000_000, timeoutMs: 12_000, headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.5' } });
  if (isErr(r)) return { ok: false, checks: { ...base, reachable: false, error: r.error, blocked: r.reason === 'blocked' }, content: '', error: `Site not reachable: ${r.error}` };
  const ctype = r.headers['content-type'] ?? '';
  const finalHttps = r.url.startsWith('https://');
  const reach = { reachable: r.ok, status: r.status, finalUrl: r.url, redirects: r.redirects, https: finalHttps, responseMs: r.elapsedMs, contentType: ctype, bytes: r.body.length, truncated: r.truncated };
  if (!r.ok) return { ok: false, checks: { ...base, ...reach }, content: '', error: `Site returned HTTP ${r.status}` };
  const isHtml = /html|xml/i.test(ctype) || /<html|<body|<!doctype/i.test(r.text.slice(0, 2000));
  if (!isHtml) {
    const text = /^text\//i.test(ctype) && !r.body.includes(0) ? r.text : '';
    return { ok: !!text, checks: { ...base, ...reach, html: false }, content: text, error: text ? undefined : 'URL does not serve an HTML page or text' };
  }
  const sig = htmlSignals(r.text, r.url);
  const sample = sig.internalLinks.slice(0, Math.min(20, opts.sampleLinks ?? 20));
  const broken: { url: string; status: number | null; error?: string }[] = [];
  let checked = 0;
  for (const link of sample) {
    let lr = await tryFetch(link, { method: 'HEAD', timeoutMs: 6_000 });
    if (!isErr(lr) && (lr.status === 405 || lr.status === 501)) lr = await tryFetch(link, { timeoutMs: 6_000, maxBytes: 64_000 });
    if (isErr(lr)) {
      if (lr.reason === 'blocked') continue; // never probed
      checked++;
      broken.push({ url: link, status: null, error: lr.error });
    } else {
      checked++;
      if (lr.status >= 400) broken.push({ url: link, status: lr.status });
    }
  }
  const text = htmlToText(r.text);
  const { internalLinks: _l, ...signals } = sig;
  const checks = {
    ...base, ...reach, html: true, ...signals,
    brokenLinks: { sampled: sample.length, checked, broken: broken.length, items: broken.slice(0, 20) },
    textChars: text.length,
  };
  const content = [
    `Website: ${r.url}`, `Title: ${sig.title ?? '(none)'}`, sig.metaDescription ? `Meta description: ${sig.metaDescription}` : '',
    `HTTPS: ${finalHttps ? 'yes' : 'no'}; response ${r.elapsedMs} ms; lang: ${sig.lang ?? 'missing'}; images with alt: ${sig.images.withAlt}/${sig.images.total}; ` +
      `form fields labelled: ${sig.forms.labelled}/${sig.forms.fields}; headings skipped levels: ${sig.headings.skippedLevels}; broken internal links: ${broken.length}/${checked}`,
    `\n=== Page text ===\n${text}`,
  ].filter(Boolean).join('\n');
  return { ok: true, checks, content, html: r.text };
}

/* ───────────── documents & images ───────────── */

export function documentChecks(text: string, mimeType: string, sizeBytes: number, raw?: Buffer) {
  const words = text.split(/\s+/).filter(Boolean).length;
  const lines = text.split('\n');
  const pages = mimeType === 'application/pdf' && raw ? (raw.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length || null : null;
  return {
    kind: mimeType === 'application/pdf' ? 'pdf' : 'document', mimeType, sizeBytes, checkedAt: now(),
    text: {
      extracted: true, chars: text.length, words, lines: lines.length,
      headings: lines.filter((l) => /^#{1,6}\s+\S/.test(l) || /^[A-Z][A-Z0-9 ,&:-]{4,60}$/.test(l.trim())).length,
      listItems: lines.filter((l) => /^\s*([-*•]|\d+[.)])\s+\S/.test(l)).length,
      tables: lines.filter((l) => /^\s*\|.*\|\s*$/.test(l)).length,
    },
    pages,
    structure: words < 150 ? 'very short' : words < 600 ? 'short' : words < 3000 ? 'medium' : 'long',
  };
}

export type ImageType = 'png' | 'jpeg' | 'gif' | 'webp';
export const IMAGE_MIME: Record<ImageType, string> = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

/** Detect image type by magic bytes and read dimensions (no decoding, no OCR). */
export function imageInfo(buf: Buffer): { type: ImageType; width: number | null; height: number | null } | null {
  if (buf.length >= 24 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { type: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 10 && (buf.subarray(0, 6).toString('latin1') === 'GIF87a' || buf.subarray(0, 6).toString('latin1') === 'GIF89a')) {
    return { type: 'gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.length >= 30 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
    const chunk = buf.subarray(12, 16).toString('latin1');
    if (chunk === 'VP8X') return { type: 'webp', width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    if (chunk === 'VP8L' && buf.length >= 25) { const b = buf.readUInt32LE(21); return { type: 'webp', width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }; }
    if (chunk === 'VP8 ' && buf.length >= 30) return { type: 'webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    return { type: 'webp', width: null, height: null };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { type: 'jpeg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      i += 2 + buf.readUInt16BE(i + 2);
    }
    return { type: 'jpeg', width: null, height: null };
  }
  return null;
}
