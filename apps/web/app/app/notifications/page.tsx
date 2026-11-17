'use client';
import { idleText } from '@/lib/tokens';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Bell, CheckCheck } from 'lucide-react';
import { useSWRConfig } from 'swr';
import { NOTIFICATION_TYPES } from '@aix/shared';
import { Button, EmptyState, ErrorState, PageHeader, Tabs, Toggle, cn, fmtRelative } from '@/components/ui';
import { api, useApi } from '@/lib/api';
import { Chip, ChipRow, ListSkeleton, Pagination, Section, titleCase, useAction } from '@/components/app/primitives';
import { listOf, type NotificationItem, type Paged } from '@/components/app/types';

interface Pref { type: string; inApp: boolean; email: boolean }

export default function NotificationsPage() {
  const [tab, setTab] = useState<'inbox' | 'prefs'>('inbox');
  return (
    <div className="space-y-6">
      <PageHeader title="Notifications" description="Training requests, results, payments and security alerts." />
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
              <button className="min-w-0 flex-1 text-left" onClick={() => open(n)}>
                <p className={cn('text-sm', !isRead(n) && 'font-medium')}>{idleText(n.title)}</p>
                {n.body && <p className="mt-0.5 line-clamp-2 text-xs text-fg-muted">{idleText(n.body)}</p>}
                <p className="mt-1 text-[11px] text-fg-subtle">{titleCase(n.type)} · {fmtRelative(n.createdAt)}</p>
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
    <Section title="Delivery preferences" subtitle="Security alerts are always delivered in-app.">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] text-sm">
          <thead><tr className="text-xs text-fg-subtle"><th className="py-2 text-left font-medium">Type</th><th className="w-24 py-2 font-medium">In-app</th><th className="w-24 py-2 font-medium">Email</th></tr></thead>
          <tbody className="divide-y divide-line/50">
            {prefs.map((p) => (
              <tr key={p.type}>
                <td className="py-3">{titleCase(p.type)}</td>
                <td className="py-3 text-center"><Toggle label={`${titleCase(p.type)} in-app`} checked={p.inApp} disabled={p.type === 'security_alert'} onChange={(v) => set(p.type, 'inApp', v)} /></td>
                <td className="py-3 text-center"><Toggle label={`${titleCase(p.type)} email`} checked={p.email} onChange={(v) => set(p.type, 'email', v)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Button className="mt-4" variant="primary" loading={busy === 'p'} onClick={async () => { await run('p', () => api.put('/notifications/preferences', prefs), 'Preferences saved'); mutate(); }}>Save preferences</Button>
    </Section>
  );
}
