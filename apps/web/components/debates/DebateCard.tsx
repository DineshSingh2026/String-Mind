'use client';
import Link from 'next/link';
import { Crown, MailQuestion, Swords } from 'lucide-react';
import { Avatar, Badge, cn, fmtRelative } from '@/components/ui';
import { agentColor } from '@/components/brand/hex';
import { DebateStatusPill } from './DebateRoom';
import { type Debate, type DebateAgent, kindLabel } from './model';

function Side({ agent, votes, won, showVotes, right }: { agent: DebateAgent | null; votes: number; won: boolean; showVotes: boolean; right?: boolean }) {
  const name = agent?.name ?? 'Unknown agent';
  const c = agentColor(agent?.id ?? name);
  return (
    <div className={cn('flex min-w-0 flex-1 items-center gap-2.5', right && 'flex-row-reverse text-right')}>
      <span className="relative shrink-0">
        {won && <Crown className="absolute -top-3.5 left-1/2 h-3.5 w-3.5 -translate-x-1/2 text-gold" aria-label="Winner" />}
        <Avatar name={name} seed={agent?.id} src={agent?.avatar} size={40} />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium" style={{ color: c.text }}>{name}</span>
        <span className="block truncate text-[11px] text-fg-subtle">{showVotes ? `${votes} vote${votes === 1 ? '' : 's'}` : agent?.orgName ?? ' '}</span>
      </span>
    </div>
  );
}

export function DebateCard({ d, href }: { d: Debate; href: string }) {
  const showVotes = d.status === 'voting' || d.status === 'closed';
  return (
    <Link href={href} className="card ax-lift group flex flex-col gap-3 p-4 transition hover:border-fg-subtle/40">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={d.kind === 'challenge' ? 'violet' : 'electric'} icon={<Swords className="h-3 w-3" />}>{kindLabel(d.kind)}</Badge>
        <DebateStatusPill d={d} />
        {d.viewer?.isInvited && <Badge tone="gold" icon={<MailQuestion className="h-3 w-3" />}>Invitation</Badge>}
        <span className="ml-auto text-[11px] text-fg-subtle">{fmtRelative(d.closedAt ?? d.startedAt ?? d.createdAt)}</span>
      </div>
      <div>
        <h3 className="line-clamp-1 font-semibold group-hover:text-gold-soft">{d.title}</h3>
        <p className="mt-0.5 line-clamp-2 text-sm text-fg-muted">{d.prompt}</p>
      </div>
      <div className="mt-auto flex items-center gap-2">
        <Side agent={d.agentA} votes={d.votesA} won={d.status === 'closed' && d.winnerAgentId === d.agentA?.id} showVotes={showVotes} />
        <span className="shrink-0 text-[10px] font-bold tracking-widest text-fg-subtle">VS</span>
        <Side agent={d.agentB} votes={d.votesB} won={d.status === 'closed' && d.winnerAgentId === d.agentB?.id} showVotes={showVotes} right />
      </div>
      {d.status === 'live' && (
        <div className="h-1 overflow-hidden rounded-full bg-ink-800" aria-label={`${d.argumentCount} of ${d.totalTurns} turns`}>
          <div className="h-full bg-hive-sheen" style={{ width: `${Math.round((d.argumentCount / Math.max(1, d.totalTurns)) * 100)}%` }} />
        </div>
      )}
    </Link>
  );
}
