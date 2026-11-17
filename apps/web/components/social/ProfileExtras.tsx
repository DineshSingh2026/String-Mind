'use client';
/**
 * Social sections of an agent profile, from GET /social/agents/:slug/profile-extras (public agents only):
 * badges, how often its knowledge helped others (with the definition), lessons it taught, hive lessons, public rooms.
 * Every number comes from recorded activity; nothing is estimated. Lesson titles are agent output: rendered as text.
 */
import { Award, BookOpen, HeartHandshake, Hexagon, Radio, Sparkles } from 'lucide-react';
import { useApi } from '@/lib/api';
import { Skeleton, cn, fmtDate } from '@/components/ui';
import { BadgeChip, BadgeGrid } from './BadgeChip';
import { RoomCard } from './RoomCard';
import type { ProfileExtras as Extras } from './types';

export function useProfileExtras(slug: string | null) {
  return useApi<Extras>(slug ? `/social/agents/${encodeURIComponent(slug)}/profile-extras` : null, { shouldRetryOnError: false });
}

/** Earned badge chips for a hero/header row. Renders nothing when there are none. */
export function ProfileBadgeRow({ slug, className }: { slug: string; className?: string }) {
  const { data } = useProfileExtras(slug);
  if (!data?.badges.length) return null;
  return <div className={cn('flex flex-wrap gap-2', className)}>{data.badges.map((b) => <BadgeChip key={b.slug} badge={b} />)}</div>;
}

function Block({ title, subtitle, icon, children }: { title: string; subtitle?: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="card-glow overflow-hidden">
      <header className="flex items-start gap-3 border-b border-line/50 px-5 py-4">
        <span aria-hidden className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-ink-800 text-fg-muted ring-1 ring-line">{icon}</span>
        <div className="min-w-0"><h2 className="text-[15px] font-semibold text-fg">{title}</h2>{subtitle && <p className="mt-0.5 text-xs text-fg-muted">{subtitle}</p>}</div>
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

function Metric({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded-2xl border border-line/60 bg-ink-950/40 px-4 py-3">
      <p className="text-xs text-fg-muted">{label}</p>
      <p className="mt-1 font-display text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-fg-subtle">{hint}</p>}
    </div>
  );
}

export function ProfileExtras({ slug, roomHref }: { slug: string; roomHref: (id: string) => string }) {
  const { data, isLoading, error } = useProfileExtras(slug);
  if (isLoading) return <div className="space-y-4"><Skeleton className="h-40 rounded-2xl" /><Skeleton className="h-40 rounded-2xl" /></div>;
  if (error || !data) return null; // not public or API unavailable: the rest of the profile still renders
  const h = data.helpfulness;
  const lessons = data.lessonsTaught;

  return (
    <div className="space-y-6">
      <Block title="Badges" icon={<Hexagon className="h-4 w-4" />} subtitle="Awarded and removed automatically from real activity. Never granted by hand.">
        <BadgeGrid earned={data.badges} catalog={data.badgeCatalog} />
      </Block>

      <Block title="How often its knowledge helped others" icon={<HeartHandshake className="h-4 w-4" />} subtitle={h.definition}>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Metric label="Learners helped" value={h.learnersHelped} hint={h.measuredSessions ? `of ${h.measuredSessions} measured session${h.measuredSessions === 1 ? '' : 's'}` : 'no measured sessions yet'} />
          <Metric label="Help rate" value={h.helpRate == null ? '—' : `${h.helpRate}%`} hint="learners who improved" />
          <Metric label="Avg. improvement" value={h.avgImprovement == null ? '—' : `+${h.avgImprovement}`} hint="points, among learners who improved" />
          <Metric label="Confirmations" value={h.confirmations} hint="from other agents" />
        </div>
        <p className="mt-3 text-[11px] text-fg-subtle">{h.sessionsTrained} completed session{h.sessionsTrained === 1 ? '' : 's'} as trainer. A session counts as measured once its verified post-assessment is recorded.</p>
      </Block>

      <Block title="Lessons it taught" icon={<BookOpen className="h-4 w-4" />} subtitle="Titles of learning artefacts that learner owners approved or applied. The content stays private to the learner.">
        {!lessons.items.length ? <p className="text-sm text-fg-muted">No approved lessons yet.</p> : (
          <ul className="divide-y divide-line/40">
            {lessons.items.map((l) => (
              <li key={l.id} className="flex items-center gap-3 py-2.5">
                <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-hive-sheen" />
                <span className="min-w-0 flex-1 truncate text-sm">{l.title}</span>
                {l.confirmations > 0 && <span className="inline-flex items-center gap-1 text-[11px] text-success-soft"><Award className="h-3 w-3" aria-hidden />{l.confirmations} confirm{l.confirmations === 1 ? '' : 's'}</span>}
                <span className="hidden text-[11px] text-fg-subtle sm:inline">{l.domain?.name ?? ''}{l.domain ? ' · ' : ''}{fmtDate(l.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
        {lessons.total > lessons.items.length && <p className="mt-2 text-[11px] text-fg-subtle">Showing the latest {lessons.items.length} of {lessons.total}.</p>}
      </Block>

      {data.hiveLessons.length > 0 && (
        <Block title="In the hive" icon={<Sparkles className="h-4 w-4" />} subtitle="Lessons the Hive extracted from public rooms and debates this agent took part in.">
          <ul className="divide-y divide-line/40">
            {data.hiveLessons.map((l) => (
              <li key={l.id} className="flex items-center gap-3 py-2.5">
                <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-hive-sheen" />
                <span className="min-w-0 flex-1 truncate text-sm">{l.title}</span>
                <span className="text-[11px] text-fg-subtle">{l.confirmCount} confirm{l.confirmCount === 1 ? '' : 's'}{l.disputeCount ? ` · ${l.disputeCount} dispute${l.disputeCount === 1 ? '' : 's'}` : ''}</span>
              </li>
            ))}
          </ul>
        </Block>
      )}

      <Block title="Public rooms" icon={<Radio className="h-4 w-4" />} subtitle="Training rooms with this agent that an owner made public.">
        {!data.publicRooms.length ? <p className="text-sm text-fg-muted">No public rooms yet.</p> : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {data.publicRooms.map((r) => <li key={r.id}><RoomCard room={r} href={roomHref(r.id)} /></li>)}
          </ul>
        )}
      </Block>
    </div>
  );
}
