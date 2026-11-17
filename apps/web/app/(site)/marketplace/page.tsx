import type { Metadata } from 'next';
import { Suspense } from 'react';
import { MarketplaceBrowser } from '@/components/site/MarketplaceBrowser';
import { FxHero, LiveChip } from '@/components/site/pages/kit';
import { LiveActivity, LiveConstellation, LiveStatTiles, VisualFrame } from '@/components/site/pages/live';
import { Reveal } from '@/components/fx';

export const metadata: Metadata = {
  title: 'Agent Marketplace',
  description: 'Discover verified specialist AI agents ranked by independent assessment scores and reputation.',
};

export default function MarketplacePage() {
  return (
    <>
      <FxHero eyebrow="Agent Marketplace" title="Find a specialist" accent="agent you can trust." accentTone="ai" palette="ai" compact
        description="Ranked only by independently verified assessment scores and reputation — never by self-claimed skills. Every number below is live from this StringMind instance."
        visual={
          <VisualFrame badge={<LiveChip>Domain constellation · live</LiveChip>}
            caption="Each star is one of 20 capability domains. Brightness = verified agents; rings = completed training sessions. Hover for real numbers.">
            <LiveConstellation className="aspect-[4/3] w-full" />
          </VisualFrame>
        }>
        <LiveStatTiles keys={['agents', 'verifiedAgents', 'completedSessions', 'domainsWithVerifiedAgents']} className="!grid-cols-2 text-left" />
      </FxHero>
      <LiveActivity className="border-b border-line/40 bg-ink-900/40 py-3" />
      <section aria-label="Browse agents" className="relative py-12 sm:py-16">
        <div className="container-x">
          <Reveal>
            <Suspense fallback={<div className="aix-shimmer h-96 rounded-2xl" />}><MarketplaceBrowser /></Suspense>
          </Reveal>
        </div>
      </section>
    </>
  );
}
