'use client';
import Link from 'next/link';
import { ArrowRight, BadgeCheck, Bookmark, Heart, Layers } from 'lucide-react';
import { Avatar, Badge, Button, ScoreRing, cn, fmtCredits } from '@/components/ui';
import { IdleToken } from '@/components/brand/IdleToken';
import { Rating, reputationName, shortDomainName } from './primitives';
import type { MarketAgent } from './types';

const providerName = (p: MarketAgent['provider']) => (!p ? null : typeof p === 'string' ? p : p.name);

/** Tier pill derived only from the verified overall score (never claimed domains). */
export function tierFor(score: number | null | undefined): { label: string; tone: 'success' | 'violet' | 'electric' } | null {
  if (score == null) return null;
  if (score >= 85) return { label: 'Expert', tone: 'success' };
  if (score >= 70) return { label: 'Pro', tone: 'violet' };
  return { label: 'Developing', tone: 'electric' };
}

export function AgentCard({ agent, top, favourite, shortlisted, onFavourite, onShortlist, compareSelected, onCompare, compareDisabled }: {
  agent: MarketAgent; top?: boolean; favourite?: boolean; shortlisted?: boolean;
  onFavourite?: () => void; onShortlist?: () => void; compareSelected?: boolean; onCompare?: () => void; compareDisabled?: boolean;
}) {
  const cheapest = agent.listings?.length ? agent.listings.reduce((a, b) => (b.priceCredits < a.priceCredits ? b : a)) : null;
  const tier = tierFor(agent.overallScore);
  const href = `/app/marketplace/${encodeURIComponent(agent.slug)}`;
  const verified = agent.verifiedDomains?.filter((d) => d.score != null) ?? [];
  return (
    <article className={cn('card ax-spot ax-lift group relative flex flex-col overflow-hidden p-4 hover:border-ink-600', top && 'ax-spot--gold border-gold/30', compareSelected && 'border-electric/60 ring-1 ring-electric/40')}>
      {top && <div className="pointer-events-none absolute -right-10 -top-10 h-28 w-28 rounded-full bg-gold/15 blur-2xl" aria-hidden />}
      <div className="relative flex items-start gap-3">
        <span className="relative shrink-0 transition-transform duration-300 group-hover:scale-105 group-hover:-rotate-3"><Avatar name={agent.name} src={agent.avatar} size={52} /></span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <Link href={href} className={cn('truncate font-display text-[15px] font-semibold hover:underline', top ? 'text-gold-gradient' : 'text-fg')}>{agent.name}</Link>
            {agent.verificationStatus === 'verified' && <BadgeCheck className="h-4 w-4 shrink-0 text-success" aria-label="Verified agent" />}
          </div>
          <p className="mt-0.5 line-clamp-1 text-xs text-fg-muted">{agent.description || (verified[0] ? `Verified in ${shortDomainName(verified[0].slug)}` : 'No description')}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1"><Rating value={agent.rating} count={agent.ratingCount} />{agent.sessionsCompleted > 0 && <span className="text-xs text-fg-subtle">{agent.sessionsCompleted} sessions</span>}</div>
        </div>
        <ScoreRing score={agent.overallScore} size={46} label="Verified overall score" />
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {tier && <Badge tone={tier.tone}>{tier.label}</Badge>}
        {agent.experience?.domains.some((d) => d.level === 'established') ? <Badge tone="success">Established trainer</Badge>
          : agent.experience?.domains.some((d) => d.level === 'provisional') ? <Badge tone="electric">Provisional trainer</Badge> : null}
        {agent.reputationLevel && <Badge tone="gold">{reputationName(agent.reputationLevel)}</Badge>}
        {providerName(agent.provider) && <Badge>{providerName(agent.provider)}</Badge>}
      </div>

      {verified.length > 0 && (
        <ul className="mt-3 space-y-1" aria-label="Verified domain scores">
          {verified.slice(0, 3).map((d) => (
            <li key={d.slug} className="text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-fg-muted">{d.name || shortDomainName(d.slug)}</span>
                <span className="font-medium tabular-nums text-success-soft">{Math.round(d.score!)}</span>
              </div>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-ink-800" aria-hidden><div className="h-full rounded-full bg-gradient-to-r from-success/50 to-success" style={{ width: `${Math.max(0, Math.min(100, d.score!))}%` }} /></div>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-auto pt-4">
        <div className="mb-3 flex items-baseline justify-between">
          {cheapest ? (
            <p className="flex items-center gap-1.5 text-sm"><IdleToken size={18} /><span className="font-display text-lg font-semibold text-gold">{fmtCredits(cheapest.priceCredits)}</span><span className="text-fg-subtle">/ {cheapest.pricingModel === 'per_hour' ? 'hour' : 'session'}</span></p>
          ) : <p className="text-xs text-fg-subtle">No training listings</p>}
          {agent.listings?.length > 1 && <span className="text-[11px] text-fg-subtle">{agent.listings.length} listings</span>}
        </div>
        <div className="flex items-center gap-2">
          <Button href={href} variant="outline" size="sm" className="flex-1">View Profile <ArrowRight className="h-3.5 w-3.5" /></Button>
          {onFavourite && <IconToggle on={!!favourite} onClick={onFavourite} label={favourite ? 'Remove from favourites' : 'Add to favourites'} icon={<Heart className={cn('h-4 w-4', favourite && 'fill-danger text-danger')} />} />}
          {onShortlist && <IconToggle on={!!shortlisted} onClick={onShortlist} label={shortlisted ? 'Remove from shortlist' : 'Add to shortlist'} icon={<Bookmark className={cn('h-4 w-4', shortlisted && 'fill-gold text-gold')} />} />}
          {onCompare && <IconToggle on={!!compareSelected} disabled={compareDisabled && !compareSelected} onClick={onCompare} label={compareSelected ? 'Remove from comparison' : 'Add to comparison'} icon={<Layers className={cn('h-4 w-4', compareSelected && 'text-electric')} />} />}
        </div>
      </div>
    </article>
  );
}

function IconToggle({ on, onClick, label, icon, disabled }: { on: boolean; onClick: () => void; label: string; icon: React.ReactNode; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-pressed={on} aria-label={label} title={label}
      className={cn('flex h-8 w-8 items-center justify-center rounded-xl border transition disabled:opacity-40', on ? 'border-ink-600 bg-ink-800' : 'border-line text-fg-muted hover:bg-ink-800 hover:text-fg')}>
      {icon}
    </button>
  );
}
