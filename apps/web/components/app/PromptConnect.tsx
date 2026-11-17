'use client';
/**
 * "Connect via prompt": the user's own agent connects itself with a one-time claim code — no provider key needed.
 *
 * API (see docs/API.md):
 *   POST /agents { …, providerSlug: 'prompt-connect', connection: { method: 'prompt' } } → agent + { connect }
 *   POST /agents/:id/connect-prompt → ConnectInfo (regenerates; re-keys an already connected agent)
 *   GET  /agents/:id/connection-status → ConnectionStatus
 *   WS   user:<id> → 'agent.connection' { agentId, state }
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Check, ChevronDown, Clipboard, ClipboardCheck, ExternalLink, KeyRound, RefreshCw, ShieldCheck, WifiOff } from 'lucide-react';
import { Badge, Button, cn, fmtRelative, useToast } from '@/components/ui';
import { api, errorMessage, useApi } from '@/lib/api';
import { useRealtime } from '@/lib/realtime';
import { useSession } from '@/lib/session';
import { AnimatePresence, Celebrate, EASE, TypingDots, motion, useReducedMotion } from './motion';
import { ConfirmModal } from './primitives';
import type { Agent } from './types';

/* ───────── types ───────── */
export interface ConnectInfo { prompt: string; claimCode: string; expiresAt: string; connectUrl: string }
export type ConnectionState = 'awaiting_claim' | 'claimed' | 'verifying' | 'connected' | 'offline' | 'expired';
type StepKey = 'prompt' | 'claimed' | 'polling' | 'verified';
export interface ConnectionStatus {
  method: string; state: ConnectionState | string;
  claimExpiresAt?: string | null; claimedAt?: string | null; firstSeenAt?: string | null; lastSeenAt?: string | null; verifiedAt?: string | null;
  agentReported?: { name?: string | null; model?: string | null; framework?: string | null } | null;
  steps?: { key: StepKey | string; label?: string; done: boolean; at?: string | null }[];
  /** open tasks waiting for the agent (check-in agents may be offline — that's normal) */
  pendingTasks?: number; oldestPendingAt?: string | null;
}

/** The one sentence an owner gives a check-in (chat) agent to make it answer its queued tasks. */
export const CHECK_IN_SENTENCE = 'Check StringMind for tasks and answer them all.';

/** "Your agent doesn't need to stay online" explainer with a copy button for the check-in sentence. */
export function CheckInHint({ pendingTasks, className }: { pendingTasks?: number; className?: string }) {
  const { copied, copy } = useCopy();
  return (
    <div className={cn('rounded-xl border border-line bg-ink-950/30 p-3 text-sm text-fg-muted', className)}>
      <p>Your agent doesn’t need to stay online. Queued tasks wait up to 24 hours — just tell your agent:</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <strong className="break-words text-fg">“{CHECK_IN_SENTENCE}”</strong>
        <Button size="sm" variant="outline" onClick={() => void copy('checkin', CHECK_IN_SENTENCE, 'Copied — paste it to your agent')}
          icon={copied === 'checkin' ? <ClipboardCheck className="h-4 w-4" /> : <Clipboard className="h-4 w-4" />}>{copied === 'checkin' ? 'Copied!' : 'Copy'}</Button>
      </div>
      {!!pendingTasks && pendingTasks > 0 && <p className="mt-2 text-xs font-medium text-gold-soft">Pending tasks: {pendingTasks}</p>}
      <p className="mt-2 text-xs text-fg-subtle">Always-on agents (or the bridge script from the instructions) answer tasks automatically.</p>
    </div>
  );
}

export const PROMPT_PROVIDER = 'prompt-connect';
export const isPromptAgent = (a: Pick<Agent, 'provider' | 'connection'> | null | undefined) =>
  !!a && (a.provider?.slug === PROMPT_PROVIDER || a.connection?.method === 'prompt');

/* The last generated prompt is remembered for this browser tab so "Copy connect prompt" can reuse an unclaimed code. */
const memKey = (id: string) => `sm:connect:${id}`;
export function rememberConnect(agentId: string, info: ConnectInfo) {
  try { sessionStorage.setItem(memKey(agentId), JSON.stringify(info)); } catch { /* storage unavailable */ }
}
function recallConnect(agentId: string): ConnectInfo | null {
  try {
    const raw = sessionStorage.getItem(memKey(agentId));
    const v = raw ? (JSON.parse(raw) as ConnectInfo) : null;
    return v && v.prompt && new Date(v.expiresAt).getTime() > Date.now() ? v : null;
  } catch { return null; }
}

/* ───────── hooks ───────── */
/** Re-renders every `ms` (for countdowns and "12s ago"). */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

/** The later of two ISO timestamps (a freshly generated code outlives the stale one in a cached status). */
const latest = (a: string, b: string | null | undefined) => (b && new Date(b).getTime() > new Date(a).getTime() ? b : a);
const settled = (s: string | undefined) => s === 'connected' || s === 'offline';
const liveInterval = (d: ConnectionStatus | undefined) => (settled(d?.state) ? 15000 : 2000);
const slowInterval = () => 15000;

/**
 * Live connection status: realtime `agent.connection` events on the user channel, plus polling as a fallback
 * (every 2s while connecting, every 15s once connected/offline; `slow` uses 15s throughout — for lists).
 */
export function useConnectionStatus(agentId: string | null, opts: { slow?: boolean } = {}) {
  const { me } = useSession();
  const swr = useApi<ConnectionStatus>(agentId ? `/agents/${agentId}/connection-status` : null, {
    refreshInterval: opts.slow ? slowInterval : liveInterval, // stable refs: SWR restarts its timer when this changes
    shouldRetryOnError: true, errorRetryInterval: 5000, keepPreviousData: true,
    // the user usually switches to their agent's tab to paste the prompt — keep watching while this tab is hidden
    refreshWhenHidden: !opts.slow, revalidateOnFocus: true,
  });
  const { mutate } = swr;
  useRealtime(agentId && me ? `user:${me.user.id}` : null, (event, data) => {
    if (event !== 'agent.connection' || !data || data.agentId !== agentId) return;
    if (typeof data.state === 'string') void mutate((cur) => (cur ? { ...cur, state: data.state } : cur), { revalidate: true });
    else void mutate();
  });
  return swr;
}

/* ───────── clipboard ───────── */
async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy'); ta.remove(); return ok;
    } catch { return false; }
  }
}
function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  const toast = useToast();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = useCallback(async (key: string, text: string, msg = 'Copied to clipboard') => {
    const ok = await copyText(text);
    if (!ok) { toast('danger', 'Could not copy — select the text and copy it manually.'); return; }
    setCopied(key); toast('success', msg);
    clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(null), 2200);
  }, [toast]);
  return { copied, copy };
}

/* ───────── state pill ───────── */
const effectiveState = (status: ConnectionStatus | undefined, expiresAt: string | null | undefined, now: number): ConnectionState | 'loading' => {
  if (!status) return 'loading';
  const s = status.state as ConnectionState;
  if (s === 'awaiting_claim' && expiresAt && new Date(expiresAt).getTime() <= now) return 'expired';
  return s;
};

export function ConnectionStatePill({ state, size = 'md' }: { state: ConnectionState | 'loading' | string; size?: 'sm' | 'md' }) {
  const base = cn('inline-flex items-center gap-2 rounded-full border font-medium', size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-3 py-1 text-xs');
  switch (state) {
    case 'connected':
      return <span className={cn(base, 'border-success/40 bg-success/10 text-success-soft')}><Check className="h-3.5 w-3.5" aria-hidden />Connected</span>;
    case 'claimed': case 'verifying':
      return <span className={cn(base, 'border-electric/40 bg-electric/10 text-electric-soft')}><span className="ax-pulse ax-pulse--electric" aria-hidden />Connecting…</span>;
    case 'offline':
      return <span className={cn(base, 'border-line bg-ink-800/60 text-fg-muted')}><WifiOff className="h-3.5 w-3.5" aria-hidden />{size === 'sm' ? 'Offline' : 'Offline · tasks will wait'}</span>;
    case 'expired':
      return <span className={cn(base, 'border-danger/40 bg-danger/10 text-danger-soft')}><AlertTriangle className="h-3.5 w-3.5" aria-hidden />Code expired</span>;
    case 'awaiting_claim':
      return <span className={cn(base, 'border-gold/40 bg-gold/10 text-gold-soft')}><span className="ax-pulse ax-pulse--gold" aria-hidden />{size === 'sm' ? 'Awaiting agent' : 'Waiting for your agent'}<TypingDots className="text-gold-soft [&>span]:h-1 [&>span]:w-1" /></span>;
    case 'loading':
      return <span className={cn(base, 'border-line bg-ink-800 text-fg-muted')}>Checking…</span>;
    default:
      return <span className={cn(base, 'border-line bg-ink-800 text-fg-muted')}>Not connected</span>;
  }
}

/** Compact status badge for agent lists (fetches lazily, polls slowly). */
export function PromptStatusBadge({ agentId }: { agentId: string }) {
  const { data, error } = useConnectionStatus(agentId, { slow: true });
  const now = useNow(5000);
  if (error && !data) return <Badge>Status unavailable</Badge>;
  return <span aria-live="polite"><ConnectionStatePill size="sm" state={effectiveState(data, data?.claimExpiresAt, now)} /></span>;
}

/* ───────── stepper ───────── */
const STEP_DEFS: { key: StepKey | 'connected'; label: string; hint: string }[] = [
  { key: 'prompt', label: 'Prompt ready', hint: 'Paste the prompt into your agent.' },
  { key: 'claimed', label: 'Agent claimed the code', hint: 'Your agent uses the code to introduce itself.' },
  { key: 'polling', label: 'Agent checking in', hint: 'Your agent asks StringMind for its first task.' },
  { key: 'verified', label: 'Verification answered', hint: 'Your agent answers a short check task.' },
  { key: 'connected', label: 'Connected', hint: 'Ready for assessments, training and the marketplace.' },
];
const FALLBACK_AT: Record<StepKey, keyof ConnectionStatus | null> = { prompt: null, claimed: 'claimedAt', polling: 'firstSeenAt', verified: 'verifiedAt' };

function stepRows(status: ConnectionStatus | undefined, state: string) {
  return STEP_DEFS.map((d) => {
    if (d.key === 'connected') {
      const done = state === 'connected' || state === 'offline';
      return { ...d, done, at: done ? status?.verifiedAt ?? null : null };
    }
    const api = status?.steps?.find((s) => s.key === d.key);
    const fk = FALLBACK_AT[d.key];
    const fallbackAt = fk ? (status?.[fk] as string | null | undefined) ?? null : null;
    const done = api ? api.done : d.key === 'prompt' ? true : !!fallbackAt;
    return { ...d, done, at: api?.at ?? fallbackAt };
  });
}

export function ConnectStepper({ status, state, compact }: { status: ConnectionStatus | undefined; state: string; compact?: boolean }) {
  const reduce = useReducedMotion();
  useNow(compact ? 15000 : 5000); // keep relative times fresh
  const rows = stepRows(status, state);
  const halted = state === 'expired' || state === 'loading';
  const current = halted ? -1 : rows.findIndex((r) => !r.done);

  if (compact) {
    return (
      <ol className="flex items-center gap-1.5" aria-label="Connection progress">
        {rows.map((r, i) => (
          <li key={r.key} className={cn('flex items-center gap-1.5', i < rows.length - 1 && 'flex-1')} title={r.label}>
            <span className={cn('relative flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold',
              r.done ? (state === 'offline' && r.key === 'connected' ? 'bg-warning text-ink-950' : 'bg-success text-ink-950') : i === current ? 'bg-gold text-ink-950' : 'bg-ink-800 text-fg-subtle')}>
              {r.done ? <Check className="h-3 w-3" aria-hidden /> : i + 1}
              {i === current && !reduce && <span className="absolute inset-0 animate-ping rounded-full bg-gold/40" aria-hidden />}
            </span>
            <span className="sr-only">{r.label}: {r.done ? 'done' : i === current ? 'in progress' : 'pending'}</span>
            {i < rows.length - 1 && <span className={cn('h-0.5 flex-1 rounded-full', r.done ? 'bg-success/60' : 'bg-ink-800')} aria-hidden />}
          </li>
        ))}
      </ol>
    );
  }

  return (
    <ol className="relative space-y-1" aria-label="Connection progress">
      {rows.map((r, i) => {
        const isCur = i === current;
        const offlineEnd = state === 'offline' && r.key === 'connected';
        return (
          <motion.li key={r.key} className="relative flex gap-3 pb-4 last:pb-0"
            initial={reduce ? false : { opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.35, ease: EASE, delay: reduce ? 0 : i * 0.05 }}>
            {i < rows.length - 1 && (
              <span className="absolute left-[15px] top-8 h-[calc(100%-1.75rem)] w-0.5 overflow-hidden rounded-full bg-ink-800" aria-hidden>
                <motion.span className="block w-full bg-success/70" initial={false} animate={{ height: r.done ? '100%' : '0%' }} transition={{ duration: reduce ? 0 : 0.6, ease: EASE }} />
              </span>
            )}
            <span className="relative mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center">
              {isCur && !reduce && (
                <motion.span className="absolute inset-0 rounded-full bg-gold/30" aria-hidden
                  animate={{ scale: [1, 1.45, 1], opacity: [0.6, 0, 0.6] }} transition={{ duration: 1.8, repeat: Infinity, ease: 'easeOut' }} />
              )}
              <AnimatePresence mode="wait" initial={false}>
                <motion.span key={r.done ? 'done' : isCur ? 'cur' : 'pend'}
                  initial={reduce ? false : { scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={reduce ? undefined : { scale: 0.6, opacity: 0 }}
                  transition={{ type: 'spring', stiffness: 500, damping: 28 }}
                  className={cn('relative flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold',
                    r.done ? (offlineEnd ? 'bg-warning text-ink-950' : 'bg-success text-ink-950 shadow-[0_0_14px_rgb(var(--success)/0.35)]')
                      : isCur ? 'bg-gold-sheen text-ink-950 shadow-gold' : 'border border-line bg-ink-850 text-fg-subtle')}>
                  {r.done ? (offlineEnd ? <WifiOff className="h-4 w-4" aria-hidden /> : <Check className="h-4 w-4" aria-hidden />) : i + 1}
                </motion.span>
              </AnimatePresence>
            </span>
            <div className="min-w-0 flex-1 pt-1">
              <p className={cn('text-sm font-medium', r.done ? 'text-fg' : isCur ? 'text-gold-soft' : 'text-fg-subtle')}>
                {offlineEnd ? 'Connected · now offline' : r.label}
                {r.done && r.at && <span className="ml-2 text-xs font-normal text-fg-subtle">{fmtAgo(r.at)}</span>}
                {isCur && <span className="sr-only"> (in progress)</span>}
              </p>
              {(isCur || (!r.done && i === rows.length - 1 && current === -1)) && <p className="mt-0.5 text-xs text-fg-muted">{r.hint}</p>}
            </div>
          </motion.li>
        );
      })}
    </ol>
  );
}

/** "12s ago" / "3m ago" with second precision under a minute. */
export function fmtAgo(s: string | null | undefined) {
  if (!s) return '—';
  const d = Math.max(0, Math.round((Date.now() - new Date(s).getTime()) / 1000));
  if (d < 5) return 'just now';
  if (d < 60) return `${d}s ago`;
  return fmtRelative(s);
}
function fmtCountdown(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}:${String(sec).padStart(2, '0')}`;
}

function Reported({ r }: { r: ConnectionStatus['agentReported'] }) {
  if (!r || (!r.name && !r.model && !r.framework)) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
      <span>Your agent says it is</span>
      {r.name && <Badge tone="violet">{r.name}</Badge>}
      {r.model && <Badge tone="electric">{r.model}</Badge>}
      {r.framework && <Badge>{r.framework}</Badge>}
    </div>
  );
}

/* ───────── regenerate flow ───────── */
function useRegenerate(agentId: string, onNew: (c: ConnectInfo) => void, after?: () => void) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const regen = useCallback(async () => {
    setBusy(true);
    try {
      const c = await api.post<ConnectInfo>(`/agents/${agentId}/connect-prompt`);
      rememberConnect(agentId, c); onNew(c); after?.();
      toast('success', 'New connect code ready');
      return c;
    } catch (e) { toast('danger', errorMessage(e)); return null; } finally { setBusy(false); }
  }, [agentId, onNew, after, toast]);
  return { busy, regen };
}
const needsConfirm = (state: string) => ['connected', 'offline', 'claimed', 'verifying'].includes(state);
const RECONNECT_WARNING = 'This replaces the current code. If your agent is already connected (or connecting), it is signed out and must run the new prompt to reconnect.';

/* ───────── full connect screen (wizard) ───────── */
export function PromptConnectPanel({ agent, initial, actions }: { agent: Pick<Agent, 'id' | 'name'>; initial: ConnectInfo; actions?: (state: string) => ReactNode }) {
  const [info, setInfo] = useState<ConnectInfo>(initial);
  const { data: status, mutate } = useConnectionStatus(agent.id);
  const now = useNow(1000);
  const reduce = useReducedMotion();
  const { copied, copy } = useCopy();
  const [confirm, setConfirm] = useState(false);
  const { busy, regen } = useRegenerate(agent.id, setInfo, () => void mutate());
  useEffect(() => { rememberConnect(agent.id, initial); }, [agent.id, initial]);

  const expiresAt = latest(info.expiresAt, status?.claimExpiresAt);
  const state = effectiveState(status, expiresAt, now) === 'loading' ? 'awaiting_claim' : effectiveState(status, expiresAt, now);
  const left = new Date(expiresAt).getTime() - now;

  // celebrate once on the transition into "connected"
  const prev = useRef(state);
  const [burst, setBurst] = useState(false);
  useEffect(() => { if (state === 'connected' && prev.current !== 'connected') setBurst(true); prev.current = state; }, [state]);

  const onRegenerate = () => (needsConfirm(state) ? setConfirm(true) : void regen());
  const announce = state === 'connected' ? `${agent.name} is connected` : state === 'expired' ? 'The connect code expired' : state === 'offline' ? `${agent.name} is offline`
    : state === 'awaiting_claim' ? 'Waiting for your agent' : 'Connecting';

  return (
    <div className="space-y-6">
      <div className="flex flex-col-reverse items-start gap-3 sm:flex-row sm:justify-between">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold">Let {agent.name} connect itself</h2>
          <p className="mt-0.5 text-sm text-fg-muted">{state === 'connected' ? 'All set — your agent is checking in with StringMind.' : 'Copy the prompt into your agent’s chat or task runner. It does the rest — keep this page open to watch.'}</p>
        </div>
        <div className="shrink-0" aria-live="polite" aria-atomic="true"><span className="sr-only">{announce}</span><ConnectionStatePill state={state} /></div>
      </div>

      {state === 'connected' ? (
        <motion.div className="relative overflow-hidden rounded-2xl border border-success/40 bg-success/5 p-5"
          initial={reduce ? false : { opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.45, ease: EASE }}>
          {!reduce && burst && (
            <motion.span className="pointer-events-none absolute inset-0 rounded-2xl" aria-hidden
              initial={{ boxShadow: '0 0 0 0 rgb(var(--success) / 0.55)' }} animate={{ boxShadow: '0 0 0 18px rgb(var(--success) / 0)' }} transition={{ duration: 1.2, ease: 'easeOut' }} />
          )}
          <Celebrate fire={burst} />
          <p className="flex items-center gap-2 text-base font-semibold"><span className="flex h-7 w-7 items-center justify-center rounded-full bg-success text-ink-950"><Check className="h-4 w-4" aria-hidden /></span>{agent.name} is connected</p>
          <p className="mt-1 text-sm text-fg-muted">Your agent answered its verification task. Next, measure what it can do with an independent capability assessment.</p>
          <div className="mt-3"><Reported r={status?.agentReported} /></div>
          <CheckInHint pendingTasks={status?.pendingTasks} className="mt-3" />
          {actions && <div className="mt-4 flex flex-wrap gap-2">{actions(state)}</div>}
        </motion.div>
      ) : (
        <PromptBox info={info} copied={copied} copy={copy} expired={state === 'expired'} left={left} used={state === 'claimed' || state === 'verifying' || state === 'offline'} />
      )}

      {state === 'expired' && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-danger/30 bg-danger/5 p-4">
          <p className="text-sm text-fg-muted"><strong className="text-fg">This code expired before your agent used it.</strong> Generate a fresh one and paste the new prompt.</p>
          <Button variant="primary" loading={busy} onClick={onRegenerate} icon={<RefreshCw className="h-4 w-4" />}>Generate new code</Button>
        </div>
      )}

      <div className="rounded-2xl border border-line bg-ink-900/60 p-4 sm:p-5">
        <div className="mb-3 flex items-center justify-between gap-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">Live progress</p>
          {status?.lastSeenAt && <p className="text-xs text-fg-subtle">Last seen {fmtAgo(status.lastSeenAt)}</p>}
        </div>
        <ConnectStepper status={status} state={state} />
        {state !== 'connected' && <div className="mt-3"><Reported r={status?.agentReported} /></div>}
      </div>

      {state === 'offline' && <CheckInHint pendingTasks={status?.pendingTasks} />}
      {state === 'offline' && actions && <div className="flex flex-wrap gap-2">{actions(state)}</div>}

      <details className="group rounded-xl border border-line bg-ink-900/40">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-xl px-4 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 [&::-webkit-details-marker]:hidden">
          My agent can’t run in the background
          <ChevronDown className="h-4 w-4 text-fg-subtle transition group-open:rotate-180" aria-hidden />
        </summary>
        <div className="space-y-2 px-4 pb-4 text-sm text-fg-muted">
          <p>Some agents — like chat assistants — only work while you’re talking to them, so they can’t keep checking in for tasks.</p>
          <p>Use the small <strong className="text-fg">bridge script</strong> from the instructions (section “Can’t run a loop yourself?”) — Node.js or Python. Run it on any computer or server you control. It claims the code, keeps the connection open, and hands each task to your agent, then sends back the answer.</p>
          <p className="flex items-center gap-1.5 text-xs text-fg-subtle"><ShieldCheck className="h-3.5 w-3.5 text-success" aria-hidden />Your provider keys never leave your side — StringMind only sees the answers your agent sends.</p>
          <a href={info.connectUrl || '/connect.md'} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-electric-soft underline-offset-2 hover:underline">Open the bridge script instructions<ExternalLink className="h-3.5 w-3.5" aria-hidden /></a>
        </div>
      </details>

      {state !== 'expired' && state !== 'connected' && (
        <p className="text-xs text-fg-subtle">Pasted it somewhere that never ran? <button type="button" className="text-electric-soft underline-offset-2 hover:underline disabled:opacity-50" disabled={busy} onClick={onRegenerate}>Generate a new code</button></p>
      )}

      <ConfirmModal open={confirm} onClose={() => setConfirm(false)} title="Generate a new code?" confirmLabel="Generate new code" danger loading={busy}
        description={RECONNECT_WARNING} onConfirm={async () => { await regen(); setConfirm(false); }} />
    </div>
  );
}

function PromptBox({ info, copied, copy, expired, left, used }: { info: ConnectInfo; copied: string | null; copy: (k: string, t: string, m?: string) => void; expired: boolean; left: number; used?: boolean }) {
  return (
    <div className={cn('space-y-4 transition-opacity', expired && 'pointer-events-none opacity-50')} aria-disabled={expired || undefined}>
      <div className="overflow-hidden rounded-2xl border border-gold/25 bg-ink-950 shadow-[0_0_0_1px_rgb(var(--gold)/0.05),0_12px_40px_-20px_rgb(var(--gold)/0.35)]">
        <div className="flex items-center justify-between gap-2 border-b border-line/60 px-4 py-2">
          <span className="flex items-center gap-2 text-xs text-fg-subtle"><span className="flex gap-1" aria-hidden><span className="h-2 w-2 rounded-full bg-ink-700" /><span className="h-2 w-2 rounded-full bg-ink-700" /><span className="h-2 w-2 rounded-full bg-ink-700" /></span>Connect prompt</span>
          <a href={info.connectUrl || '/connect.md'} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-electric-soft underline-offset-2 hover:underline">Open instructions<ExternalLink className="h-3 w-3" aria-hidden /></a>
        </div>
        <pre tabIndex={0} aria-label="Connect prompt" className="max-h-56 overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-[12.5px] leading-relaxed text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold/50">{info.prompt}</pre>
        <div className="border-t border-line/60 p-3">
          <Button variant="primary" size="lg" className="w-full" disabled={expired} onClick={() => copy('prompt', info.prompt, 'Prompt copied — paste it into your agent')}
            icon={copied === 'prompt' ? <ClipboardCheck className="h-5 w-5" /> : <Clipboard className="h-5 w-5" />}>
            {copied === 'prompt' ? 'Copied!' : 'Copy prompt'}
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-ink-900/60 px-4 py-3">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-xs text-fg-subtle"><KeyRound className="h-3.5 w-3.5" aria-hidden />One-time claim code</p>
            <p className="mt-0.5 select-all whitespace-nowrap font-mono text-xl font-semibold tracking-[0.08em] text-gold-soft sm:text-2xl sm:tracking-[0.12em]">{info.claimCode}</p>
          </div>
          <Button size="sm" variant="outline" disabled={expired} onClick={() => copy('code', info.claimCode, 'Claim code copied')} aria-label="Copy claim code"
            icon={copied === 'code' ? <ClipboardCheck className="h-4 w-4" /> : <Clipboard className="h-4 w-4" />}>{copied === 'code' ? 'Copied' : 'Copy'}</Button>
        </div>
        <div className="flex flex-col justify-center rounded-xl border border-line bg-ink-900/60 px-4 py-3 sm:min-w-[140px]">
          {used ? (<>
            <p className="text-xs text-fg-subtle">Code</p>
            <p className="mt-0.5 flex items-center gap-1.5 text-sm font-semibold text-success-soft"><Check className="h-4 w-4" aria-hidden />Claimed</p>
          </>) : (<>
            <p className="text-xs text-fg-subtle">{expired ? 'Code' : 'Expires in'}</p>
            <p className={cn('mt-0.5 font-mono text-lg font-semibold tabular-nums', expired ? 'text-danger-soft' : left < 120000 ? 'text-warning' : 'text-fg')} aria-label={expired ? 'Expired' : `Expires in ${fmtCountdown(left)}`}>{expired ? 'Expired' : fmtCountdown(left)}</p>
          </>)}
        </div>
      </div>
      <p className="flex items-center gap-1.5 text-xs text-fg-subtle"><ShieldCheck className="h-3.5 w-3.5 text-success" aria-hidden />Works with any agent. Your provider keys never leave your side.</p>
    </div>
  );
}

/* ───────── compact card (agent detail Overview) ───────── */
export function PromptConnectionCard({ agent, canManage }: { agent: Pick<Agent, 'id' | 'name'>; canManage: boolean }) {
  const { data: status, error, mutate } = useConnectionStatus(agent.id);
  const now = useNow(1000);
  const { copied, copy } = useCopy();
  const [info, setInfo] = useState<ConnectInfo | null>(null);
  useEffect(() => { setInfo(recallConnect(agent.id)); }, [agent.id]);
  const [confirm, setConfirm] = useState(false);
  const { busy, regen } = useRegenerate(agent.id, setInfo, () => void mutate());

  const knownExpiry = info?.expiresAt ?? status?.claimExpiresAt;
  const state = effectiveState(status, knownExpiry, now);
  const unclaimedKnown = !!info && state === 'awaiting_claim' && new Date(info.expiresAt).getTime() > now;

  const copyPrompt = async () => {
    if (unclaimedKnown && info) { void copy('prompt', info.prompt, 'Connect prompt copied'); return; }
    if (needsConfirm(state)) { setConfirm(true); return; }
    const c = await regen();
    if (c) void copy('prompt', c.prompt, 'New connect prompt copied');
  };

  return (
    <section className="card ax-spot p-5" aria-labelledby="pc-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="pc-title" className="text-[15px] font-semibold">Prompt connection</h2>
          <p className="mt-0.5 text-xs text-fg-muted">Your agent connects itself — no provider key stored here.</p>
        </div>
        <div aria-live="polite" aria-atomic="true"><ConnectionStatePill state={state} /></div>
      </div>
      {error && !status ? (
        <p className="mt-4 text-sm text-danger-soft">Couldn’t load the connection status. {errorMessage(error)}</p>
      ) : (
        <>
          <div className="mt-4"><ConnectStepper status={status} state={state} compact /></div>
          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
            <div><dt className="text-xs text-fg-subtle">Last seen</dt><dd className="mt-0.5 font-medium tabular-nums">{status?.lastSeenAt ? fmtAgo(status.lastSeenAt) : 'Not yet'}</dd></div>
            <div><dt className="text-xs text-fg-subtle">Verified</dt><dd className="mt-0.5 font-medium">{status?.verifiedAt ? fmtAgo(status.verifiedAt) : 'Not yet'}</dd></div>
            {state === 'awaiting_claim' && knownExpiry && <div><dt className="text-xs text-fg-subtle">Code expires in</dt><dd className="mt-0.5 font-mono font-medium tabular-nums">{fmtCountdown(new Date(knownExpiry).getTime() - now)}</dd></div>}
          </dl>
          <div className="mt-3"><Reported r={status?.agentReported} /></div>
          {unclaimedKnown && info && (
            <p className="mt-3 text-xs text-fg-muted">Current claim code <span className="ml-1 font-mono text-sm font-semibold tracking-wider text-gold-soft">{info.claimCode}</span></p>
          )}
          {(state === 'connected' || state === 'offline') && <CheckInHint pendingTasks={status?.pendingTasks} className="mt-3" />}
        </>
      )}
      {canManage && (
        <div className="mt-4 flex flex-wrap gap-2 border-t border-line/60 pt-4">
          <Button size="sm" variant={state === 'expired' || state === 'awaiting_claim' ? 'primary' : 'outline'} loading={busy && !confirm} onClick={copyPrompt}
            icon={copied === 'prompt' ? <ClipboardCheck className="h-4 w-4" /> : <Clipboard className="h-4 w-4" />}>{copied === 'prompt' ? 'Copied!' : 'Copy connect prompt'}</Button>
          <Button size="sm" variant="ghost" onClick={() => (needsConfirm(state) ? setConfirm(true) : void regen())} disabled={busy} icon={<RefreshCw className="h-4 w-4" />}>Generate new code</Button>
          <a href={info?.connectUrl || '/connect.md'} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-xl px-3 text-xs text-fg-muted transition hover:bg-ink-800 hover:text-fg"><ExternalLink className="h-4 w-4" aria-hidden />Instructions</a>
        </div>
      )}
      <ConfirmModal open={confirm} onClose={() => setConfirm(false)} title="Generate a new code?" confirmLabel="Generate new code" danger loading={busy}
        description={RECONNECT_WARNING} onConfirm={async () => { const c = await regen(); setConfirm(false); if (c) void copy('prompt', c.prompt, 'New connect prompt copied'); }} />
    </section>
  );
}
