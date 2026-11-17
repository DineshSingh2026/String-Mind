'use client';
/** Real featured agents (GET /public/featured-agents) as a snap carousel of tilt cards. */
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Bot } from 'lucide-react';
import { useApi } from '@/lib/api';
import { Button, EmptyState } from '@/components/ui';
import { Stagger, StaggerItem, TiltCard } from '@/components/fx';
import { AgentCard, AgentCardSkeleton } from '../AgentCard';
import { toItems, type MarketplaceAgent, type Paged } from '../types';
import { cx } from '../primitives';

export function FeaturedCarousel() {
  const { data, error, isLoading } = useApi<MarketplaceAgent[] | Paged<MarketplaceAgent>>('/public/featured-agents?limit=12', { shouldRetryOnError: false });
  const items = toItems(data);
  const track = useRef<HTMLUListElement>(null);
  const [edge, setEdge] = useState({ start: true, end: false });

  useEffect(() => {
    const el = track.current; if (!el) return;
    const on = () => setEdge({ start: el.scrollLeft < 8, end: el.scrollLeft + el.clientWidth > el.scrollWidth - 8 });
    on();
    el.addEventListener('scroll', on, { passive: true });
    window.addEventListener('resize', on);
    return () => { el.removeEventListener('scroll', on); window.removeEventListener('resize', on); };
  }, [items.length]);

  const go = (dir: 1 | -1) => {
    const el = track.current; if (!el) return;
    const card = el.querySelector('li');
    el.scrollBy({ left: dir * ((card?.clientWidth ?? 320) + 16), behavior: 'smooth' });
  };

  if (isLoading) return <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{Array.from({ length: 3 }).map((_, i) => <AgentCardSkeleton key={i} />)}</div>;
  if (error || !items.length) {
    return (
      <EmptyState
        icon={<Bot className="h-6 w-6" />}
        title={error ? 'Featured agents are unavailable right now' : 'No verified public agents yet'}
        description={error ? 'The marketplace could not be reached. You can still browse or connect an agent.' : 'Agents appear here once they pass an independent capability assessment and their owners publish them.'}
        action={<div className="flex flex-col gap-2 sm:flex-row"><Button variant="primary" href="/register?persona=agent_owner">Connect your agent</Button><Button variant="outline" href="/marketplace">Browse marketplace</Button></div>}
      />
    );
  }
  return (
    <div className="relative">
      <div className="mb-4 hidden justify-end gap-2 sm:flex">
        <button type="button" onClick={() => go(-1)} disabled={edge.start} aria-label="Previous agents"
          className="flex h-10 w-10 items-center justify-center rounded-full border border-line bg-ink-900/70 text-fg transition hover:border-gold/50 hover:text-gold disabled:opacity-30">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <button type="button" onClick={() => go(1)} disabled={edge.end} aria-label="Next agents"
          className="flex h-10 w-10 items-center justify-center rounded-full border border-line bg-ink-900/70 text-fg transition hover:border-gold/50 hover:text-gold disabled:opacity-30">
          <ArrowRight className="h-4 w-4" />
        </button>
      </div>
      <Stagger>
        <ul ref={track} aria-label="Featured verified agents"
          className="-mx-4 flex snap-x snap-mandatory scroll-px-4 sm:scroll-px-6 lg:scroll-px-8 gap-4 overflow-x-auto scroll-smooth px-4 pb-4 pt-2 [scrollbar-width:none] sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8 [&::-webkit-scrollbar]:hidden">
          {items.map((a, i) => (
            <li key={a.id} className="w-[86%] shrink-0 snap-start sm:w-[calc(50%-8px)] lg:w-[calc(33.333%-11px)]">
              <StaggerItem className="h-full"><TiltCard max={6}><AgentCard agent={a} highlight={i === 0} /></TiltCard></StaggerItem>
            </li>
          ))}
        </ul>
      </Stagger>
      <div aria-hidden className={cx('pointer-events-none absolute bottom-4 right-0 top-14 w-16 bg-gradient-to-l from-ink-950 to-transparent transition-opacity sm:-right-6 lg:-right-8', edge.end && 'opacity-0')} />
    </div>
  );
}
