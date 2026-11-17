'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, ArrowUpRight, Check, GraduationCap, Inbox, Send, Search, Timer, X, TrendingUp, TrendingDown } from 'lucide-react';
import {
  Alert, Avatar, Badge, Button, Card, EmptyState, ErrorState, Modal, PageHeader, Skeleton, Tabs, cn, fmtCredits, fmtDateTime, fmtRelative,
} from '@/components/ui';
import { api, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ConfirmModal } from '@/components/training/ConfirmModal';
import { StatusPill } from '@/components/training/parts';
import {
  type TrainingRequest, type TrainingSession, DONE_STATUSES, LIVE_STATUSES, STAGE_LABELS, agentName, asList, domainName, scoresOf,
  settlementOf, sideAgent, stageProgress,
} from '@/components/training/model';
import type { TrainingStage } from '@aix/shared';

type Tab = 'incoming' | 'outgoing' | 'active' | 'completed';
const REQ_TONE: Record<string, 'gold' | 'success' | 'danger' | 'neutral'> = { pending: 'gold', accepted: 'success', declined: 'danger', cancelled: 'neutral', expired: 'neutral' };

export default function TrainingHubPage() {
  const { can } = useSession();
  const [tab, setTab] = useState<Tab>('incoming');
  useEffect(() => {
    const h = window.location.hash.slice(1) as Tab;
    if (['incoming', 'outgoing', 'active', 'completed'].includes(h)) setTab(h);
  }, []);
  const change = (t: Tab) => { setTab(t); history.replaceState(null, '', `#${t}`); };

  const incoming = useApi<unknown>('/training/requests?direction=incoming&pageSize=100');
  const outgoing = useApi<unknown>('/training/requests?direction=outgoing&pageSize=100');
  const sessions = useApi<unknown>('/training/sessions?pageSize=100', { refreshInterval: 20000 });
  const inList = asList<TrainingRequest>(incoming.data);
  const outList = asList<TrainingRequest>(outgoing.data);
  const sesList = asList<TrainingSession>(sessions.data);
  const active = sesList.filter((s) => LIVE_STATUSES.includes(s.status));
  const done = sesList.filter((s) => DONE_STATUSES.includes(s.status));
  const pendingIn = inList.filter((r) => r.status === 'pending').length;

  const [detail, setDetail] = useState<{ req: TrainingRequest; dir: 'incoming' | 'outgoing' } | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'accept' | 'decline' | 'cancel'; req: TrainingRequest } | null>(null);

  const refreshAll = () => { void incoming.mutate(); void outgoing.mutate(); void sessions.mutate(); };

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader eyebrow="Training Hub" title="Agent-to-agent training"
        description="Manage training requests, follow live sessions and review independently-evaluated results. IDLE is escrowed on acceptance and settled only after the post-training evaluation."
        actions={<Button variant="primary" href="/app/marketplace" icon={<Search className="h-4 w-4" />}>Find a trainer</Button>} />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MiniStat label="Pending incoming" value={incoming.isLoading ? null : pendingIn} icon={<Inbox className="h-4 w-4" />} tone="gold" />
        <MiniStat label="Outgoing requests" value={outgoing.isLoading ? null : outList.filter((r) => r.status === 'pending').length} icon={<Send className="h-4 w-4" />} tone="electric" />
        <MiniStat label="Active sessions" value={sessions.isLoading ? null : active.length} icon={<Timer className="h-4 w-4" />} tone="success" />
        <MiniStat label="Completed" value={sessions.isLoading ? null : done.filter((s) => s.status === 'completed').length} icon={<GraduationCap className="h-4 w-4" />} tone="violet" />
      </div>

      <Card>
        <Tabs<Tab> className="px-3" value={tab} onChange={change} tabs={[
          { value: 'incoming', label: 'Incoming requests', count: incoming.data ? pendingIn : undefined },
          { value: 'outgoing', label: 'Outgoing requests', count: outgoing.data ? outList.length : undefined },
          { value: 'active', label: 'Active sessions', count: sessions.data ? active.length : undefined },
          { value: 'completed', label: 'Completed', count: sessions.data ? done.length : undefined },
        ]} />
        <div className="p-4 sm:p-5">
          {tab === 'incoming' && (
            <RequestList q={incoming} items={inList} dir="incoming" onOpen={(r) => setDetail({ req: r, dir: 'incoming' })}
              empty={<EmptyState icon={<Inbox className="h-5 w-5" />} title="No incoming requests" description="When another organisation asks one of your trainer agents for a session, it appears here. Publish a training listing to get discovered." action={<Button variant="outline" href="/app/agents">Manage my agents</Button>} />}
              actions={(r) => r.status === 'pending' && (
                can('training.respond') ? <>
                  <Button size="sm" variant="primary" icon={<Check className="h-3.5 w-3.5" />} onClick={() => setConfirm({ kind: 'accept', req: r })}>Accept</Button>
                  <Button size="sm" variant="outline" icon={<X className="h-3.5 w-3.5" />} onClick={() => setConfirm({ kind: 'decline', req: r })}>Decline</Button>
                </> : <span className="text-xs text-fg-subtle">Requires the “training.respond” permission</span>
              )} />
          )}
          {tab === 'outgoing' && (
            <RequestList q={outgoing} items={outList} dir="outgoing" onOpen={(r) => setDetail({ req: r, dir: 'outgoing' })}
              empty={<EmptyState icon={<Send className="h-5 w-5" />} title="No outgoing requests" description="Find a verified trainer in the marketplace and request a session for one of your agents." action={<Button variant="primary" href="/app/marketplace">Find a trainer <ArrowRight className="h-4 w-4" /></Button>} />}
              actions={(r) => <>
                {r.status === 'pending' && can('training.request') && <Button size="sm" variant="outline" onClick={() => setConfirm({ kind: 'cancel', req: r })}>Cancel</Button>}
                {r.sessionId && <Button size="sm" variant="ai" href={`/app/training/${r.sessionId}`}>Open session</Button>}
              </>} />
          )}
          {tab === 'active' && (
            <SessionList q={sessions} items={active}
              empty={<EmptyState icon={<Timer className="h-5 w-5" />} title="No active sessions" description="Accepted requests become scheduled sessions. Start one from its training room." action={<Button variant="primary" href="/app/marketplace">Find a trainer</Button>} />} />
          )}
          {tab === 'completed' && (
            <SessionList q={sessions} items={done} completed
              empty={<EmptyState icon={<GraduationCap className="h-5 w-5" />} title="No completed sessions yet" description="Completed sessions show the independent pre → post evaluation and how IDLE was settled." />} />
          )}
        </div>
      </Card>

      <RequestDetail open={!!detail} req={detail?.req ?? null} dir={detail?.dir ?? 'incoming'} onClose={() => setDetail(null)}
        onAction={(kind) => detail && setConfirm({ kind, req: detail.req })} canRespond={can('training.respond')} canRequest={can('training.request')} />

      <ConfirmModal open={confirm?.kind === 'accept'} onClose={() => setConfirm(null)} tone="primary" confirmLabel="Accept & schedule"
        title="Accept training request?" successMessage="Request accepted — session scheduled"
        description="A training session is created and the learner's IDLE is escrowed. A pre-training assessment is scheduled automatically."
        onConfirm={async () => { await api.post(`/training/requests/${confirm!.req.id}/accept`); setDetail(null); refreshAll(); }}>
        {confirm && <RequestSummary req={confirm.req} />}
      </ConfirmModal>
      <ConfirmModal open={confirm?.kind === 'decline'} onClose={() => setConfirm(null)} confirmLabel="Decline request"
        title="Decline training request?" successMessage="Request declined" description="The requester is notified. No IDLE is charged."
        onConfirm={async () => { await api.post(`/training/requests/${confirm!.req.id}/decline`); setDetail(null); refreshAll(); }}>
        {confirm && <RequestSummary req={confirm.req} />}
      </ConfirmModal>
      <ConfirmModal open={confirm?.kind === 'cancel'} onClose={() => setConfirm(null)} confirmLabel="Cancel request"
        title="Cancel your training request?" successMessage="Request cancelled" description="The trainer will no longer be able to accept it. Nothing has been charged yet."
        onConfirm={async () => { await api.post(`/training/requests/${confirm!.req.id}/cancel`); setDetail(null); refreshAll(); }}>
        {confirm && <RequestSummary req={confirm.req} />}
      </ConfirmModal>
    </div>
  );
}

function MiniStat({ label, value, icon, tone }: { label: string; value: number | null; icon: React.ReactNode; tone: 'gold' | 'electric' | 'success' | 'violet' }) {
  const ring = { gold: 'text-gold bg-gold/10', electric: 'text-electric bg-electric/10', success: 'text-success bg-success/10', violet: 'text-violet bg-violet/10' }[tone];
  return (
    <div className="card flex items-center justify-between p-4">
      <div><p className="text-xs text-fg-muted">{label}</p>{value === null ? <Skeleton className="mt-2 h-6 w-10" /> : <p className="mt-1 font-display text-2xl font-semibold tabular-nums">{value}</p>}</div>
      <span className={cn('rounded-xl p-2.5', ring)}>{icon}</span>
    </div>
  );
}

type Q = { isLoading: boolean; error?: unknown; mutate: () => unknown };

function ListSkeleton() {
  return <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-20 w-full" />)}</div>;
}

function RequestList({ q, items, dir, onOpen, actions, empty }: { q: Q; items: TrainingRequest[]; dir: 'incoming' | 'outgoing'; onOpen: (r: TrainingRequest) => void; actions: (r: TrainingRequest) => React.ReactNode; empty: React.ReactNode }) {
  if (q.isLoading) return <ListSkeleton />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.mutate()} />;
  if (!items.length) return <>{empty}</>;
  const sorted = [...items].sort((a, b) => (a.status === 'pending' ? -1 : 0) - (b.status === 'pending' ? -1 : 0) || +new Date(b.createdAt ?? 0) - +new Date(a.createdAt ?? 0));
  return (
    <ul className="divide-y divide-line/50">
      {sorted.map((r) => {
        const learner = sideAgent(r, 'learner'); const trainer = sideAgent(r, 'trainer');
        const counterpart = dir === 'incoming' ? learner : trainer;
        return (
          <li key={r.id} className="flex flex-col gap-3 py-3.5 sm:flex-row sm:items-center">
            <button onClick={() => onOpen(r)} className="flex min-w-0 flex-1 items-center gap-3 rounded-xl text-left hover:opacity-90">
              <Avatar name={agentName(counterpart)} src={counterpart?.avatar} size={40} className="rounded-full" />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {agentName(learner)} <span className="text-fg-subtle">→ learns from →</span> {agentName(trainer)}
                </p>
                <p className="mt-0.5 truncate text-xs text-fg-muted">
                  {domainName(r) ?? 'Domain'} · {(r.objectives ?? []).length} objective{(r.objectives ?? []).length === 1 ? '' : 's'} · {fmtRelative(r.createdAt)}
                </p>
              </div>
            </button>
            <div className="flex flex-wrap items-center gap-2 sm:justify-end">
              <span className="font-display text-sm font-semibold text-gold-soft">{r.priceCredits ? fmtCredits(r.priceCredits) : 'Free'}</span>
              <Badge tone={REQ_TONE[r.status] ?? 'neutral'}>{r.status}</Badge>
              {actions(r)}
              <Button size="sm" variant="ghost" onClick={() => onOpen(r)}>Details</Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function SessionList({ q, items, completed, empty }: { q: Q; items: TrainingSession[]; completed?: boolean; empty: React.ReactNode }) {
  if (q.isLoading) return <ListSkeleton />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.mutate()} />;
  if (!items.length) return <>{empty}</>;
  const sorted = [...items].sort((a, b) => +new Date(b.updatedAt ?? b.createdAt ?? 0) - +new Date(a.updatedAt ?? a.createdAt ?? 0));
  return (
    <ul className="grid gap-3 md:grid-cols-2">
      {sorted.map((s) => {
        const learner = sideAgent(s, 'learner'); const trainer = sideAgent(s, 'trainer');
        const sc = scoresOf(s); const st = settlementOf(s);
        const pct = stageProgress(s);
        return (
          <li key={s.id}>
            <Link href={`/app/training/${s.id}`} className="card block p-4 transition hover:border-gold/40">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium">{s.subject ?? domainName(s) ?? 'Training session'}</p>
                  <p className="mt-0.5 truncate text-xs text-fg-muted">{agentName(learner)} ← {agentName(trainer)}</p>
                </div>
                <StatusPill status={s.status} />
              </div>
              {!completed ? (
                <div className="mt-4">
                  <div className="mb-1.5 flex justify-between text-xs text-fg-muted"><span>{STAGE_LABELS[s.stage as TrainingStage] ?? s.stage}</span><span className="tabular-nums">{pct}%</span></div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-ink-800"><div className="h-full rounded-full bg-success" style={{ width: `${pct}%` }} /></div>
                </div>
              ) : (
                <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
                  <div><p className="text-fg-subtle">Pre → Post</p><p className="mt-0.5 font-medium tabular-nums">{sc.pre != null ? sc.pre.toFixed(1) : '—'} → {sc.post != null ? sc.post.toFixed(1) : '—'}</p></div>
                  <div><p className="text-fg-subtle">Improvement</p>
                    {sc.improvement != null
                      ? <p className={cn('mt-0.5 flex items-center gap-1 font-semibold tabular-nums', sc.improvement >= 0 ? 'text-success' : 'text-danger-soft')}>{sc.improvement >= 0 ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}{sc.improvement >= 0 ? '+' : ''}{sc.improvement.toFixed(1)}</p>
                      : <p className="mt-0.5 text-fg-muted">Not assessed</p>}
                  </div>
                  <div><p className="text-fg-subtle">Settlement</p><p className="mt-0.5 font-medium capitalize">{st.status}{st.fee ? ` · ${fmtCredits(st.fee)}` : ''}</p></div>
                </div>
              )}
              <p className="mt-3 flex items-center justify-between text-[11px] text-fg-subtle">
                <span>{s.startedAt ? `Started ${fmtDateTime(s.startedAt)}` : `Created ${fmtDateTime(s.createdAt)}`}</span>
                <span className="inline-flex items-center gap-0.5 text-electric-soft">Open room <ArrowUpRight className="h-3 w-3" /></span>
              </p>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function RequestSummary({ req }: { req: TrainingRequest }) {
  return (
    <div className="rounded-xl border border-line bg-ink-950/50 p-3 text-sm">
      <p><span className="text-fg-muted">Learner:</span> {agentName(sideAgent(req, 'learner'))}</p>
      <p><span className="text-fg-muted">Trainer:</span> {agentName(sideAgent(req, 'trainer'))}</p>
      <p><span className="text-fg-muted">Price:</span> <span className="text-gold-soft">{req.priceCredits ? fmtCredits(req.priceCredits) : 'Free'}</span></p>
    </div>
  );
}

function RequestDetail({ open, req, dir, onClose, onAction, canRespond, canRequest }: {
  open: boolean; req: TrainingRequest | null; dir: 'incoming' | 'outgoing'; onClose: () => void;
  onAction: (k: 'accept' | 'decline' | 'cancel') => void; canRespond: boolean; canRequest: boolean;
}) {
  const parts = useMemo(() => req ? [{ a: sideAgent(req, 'learner'), role: 'Learner' }, { a: sideAgent(req, 'trainer'), role: 'Trainer' }] : [], [req]);
  if (!req) return null;
  const pending = req.status === 'pending';
  return (
    <Modal open={open} onClose={onClose} size="lg" title="Training request" description={`${dir === 'incoming' ? 'Received' : 'Sent'} ${fmtDateTime(req.createdAt)}`}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Close</Button>
        {req.sessionId && <Button variant="ai" href={`/app/training/${req.sessionId}`}>Open session</Button>}
        {pending && dir === 'incoming' && canRespond && <>
          <Button variant="outline" onClick={() => onAction('decline')}>Decline</Button>
          <Button variant="primary" onClick={() => onAction('accept')}>Accept</Button>
        </>}
        {pending && dir === 'outgoing' && canRequest && <Button variant="danger" onClick={() => onAction('cancel')}>Cancel request</Button>}
      </>}>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          {parts.map(({ a, role }) => (
            <div key={role} className="flex items-center gap-3 rounded-xl border border-line bg-ink-950/40 p-3">
              <Avatar name={agentName(a)} src={a?.avatar} size={40} className="rounded-full" />
              <div className="min-w-0"><p className="truncate text-sm font-medium">{agentName(a)}</p><p className="text-xs text-fg-muted">{role}{a?.org?.name ? ` · ${a.org.name}` : ''}</p></div>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge tone={REQ_TONE[req.status] ?? 'neutral'}>{req.status}</Badge>
          {domainName(req) && <Badge tone="electric">{domainName(req)}</Badge>}
          {req.listing?.title && <Badge tone="violet">{req.listing.title}</Badge>}
          <Badge tone="gold">{req.priceCredits ? fmtCredits(req.priceCredits) : 'Free'}</Badge>
        </div>
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wider text-fg-subtle">Objectives</p>
          {(req.objectives ?? []).length ? (
            <ol className="list-decimal space-y-1 pl-5 text-sm">{req.objectives!.map((o, i) => <li key={i}>{o}</li>)}</ol>
          ) : <p className="text-sm text-fg-muted">No objectives specified.</p>}
        </div>
        {req.message && <div><p className="mb-2 text-xs font-medium uppercase tracking-wider text-fg-subtle">Message</p><p className="whitespace-pre-wrap rounded-xl border border-line bg-ink-950/40 p-3 text-sm text-fg-muted">{req.message}</p></div>}
        {pending && dir === 'incoming' && <Alert tone="info">Accepting escrows the learner&apos;s IDLE. Your IDLE earnings (fee minus platform commission) are released after the independent post-training evaluation, per the listing&apos;s settlement terms.</Alert>}
      </div>
    </Modal>
  );
}
