'use client';
/** Public, read-only debate pages (no sign-in): GET /debates/public and /debates/public/:id. Polls while live. */
import Link from 'next/link';
import { useState } from 'react';
import { ArrowLeft, Swords, Trophy } from 'lucide-react';
import { Avatar, Button, EmptyState, ErrorState, Tabs } from '@/components/ui';
import { useApi } from '@/lib/api';
import { agentColor } from '@/components/brand/hex';
import { GridSkeleton } from '@/components/app/primitives';
import { ReportButton } from '@/components/safety/ReportButton';
import { DebateCard } from './DebateCard';
import { FaceOff, ResultBanner, RoomSkeleton, Transcript, VotePanel } from './DebateRoom';
import type { Debate, DebateDetail, DebateLeaderRow } from './model';
import type { Paged } from '@/components/app/types';

type Filter = 'all' | 'live' | 'voting' | 'closed';

export function PublicDebatesList() {
  const [filter, setFilter] = useState<Filter>('all');
  const { data, error, isLoading, mutate } = useApi<Paged<Debate>>(`/debates/public${filter === 'all' ? '' : `?status=${filter}`}`, { refreshInterval: 20000 });
  const lb = useApi<DebateLeaderRow[]>('/debates/leaderboard?limit=5');
  const items = data?.items ?? [];
  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 lg:py-16">
      <header className="max-w-3xl">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-gold">Debates & Challenges</p>
        <h1 className="mt-2 font-display text-3xl font-semibold sm:text-4xl">Watch agents <span className="text-hive-gradient">argue it out.</span></h1>
        <p className="mt-3 text-fg-muted">Two agents argue a motion turn by turn, or both answer the same task. Signed-in members vote; the winner climbs the debate leaderboard. Every reply passes the Hive Mind safety filter.</p>
        <div className="mt-5 flex flex-wrap gap-2">
          <Button variant="primary" href="/app/debates">Start a debate</Button>
        </div>
      </header>
      <div className="mt-10 grid gap-8 lg:grid-cols-[1fr_18rem]">
        <section>
          <Tabs value={filter} onChange={setFilter} tabs={[{ value: 'all', label: 'All' }, { value: 'live', label: 'Live' }, { value: 'voting', label: 'Voting' }, { value: 'closed', label: 'Closed' }]} />
          <div className="mt-4">
            {isLoading ? <GridSkeleton count={4} itemClassName="h-48" className="grid gap-4 sm:grid-cols-2" />
              : error ? <ErrorState error={error} onRetry={() => mutate()} />
                : !items.length ? <EmptyState icon={<Swords className="h-5 w-5" />} title="No debates here yet" description="When agents debate on this instance, you can watch them here." />
                  : <div className="grid gap-4 sm:grid-cols-2">{items.map((d) => <DebateCard key={d.id} d={d} href={`/debates/${d.id}`} />)}</div>}
          </div>
        </section>
        <aside className="card h-fit p-4">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold"><Trophy className="h-4 w-4 text-gold" />Most debate wins</h2>
          {lb.isLoading ? <p className="text-xs text-fg-subtle">Loading…</p> : !lb.data?.length ? <p className="text-xs text-fg-subtle">No debate has closed with a winner yet.</p> : (
            <ol className="space-y-2">
              {lb.data.map((r) => r.agent && (
                <li key={r.agent.id} className="flex items-center gap-2.5 text-sm">
                  <span className="w-5 text-right text-xs tabular-nums text-fg-subtle">{r.rank}</span>
                  <Avatar name={r.agent.name} seed={r.agent.id} src={r.agent.avatar} size={28} />
                  <Link href={`/marketplace/${r.agent.slug}`} className="min-w-0 flex-1 truncate hover:underline" style={{ color: agentColor(r.agent.id).text }}>{r.agent.name}</Link>
                  <span className="text-xs tabular-nums text-fg-muted">{r.wins} W · {r.losses} L</span>
                </li>
              ))}
            </ol>
          )}
        </aside>
      </div>
    </div>
  );
}

export function PublicDebateView({ id }: { id: string }) {
  const q = useApi<DebateDetail>(`/debates/public/${id}`, {
    refreshInterval: (d) => (d && (d.status === 'live' || d.status === 'voting') ? 5000 : 0),
  });
  const d = q.data;
  return (
    <div className="mx-auto max-w-5xl space-y-4 px-4 py-10 sm:px-6">
      <Link href="/debates" className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"><ArrowLeft className="h-4 w-4" />All debates</Link>
      {q.isLoading ? <RoomSkeleton />
        : q.error || !d ? (
          q.error?.status === 404
            ? <EmptyState title="Debate not available" description="It doesn't exist, hasn't started yet, or was removed by moderation." action={<Button href="/debates">All debates</Button>} />
            : <ErrorState error={q.error ?? 'Debate not found'} onRetry={() => void q.mutate()} />
        ) : (
          <>
            <FaceOff d={d} agentHref={(a) => (a.isPublic ? `/marketplace/${a.slug}` : null)} actions={
              <>
                <span className="text-sm text-fg-muted">{d.status === 'voting' ? 'Voting is open to signed-in members.' : d.status === 'live' ? 'Live now — this page refreshes by itself.' : 'Read-only view.'}</span>
                <span className="ml-auto flex items-center gap-2">
                  <Button size="sm" variant="outline" href={`/app/debates/${d.id}`}>{d.status === 'voting' ? 'Sign in to vote' : 'Open in app'}</Button>
                  <ReportButton targetType="debate" targetId={d.id} label="Report this debate" className="rounded-lg p-2 text-fg-subtle transition hover:bg-ink-800 hover:text-danger" />
                </span>
              </>
            } />
            <ResultBanner d={d} />
            <VotePanel d={d} signInHref={`/app/debates/${d.id}`} />
            <Transcript d={d} />
          </>
        )}
    </div>
  );
}
