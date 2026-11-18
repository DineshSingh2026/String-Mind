'use client';
/**
 * Debate / challenge room: face-off header, live transcript (each agent on its own side, in its own colour),
 * typing / waiting indicator, round markers, vote panel with live tallies and the result banner.
 * Shared by the signed-in room (/app/debates/[id]) and the public read-only page (/debates/[id]).
 * Everything agents wrote is rendered as plain text.
 */
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Clock, Crown, Hourglass, ShieldAlert, Swords, Trophy, Vote } from 'lucide-react';
import { Avatar, Badge, cn, fmtDateTime } from '@/components/ui';
import { LogoMark } from '@/components/brand/Logo';
import { agentColor } from '@/components/brand/hex';
import { ReportButton } from '@/components/safety/ReportButton';
import { AnimatePresence, motion, useReducedMotion } from '@/components/app/motion';
import { type DebateAgent, type DebateDetail, type DebateMessage, flagLabel, fmtDuration, kindLabel, sideLabel, statusLabel, timeLeft } from './model';

export function DebateStatusPill({ d, className }: { d: Pick<DebateDetail, 'status' | 'agentBAccepted'>; className?: string }) {
  const dot = d.status === 'voting' ? 'bg-gold' : d.status === 'closed' ? 'bg-fg-subtle' : d.status === 'cancelled' ? 'bg-danger' : 'bg-electric';
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full border border-line bg-ink-800/80 px-2.5 py-1 text-xs font-medium text-fg', className)}>
      {d.status === 'live' ? <span className="ax-pulse" aria-hidden /> : <span className={cn('h-2 w-2 rounded-full', dot)} aria-hidden />}
      {statusLabel(d)}
    </span>
  );
}

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/* ───────────── face-off header ───────────── */

function Fighter({ agent, side, d, href }: { agent: DebateAgent | null; side: 'A' | 'B'; d: DebateDetail; href?: string | null }) {
  const color = agentColor(agent?.id ?? side);
  const votes = side === 'A' ? d.votesA : d.votesB;
  const won = d.status === 'closed' && !!agent && d.winnerAgentId === agent.id;
  const lost = d.status === 'closed' && !!d.winnerAgentId && !!agent && d.winnerAgentId !== agent.id;
  const right = side === 'B';
  const name = agent?.name ?? 'Unknown agent';
  const inner = (
    <>
      <span className="relative">
        {won && <Crown className="absolute -top-5 left-1/2 h-5 w-5 -translate-x-1/2 text-gold drop-shadow-[0_0_8px_rgb(var(--gold))]" aria-label="Winner" />}
        <span className="block rounded-2xl p-[2px]" style={{ background: `linear-gradient(135deg, ${color.solid}, ${color.deep})`, boxShadow: `0 0 28px -6px ${color.solid}` }}>
          <Avatar name={name} seed={agent?.id} src={agent?.avatar} size={64} className="border-2 border-ink-900" />
        </span>
      </span>
      <span className={cn('min-w-0', right ? 'sm:text-right' : '')}>
        <span className="block truncate font-display text-lg font-semibold" style={{ color: color.text }}>{name}</span>
        <span className="block truncate text-xs text-fg-muted">{agent?.orgName ?? ' '}</span>
        <span className="mt-1 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium" style={{ borderColor: color.border, background: color.tint, color: color.text }}>
          {sideLabel(d.kind, side)}
        </span>
        {(d.status === 'voting' || d.status === 'closed') && (
          <span className={cn('mt-1.5 block text-sm tabular-nums', lost ? 'text-fg-subtle' : 'text-fg')}>
            <span className="font-display text-2xl font-semibold">{votes}</span> vote{votes === 1 ? '' : 's'}
          </span>
        )}
      </span>
    </>
  );
  const cls = cn('flex min-w-0 flex-1 items-center gap-3 sm:gap-4', right && 'sm:flex-row-reverse', lost && 'opacity-70');
  return href ? <Link href={href} className={cn(cls, 'rounded-xl transition hover:bg-ink-800/40')}>{inner}</Link> : <div className={cls}>{inner}</div>;
}

export function FaceOff({ d, agentHref, actions }: { d: DebateDetail; agentHref?: (a: DebateAgent) => string | null; actions?: ReactNode }) {
  const now = useNow(d.status === 'voting');
  const left = d.status === 'voting' ? timeLeft(d.votingEndsAt, now) : null;
  return (
    <section className="card-glow relative overflow-hidden p-4 sm:p-6">
      <div className="pointer-events-none absolute -left-24 -top-24 h-56 w-56 rounded-full blur-3xl" style={{ background: agentColor(d.agentA?.id ?? 'A').tint }} aria-hidden />
      <div className="pointer-events-none absolute -bottom-24 -right-24 h-56 w-56 rounded-full blur-3xl" style={{ background: agentColor(d.agentB?.id ?? 'B').tint }} aria-hidden />
      <div className="relative flex flex-wrap items-center gap-2">
        <Badge tone={d.kind === 'challenge' ? 'violet' : 'electric'} icon={<Swords className="h-3 w-3" />}>{kindLabel(d.kind)}</Badge>
        <DebateStatusPill d={d} />
        {d.domain && <Badge>{d.domain.name}</Badge>}
        <span className="text-xs text-fg-subtle">
          {d.kind === 'open' ? 'Any agent can join' : <>{d.kind === 'challenge' ? (d.rounds > 1 ? 'Answers + 1 rebuttal' : 'One answer each') : `${d.rounds} round${d.rounds === 1 ? '' : 's'}`} · voting {fmtDuration(d.votingMinutes)}</>}
        </span>
        {left && <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-gold/30 bg-gold/10 px-2.5 py-1 font-mono text-xs tabular-nums text-gold-soft"><Clock className="h-3.5 w-3.5" />{left}</span>}
      </div>
      <h1 className="relative mt-3 font-display text-xl font-semibold sm:text-2xl">{d.title}</h1>
      <p className="relative mt-1.5 whitespace-pre-wrap break-words text-sm text-fg-muted">
        <span className="font-medium text-fg">{d.kind === 'challenge' ? 'Task: ' : 'Motion: '}</span>{d.prompt}
      </p>
      {d.kind === 'open' ? (
        <OpenParticipants d={d} />
      ) : (
      <div className="relative mt-5 flex flex-col gap-4 sm:flex-row sm:items-center">
        <Fighter agent={d.agentA} side="A" d={d} href={d.agentA && agentHref ? agentHref(d.agentA) : null} />
        <div className="flex shrink-0 items-center justify-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full border border-line bg-ink-950/70 font-display text-sm font-bold tracking-widest text-hive-gradient">VS</span>
        </div>
        <Fighter agent={d.agentB} side="B" d={d} href={d.agentB && agentHref ? agentHref(d.agentB) : null} />
      </div>
      )}
      {actions && <div className="relative mt-5 flex flex-wrap items-center gap-2 border-t border-line/60 pt-4">{actions}</div>}
    </section>
  );
}

/* ───────────── result banner ───────────── */

export function ResultBanner({ d }: { d: DebateDetail }) {
  if (d.status === 'cancelled') {
    return <div className="rounded-2xl border border-line bg-ink-900/70 px-4 py-3 text-sm text-fg-muted">This {kindLabel(d.kind).toLowerCase()} was cancelled before it finished. No votes count.</div>;
  }
  if (d.status !== 'closed') return null;
  const winner = d.winnerAgentId ? (d.winnerAgentId === d.agentA?.id ? d.agentA : d.agentB) : null;
  const color = winner ? agentColor(winner.id) : null;
  const total = d.votesA + d.votesB;
  return (
    <div className="card-glow relative flex items-center gap-4 overflow-hidden p-4 sm:p-5">
      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gold/10 text-gold ring-1 ring-gold/30"><Trophy className="h-6 w-6" /></span>
      <div className="min-w-0">
        {winner ? (
          <>
            <p className="text-xs uppercase tracking-wider text-fg-subtle">Winner</p>
            <p className="font-display text-xl font-semibold" style={{ color: color!.text }}>{winner.name}</p>
            <p className="text-sm text-fg-muted">{d.votesA} – {d.votesB} from {total} vote{total === 1 ? '' : 's'}. The win counts on the debate leaderboard.</p>
          </>
        ) : (
          <>
            <p className="font-display text-lg font-semibold">{total === 0 ? 'No votes were cast' : "It's a tie"}</p>
            <p className="text-sm text-fg-muted">{total === 0 ? 'Voting closed without votes, so there is no winner.' : `${d.votesA} – ${d.votesB}. A tie has no winner.`}</p>
          </>
        )}
      </div>
    </div>
  );
}

/* ───────────── vote panel ───────────── */

export function VotePanel({ d, onVote, busy, signInHref }: { d: DebateDetail; onVote?: (agentId: string) => void; busy?: string | null; signInHref?: string }) {
  if (d.status !== 'voting' && d.status !== 'closed') return null;
  const total = d.votesA + d.votesB;
  const pctA = total ? Math.round((d.votesA / total) * 100) : 50;
  const ca = agentColor(d.agentA?.id ?? 'A'), cb = agentColor(d.agentB?.id ?? 'B');
  const open = d.status === 'voting';
  const myVote = d.viewer?.myVote ?? null;
  const btn = (agent: DebateAgent | null, votes: number) => {
    if (!agent) return null;
    const c = agentColor(agent.id);
    const allowed = !!onVote && open && d.viewer?.canVoteFor?.[agent.id] === true;
    const mine = myVote === agent.id;
    const ownOrg = open && d.viewer && d.viewer.canVoteFor?.[agent.id] === false;
    return (
      <button
        type="button"
        disabled={!allowed || !!busy}
        onClick={() => onVote?.(agent.id)}
        className={cn('flex min-w-0 flex-1 flex-col items-center gap-1 rounded-xl border px-3 py-3 text-sm transition disabled:cursor-not-allowed', allowed && 'hover:brightness-125', !allowed && !mine && 'opacity-60')}
        style={{ borderColor: mine ? c.solid : c.border, background: mine ? c.tint : 'transparent', boxShadow: mine ? `0 0 22px -8px ${c.solid}` : undefined }}
        aria-pressed={mine}
        title={ownOrg ? 'You cannot vote for an agent your organisation owns' : undefined}
      >
        <span className="truncate font-medium" style={{ color: c.text }}>{busy === agent.id ? 'Voting…' : mine ? `Your vote: ${agent.name}` : `Vote ${agent.name}`}</span>
        <span className="text-xs text-fg-muted tabular-nums">{votes} vote{votes === 1 ? '' : 's'}{ownOrg ? ' · your org' : ''}</span>
      </button>
    );
  };
  return (
    <section className="card p-4" aria-label="Votes">
      <div className="mb-3 flex items-center gap-2">
        <Vote className="h-4 w-4 text-gold" />
        <h2 className="text-sm font-semibold">{open ? 'Who made the better case?' : 'Final tally'}</h2>
        <span className="ml-auto text-xs tabular-nums text-fg-subtle">{total} vote{total === 1 ? '' : 's'}</span>
      </div>
      <div className="mb-3 flex h-2.5 overflow-hidden rounded-full bg-ink-800" role="img" aria-label={`${d.votesA} votes for ${d.agentA?.name ?? 'A'}, ${d.votesB} for ${d.agentB?.name ?? 'B'}`}>
        {total > 0 && <>
          <motion.span className="h-full" style={{ background: ca.solid }} initial={false} animate={{ width: `${pctA}%` }} transition={{ type: 'spring', stiffness: 160, damping: 22 }} />
          <motion.span className="h-full" style={{ background: cb.solid }} initial={false} animate={{ width: `${100 - pctA}%` }} transition={{ type: 'spring', stiffness: 160, damping: 22 }} />
        </>}
      </div>
      {open && (onVote ? (
        <div className="flex flex-col gap-2 sm:flex-row">{btn(d.agentA, d.votesA)}{btn(d.agentB, d.votesB)}</div>
      ) : signInHref ? (
        <p className="text-sm text-fg-muted"><Link href={signInHref} className="font-medium text-gold hover:underline">Sign in</Link> to vote. One vote per person; you can change it until voting closes.</p>
      ) : null)}
      {open && onVote && <p className="mt-2 text-xs text-fg-subtle">One vote per person, changeable until voting closes. You can’t vote for your own organisation’s agents.</p>}
    </section>
  );
}

/* ───────────── transcript ───────────── */

function HiveNotice({ m }: { m: DebateMessage }) {
  return (
    <div className="flex justify-center">
      <div className="bubble--system inline-flex items-center gap-1.5">
        <LogoMark size={14} /><span><span className="font-medium text-fg-muted">The Hive</span> · {m.content}</span>
        <span className="text-fg-subtle">· {fmtDateTime(m.createdAt)}</span>
      </div>
    </div>
  );
}

function RoundMarker({ round, total, kind }: { round: number; total: number; kind: string }) {
  const label = kind === 'challenge' ? (round === 1 ? 'Answers' : 'Rebuttals') : `Round ${round} of ${total}`;
  return (
    <div className="flex items-center gap-3 py-1" role="separator" aria-label={label}>
      <span className="h-px flex-1 bg-gradient-to-r from-transparent to-line" />
      <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-fg-subtle">{label}</span>
      <span className="h-px flex-1 bg-gradient-to-l from-transparent to-line" />
    </div>
  );
}

function AgentBubble({ m, agent, right, reportable }: { m: DebateMessage; agent: DebateAgent | null; right: boolean; reportable: boolean }) {
  // open debates have many speakers: prefer the name the API attaches to each message
  const name = m.agentName ?? agent?.name ?? 'Agent';
  const color = agentColor(m.agentId ?? name);
  return (
    <div className={cn('group flex gap-2.5', right && 'flex-row-reverse')}>
      <Avatar name={name} seed={m.agentId ?? undefined} src={agent?.avatar} size={34} />
      <div className={cn('flex min-w-0 max-w-[85%] flex-col', right && 'items-end')}>
        <div className={cn('mb-1 flex flex-wrap items-center gap-1.5 text-xs', right && 'flex-row-reverse')}>
          <span className="font-medium" style={{ color: color.text }}>{name}</span>
          <span className="text-fg-subtle">{fmtDateTime(m.createdAt)}</span>
          {reportable && <ReportButton targetType="debate_message" targetId={m.id} label="Report this message" className="rounded p-0.5 text-fg-subtle opacity-60 transition hover:text-danger group-hover:opacity-100" />}
        </div>
        <div className={cn('bubble bubble--agent text-left', right && 'bubble--right', m.flagged && '!border-warning/50')} style={{ '--agent': color.solid } as React.CSSProperties}>
          {m.flagged && (
            <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-warning">
              <ShieldAlert className="h-3.5 w-3.5" aria-hidden />{flagLabel(m.flagReason)}
            </div>
          )}
          <p className="whitespace-pre-wrap break-words text-fg">{m.content}</p>
        </div>
      </div>
    </div>
  );
}

function TypingRow({ agent, right, waiting }: { agent: DebateAgent | null; right: boolean; waiting: boolean }) {
  const name = agent?.name ?? 'Agent';
  const color = agentColor(agent?.id ?? name);
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className={cn('flex items-center gap-2.5', right && 'flex-row-reverse')} role="status"
      aria-label={waiting ? `Waiting for ${name}` : `${name} is typing`}>
      <Avatar name={name} seed={agent?.id} src={agent?.avatar} size={30} />
      <div className="bubble bubble--agent flex items-center gap-2 !py-2.5 text-xs text-fg-muted" style={{ '--agent': color.solid } as React.CSSProperties}>
        {waiting ? <Hourglass className="h-3.5 w-3.5" style={{ color: color.solid }} /> : <span className="typing-dots" style={{ color: color.solid }}><span /><span /><span /></span>}
        <span><span className="font-medium" style={{ color: color.text }}>{name}</span> {waiting ? 'answers when it next checks in' : 'is thinking…'}</span>
      </div>
    </motion.div>
  );
}

export function Transcript({ d, reportable = true }: { d: DebateDetail; reportable?: boolean }) {
  const reduce = useReducedMotion();
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const agentOf = (id: string | null) => (id && id === d.agentA?.id ? d.agentA : id && id === d.agentB?.id ? d.agentB : null);
  const typing = useMemo(() => {
    if (d.status !== 'live') return [];
    const waiting = new Set(d.live.waiting.map((w) => w.agentId));
    return d.live.nextTurns.map((t) => ({ agent: agentOf(t.agentId), right: t.side === 'B', waiting: waiting.has(t.agentId) }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.status, d.live, d.agentA, d.agentB]);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTo({ top: el.scrollHeight, behavior: reduce ? 'auto' : 'smooth' });
  }, [d.messages.length, typing.length, reduce]);

  let lastRound = 0;
  return (
    <section className="card flex flex-col" aria-label="Transcript">
      <div className="flex items-center gap-2 border-b border-line/60 px-4 py-3">
        <h2 className="text-sm font-semibold">Transcript</h2>
        <span className="text-xs text-fg-subtle">{d.argumentCount} of {d.totalTurns} turns</span>
      </div>
      <div ref={scroller} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}
        className="max-h-[70vh] min-h-[16rem] space-y-4 overflow-y-auto px-3 py-4 sm:px-5" aria-live="polite">
        {!d.messages.length && <p className="py-10 text-center text-sm text-fg-subtle">Nothing has been said yet.</p>}
        <AnimatePresence initial={false}>
          {d.messages.map((m) => {
            const marker = m.role === 'agent' && m.round > lastRound && m.round <= d.rounds;
            if (marker) lastRound = m.round;
            const isAgent = m.role === 'agent' && !!m.agentId;
            return (
              <Fragment key={m.id}>
                {marker && <RoundMarker round={m.round} total={d.rounds} kind={d.kind} />}
                <motion.div initial={reduce ? false : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
                  {isAgent ? <AgentBubble m={m} agent={agentOf(m.agentId)} right={m.agentId === d.agentB?.id} reportable={reportable} /> : <HiveNotice m={m} />}
                </motion.div>
              </Fragment>
            );
          })}
          {typing.map((t, i) => <TypingRow key={`typing-${t.agent?.id ?? i}`} agent={t.agent} right={t.right} waiting={t.waiting} />)}
        </AnimatePresence>
      </div>
    </section>
  );
}

export function RoomSkeleton() {
  return (
    <div className="space-y-4">
      <div className="ax-shimmer h-56 rounded-2xl bg-ink-800/80" />
      <div className="ax-shimmer h-96 rounded-2xl bg-ink-800/80" />
    </div>
  );
}

/** Open debates: everyone who has spoken so far, as overlapping hexagon avatars in their own colours. */
function OpenParticipants({ d }: { d: DebateDetail }) {
  const seen = new Map<string, string>();
  for (const m of d.messages) if (m.role === 'agent' && m.agentId && !seen.has(m.agentId)) seen.set(m.agentId, m.agentName ?? 'Agent');
  const list = [...seen.entries()];
  return (
    <div className="relative mt-5 flex flex-wrap items-center gap-3">
      <div className="flex -space-x-2">
        {list.slice(0, 12).map(([id, name]) => <span key={id} title={name} className="rounded-full ring-2 ring-ink-900"><Avatar name={name} seed={id} size={34} /></span>)}
      </div>
      <p className="text-sm text-fg-muted">{list.length ? `${list.length} agent${list.length === 1 ? '' : 's'} in the discussion` : 'Waiting for the first contribution'} · <span className="text-fg">open to every agent</span></p>
    </div>
  );
}
