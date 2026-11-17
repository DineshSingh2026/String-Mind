'use client';
import './pages/pages.css';
import Link from 'next/link';
import { ArrowRight, BadgeCheck, Crown, GraduationCap, Star } from 'lucide-react';
import { Avatar, fmtNumber } from '@/components/ui';
import { REPUTATION_LEVELS } from '@aix/shared';
import { SpotlightCard } from '@/components/fx';
import { ScoreRingFx } from './pages/ScoreRingFx';
import { DomainIcon } from './DomainIcon';
import { humanize, providerName, type MarketplaceAgent } from './types';
import { cx } from './primitives';

export function reputationLabel(slug?: string | null) {
  if (!slug) return null;
  return REPUTATION_LEVELS.find((l) => l.slug === slug)?.name ?? humanize(slug);
}
export function reputationTone(slug?: string | null): 'success' | 'violet' | 'gold' | 'neutral' | 'electric' {
  switch (slug) {
    case 'top_performer': return 'gold';
    case 'elite_contributor': case 'expert_trainer': return 'success';
    case 'skilled_trainer': return 'violet';
    case 'verified_agent': return 'electric';
    default: return 'neutral';
  }
}
const REP_CLS = {
  gold: 'border-gold/40 bg-gold/10 text-gold-soft', success: 'border-success/35 bg-success/10 text-success-soft', violet: 'border-violet/35 bg-violet/10 text-violet-soft',
  electric: 'border-electric/35 bg-electric/10 text-electric-soft', neutral: 'border-line bg-ink-800/80 text-fg-muted',
};
export function lowestPrice(a: MarketplaceAgent): number | null {
  const ps = (a.listings ?? []).map((l) => l.priceCredits).filter((n): n is number => typeof n === 'number');
  return ps.length ? Math.min(...ps) : null;
}

export function AgentCard({ agent, highlight }: { agent: MarketplaceAgent; highlight?: boolean }) {
  const price = lowestPrice(agent);
  const rep = reputationLabel(agent.reputationLevel);
  const top = agent.verifiedDomains?.[0];
  const prov = providerName(agent.provider);
  const hasListing = (agent.listings ?? []).length > 0;
  return (
    <SpotlightCard glow={highlight ? 'gold' : 'electric'} className={cx('group h-full', highlight && 'ring-1 ring-gold/30')}>
      <article className="relative flex h-full flex-col p-5">
        <div className="flex items-start gap-3.5">
          <div className="relative">
            <span aria-hidden className="absolute -inset-1 rounded-[20px] bg-gradient-to-br from-electric/40 via-violet/20 to-gold/30 opacity-0 blur-md transition duration-500 group-hover:opacity-100" />
            <Avatar name={agent.name} src={agent.avatar} size={52} className="relative rounded-2xl ring-1 ring-white/10" />
          </div>
          <div className="min-w-0 flex-1 pr-14">
            <h3 className={cx('truncate text-[15.5px] font-semibold', highlight ? 'text-gold-soft' : 'text-fg')}>
              <Link href={`/marketplace/${agent.slug}`} className="after:absolute after:inset-0 after:content-[''] focus-visible:outline-none">{agent.name}</Link>
            </h3>
            <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-fg-muted">{agent.description ?? top?.name ?? 'Specialist agent'}</p>
          </div>
        </div>

        <div className="absolute right-4 top-4">
          <ScoreRingFx score={agent.overallScore ?? null} size={48} stroke={4} label={`${agent.name} overall verified score`} />
        </div>

        <div className="mt-4 flex flex-wrap gap-1.5">
          {highlight && <span className="inline-flex items-center gap-1 rounded-full border border-gold/40 bg-gold/10 px-2 py-0.5 text-[11px] font-medium text-gold-soft"><Crown aria-hidden className="h-3 w-3" />Top match</span>}
          {(agent.verifiedDomains ?? []).slice(0, 2).map((d) => (
            <span key={d.slug} className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-electric/25 bg-electric/[0.07] px-2 py-0.5 text-[11px] text-electric-soft">
              <DomainIcon slug={d.slug} className="h-3 w-3 shrink-0" />
              <span className="truncate">{d.name}</span>
              {d.score != null && <span className="font-semibold tabular-nums text-fg">{Math.round(d.score)}</span>}
            </span>
          ))}
          {rep && <span className={cx('inline-flex items-center rounded-full border px-2 py-0.5 text-[11px]', REP_CLS[reputationTone(agent.reputationLevel)])}>{rep}</span>}
          {agent.verificationStatus === 'verified' && <span className="inline-flex items-center gap-1 rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-[11px] text-success-soft"><BadgeCheck aria-hidden className="h-3 w-3" />Verified</span>}
        </div>

        <dl className="mt-4 grid grid-cols-3 divide-x divide-line/50 rounded-xl border border-line/50 bg-ink-950/50 py-2.5 text-center">
          <div>
            <dt className="text-[10px] uppercase tracking-wider text-fg-subtle">Rating</dt>
            <dd className="mt-0.5 inline-flex items-center gap-1 font-display text-sm font-semibold tabular-nums">
              {agent.rating != null && agent.ratingCount ? <><Star aria-hidden className="h-3.5 w-3.5 fill-gold text-gold" />{agent.rating.toFixed(1)}<span className="text-[10px] font-normal text-fg-subtle">({fmtNumber(agent.ratingCount)})</span></> : <span className="text-xs font-normal text-fg-subtle">No reviews</span>}
            </dd>
          </div>
          <div><dt className="text-[10px] uppercase tracking-wider text-fg-subtle">Sessions</dt><dd className="mt-0.5 font-display text-sm font-semibold tabular-nums">{fmtNumber(agent.sessionsCompleted ?? 0)}</dd></div>
          <div><dt className="text-[10px] uppercase tracking-wider text-fg-subtle">From</dt><dd className="mt-0.5 font-display text-sm font-semibold tabular-nums text-gold">{price == null ? '—' : price === 0 ? 'Free' : `${fmtNumber(price)} IDLE`}</dd></div>
        </dl>
        {prov && <p className="mt-3 truncate text-[11px] text-fg-subtle">{prov}{agent.modelName ? ` · ${agent.modelName}` : ''}</p>}

        <div className="relative z-10 mt-auto grid grid-cols-2 gap-2 pt-4">
          <Link href={`/marketplace/${agent.slug}`} className="inline-flex h-9 items-center justify-center gap-1 rounded-xl border border-line bg-ink-900/60 text-xs font-medium text-fg transition hover:border-ink-600 hover:bg-ink-800">
            View Profile <ArrowRight aria-hidden className="h-3.5 w-3.5 transition group-hover:translate-x-0.5" />
          </Link>
          {hasListing ? (
            <Link href={`/sign-in?next=${encodeURIComponent(`/app/marketplace/${agent.slug}`)}`} className="inline-flex h-9 items-center justify-center gap-1 rounded-xl bg-ai-sheen text-xs font-semibold text-white shadow-[0_6px_18px_-8px_rgb(var(--violet)/0.8)] transition hover:brightness-110">
              <GraduationCap aria-hidden className="h-3.5 w-3.5" /> Request training
            </Link>
          ) : (
            <span className="inline-flex h-9 items-center justify-center rounded-xl border border-dashed border-line text-[11px] text-fg-subtle" title="This agent has no active training listing">No listing yet</span>
          )}
        </div>
      </article>
    </SpotlightCard>
  );
}

export function AgentCardSkeleton() {
  return (
    <div className="card p-5" aria-hidden>
      <div className="flex gap-3.5"><div className="aix-shimmer h-[52px] w-[52px] rounded-2xl" /><div className="flex-1 space-y-2 pt-1"><div className="aix-shimmer h-4 w-2/3 rounded" /><div className="aix-shimmer h-3 w-5/6 rounded" /></div><div className="aix-shimmer h-12 w-12 rounded-full" /></div>
      <div className="mt-4 flex gap-1.5"><div className="aix-shimmer h-5 w-28 rounded-full" /><div className="aix-shimmer h-5 w-20 rounded-full" /></div>
      <div className="aix-shimmer mt-4 h-14 rounded-xl" />
      <div className="mt-4 grid grid-cols-2 gap-2"><div className="aix-shimmer h-9 rounded-xl" /><div className="aix-shimmer h-9 rounded-xl" /></div>
    </div>
  );
}
