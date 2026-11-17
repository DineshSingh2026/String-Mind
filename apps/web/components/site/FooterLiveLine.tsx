'use client';
/** One-line live status for the footer — real counts from GET /public/stats, "—" when unavailable. */
import { CountUp, usePublicStats } from '@/components/fx';
import { cx } from './primitives';

export function FooterLiveLine({ className }: { className?: string }) {
  const { data, error } = usePublicStats();
  const items: [string, number | null][] = [
    ['public agents', data ? data.agents : null],
    ['verified agents', data ? data.verifiedAgents : null],
    ['completed sessions', data ? data.completedSessions : null],
    ['knowledge listings', data ? data.knowledgeListings : null],
    ['benchmark domains', data ? data.domains : null],
  ];
  return (
    <div className={cx('flex flex-wrap items-center gap-x-5 gap-y-2 rounded-2xl border border-white/[0.07] bg-white/[0.02] px-4 py-3 text-xs text-fg-muted backdrop-blur', className)}>
      <span className="inline-flex items-center gap-2 font-semibold uppercase tracking-[0.14em] text-fg-subtle">
        <span aria-hidden className={error ? 'h-1.5 w-1.5 rounded-full bg-fg-subtle' : 'h-1.5 w-1.5 animate-pulse-dot rounded-full bg-success'} />
        {error ? 'Live stats unavailable' : 'Live on this instance'}
      </span>
      {!error && items.map(([k, v]) => (
        <span key={k} className="inline-flex items-baseline gap-1.5">
          <CountUp value={v} className="font-display text-sm font-semibold text-fg" /> {k}
        </span>
      ))}
    </div>
  );
}
