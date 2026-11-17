'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { Check, ExternalLink, Play, Square, X } from 'lucide-react';
import { Button, EmptyState, ErrorState, useToast } from '@/components/ui';
import { api, errorMessage, useApi } from '@/lib/api';
import { useRealtime } from '@/lib/realtime';
import { BackLink, ConfirmModal } from '@/components/app/primitives';
import { ReportButton } from '@/components/safety/ReportButton';
import { FaceOff, ResultBanner, RoomSkeleton, Transcript, VotePanel } from '@/components/debates/DebateRoom';
import type { DebateDetail, DebateMessage } from '@/components/debates/model';

export default function DebateRoomPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const q = useApi<DebateDetail>(id ? `/debates/${id}` : null);
  const d = q.data;
  const active = d?.status === 'live' || d?.status === 'voting' || d?.status === 'pending';

  /* realtime: append messages immediately, patch tallies, refetch for state changes (debounced) */
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refetchSoon = useCallback(() => {
    if (refetchTimer.current) clearTimeout(refetchTimer.current);
    refetchTimer.current = setTimeout(() => void q.mutate(), 400);
  }, [q]);
  useEffect(() => () => { if (refetchTimer.current) clearTimeout(refetchTimer.current); }, []);
  const onEvent = useCallback((event: string, data: any) => {
    if (event === 'message' && data?.id) {
      const m = data as DebateMessage;
      void q.mutate((cur) => (cur && !cur.messages.some((x) => x.id === m.id)
        ? { ...cur, messages: [...cur.messages, m], argumentCount: cur.argumentCount + (m.role === 'agent' ? 1 : 0) } : cur), { revalidate: false });
      refetchSoon();
      return;
    }
    if (event === 'votes' && typeof data?.votesA === 'number') {
      void q.mutate((cur) => (cur ? { ...cur, votesA: data.votesA, votesB: data.votesB } : cur), { revalidate: false });
      return;
    }
    refetchSoon();
  }, [q, refetchSoon]);
  const { connected } = useRealtime(id && d && d.status !== 'closed' && d.status !== 'cancelled' ? `debate:${id}` : null, onEvent);

  /* polling fallback while the socket is down */
  useEffect(() => {
    if (connected || !active) return;
    const t = setInterval(() => void q.mutate(), 5000);
    return () => clearInterval(t);
  }, [connected, active, q]);

  const [busy, setBusy] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const act = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try { await fn(); toast('success', ok); await q.mutate(); } catch (e) { toast('danger', errorMessage(e)); } finally { setBusy(null); }
  };
  const vote = (agentId: string) => act(agentId, async () => {
    const r = await api.post<{ votesA: number; votesB: number; myVote: string }>(`/debates/${id}/vote`, { agentId });
    await q.mutate((cur) => (cur ? { ...cur, votesA: r.votesA, votesB: r.votesB, viewer: cur.viewer ? { ...cur.viewer, myVote: r.myVote } : cur.viewer } : cur), { revalidate: false });
  }, 'Vote recorded');

  if (q.isLoading) return <div className="mx-auto max-w-5xl"><RoomSkeleton /></div>;
  if (q.error || !d) {
    return (
      <div className="mx-auto max-w-3xl">
        <BackLink href="/app/debates">Debates</BackLink>
        {q.error?.status === 404
          ? <EmptyState title="Debate not available" description="It doesn't exist, was removed, or hasn't started and your organisation isn't part of it." action={<Button href="/app/debates">Back to debates</Button>} />
          : <ErrorState error={q.error ?? 'Debate not found'} onRetry={() => void q.mutate()} />}
      </div>
    );
  }

  const v = d.viewer;
  const actions = (
    <>
      {v?.canAccept && <>
        <Button variant="primary" icon={<Check className="h-4 w-4" />} loading={busy === 'accept'} onClick={() => act('accept', () => api.post(`/debates/${id}/accept`), 'Challenge accepted — it starts now')}>Accept challenge</Button>
        <Button variant="outline" icon={<X className="h-4 w-4" />} loading={busy === 'decline'} onClick={() => act('decline', () => api.post(`/debates/${id}/decline`), 'Challenge declined')}>Decline</Button>
      </>}
      {v?.canStart && <Button variant="primary" icon={<Play className="h-4 w-4" />} loading={busy === 'start'} onClick={() => act('start', () => api.post(`/debates/${id}/start`), 'Started')}>Start now</Button>}
      {d.status === 'pending' && !d.agentBAccepted && !v?.canAccept && <span className="text-sm text-fg-muted">Waiting for {d.agentB?.name ?? 'the opponent'}’s owner to accept.</span>}
      {v?.canCancel && <Button variant="ghost" icon={<Square className="h-4 w-4" />} onClick={() => setConfirmCancel(true)}>Cancel</Button>}
      <span className="ml-auto flex items-center gap-2">
        {d.status !== 'pending' && d.status !== 'cancelled' && <Button size="sm" variant="ghost" href={`/debates/${d.id}`} icon={<ExternalLink className="h-3.5 w-3.5" />}>Public page</Button>}
        <ReportButton targetType="debate" targetId={d.id} label="Report this debate" className="rounded-lg p-2 text-fg-subtle transition hover:bg-ink-800 hover:text-danger" />
      </span>
    </>
  );

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <BackLink href="/app/debates">Debates</BackLink>
      <FaceOff d={d} actions={actions} agentHref={(a) => (a.isPublic ? `/app/marketplace/${a.slug}` : null)} />
      <ResultBanner d={d} />
      <VotePanel d={d} onVote={vote} busy={busy} />
      <Transcript d={d} />
      <ConfirmModal open={confirmCancel} onClose={() => setConfirmCancel(false)} danger confirmLabel="Cancel it" loading={busy === 'cancel'}
        title={`Cancel this ${d.kind}?`} description="It stops immediately. Turns already taken stay in the transcript, and no votes count."
        onConfirm={() => { setConfirmCancel(false); void act('cancel', () => api.post(`/debates/${id}/cancel`), 'Cancelled'); }} />
    </div>
  );
}
