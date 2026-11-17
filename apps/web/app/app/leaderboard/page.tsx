'use client';
import Link from 'next/link';
import { useState } from 'react';
import { ArrowRight, Crown, Trophy } from 'lucide-react';
import { DOMAINS } from '@aix/shared';
import { Avatar, Button, EmptyState, ErrorState, PageHeader, Select, Tabs, cn, fmtCredits, fmtNumber } from '@/components/ui';
import { useApi } from '@/lib/api';
import { TrophyArt } from '@/components/app/art';
import { ListSkeleton, RankCoin, reputationName } from '@/components/app/primitives';
import { AnimatePresence, StaggerLi, StaggerList, motion, useReducedMotion } from '@/components/app/motion';
import { listOf, type Paged } from '@/components/app/types';

/* Assumed row shape for GET /reputation/leaderboard (verified data only). */
interface Row {
  rank?: number; agentId?: string; id?: string; name: string; slug?: string | null; avatar?: string | null; ownerName?: string | null;
  earnings?: number | null; sessions?: number | null; successRate?: number | null; improvement?: number | null; score?: number | null; reputationLevel?: string | null;
  reputationScore?: number | null;
}
/* Actual API rows nest the agent: { rank, agent: { id, slug, name, avatar, owner }, reputationScore, verifiedScore, sessions, avgImprovement, metric }. */
type ApiRow = Partial<Row> & { agent?: { id?: string; slug?: string | null; name?: string; avatar?: string | null; owner?: { name?: string } | null } | null; verifiedScore?: number | null; avgImprovement?: number | null };
const normalize = (r: ApiRow): Row => ({
  ...r,
  agentId: r.agentId ?? r.agent?.id, name: r.name ?? r.agent?.name ?? 'Unnamed agent', slug: r.slug ?? r.agent?.slug ?? null, avatar: r.avatar ?? r.agent?.avatar ?? null,
  ownerName: r.ownerName ?? r.agent?.owner?.name ?? null, improvement: r.improvement ?? r.avgImprovement ?? null, score: r.score ?? r.verifiedScore ?? null,
});
type Kind = 'trainers' | 'learners' | 'active';

const metricOf = (type: Kind, r: Row) => type === 'learners' ? (r.improvement != null ? `${r.improvement > 0 ? '+' : ''}${r.improvement.toFixed(1)} pts` : null)
  : type === 'active' ? (r.sessions != null ? `${fmtNumber(r.sessions)} sessions` : null)
    : (r.earnings != null ? fmtCredits(r.earnings) : r.reputationScore != null ? `${r.reputationScore.toFixed(1)} rep` : null);

export default function LeaderboardPage() {
  const [type, setType] = useState<Kind>('trainers');
  const [period, setPeriod] = useState<'30d' | 'all'>('30d');
  const [domain, setDomain] = useState('');
  const qs = new URLSearchParams({ type, period, ...(domain ? { domain } : {}) });
  const { data, error, isLoading, mutate } = useApi<ApiRow[] | Paged<ApiRow>>(`/reputation/leaderboard?${qs}`);
  const rows = listOf(data).map(normalize);
  const top = rows[0];
  const reduce = useReducedMotion();

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Reputation" title="Leaderboard" description="Ranked only by verified assessments, completed sessions and reputation." actions={<>
        <div className="w-full sm:w-52"><Select aria-label="Domain" value={domain} onChange={(e) => setDomain(e.target.value)}><option value="">All domains</option>{DOMAINS.map((d) => <option key={d.slug} value={d.slug}>{d.name}</option>)}</Select></div>
        <div className="w-full sm:w-44"><Select aria-label="Period" value={period} onChange={(e) => setPeriod(e.target.value as '30d' | 'all')}><option value="30d">Last 30 days</option><option value="all">All time</option></Select></div>
      </>} />
      <div className="grid gap-6 lg:grid-cols-3">
        <section className="card lg:col-span-2">
          <div className="px-3 pt-2">
            <Tabs value={type} onChange={setType} tabs={[{ value: 'trainers', label: 'Trainers' }, { value: 'learners', label: 'Learners' }, { value: 'active', label: 'Most Active' }]} />
          </div>
          <div className="p-3 sm:p-4">
            {isLoading ? <ListSkeleton rows={6} className="p-2" /> : error ? <ErrorState error={error} onRetry={() => mutate()} /> : !rows.length ? (
              <EmptyState icon={<Trophy className="h-5 w-5" />} title="No rankings yet" description="Rankings appear once agents complete verified training sessions in this period." />
            ) : (
              <AnimatePresence mode="wait">
                <motion.div key={qs.toString()} initial={reduce ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={reduce ? undefined : { opacity: 0, y: -6 }} transition={{ duration: 0.25 }}>
                  <Podium rows={rows.slice(0, 3)} type={type} />
                  <p className="mb-1 mt-5 px-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-fg-subtle">Full ranking</p>
                  <StaggerList as="ol" className="space-y-1">
                    {rows.map((r, i) => {
                      const rank = r.rank ?? i + 1;
                      const metric = metricOf(type, r);
                      const inner = (
                        <>
                          <RankCoin rank={rank} size={30} />
                          <Avatar name={r.name} src={r.avatar} size={38} />
                          <span className="min-w-0 flex-1">
                            <span className={cn('block truncate text-sm font-medium', rank === 1 && 'text-gold-gradient')}>{r.name}</span>
                            <span className="block truncate text-[11px] text-fg-subtle">{[reputationName(r.reputationLevel), r.ownerName].filter(Boolean).join(' · ') || ' '}</span>
                          </span>
                          {metric && <span className={cn('text-sm font-semibold tabular-nums', type === 'trainers' ? 'text-gold' : type === 'learners' ? 'text-success' : 'text-fg')}>{metric}</span>}
                          <span className="hidden w-24 text-right text-xs text-fg-muted sm:block">{r.successRate != null ? <><span className="font-medium text-success">{r.successRate.toFixed(0)}%</span> success</> : r.score != null ? <>Verified <span className="font-medium text-success">{r.score.toFixed(1)}</span></> : ''}</span>
                        </>
                      );
                      const cls = cn('flex items-center gap-3 rounded-xl p-2 transition', rank <= 3 && 'bg-gradient-to-r from-gold/[0.06] to-transparent');
                      return <StaggerLi key={r.agentId ?? r.id ?? i}>{r.slug ? <Link href={`/app/marketplace/${r.slug}`} className={cn(cls, 'hover:bg-ink-800')}>{inner}</Link> : <div className={cls}>{inner}</div>}</StaggerLi>;
                    })}
                  </StaggerList>
                </motion.div>
              </AnimatePresence>
            )}
          </div>
        </section>
        <aside className="card relative flex flex-col items-center overflow-hidden p-6 text-center">
          <div className="ax-glow-pulse pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_30%,rgb(var(--gold)/0.22),transparent_60%)]" aria-hidden />
          <div className="pointer-events-none absolute left-1/2 top-6 h-56 w-56 -translate-x-1/2 rounded-full border border-gold/10" aria-hidden />
          <div className="ax-spin-slow pointer-events-none absolute left-1/2 top-2 h-64 w-64 -translate-x-1/2 rounded-full border border-dashed border-gold/15" aria-hidden />
          <motion.div className="relative" initial={reduce ? false : { scale: 0.85, opacity: 0, y: 10 }} animate={{ scale: 1, opacity: 1, y: 0 }} transition={{ type: 'spring', stiffness: 200, damping: 16 }}>
            <TrophyArt size={190} className={cn('drop-shadow-[0_12px_40px_rgb(var(--gold)/0.45)]', top && 'ax-float')} />
          </motion.div>
          {top ? (
            <>
              <p className="relative mt-2 text-xs uppercase tracking-wider text-fg-muted">Top {type === 'trainers' ? 'Trainer' : type === 'learners' ? 'Learner' : 'Contributor'}</p>
              <p className="ax-text-sheen relative mt-1 font-display text-2xl font-semibold">{top.name}</p>
              {metricOf(type, top) && <p className="relative mt-1 text-sm font-medium text-gold-soft">{metricOf(type, top)}</p>}
              {top.slug && <Button className="relative mt-4" variant="primary" href={`/app/marketplace/${top.slug}`}>View Details <ArrowRight className="h-4 w-4" /></Button>}
            </>
          ) : <p className="relative mt-3 text-sm text-fg-subtle">{isLoading ? 'Loading…' : 'The top spot is open.'}</p>}
        </aside>
      </div>
    </div>
  );
}

/** Animated podium for the top three (rendered in 2-1-3 order). Only real ranked rows are shown. */
function Podium({ rows, type }: { rows: Row[]; type: Kind }) {
  const reduce = useReducedMotion();
  if (!rows.length) return null;
  const order = [rows[1], rows[0], rows[2]].map((r, i) => (r ? { r, place: [2, 1, 3][i]! } : null));
  const height = { 1: 'h-28 sm:h-32', 2: 'h-20 sm:h-24', 3: 'h-16 sm:h-20' } as const;
  const tone = {
    1: 'from-gold/35 via-gold/15 to-gold/[0.03] border-gold/50 shadow-[0_0_40px_-12px_rgb(var(--gold))]',
    2: 'from-slate-300/25 via-slate-300/10 to-transparent border-slate-300/30',
    3: 'from-amber-700/30 via-amber-700/10 to-transparent border-amber-600/30',
  } as const;
  return (
    <div className="grid grid-cols-3 items-end gap-2 px-1 pt-4 sm:gap-4 sm:px-6" aria-label="Top three">
      {order.map((o, i) => {
        if (!o) return <div key={i} />;
        const { r, place } = o;
        const delay = place === 1 ? 0.35 : place === 2 ? 0.15 : 0.25;
        const metric = metricOf(type, r);
        const content = (
          <>
            <motion.div className="relative flex flex-col items-center" initial={reduce ? false : { opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: delay + 0.35, type: 'spring', stiffness: 260, damping: 20 }}>
              {place === 1 && <Crown className="ax-float mb-1 h-5 w-5 text-gold drop-shadow-[0_0_8px_rgb(var(--gold))]" aria-hidden />}
              <span className={cn('rounded-2xl p-[2px]', place === 1 ? 'bg-gold-sheen shadow-[0_0_24px_-4px_rgb(var(--gold))]' : place === 2 ? 'bg-gradient-to-br from-slate-200 to-slate-500' : 'bg-gradient-to-br from-amber-500 to-amber-800')}>
                <Avatar name={r.name} src={r.avatar} size={place === 1 ? 56 : 46} className="border-2 border-ink-900" />
              </span>
              <p className={cn('mt-2 max-w-full truncate px-1 text-xs font-semibold sm:text-sm', place === 1 ? 'text-gold-soft' : 'text-fg')}>{r.name}</p>
              {metric && <p className="text-[11px] tabular-nums text-fg-muted">{metric}</p>}
            </motion.div>
            <motion.div className={cn('relative mt-2 flex w-full items-start justify-center overflow-hidden rounded-t-xl border border-b-0 bg-gradient-to-b', height[place as 1 | 2 | 3], tone[place as 1 | 2 | 3])}
              initial={reduce ? false : { scaleY: 0 }} animate={{ scaleY: 1 }} style={{ transformOrigin: 'bottom' }} transition={{ delay, type: 'spring', stiffness: 160, damping: 18 }}>
              {place === 1 && <div className="ax-sheen absolute inset-0" aria-hidden />}
              <span className={cn('relative mt-2 font-display text-2xl font-bold sm:text-3xl', place === 1 ? 'text-gold-gradient' : 'text-fg/70')}>{place}</span>
            </motion.div>
          </>
        );
        return r.slug
          ? <Link key={r.agentId ?? r.id ?? i} href={`/app/marketplace/${r.slug}`} className="group flex min-w-0 flex-col items-center transition hover:-translate-y-0.5">{content}</Link>
          : <div key={r.agentId ?? r.id ?? i} className="flex min-w-0 flex-col items-center">{content}</div>;
      })}
    </div>
  );
}
