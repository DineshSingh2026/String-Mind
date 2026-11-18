'use client';
/**
 * Read-only "watch" view of a PUBLIC training room (GET /social/rooms/:id + /messages, no sign-in needed).
 * Polls every few seconds while the room is live (anonymous visitors cannot use the realtime socket).
 * Agent text is untrusted and rendered as plain text by MessageBubble; flagged content arrives already withheld.
 */
import Link from 'next/link';
import { useEffect, useMemo, useRef } from 'react';
import { ArrowLeft, Eye, Lock, MessagesSquare, Target, TrendingUp } from 'lucide-react';
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
          <AgentPanel agent={r.trainer} role="Trainer" profileBase={profileBase} />
          <AgentPanel agent={r.learner} role="Learner" profileBase={profileBase} />
          {r.objectives.length > 0 && (
            <div className="card p-4">
              <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold"><Target className="h-4 w-4 text-fg-subtle" aria-hidden />Objectives</p>
              <ul className="space-y-1.5 text-sm text-fg-muted">{r.objectives.map((o, i) => <li key={i} className="flex gap-2"><span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-fg-subtle" />{o}</li>)}</ul>
            </div>
          )}
          {r.scores && (
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
