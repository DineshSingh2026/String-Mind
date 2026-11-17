import type { Metadata } from 'next';
import { FileCheck2, Search, Upload, Wallet } from 'lucide-react';
import { Reveal, Stagger, StaggerItem } from '@/components/fx';
import { KnowledgeListings } from '@/components/site/KnowledgeListings';
import { Arrow, FxCard, FxCta, FxHero, FxLink, FxSection, LiveChip } from '@/components/site/pages/kit';
import { KnowledgeFlow } from '@/components/site/pages/diagrams';
import { LiveStatTiles } from '@/components/site/pages/live';

export const metadata: Metadata = { title: 'Knowledge Exchange', description: 'License verified, ownership-attested knowledge packs as RAG context for your agents — or sell your own.' };

export default function KnowledgeExchangePage() {
  return (
    <>
      <FxHero eyebrow="Knowledge Exchange" title="Licensed knowledge," accent="ready for retrieval." palette="mixed"
        description="Contributors publish curated, ownership-attested knowledge. After moderation and verification it can be licensed with IDLE Tokens and becomes retrievable (RAG) context for the buyer’s agents."
        actions={<>
          <FxLink href="#listings">Browse listings <Arrow /></FxLink>
          <FxLink href="/sign-in?next=%2Fapp%2Fknowledge" variant="outline">Publish knowledge</FxLink>
        </>}
        visual={<KnowledgeFlow />} />

      <FxSection eyebrow="How it works" title="From upload to licence" headingId="kx-how">
        <Stagger className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StaggerItem className="h-full"><FxCard icon={<Upload className="h-5 w-5" />} title="Contribute" kicker="01">Upload txt, md, csv, json or pdf to a knowledge source; attest ownership and choose a licence.</FxCard></StaggerItem>
          <StaggerItem className="h-full"><FxCard icon={<FileCheck2 className="h-5 w-5" />} tone="success" title="Verify" kicker="02">Listings are moderated before going live. Content duplicated from another organisation is flagged.</FxCard></StaggerItem>
          <StaggerItem className="h-full"><FxCard icon={<Search className="h-5 w-5" />} tone="electric" title="License" kicker="03">Buyers pay in IDLE and get org read-access to the source for retrieval — for all or a specific agent.</FxCard></StaggerItem>
          <StaggerItem className="h-full"><FxCard icon={<Wallet className="h-5 w-5" />} tone="violet" title="Earn" kicker="04">Contributors are credited the price minus platform commission, recorded on the ledger.</FxCard></StaggerItem>
        </Stagger>
      </FxSection>

      <FxSection id="listings" tone="raised" eyebrow="Live listings" title="Verified knowledge on this instance" headingId="kx-live" aside={<LiveChip />}>
        <Reveal className="mt-8"><LiveStatTiles keys={['knowledgeListings', 'domains', 'verifiedAgents']} /></Reveal>
        <Reveal className="mt-8"><KnowledgeListings /></Reveal>
      </FxSection>

      <FxCta eyebrow="Own your expertise" title="Have knowledge worth licensing?" description="Publish a pack, attest ownership, and earn IDLE when other organisations license it." primary={{ href: '/sign-in?next=%2Fapp%2Fknowledge', label: 'Publish knowledge' }} secondary={{ href: '/pricing#commission', label: 'Commission & payouts' }} />
    </>
  );
}
