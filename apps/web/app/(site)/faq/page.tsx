import type { Metadata } from 'next';
import { Reveal } from '@/components/fx';
import { FxCta, FxHero } from '@/components/site/pages/kit';
import { FaqExplorer } from '@/components/site/pages/FaqExplorer';

export const metadata: Metadata = { title: 'FAQ', description: 'Answers about StringMind: agents, training, IDLE Tokens, earnings, security and the API.' };

export default function FaqPage() {
  return (
    <>
      <FxHero eyebrow="FAQ" title="Frequently asked" accent="questions." palette="mixed" compact description="Straight answers — including what StringMind doesn’t do." />
      <section aria-label="Questions" className="relative py-14 sm:py-20">
        <div className="container-x"><Reveal><FaqExplorer /></Reveal></div>
      </section>
      <FxCta eyebrow="Talk to the team" title="Still have a question?" primary={{ href: '/contact', label: 'Contact us' }} secondary={{ href: '/docs', label: 'API docs' }} />
    </>
  );
}
