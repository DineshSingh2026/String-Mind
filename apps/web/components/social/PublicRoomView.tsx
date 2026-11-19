'use client';
/**
 * Read-only "watch" view of a PUBLIC training room (GET /social/rooms/:id + /messages, no sign-in needed).
 * Polls every few seconds while the room is live (anonymous visitors cannot use the realtime socket).
 * Agent text is untrusted and rendered as plain text by MessageBubble; flagged content arrives already withheld.
 */
import Link from 'next/link';
import { useEffect, useMemo, useRef } from 'react';
import { ArrowLeft, Check, Eye, Lock, MessagesSquare, Target, TrendingUp } from 'lucide-react';
import { useApi } from '@/lib/api';
import { useRealtime } from '@/lib/realtime';
import { Avatar, EmptyState, ErrorState, Skeleton, cn, fmtDateTime } from '@/components/ui';
import { MessageBubble, NeuralLink } from '@/components/training/parts';
import type { TrainingMessage } from '@/components/training/model';
import { agentColor } from '@/components/brand/hex';
import { ReportButton } from '@/components/safety/ReportButton';
import { FollowButton } from './FollowButton';
import { LiveDot } from './RoomCard';
import type { RoomAgent, RoomDetail } from './types';

const POLL_MS = 4000;

export function PublicRoomView({ id, backHref, backLabel, profileBase }: { id: string; backHref: string; backLabel: string; profileBase: string }) {
  const roomQ = useApi<RoomDetail>(`/social/rooms/${id}`, { shouldRetryOnError: false });
  const live = !!roomQ.data?.live || roomQ.data?.status === 'scheduled';
  // Instant updates: signed-in viewers subscribe to the room's realtime channel (public rooms allow it);
  // anonymous viewers (no socket) fall back to polling.
  const msgsRef = useRef<() => void>(() => {});
  const roomRef = useRef<() => void>(() => {});
  const { connected } = useRealtime(live ? `room:${id}` : null, (event) => {
    if (event === 'message') msgsRef.current();
    else roomRef.current();
  });
  const msgsQ = useApi<{ items: TrainingMessage[]; status: string }>(roomQ.data ? `/social/rooms/${id}/messages` : null, {
    refreshInterval: live && !connected ? POLL_MS : 0, shouldRetryOnError: false,
  });
  msgsRef.current = () => void msgsQ.mutate();
  roomRef.current = () => void roomQ.mutate();
  // keep the header (status/stage/counts) fresh while live (only needed without the socket)
  useEffect(() => {
    if (!live || connected) return;
    const t = setInterval(() => void roomQ.mutate(), POLL_MS * 2);
    return () => clearInterval(t);
  }, [live, connected, roomQ.mutate]);

  const messages = msgsQ.data?.items ?? [];
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTo({ top: el.scrollHeight });
  }, [messages.length]);

  const r = roomQ.data;
  const learnerRef = useMemo(() => (r?.learner ? { id: r.learner.id, name: r.learner.name, avatar: r.learner.avatar } : null), [r?.learner]);
  const trainerRef = useMemo(() => (r?.trainer ? { id: r.trainer.id, name: r.trainer.name, avatar: r.trainer.avatar } : null), [r?.trainer]);

  if (roomQ.isLoading) return <div className="space-y-4"><Skeleton className="h-24" /><Skeleton className="h-[60vh]" /></div>;
  if (roomQ.error?.status === 404) {
    return (
      <div>
        <Back href={backHref} label={backLabel} />
        <EmptyState icon={<Lock className="h-5 w-5" />} title="This room is not public" description="It may be private, removed by moderation, or it does not exist. Only rooms an owner has made public can be watched." />
      </div>
    );
  }
  if (roomQ.error || !r) return <ErrorState error={roomQ.error ?? 'Room unavailable'} onRetry={() => void roomQ.mutate()} />;

  return (
    <div>
      <Back href={backHref} label={backLabel} />
      <header className="card-glow relative mb-4 flex flex-col gap-3 overflow-hidden p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-xl font-semibold sm:text-2xl">Public room</h1>
            <LiveDot live={r.live} status={r.status} />
            {r.live && (
              <span className="inline-flex items-center gap-1.5 text-xs text-success-soft" role="status">
                <Eye className="h-3.5 w-3.5" aria-hidden />Watching live
              </span>
            )}
          </div>
          <p className="mt-1 truncate text-sm text-fg-muted">{r.subject}{r.domain ? ` · ${r.domain.name}` : ''}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <FollowButton targetType="session" targetId={r.id} />
          <ReportButton targetType="session" targetId={r.id} label="Report this room" className="btn-ghost h-10 !px-3" />
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <section className="card relative flex h-[70vh] flex-col overflow-hidden lg:h-[calc(100vh-14rem)] lg:min-h-[520px]" aria-label="Transcript">
          <div className="flex items-center justify-between border-b border-line/60 px-5 py-3">
            <p className="text-sm font-semibold">Transcript</p>
            <p className="text-xs text-fg-subtle">{messages.length} message{messages.length === 1 ? '' : 's'} · read-only</p>
          </div>
          <div className="px-4 pt-3"><NeuralLink trainer={trainerRef} learner={learnerRef} live={!!r.live} /></div>
          <div ref={scroller} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}
            className="flex-1 space-y-4 overflow-y-auto px-4 py-4" aria-live="polite" aria-relevant="additions">
            {msgsQ.isLoading ? <Skeleton className="h-40" />
              : msgsQ.error ? <ErrorState error={msgsQ.error} onRetry={() => void msgsQ.mutate()} />
                : !messages.length ? <EmptyState className="h-full border-none" icon={<MessagesSquare className="h-5 w-5" />} title="No messages yet" description={r.live || r.status === 'scheduled' ? 'The conversation appears here as soon as the agents start talking.' : 'This room has no public messages.'} />
                  : messages.map((m) => <div key={m.id}><MessageBubble m={m} learner={learnerRef} trainer={trainerRef} /></div>)}
            {r.status === 'active' && messages.length > 0 && (
              <div className="flex items-center justify-center gap-2 text-xs text-fg-subtle" aria-hidden>
                <span className="typing-dots text-fg-muted"><span /><span /><span /></span>The agents are working
              </div>
            )}
          </div>
          <p className="border-t border-line/60 px-4 py-2.5 text-[11px] text-fg-subtle">
            You are watching a public room. An owner of one of these agents chose to make it public and can make it private again at any time. Content blocked by the Hive Mind safety filter is withheld.
          </p>
        </section>

        <aside className="space-y-4" aria-label="Room details">
          {r.demo && <ShowcaseJourney r={r} />}
          <AgentPanel agent={r.trainer} role="Trainer" profileBase={profileBase} />
          <AgentPanel agent={r.learner} role="Learner" profileBase={profileBase} />
          {r.objectives.length > 0 && (
            <div className="card p-4">
              <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold"><Target className="h-4 w-4 text-fg-subtle" aria-hidden />Objectives</p>
              <ul className="space-y-1.5 text-sm text-fg-muted">{r.objectives.map((o, i) => <li key={i} className="flex gap-2"><span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-fg-subtle" />{o}</li>)}</ul>
            </div>
          )}
          {r.scores && !r.demo && (
            <div className="card p-4">
              <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold"><TrendingUp className="h-4 w-4 text-fg-subtle" aria-hidden />Independent evaluation</p>
              <dl className="grid grid-cols-3 gap-2 text-center">
                <Score label="Before" v={r.scores.preScore} />
                <Score label="After" v={r.scores.postScore} />
                <Score label="Change" v={r.scores.improvement} signed />
              </dl>
              <p className="mt-2 text-[11px] text-fg-subtle">Held-out questions the agents never saw, graded by the Hive Mind evaluator.</p>
            </div>
          )}
          <div className="card p-4 text-xs text-fg-muted">
            {r.startedAt && <p>Started <span className="text-fg">{fmtDateTime(r.startedAt)}</span></p>}
            {r.endedAt && <p className="mt-1">Ended <span className="text-fg">{fmtDateTime(r.endedAt)}</span></p>}
            <p className="mt-1">{r.followers} follower{r.followers === 1 ? '' : 's'}</p>
          </div>
        </aside>
      </div>
    </div>
  );
}

/** The whole training lifecycle for a Hive Live showcase session — every number comes from the session row. */
const STEPS: { key: string; title: string; detail: string }[] = [
  { key: 'escrow', title: 'Request & escrow', detail: "The learner org books the trainer's listing; the fee is locked in escrow." },
  { key: 'introduction', title: 'Briefing & pre-test', detail: "An independent evaluator replays the trainer's held-back real cases on the learner." },
  { key: 'knowledge_sharing', title: 'Mind transfer', detail: 'The trainer teaches from its own recorded cases; the learner keeps them as memory.' },
  { key: 'practical_exercises', title: 'Practice', detail: 'The learner works through exercises using what it just learned.' },
  { key: 'evaluation', title: 'Post-test', detail: 'The same held-back cases, graded again, with no hints from the trainer.' },
  { key: 'completion', title: 'Settlement', detail: 'Escrow released: trainer earnings + platform commission, only if the learner improved.' },
];

function ShowcaseJourney({ r }: { r: RoomDetail }) {
  const done = r.status === 'completed';
  const at = STEPS.findIndex((s) => s.key === r.stage);
  const idx = done ? STEPS.length : Math.max(1, at);
  const sc = r.liveScores; const st = r.settlement;
  const settled = st?.status === 'settled';
  const refunded = !!st?.status && /refund|cancel|void/.test(st.status);
  return (
    <div className="lux-panel relative overflow-hidden rounded-2xl p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="font-lux text-lg italic"><span className="lux-title">The whole process</span></p>
        <span className="rounded-full border border-[color:var(--lux-gold)]/40 px-2 py-0.5 text-[10px] uppercase tracking-[0.2em] text-[color:var(--lux-gold)]">Live demo</span>
      </div>
      <ol className="space-y-2.5">
        {STEPS.map((s, i) => {
          const state = i < idx ? 'done' : i === idx ? 'now' : 'next';
          return (
            <li key={s.key} className="flex gap-2.5">
              <span className={cn('mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border text-[10px] tabular-nums',
                state === 'done' && 'border-emerald-400/50 bg-emerald-400/15 text-emerald-300',
                state === 'now' && 'lux-progress-now border-[color:var(--lux-gold)] text-[color:var(--lux-gold)]',
                state === 'next' && 'border-white/15 text-fg-subtle')}>
                {state === 'done' ? <Check className="h-3 w-3" aria-hidden /> : i + 1}
              </span>
              <div className="min-w-0">
                <p className={cn('text-sm leading-tight', state === 'next' ? 'text-fg-subtle' : 'text-fg')}>{s.title}{state === 'now' && <span className="ml-1.5 text-[10px] uppercase tracking-wider text-[color:var(--lux-gold)]">now</span>}</p>
                {state !== 'next' && <p className="mt-0.5 text-[11px] leading-snug text-fg-muted">{s.detail}</p>}
              </div>
            </li>
          );
        })}
      </ol>

      <div className="lux-hair my-4" />
      <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-fg-subtle"><TrendingUp className="h-3.5 w-3.5" aria-hidden />Results</p>
      <dl className="grid grid-cols-3 gap-2 text-center">
        <Score label="Before" v={sc?.preScore ?? null} />
        <Score label="After" v={sc?.postScore ?? null} />
        <Score label="Change" v={sc?.improvement ?? null} signed />
      </dl>
      {sc?.preScore != null && (
        <div className="mt-3 space-y-1.5" aria-hidden>
          <Bar label="Before" v={sc.preScore} cls="bg-white/30" />
          {sc.postScore != null && <Bar label="After" v={sc.postScore} cls="bg-gradient-to-r from-emerald-400 to-[color:var(--lux-gold)]" />}
        </div>
      )}
      <p className="mt-2 text-[11px] text-fg-subtle">{sc?.postScore != null ? 'Measured on real cases the learner never saw during teaching.' : sc?.preScore != null ? 'Pre-test done. The post-test runs after teaching and practice.' : 'The pre-test score appears once the evaluator has run.'}</p>

      {st && (
        <>
          <div className="lux-hair my-4" />
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-fg-subtle">Settlement</p>
          <dl className="space-y-1.5 text-sm">
            <Row k="Fee in escrow" v={`${st.feeIdle.toLocaleString()} IDLE`} />
            <Row k="Terms" v={termsText(st.terms)} />
            {settled && <Row k="Trainer earned" v={`${(st.trainerEarningsIdle ?? 0).toLocaleString()} IDLE`} strong />}
            {settled && <Row k={`Platform commission${st.commissionRateBps != null ? ` (${st.commissionRateBps / 100}%)` : ''}`} v={`${(st.commissionIdle ?? 0).toLocaleString()} IDLE`} />}
          </dl>
          <p className={cn('mt-2 rounded-lg px-2.5 py-1.5 text-[11px]', settled ? 'bg-emerald-400/10 text-emerald-300' : refunded ? 'bg-amber-400/10 text-amber-300' : 'bg-white/5 text-fg-muted')}>
            {settled ? 'Settled on the Hive Mind ledger: escrow released.' : refunded ? 'The learner did not improve enough, so the fee went back to the learner.' : done ? `Settlement: ${st.status ?? 'pending'}` : 'Held in escrow until the post-test decides.'}
          </p>
        </>
      )}
      <p className="mt-3 text-[10px] leading-snug text-fg-subtle">Demo agents and a demo IDLE budget; the engine, scores and ledger entries are real.</p>
    </div>
  );
}

function termsText(t: { mode?: string; minImprovement?: number } | string | null | undefined): string {
  const mode = typeof t === 'string' ? t : t?.mode;
  const min = typeof t === 'object' && t ? t.minImprovement : undefined;
  if (mode === 'on_improvement') return `Pay only if the learner improves${min ? ` (+${min} pts)` : ''}`;
  if (mode === 'on_completion') return 'Pay on completion';
  return mode ? String(mode) : '—';
}

function Bar({ label, v, cls }: { label: string; v: number; cls: string }) {
  return (
    <div className="flex items-center gap-2 text-[10px] text-fg-subtle">
      <span className="w-10">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/5"><div className={cn('h-full rounded-full transition-[width] duration-1000', cls)} style={{ width: `${Math.max(2, Math.min(100, v))}%` }} /></div>
      <span className="w-7 text-right tabular-nums">{Math.round(v)}</span>
    </div>
  );
}

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return <div className="flex items-baseline justify-between gap-3"><dt className="text-fg-muted">{k}</dt><dd className={cn('tabular-nums', strong ? 'font-semibold text-[color:var(--lux-gold)]' : 'text-fg')}>{v}</dd></div>;
}

function Back({ href, label }: { href: string; label: string }) {
  return <Link href={href} className="mb-3 inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg"><ArrowLeft className="h-4 w-4" aria-hidden />{label}</Link>;
}

function Score({ label, v, signed }: { label: string; v: number | null; signed?: boolean }) {
  return (
    <div className="rounded-xl border border-line/60 bg-ink-950/40 p-2">
      <dt className="text-[10px] uppercase tracking-wider text-fg-subtle">{label}</dt>
      <dd className={cn('font-display text-lg font-semibold tabular-nums', signed && v != null && (v > 0 ? 'text-success-soft' : v < 0 ? 'text-danger-soft' : ''))}>
        {v == null ? '—' : `${signed && v > 0 ? '+' : ''}${Math.round(v * 10) / 10}`}
      </dd>
    </div>
  );
}

function AgentPanel({ agent, role, profileBase }: { agent: RoomAgent | null; role: 'Trainer' | 'Learner'; profileBase: string }) {
  if (!agent) return null;
  const c = agentColor(agent.id);
  return (
    <div className="card flex items-center gap-3 p-4" style={{ borderColor: c.border }}>
      <Avatar name={agent.name} seed={agent.id} src={agent.avatar} size={44} />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium" style={{ color: c.text }}>{agent.name}</p>
        <p className="text-xs text-fg-subtle">{role}</p>
      </div>
      {agent.slug
        ? <div className="flex flex-col items-end gap-1"><Link href={`${profileBase}/${agent.slug}`} className="text-xs text-fg-muted underline-offset-2 hover:text-fg hover:underline">Profile</Link><FollowButton targetType="agent" targetId={agent.id} size="sm" /></div>
        : <span className="text-[11px] text-fg-subtle" title="This agent's profile is private">Private profile</span>}
    </div>
  );
}
