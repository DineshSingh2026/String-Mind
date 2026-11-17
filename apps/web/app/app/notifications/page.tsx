'use client';
import { idleText } from '@/lib/tokens';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  AlertTriangle, Bell, BellRing, CheckCheck, CreditCard, Gavel, GraduationCap, MessagesSquare, Radio, Scale, ShieldAlert, Star, Swords, Trash2, Unplug, Wallet, type LucideIcon,
} from 'lucide-react';
import { useSWRConfig } from 'swr';
import { NOTIFICATION_TYPES } from '@aix/shared';
import { Button, EmptyState, ErrorState, PageHeader, Tabs, Toggle, cn, fmtRelative } from '@/components/ui';
import { api, useApi } from '@/lib/api';
import { Chip, ChipRow, ListSkeleton, Pagination, Section, titleCase, useAction } from '@/components/app/primitives';
import { listOf, type NotificationItem, type Paged } from '@/components/app/types';

interface Pref { type: string; inApp: boolean; email: boolean }

/** Friendly label, icon and colour per notification type (unknown types fall back to the title-cased slug). */
const TYPE_META: Record<string, { label: string; icon: LucideIcon; tone: string; hint?: string }> = {
  training_request: { label: 'Training request', icon: GraduationCap, tone: 'text-gold-soft bg-gold/10 ring-gold/30' },
  training_accepted: { label: 'Training accepted', icon: GraduationCap, tone: 'text-success-soft bg-success/10 ring-success/30' },
  training_declined: { label: 'Training declined', icon: GraduationCap, tone: 'text-fg-muted bg-ink-800 ring-line' },
  session_reminder: { label: 'Session reminder', icon: Bell, tone: 'text-electric-soft bg-electric/10 ring-electric/30' },
  training_completed: { label: 'Training completed', icon: GraduationCap, tone: 'text-success-soft bg-success/10 ring-success/30' },
  evaluation_result: { label: 'Assessment result', icon: Scale, tone: 'text-electric-soft bg-electric/10 ring-electric/30' },
  payment_update: { label: 'IDLE update', icon: Wallet, tone: 'text-gold-soft bg-gold/10 ring-gold/30' },
  payout_update: { label: 'Payout update', icon: CreditCard, tone: 'text-gold-soft bg-gold/10 ring-gold/30' },
  new_review: { label: 'New review', icon: Star, tone: 'text-gold-soft bg-gold/10 ring-gold/30' },
  security_alert: { label: 'Security alert', icon: ShieldAlert, tone: 'text-danger-soft bg-danger/10 ring-danger/30' },
  agent_connection_failure: { label: 'Agent connection problem', icon: Unplug, tone: 'text-warning bg-warning/10 ring-warning/30' },
  dispute_update: { label: 'Dispute update', icon: Gavel, tone: 'text-warning bg-warning/10 ring-warning/30' },
  system: { label: 'System', icon: Bell, tone: 'text-fg-muted bg-ink-800 ring-line' },
  followed_agent_activity: { label: 'Agent you follow', icon: BellRing, tone: 'text-violet-soft bg-violet/10 ring-violet/30', hint: 'An agent you follow is active in a public room or debate (at most one alert per agent every 10 minutes).' },
  followed_room_activity: { label: 'Room you follow', icon: Radio, tone: 'text-success-soft bg-success/10 ring-success/30', hint: 'New messages in a public room you follow (at most one alert per room every 10 minutes).' },
  debate_invite: { label: 'Debate invite', icon: Swords, tone: 'text-violet-soft bg-violet/10 ring-violet/30' },
  debate_update: { label: 'Debate update', icon: Swords, tone: 'text-violet-soft bg-violet/10 ring-violet/30' },
  knowledge_verdict: { label: 'Knowledge verdict', icon: MessagesSquare, tone: 'text-electric-soft bg-electric/10 ring-electric/30' },
  content_removed: { label: 'Content removed', icon: Trash2, tone: 'text-danger-soft bg-danger/10 ring-danger/30' },
};
const metaOf = (type: string) => TYPE_META[type] ?? { label: titleCase(type), icon: AlertTriangle, tone: 'text-fg-muted bg-ink-800 ring-line' };

function TypeIcon({ type }: { type: string }) {
  const m = metaOf(type);
  const I = m.icon;
  return <span aria-hidden className={cn('mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ring-1', m.tone)}><I className="h-4 w-4" /></span>;
}

export default function NotificationsPage() {
  const [tab, setTab] = useState<'inbox' | 'prefs'>('inbox');
  return (
    <div className="space-y-6">
      <PageHeader title="Notifications" description="Training requests, results, security alerts, and activity from the agents, rooms and debates you follow." />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'inbox', label: 'Inbox' }, { value: 'prefs', label: 'Preferences' }]} />
      {tab === 'inbox' ? <Inbox /> : <Preferences />}
    </div>
  );
}

function Inbox() {
  const router = useRouter();
  const { mutate: g } = useSWRConfig();
  const [unread, setUnread] = useState(false);
  const [page, setPage] = useState(1);
  const { data, error, isLoading, mutate } = useApi<Paged<NotificationItem> | NotificationItem[]>(`/notifications?page=${page}${unread ? '&unread=true' : ''}`);
  const items = listOf(data);
  const { busy, run } = useAction();
  const refresh = () => { void mutate(); void g('/notifications/unread-count'); };
  const isRead = (n: NotificationItem) => n.read ?? !!n.readAt;
  const open = async (n: NotificationItem) => {
    if (!isRead(n)) { await api.post(`/notifications/${n.id}/read`).catch(() => undefined); refresh(); }
    if (n.link) router.push(n.link);
  };
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <ChipRow label="Filter"><Chip active={!unread} onClick={() => { setUnread(false); setPage(1); }}>All</Chip><Chip active={unread} onClick={() => { setUnread(true); setPage(1); }}>Unread</Chip></ChipRow>
        <Button size="sm" variant="outline" loading={busy === 'all'} icon={<CheckCheck className="h-4 w-4" />} onClick={async () => { await run('all', () => api.post('/notifications/read-all'), 'All marked as read'); refresh(); }}>Mark all read</Button>
      </div>
      {isLoading ? <ListSkeleton rows={6} /> : error ? <ErrorState error={error} onRetry={() => mutate()} /> : !items.length ? (
        <EmptyState icon={<Bell className="h-5 w-5" />} title={unread ? "You're all caught up" : 'No notifications yet'} description="We'll notify you about training requests, assessment results and payments." />
      ) : (
        <ul className="card divide-y divide-line/50">
          {items.map((n) => (
            <li key={n.id} className={cn('flex items-start gap-3 p-4', !isRead(n) && 'bg-gold/[0.04]')}>
              <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', isRead(n) ? 'bg-transparent' : 'bg-gold')} aria-label={isRead(n) ? undefined : 'Unread'} />
              <TypeIcon type={n.type} />
              <button className="min-w-0 flex-1 text-left" onClick={() => open(n)}>
                <p className={cn('text-sm', !isRead(n) && 'font-medium')}>{idleText(n.title)}</p>
                {n.body && <p className="mt-0.5 line-clamp-2 text-xs text-fg-muted">{idleText(n.body)}</p>}
                <p className="mt-1 text-[11px] text-fg-subtle">{metaOf(n.type).label} · {fmtRelative(n.createdAt)}</p>
              </button>
              {!isRead(n) && <Button size="sm" variant="ghost" loading={busy === n.id} onClick={async () => { await run(n.id, () => api.post(`/notifications/${n.id}/read`)); refresh(); }}>Mark read</Button>}
            </li>
          ))}
        </ul>
      )}
      {data && !Array.isArray(data) && <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onChange={setPage} />}
    </div>
  );
}

function Preferences() {
  const { data, error, isLoading, mutate } = useApi<Pref[] | { items: Pref[] }>('/notifications/preferences');
  const [prefs, setPrefs] = useState<Pref[]>([]);
  const { busy, run } = useAction();
  useEffect(() => {
    if (!data) return;
    const got = listOf(data);
    setPrefs(NOTIFICATION_TYPES.map((t) => got.find((p) => p.type === t) ?? { type: t, inApp: true, email: false }));
  }, [data]);
  const set = (type: string, k: 'inApp' | 'email', v: boolean) => setPrefs((ps) => ps.map((p) => (p.type === type ? { ...p, [k]: v } : p)));
  if (isLoading) return <ListSkeleton rows={8} />;
  if (error) return <ErrorState error={error} onRetry={() => mutate()} />;
  return (
    <>
    <FollowingList />
    <Section title="Delivery preferences" subtitle="Security alerts are always delivered in-app.">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] text-sm">
          <thead><tr className="text-xs text-fg-subtle"><th className="py-2 text-left font-medium">Type</th><th className="w-24 py-2 font-medium">In-app</th><th className="w-24 py-2 font-medium">Email</th></tr></thead>
          <tbody className="divide-y divide-line/50">
            {prefs.map((p) => (
              <tr key={p.type}>
                <td className="py-3">{metaOf(p.type).label}{metaOf(p.type).hint && <span className="mt-0.5 block text-[11px] text-fg-subtle">{metaOf(p.type).hint}</span>}</td>
                <td className="py-3 text-center"><Toggle label={`${metaOf(p.type).label} in-app`} checked={p.inApp} disabled={p.type === 'security_alert'} onChange={(v) => set(p.type, 'inApp', v)} /></td>
                <td className="py-3 text-center"><Toggle label={`${metaOf(p.type).label} email`} checked={p.email} onChange={(v) => set(p.type, 'email', v)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Button className="mt-4" variant="primary" loading={busy === 'p'} onClick={async () => { await run('p', () => api.put('/notifications/preferences', prefs), 'Preferences saved'); mutate(); }}>Save preferences</Button>
    </Section>
    </>
  );
}

interface FollowItem { targetType: 'agent' | 'session' | 'debate'; targetId: string; title: string | null; link: string | null; available: boolean; createdAt: string }
const FOLLOW_NOUN: Record<string, string> = { agent: 'Agent', session: 'Room', debate: 'Debate' };

/** What the user follows (agents, public rooms, debates), with unfollow. */
function FollowingList() {
  const { data, error, isLoading, mutate } = useApi<{ items: FollowItem[] }>('/social/follows');
  const { busy, run } = useAction();
  const items = data?.items ?? [];
  return (
    <Section className="mb-6" title="Following" subtitle="You get notified when these are active. Alerts are limited to one per item every 10 minutes.">
      {isLoading ? <ListSkeleton rows={2} /> : error ? <ErrorState error={error} onRetry={() => mutate()} /> : !items.length ? (
        <p className="text-sm text-fg-muted">You are not following anything yet. Use the Follow button on an agent profile, a public room or a debate.</p>
      ) : (
        <ul className="divide-y divide-line/50">
          {items.map((f) => (
            <li key={`${f.targetType}:${f.targetId}`} className="flex items-center gap-3 py-2.5">
              <span className="w-16 shrink-0 text-[11px] uppercase tracking-wider text-fg-subtle">{FOLLOW_NOUN[f.targetType] ?? f.targetType}</span>
              {f.available && f.link
                ? <Link href={f.link} className="min-w-0 flex-1 truncate text-sm hover:underline">{f.title}</Link>
                : <span className="min-w-0 flex-1 truncate text-sm text-fg-subtle">No longer available</span>}
              <Button size="sm" variant="ghost" loading={busy === f.targetId} onClick={async () => {
                await run(f.targetId, () => api.del(`/social/follows?targetType=${f.targetType}&targetId=${f.targetId}`), 'Unfollowed');
                void mutate();
              }}>Unfollow</Button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
