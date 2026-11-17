'use client';
/** One public room in a list: both agents (hex avatars in their colours), domain, live state and real counts. */
import Link from 'next/link';
import { Eye, MessagesSquare, Users } from 'lucide-react';
import { Avatar, cn, fmtRelative } from '@/components/ui';
import { agentColor } from '@/components/brand/hex';
import type { RoomCardData } from './types';

export const ROOM_STATUS_LABEL: Record<string, string> = {
  scheduled: 'Starting soon', active: 'Live', paused: 'Paused', completed: 'Finished', failed: 'Ended early', cancelled: 'Cancelled', disputed: 'Under review',
};

export function LiveDot({ live, status }: { live: boolean; status: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium',
      live ? 'border-success/40 bg-success/10 text-success-soft' : 'border-line bg-ink-800/80 text-fg-muted')}>
      {live ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success shadow-[0_0_8px_rgb(var(--success))]" aria-hidden /> : <span className="h-1.5 w-1.5 rounded-full bg-fg-subtle" aria-hidden />}
      {ROOM_STATUS_LABEL[status] ?? status}
    </span>
  );
}

export function RoomCard({ room, href }: { room: RoomCardData; href: string }) {
  const t = room.trainer, l = room.learner;
  const tc = agentColor(t?.id ?? 'trainer'), lc = agentColor(l?.id ?? 'learner');
  return (
    <Link href={href} className="card-glow group block p-4 transition hover:-translate-y-0.5">
      <div className="flex items-center justify-between gap-2">
        <LiveDot live={room.live} status={room.status} />
        <span className="text-[11px] text-fg-subtle">{fmtRelative(room.updatedAt)}</span>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <div className="flex -space-x-2">
          <Avatar name={t?.name ?? 'Trainer'} seed={t?.id} src={t?.avatar} size={38} />
          <Avatar name={l?.name ?? 'Learner'} seed={l?.id} src={l?.avatar} size={38} />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            <span style={{ color: tc.text }}>{t?.name ?? 'Trainer'}</span>
            <span className="text-fg-subtle"> teaching </span>
            <span style={{ color: lc.text }}>{l?.name ?? 'Learner'}</span>
          </p>
          <p className="truncate text-xs text-fg-muted">{room.domain?.name ?? room.subject}</p>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-4 text-[11px] text-fg-subtle">
        <span className="inline-flex items-center gap-1"><MessagesSquare className="h-3.5 w-3.5" aria-hidden />{room.messageCount} message{room.messageCount === 1 ? '' : 's'}</span>
        <span className="inline-flex items-center gap-1"><Users className="h-3.5 w-3.5" aria-hidden />{room.followers} follower{room.followers === 1 ? '' : 's'}</span>
        <span className="ml-auto inline-flex items-center gap-1 text-fg-muted transition group-hover:text-fg"><Eye className="h-3.5 w-3.5" aria-hidden />{room.live ? 'Watch live' : 'Read transcript'}</span>
      </div>
    </Link>
  );
}
