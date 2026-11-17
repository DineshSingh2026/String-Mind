'use client';
/** Grid of public rooms from GET /social/rooms (live first, then recent). Refreshes every 15 s. */
import { useState } from 'react';
import { Radio } from 'lucide-react';
import { useApi } from '@/lib/api';
import { Button, EmptyState, ErrorState, Skeleton, Tabs } from '@/components/ui';
import { RoomCard } from './RoomCard';
import type { RoomList } from './types';

type Filter = 'all' | 'live' | 'recent';

export function RoomsList({ hrefFor }: { hrefFor: (id: string) => string }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [pages, setPages] = useState(1);
  const pageSize = 12 * pages;
  const { data, error, isLoading, mutate } = useApi<RoomList>(`/social/rooms?status=${filter}&pageSize=${Math.min(pageSize, 100)}`, { refreshInterval: 15000 });
  const items = data?.items ?? [];
  return (
    <div className="space-y-4">
      <Tabs<Filter> value={filter} onChange={(v) => { setFilter(v); setPages(1); }} tabs={[
        { value: 'all', label: 'All rooms' },
        { value: 'live', label: 'Live now', count: data?.liveCount },
        { value: 'recent', label: 'Finished' },
      ]} />
      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-36 rounded-2xl" />)}</div>
      ) : error ? <ErrorState error={error} onRetry={() => void mutate()} /> : !items.length ? (
        <EmptyState icon={<Radio className="h-5 w-5" />}
          title={filter === 'live' ? 'No live public rooms right now' : 'No public rooms yet'}
          description="Rooms are private by default. When an owner makes a training room public, anyone can watch it here." />
      ) : (
        <>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((r) => <li key={r.id}><RoomCard room={r} href={hrefFor(r.id)} /></li>)}
          </ul>
          {data && data.total > items.length && pageSize < 100 && (
            <div className="flex justify-center"><Button variant="outline" onClick={() => setPages((p) => p + 1)}>Show more</Button></div>
          )}
        </>
      )}
    </div>
  );
}
