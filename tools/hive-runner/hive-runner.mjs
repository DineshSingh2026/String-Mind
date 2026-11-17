#!/usr/bin/env node
/**
 * hive-runner — keep a Hive Mind agent online. Dependency-free (Node >= 20, global fetch only).
 *
 *   HIVE_URL=https://your-hive-mind HIVE_AGENT_TOKEN=sm_at_... node hive-runner.mjs --backend command "python my_agent.py"
 *   HIVE_URL=... HIVE_AGENT_TOKEN=... RUNNER_BASE_URL=http://localhost:11434/v1 RUNNER_MODEL=llama3.1 node hive-runner.mjs --backend openai-compatible
 *   HIVE_URL=... HIVE_AGENT_TOKEN=... ANTHROPIC_API_KEY=... node hive-runner.mjs --backend anthropic
 *
 * It long-polls GET /agent-api/tasks/next, hands each task to a backend that runs on YOUR machine, and posts the
 * answer back. Provider keys (RUNNER_API_KEY, ANTHROPIC_API_KEY) are only ever sent to the provider you configure —
 * never to Hive Mind. Hive Mind only sees the agent token and the answers.
 *
 * Exit codes: 0 clean stop (Ctrl+C) · 1 bad usage/config · 2 token invalid or revoked (get a new link) · 3 agent suspended.
 */
import { spawn } from 'node:child_process';
import process from 'node:process';

const VERSION = '1.0.0';
const POLL_WAIT_S = 25;
const HEARTBEAT_MS = 60_000;
const PAUSED_SLEEP_MS = 5_000; // the server already holds polls of a paused agent for ~25 s
const MAX_BACKOFF_MS = 60_000;
const MAX_ANSWER_CHARS = 20_000;

/* ───────────── args & config ───────────── */

function usage(msg) {
  if (msg) console.error(`hive-runner: ${msg}\n`);
  console.error(`Usage: node hive-runner.mjs --backend <command "<shell command>" | openai-compatible | anthropic> [options]

Options:
  --url <url>           Hive Mind URL (default: env HIVE_URL), e.g. https://hive.example.com
  --token <sm_at_...>   Agent token (default: env HIVE_AGENT_TOKEN; prefer the env var so it stays out of shell history)
  --claim <SM-XXXX-XXXX> Claim a fresh connection code first and print the new agent token once (stderr)
  --once                Exit after the task queue is empty (no long-poll); handy for testing and cron
  --no-auto-verify      Send connection checks (verify / health tasks) to the backend instead of answering them directly
  --task-timeout <s>    Max seconds a backend may spend on one task (default 600, capped by the task deadline)
  --quiet               Only log errors
  -h, --help            Show this help

Env for backends:
  command            the command after --backend command (task JSON on stdin, answer on stdout)
  openai-compatible  RUNNER_BASE_URL (e.g. http://localhost:11434/v1 for Ollama, http://localhost:1234/v1 for LM Studio),
                     RUNNER_MODEL, RUNNER_API_KEY (optional for local servers)
  anthropic          ANTHROPIC_API_KEY, RUNNER_MODEL (default claude-opus-5-5), RUNNER_MAX_TOKENS (default 16000)`);
  process.exit(msg ? 1 : 0);
}

function parseArgs(argv) {
  const o = { backend: null, command: null, url: process.env.HIVE_URL, token: process.env.HIVE_AGENT_TOKEN, claim: process.env.HIVE_CLAIM_CODE,
    once: false, autoVerify: true, taskTimeoutS: 600, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined) usage(`${a} needs a value`); return v; };
    if (a === '-h' || a === '--help') usage();
    else if (a === '--backend') {
      o.backend = val();
      if (o.backend === 'command' && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) o.command = argv[++i];
    } else if (a === '--command' || a === '--cmd') o.command = val();
    else if (a === '--url') o.url = val();
    else if (a === '--token') o.token = val();
    else if (a === '--claim') o.claim = val();
    else if (a === '--once') o.once = true;
    else if (a === '--no-auto-verify') o.autoVerify = false;
    else if (a === '--task-timeout') o.taskTimeoutS = Math.max(5, Number(val()) || 600);
    else if (a === '--quiet') o.quiet = true;
    else usage(`unknown argument: ${a}`);
  }
  if (!o.backend) usage('--backend is required');
  if (!['command', 'openai-compatible', 'anthropic'].includes(o.backend)) usage(`unknown backend "${o.backend}"`);
  if (o.backend === 'command' && !o.command) usage('--backend command needs a shell command, e.g. --backend command "python agent.py"');
  if (o.backend === 'openai-compatible' && (!process.env.RUNNER_BASE_URL || !process.env.RUNNER_MODEL)) usage('openai-compatible needs RUNNER_BASE_URL and RUNNER_MODEL');
  if (o.backend === 'anthropic' && !process.env.ANTHROPIC_API_KEY) usage('anthropic needs ANTHROPIC_API_KEY');
  if (!o.url) usage('set HIVE_URL (or --url) to your Hive Mind address');
  if (!o.token && !o.claim) usage('set HIVE_AGENT_TOKEN (or --claim SM-XXXX-XXXX to claim a new connection code)');
  if (o.token && !o.token.startsWith('sm_at_')) usage('the agent token must start with sm_at_');
  return o;
}

/** "https://hive.example" → ".../api/agent-api"; a URL already ending in /agent-api is used as-is (direct API access). */
function apiBase(url) {
  const u = url.replace(/\/+$/, '');
  return /\/agent-api$/.test(u) ? u : `${u}/api/agent-api`;
}

/* ───────────── logging ───────────── */

let QUIET = false;
const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => { if (!QUIET) console.log(`[${ts()}]`, ...a); };
const warn = (...a) => console.error(`[${ts()}]`, ...a);

/* ───────────── shutdown ───────────── */

const stop = new AbortController();
let stopping = false;
process.on('SIGINT', () => {
  if (stopping) { warn('Forced exit.'); process.exit(130); }
  stopping = true;
  warn('Stopping… (finishing the current task; press Ctrl+C again to force)');
  stop.abort();
});
process.on('SIGTERM', () => { stopping = true; stop.abort(); });

const sleep = (ms) => new Promise((resolve) => {
  if (stop.signal.aborted) return resolve();
  const t = setTimeout(done, ms);
  function done() { clearTimeout(t); stop.signal.removeEventListener('abort', done); resolve(); }
  stop.signal.addEventListener('abort', done, { once: true });
});

/* ───────────── Hive Mind client ───────────── */

class HiveError extends Error {
  constructor(status, message, retryAfterS) { super(message); this.status = status; this.retryAfterS = retryAfterS; }
}

function makeClient(base, getToken) {
  return async function hive(method, path, { body, timeoutMs = 30_000, abortable = false } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const onStop = () => ctrl.abort();
    if (abortable) stop.signal.addEventListener('abort', onStop, { once: true });
    try {
      const token = getToken();
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), 'user-agent': `hive-runner/${VERSION}` },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      if (!res.ok) {
        const retry = Number(res.headers.get('retry-after'));
        throw new HiveError(res.status, json?.error?.message ?? `HTTP ${res.status}`, Number.isFinite(retry) && retry > 0 ? retry : undefined);
      }
      return { status: res.status, json, paused: res.headers.get('x-hive-paused') === 'true' };
    } finally {
      clearTimeout(timer);
      if (abortable) stop.signal.removeEventListener('abort', onStop);
    }
  };
}

/* ───────────── backends ───────────── */

/** Messages as plain {role, content} with string content; Hive Mind tasks are text-only. */
const taskMessages = (task) => (task.messages ?? []).map((m) => ({ role: m.role, content: String(m.content ?? '') }));

function commandBackend(cmd) {
  return (task, timeoutMs) => new Promise((resolve, reject) => {
    const child = spawn(cmd, { shell: true, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
    let out = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`command timed out after ${Math.round(timeoutMs / 1000)}s`)); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; if (out.length > MAX_ANSWER_CHARS * 2) child.kill(); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`command exited with code ${code}`));
      else resolve(out.trim());
    });
    child.stdin.on('error', () => undefined); // the command may not read stdin
    child.stdin.end(JSON.stringify({ id: task.id, kind: task.kind, system: task.system, messages: taskMessages(task), deadline: task.deadline }));
  });
}

function openAiBackend() {
  const base = process.env.RUNNER_BASE_URL.replace(/\/+$/, '');
  const model = process.env.RUNNER_MODEL;
  const key = process.env.RUNNER_API_KEY;
  return async (task, timeoutMs) => {
    const messages = [...(task.system ? [{ role: 'system', content: task.system }] : []), ...taskMessages(task)];
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model, messages }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`model server ${res.status}: ${json?.error?.message ?? JSON.stringify(json)?.slice(0, 200)}`);
    const text = json?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new Error('model server returned no message content');
    return text.trim();
  };
}

function anthropicBackend() {
  const key = process.env.ANTHROPIC_API_KEY;
  const model = process.env.RUNNER_MODEL || 'claude-opus-5-5';
  const maxTokens = Number(process.env.RUNNER_MAX_TOKENS) || 16000;
  return async (task, timeoutMs) => {
    // The Messages API takes the system prompt separately; any system-role task message is folded into it.
    const sys = [task.system, ...taskMessages(task).filter((m) => m.role === 'system').map((m) => m.content)].filter(Boolean).join('\n\n');
    const messages = taskMessages(task).filter((m) => m.role !== 'system').map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
    if (!messages.length || messages[0].role !== 'user') messages.unshift({ role: 'user', content: '(no message)' });
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2026-10-21' },
      body: JSON.stringify({ model, max_tokens: maxTokens, ...(sys ? { system: sys } : {}), messages }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${json?.error?.message ?? 'request failed'}`);
    if (json?.stop_reason === 'refusal') return 'I can\'t help with this task.';
    const text = (json?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    if (!text) throw new Error(`Anthropic API returned no text (stop_reason ${json?.stop_reason ?? 'unknown'})`);
    return text;
  };
}

/** Connection checks ask for one exact string; the runner answers them itself so a model can't garble them. */
function autoAnswer(task) {
  if (task.kind !== 'verify' && task.kind !== 'health') return null;
  const last = taskMessages(task).at(-1)?.content ?? '';
  const m = /Reply with exactly this text and nothing else:\s*(\S+)/.exec(last);
  return m ? m[1] : null;
}

/* ───────────── main loop ───────────── */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  QUIET = opts.quiet;
  const base = apiBase(opts.url);
  let token = opts.token;
  const hive = makeClient(base, () => token);
  const backend = opts.backend === 'command' ? commandBackend(opts.command) : opts.backend === 'openai-compatible' ? openAiBackend() : anthropicBackend();

  if (opts.claim) {
    const r = await hive('POST', '/claim', { body: { claimCode: opts.claim, agent: { framework: `hive-runner/${VERSION} (${opts.backend})`, ...(process.env.RUNNER_MODEL ? { model: process.env.RUNNER_MODEL } : {}) } } })
      .catch((e) => { warn(`Claim failed: ${e.message}`); process.exitCode = e.status === 401 || e.status === 404 || e.status === 410 ? 2 : 1; throw new ExitNow(); });
    token = r.json.agentToken;
    console.error(`\nClaimed. Your agent token (shown once — store it somewhere safe and use HIVE_AGENT_TOKEN next time):\n${token}\n`);
  }

  let me;
  for (let attempt = 0; !me; attempt++) {
    try {
      me = await hive('GET', '/me');
    } catch (e) {
      if (!(e instanceof HiveError) && attempt >= 5) return fatal(e);
      if (e instanceof HiveError && e.status !== 429 && e.status < 500) return fatal(e);
      const waitS = e.retryAfterS ?? Math.min(2 ** (attempt + 1), 60);
      warn(`${e.status === 429 ? 'Rate limited by Hive Mind' : `Cannot reach Hive Mind (${e.message})`} — retrying in ${waitS}s.`);
      await sleep(waitS * 1000);
      if (stopping) return;
    }
  }
  let paused = !!me.json?.paused;
  log(`hive-runner ${VERSION} · agent "${me.json?.name}" · backend ${opts.backend} · ${base}`);
  if (paused) log('Agent is PAUSED by its owner — waiting for resume (no tasks are delivered while paused).');

  const setPaused = (p) => {
    if (p === paused) return;
    paused = p;
    log(p ? 'Agent was PAUSED by its owner — waiting for resume.' : 'Agent RESUMED — taking tasks again.');
  };

  // heartbeat: keeps the agent "online" while a long task runs, and notices pause/resume.
  let lastHeartbeat = Date.now();
  const hb = setInterval(() => {
    if (stopping || Date.now() - lastHeartbeat < HEARTBEAT_MS) return;
    lastHeartbeat = Date.now();
    hive('POST', '/heartbeat').then((r) => setPaused(!!r.json?.paused)).catch((e) => { if (e.status === 401 || e.status === 403) { pendingFatal = e; stop.abort(); } });
  }, 5_000);
  hb.unref();

  let pendingFatal = null;
  let backoff = 2_000;
  let handled = 0;
  while (!stopping) {
    try {
      const r = await hive('GET', `/tasks/next?wait=${opts.once ? 0 : POLL_WAIT_S}`, { timeoutMs: (POLL_WAIT_S + 15) * 1000, abortable: true });
      lastHeartbeat = Date.now();
      backoff = 2_000;
      if (r.status === 204) {
        setPaused(r.paused);
        if (opts.once && !r.paused) break;
        if (opts.once && r.paused) { log('Paused; nothing to do in --once mode.'); break; }
        if (r.paused) await sleep(PAUSED_SLEEP_MS); // be gentle while paused
        continue;
      }
      setPaused(false);
      const task = r.json?.task;
      if (!task?.id) continue;
      await handleTask(task);
      handled++;
    } catch (e) {
      if (e instanceof ExitNow) throw e;
      if (pendingFatal) break;
      if (stopping && (e.name === 'AbortError' || e.name === 'TimeoutError')) break;
      if (e instanceof HiveError && (e.status === 401 || e.status === 403)) return fatal(e);
      if (e instanceof HiveError && e.status === 429) {
        const s = e.retryAfterS ?? 30;
        warn(`Rate limited by Hive Mind — waiting ${s}s.`);
        await sleep(s * 1000);
        continue;
      }
      warn(`Poll failed: ${e.message} — retrying in ${Math.round(backoff / 1000)}s.`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  }
  clearInterval(hb);
  if (pendingFatal) return fatal(pendingFatal);
  log(`Stopped. Tasks answered this run: ${handled}.`);
  process.exitCode = 0;

  async function handleTask(task) {
    const started = Date.now();
    const left = Date.parse(task.deadline) - Date.now();
    const timeoutMs = Math.max(1_000, Math.min(opts.taskTimeoutS * 1000, Number.isFinite(left) ? left - 2_000 : Infinity));
    log(`Task ${task.id.slice(0, 8)} (${task.kind}) received.`);
    let answer = opts.autoVerify ? autoAnswer(task) : null;
    if (answer === null) {
      try {
        answer = await backend(task, timeoutMs);
      } catch (e) {
        // Never invent an answer: the task stays unanswered and Hive Mind re-offers it later.
        warn(`Backend failed on task ${task.id.slice(0, 8)}: ${e.message}. It will be offered again.`);
        await sleep(5_000);
        return;
      }
    }
    if (!answer) { warn(`Backend returned an empty answer for ${task.id.slice(0, 8)}; skipping.`); return; }
    if (answer.length > MAX_ANSWER_CHARS) answer = answer.slice(0, MAX_ANSWER_CHARS);
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await hive('POST', `/tasks/${task.id}/result`, { body: { text: answer } });
        const extra = res.json?.message ? ` — ${res.json.message}` : '';
        log(`Task ${task.id.slice(0, 8)} answered in ${((Date.now() - started) / 1000).toFixed(1)}s${extra}`);
        return;
      } catch (e) {
        if (e instanceof HiveError && e.status === 409) { warn(`Task ${task.id.slice(0, 8)}: ${e.message}`); return; }
        if (e instanceof HiveError && (e.status === 401 || e.status === 403)) return fatal(e);
        if (e instanceof HiveError && e.status === 429) { await sleep((e.retryAfterS ?? 30) * 1000); continue; }
        warn(`Posting the answer failed (${e.message}); retrying.`);
        await sleep(Math.min(2_000 * 2 ** attempt, MAX_BACKOFF_MS));
      }
    }
    warn(`Gave up posting the answer for ${task.id.slice(0, 8)}; Hive Mind will offer the task again.`);
  }
}

/** Unwinds to main() once an exit code is set (process.exit() while fetches are closing can crash libuv on Windows). */
class ExitNow extends Error {}

function fatal(e) {
  if (e.status === 401) { warn(`Agent token rejected: ${e.message}\nThe link was rotated, disconnected or deleted. Ask the owner for a new agent link.`); process.exitCode = 2; }
  else if (e.status === 403) { warn(`Forbidden: ${e.message}`); process.exitCode = 3; }
  else { warn(`Error: ${e.message}`); process.exitCode = 1; }
  throw new ExitNow();
}

main().catch((e) => {
  if (e instanceof ExitNow) return;
  warn(`Unexpected error: ${e?.stack ?? e}`);
  process.exitCode = 1;
});
