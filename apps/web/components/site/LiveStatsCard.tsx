'use client';
/** Live platform counts from GET /public/stats. Never fabricated — shows "—" if the API is unreachable. */
import { Activity } from 'lucide-react';
import { useApi } from '@/lib/api';
import { fmtNumber, Skeleton } from '@/components/ui';
import type { PublicStats } from './types';

const ROWS: { key: keyof PublicStats; label: string }[] = [
  { key: 'agents', label: 'Public agents' },
  { key: 'verifiedAgents', label: 'Verified agents' },
  { key: 'completedSessions', label: 'Completed sessions' },
  { key: 'knowledgeListings', label: 'Knowledge listings' },
  { key: 'domains', label: 'Capability domains' },
];

export function LiveStatsCard() {
  const { data, error, isLoading } = useApi<PublicStats>('/public/stats', { shouldRetryOnError: false });
  const vals = ROWS.map((r) => (data && typeof data[r.key] === 'number' ? data[r.key] : null));
  return (
    <div className="card relative flex h-full flex-col overflow-hidden p-6">
      <div aria-hidden className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-electric/15 blur-3xl" />
      <div className="relative flex items-center justify-between">
        <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-fg-muted">
          <span className={error ? 'h-2 w-2 rounded-full bg-fg-subtle' : 'h-2 w-2 animate-pulse-dot rounded-full bg-success'} aria-hidden />
          Live on this StringMind instance
        </p>
        <Activity aria-hidden className="h-4 w-4 text-electric" />
      </div>
      <dl className="relative mt-5 grid grid-cols-2 gap-x-4 gap-y-4">
        {ROWS.slice(0, 4).map((r, i) => (
          <div key={r.key}>
            <dt className="text-xs text-fg-subtle">{r.label}</dt>
            <dd className="mt-1 font-display text-2xl font-semibold tabular-nums text-fg">
              {isLoading ? <Skeleton className="h-7 w-14" /> : fmtNumber(vals[i])}
            </dd>
          </div>
        ))}
      </dl>
      {/* rising bar sparkline: decorative ramp scaled by real values (empty when unavailable) */}
      <div className="relative mt-6 flex h-24 items-end gap-1.5" aria-hidden>
        {Array.from({ length: 14 }).map((_, k) => {
          const base = (k + 1) / 14;
          const has = vals.some((v) => (v ?? 0) > 0);
          const h = has ? 18 + base * 82 : 8;
          return <span key={k} className="flex-1 rounded-t-sm bg-gradient-to-t from-electric/30 to-electric transition-all duration-700" style={{ height: `${h}%`, opacity: 0.35 + base * 0.65 }} />;
        })}
      </div>
      <p className="relative mt-3 text-xs text-fg-subtle">
        {error ? 'Live stats are unavailable right now.' : `${fmtNumber(vals[4])} capability domains. Real database counts — no projections.`}
      </p>
    </div>
  );
}
