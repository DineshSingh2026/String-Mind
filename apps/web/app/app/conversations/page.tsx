'use client';
import Link from 'next/link';
import { useCallback, useMemo, useState } from 'react';
import { ChevronRight, MessagesSquare, ShieldAlert, Radio } from 'lucide-react';
import { Avatar, Button, Card, EmptyState, ErrorState, PageHeader, Skeleton, Tabs, cn, fmtRelative } from '@/components/ui';
import { useApi } from '@/lib/api';
import { useRealtime } from '@/lib/realtime';
import { StatusPill } from '@/components/training/parts';
import {
  type TrainingMessage, type TrainingSession, LIVE_STATUSES, agentName, asList, domainName, isBlocked, senderLabel, sideAgent,
} from '@/components/training/model';

type Filter = 'live' | 'recent';

export default function ConversationsPage() {
  const q = useApi<unknown>('/training/sessions?pageSize=100', { refreshInterval: 30000 });
  const [filter, setFilter] = useState<Filter>('live');
  const all = asList<TrainingSession>(q.data);
  const liveList = all.filter((s) => LIVE_STATUSES.includes(s.status));
  const recent = useMemo(() => [...all].sort((a, b) => +new Date(b.updatedAt ?? b.createdAt ?? 0) - +new Date(a.updatedAt ?? a.createdAt ?? 0)).slice(0, 30), [all]);
  const list = filter === 'live' ? liveList : recent;

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader eyebrow="Live Conversations" title="Agent conversations"
        description="Follow the transcripts of your agents' training sessions in real time. Open a conversation to intervene, approve learning artefacts or review the evaluation." />
      <Card>
        <Tabs<Filter> className="px-3" value={filter} onChange={setFilter} tabs={[
          { value: 'live', label: 'Live now', count: q.data ? liveList.length : undefined },
          { value: 'recent', label: 'Recent', count: q.data ? recent.length : undefined },
        ]} />
        {q.isLoading ? (
          <div className="space-y-3 p-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-16" />)}</div>
        ) : q.error ? (
          <div className="p-4"><ErrorState error={q.error} onRetry={() => void q.mutate()} /></div>
        ) : !list.length ? (
          <div className="p-4">
            <EmptyState icon={<MessagesSquare className="h-5 w-5" />}
              title={filter === 'live' ? 'No live conversations' : 'No conversations yet'}
              description={filter === 'live' ? 'When one of your agents is in an active training session, its conversation streams here.' : 'Conversations are created by training sessions between agents.'}
              action={<Button variant="primary" href="/app/training">Go to Training Hub</Button>} />
          </div>
        ) : (
          <ul className="divide-y divide-line/50">{list.map((s) => <ConversationRow key={s.id} s={s} />)}</ul>
        )}
      </Card>
    </div>
  );
}

function ConversationRow({ s }: { s: TrainingSession }) {
  const isLive = LIVE_STATUSES.includes(s.status);
  // Use the preview the list endpoint provides; otherwise fetch the transcript for this row.
  const needFetch = !s.lastMessage;
  const msgs = useApi<unknown>(needFetch ? `/training/sessions/${s.id}/messages` : null);
  const [pushed, setPushed] = useState<TrainingMessage | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const onEvent = useCallback((event: string, data: any) => {
    if (event === 'message' && data) setPushed((data.message ?? data) as TrainingMessage);
    if (event === 'status' && typeof data?.status === 'string') setStatus(data.status);
    if (event === 'completed') setStatus('completed');
  }, []);
  useRealtime(isLive ? `session:${s.id}` : null, onEvent);

  const fetched = asList<TrainingMessage>(msgs.data);
  const last = pushed ?? s.lastMessage ?? fetched[fetched.length - 1] ?? null;
  const learner = sideAgent(s, 'learner'); const trainer = sideAgent(s, 'trainer');

  return (
    <li>
      <Link href={`/app/training/${s.id}`} className="flex items-center gap-3 px-4 py-3.5 transition hover:bg-ink-850">
        <div className="relative">
          <Avatar name={agentName(trainer)} src={trainer?.avatar} size={42} className="rounded-full" />
          <Avatar name={agentName(learner)} src={learner?.avatar} size={24} className="absolute -bottom-1 -right-1 rounded-full border-2 border-ink-900" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-medium">{agentName(trainer)} <span className="text-fg-subtle">×</span> {agentName(learner)}</p>
            {isLive && (status ?? s.status) === 'active' && <Radio className="h-3.5 w-3.5 shrink-0 animate-pulse-dot text-success" aria-label="Live" />}
          </div>
          <div className={cn('mt-0.5 truncate text-xs', pushed ? 'text-fg' : 'text-fg-muted')}>
            {msgs.isLoading && !last ? <Skeleton className="h-3 w-48" /> : !last ? (s.subject ?? domainName(s) ?? 'No messages yet')
              : isBlocked(last) ? <span className="inline-flex items-center gap-1 text-warning"><ShieldAlert className="h-3 w-3" />Message withheld by safety filter</span>
                : <><span className="text-fg-subtle">{senderLabel(last, learner, trainer)}:</span> {last.content}</>}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <StatusPill status={status ?? s.status} className="hidden sm:inline-flex" />
          <span className="text-[11px] text-fg-subtle">{fmtRelative(last?.createdAt ?? s.updatedAt ?? s.createdAt)}</span>
        </div>
        <ChevronRight className="h-4 w-4 shrink-0 text-fg-subtle" />
      </Link>
    </li>
  );
}
