'use client';
/** Live, data-driven visuals for inner pages. All numbers come from GET /public/stats and GET /public/network. */
import type { ReactNode } from 'react';
import { Activity, BadgeCheck, BookOpen, Bot, GraduationCap, Layers } from 'lucide-react';
import { AgentNetwork, CountUp, DomainConstellation, HoloGlobe, LiveTicker, usePublicStats, useNetworkData } from '@/components/fx';
import { cx } from '../primitives';

export interface LiveStats { agents: number; verifiedAgents: number; completedSessions: number; domains: number; domainsWithVerifiedAgents?: number; knowledgeListings: number }
type StatKey = keyof LiveStats;

const META: Record<StatKey, { label: string; icon: ReactNode; tone: string }> = {
  agents: { label: 'Public agents', icon: <Bot className="h-4 w-4" />, tone: 'text-electric-soft bg-electric/10 ring-electric/25' },
  verifiedAgents: { label: 'Verified agents', icon: <BadgeCheck className="h-4 w-4" />, tone: 'text-success bg-success/10 ring-success/25' },
  completedSessions: { label: 'Completed sessions', icon: <GraduationCap className="h-4 w-4" />, tone: 'text-gold bg-gold/10 ring-gold/25' },
  domains: { label: 'Capability domains', icon: <Layers className="h-4 w-4" />, tone: 'text-violet-soft bg-violet/10 ring-violet/25' },
  domainsWithVerifiedAgents: { label: 'Domains with verified agents', icon: <Activity className="h-4 w-4" />, tone: 'text-electric-soft bg-electric/10 ring-electric/25' },
  knowledgeListings: { label: 'Knowledge listings', icon: <BookOpen className="h-4 w-4" />, tone: 'text-gold bg-gold/10 ring-gold/25' },
};

export function useLiveStats() {
  const { data, error, isLoading } = usePublicStats();
  return { stats: (data ?? null) as LiveStats | null, error, isLoading };
}

/** Row of live counters. */
export function LiveStatTiles({ keys, className, variant = 'tiles' }: { keys: StatKey[]; className?: string; variant?: 'tiles' | 'inline' }) {
  const { stats, error } = useLiveStats();
  const val = (k: StatKey) => (stats && typeof stats[k] === 'number' ? (stats[k] as number) : error ? null : null);
  if (variant === 'inline') {
    return (
      <dl className={cx('flex flex-wrap items-center gap-x-6 gap-y-3', className)}>
        {keys.map((k) => (
          <div key={k} className="flex items-baseline gap-2">
            <dt className="sr-only">{META[k].label}</dt>
            <dd className="font-display text-2xl font-semibold tabular-nums text-fg"><CountUp value={val(k)} /></dd>
            <span aria-hidden className="text-xs text-fg-subtle">{META[k].label}</span>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <dl className={cx('grid gap-3', keys.length >= 4 ? 'grid-cols-2 lg:grid-cols-4' : 'grid-cols-2 sm:grid-cols-3', className)}>
      {keys.map((k) => (
        <div key={k} className="aix-panel relative overflow-hidden rounded-2xl p-4">
          <div className="flex items-center gap-2">
            <span aria-hidden className={cx('inline-flex h-7 w-7 items-center justify-center rounded-lg ring-1', META[k].tone)}>{META[k].icon}</span>
            <dt className="text-xs text-fg-muted">{META[k].label}</dt>
          </div>
          <dd className="mt-3 font-display text-3xl font-semibold tabular-nums tracking-tight text-fg"><CountUp value={val(k)} /></dd>
        </div>
      ))}
    </dl>
  );
}

/** Rotating globe with one glowing point per domain that has verified agents. */
export function LiveGlobe({ className, size = 420 }: { className?: string; size?: number }) {
  const { data } = useNetworkData();
  const points = (data?.constellation ?? []).filter((d) => d.verifiedAgents > 0).map((d) => ({ label: d.name, weight: d.verifiedAgents }));
  return <HoloGlobe className={className} size={size} points={points} />;
}

/** Live force graph of real public agents. */
export function LiveNetwork({ className, interactive = true }: { className?: string; interactive?: boolean }) {
  const { data } = useNetworkData();
  return <AgentNetwork data={data ?? null} className={className} interactive={interactive} />;
}

export function LiveConstellation({ className }: { className?: string }) {
  const { data } = useNetworkData();
  return <DomainConstellation domains={data?.constellation ?? []} className={className} />;
}

export function LiveActivity({ className }: { className?: string }) {
  const { data } = useNetworkData();
  const items = data?.activity ?? [];
  if (!items.length) return null;
  return <LiveTicker items={items} className={className} />;
}

/** Framed panel for a live canvas visual with caption. */
export function VisualFrame({ children, caption, className, badge }: { children: ReactNode; caption?: ReactNode; className?: string; badge?: ReactNode }) {
  return (
    <figure className={cx('aix-panel relative overflow-hidden rounded-[28px]', className)}>
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_60%_at_50%_40%,rgb(var(--electric)/0.12),transparent_70%)]" />
      {badge && <div className="absolute left-4 top-4 z-10">{badge}</div>}
      {children}
      {caption && <figcaption className="relative border-t border-line/50 px-5 py-3 text-xs text-fg-subtle">{caption}</figcaption>}
    </figure>
  );
}
