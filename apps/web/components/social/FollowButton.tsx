'use client';
/**
 * Follow / unfollow an agent, a public room (training session) or a debate. Shows the real follower count.
 * Works on public pages too: signed-out visitors are sent to sign-in and come back here.
 *
 *   <FollowButton targetType="agent" targetId={agent.id} />
 */
import { useState } from 'react';
import { usePathname } from 'next/navigation';
import { Bell, BellRing, Loader2 } from 'lucide-react';
import { api, errorMessage, useApi } from '@/lib/api';
import { cn } from '@/components/ui';

export type FollowTargetType = 'agent' | 'session' | 'debate';
interface Status { following: boolean; followers: number; signedIn: boolean }

const NOUN: Record<FollowTargetType, string> = { agent: 'agent', session: 'room', debate: 'debate' };

export function FollowButton({ targetType, targetId, className, size = 'md' }: {
  targetType: FollowTargetType; targetId: string; className?: string; size?: 'sm' | 'md';
}) {
  const pathname = usePathname();
  const key = targetId ? `/social/follows/status?targetType=${targetType}&targetId=${encodeURIComponent(targetId)}` : null;
  const { data, mutate, isLoading } = useApi<Status>(key, { shouldRetryOnError: false });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const following = !!data?.following;
  const followers = data?.followers ?? 0;

  const toggle = async () => {
    setErr(null);
    if (data && !data.signedIn) {
      window.location.href = `/sign-in?next=${encodeURIComponent(pathname || '/')}`;
      return;
    }
    setBusy(true);
    try {
      const res = following
        ? await api.del<Status>(`/social/follows?targetType=${targetType}&targetId=${encodeURIComponent(targetId)}`)
        : await api.post<Status>('/social/follows', { targetType, targetId });
      await mutate({ following: res.following, followers: res.followers, signedIn: true }, { revalidate: false });
    } catch (e) {
      setErr(errorMessage(e));
    } finally { setBusy(false); }
  };

  const label = following ? 'Following' : 'Follow';
  return (
    <span className={cn('inline-flex flex-col items-start', className)}>
      <button
        type="button" onClick={toggle} disabled={busy || isLoading} aria-pressed={following}
        title={following ? `Stop notifications about this ${NOUN[targetType]}` : `Get notified about this ${NOUN[targetType]}`}
        className={cn(
          'group inline-flex items-center gap-2 rounded-xl border font-medium transition disabled:opacity-60',
          size === 'sm' ? 'h-8 px-3 text-xs' : 'h-10 px-4 text-sm',
          following
            ? 'border-transparent bg-hive-sheen text-ink-950 shadow-[0_6px_22px_-8px_rgb(var(--magenta)/0.7)] hover:brightness-110'
            : 'border-line bg-ink-900/60 text-fg hover:border-fg-subtle hover:bg-ink-800',
        )}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : following ? <BellRing className="h-4 w-4" aria-hidden /> : <Bell className="h-4 w-4" aria-hidden />}
        <span>{label}</span>
        <span className={cn('rounded-full px-1.5 text-[11px] tabular-nums', following ? 'bg-ink-950/20' : 'bg-ink-800 text-fg-muted')} aria-label={`${followers} follower${followers === 1 ? '' : 's'}`}>
          {isLoading ? '…' : followers}
        </span>
      </button>
      {err && <span role="alert" className="mt-1 text-[11px] text-danger-soft">{err}</span>}
    </span>
  );
}
