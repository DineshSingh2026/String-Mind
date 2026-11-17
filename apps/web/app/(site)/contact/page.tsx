import type { Metadata } from 'next';
import { Suspense } from 'react';
import { BookOpen, Building2, LifeBuoy, ShieldAlert } from 'lucide-react';
import { AuroraBackground, GridBackground, Reveal, SpotlightCard, Stagger, StaggerItem } from '@/components/fx';
import { ContactForm } from '@/components/site/ContactForm';
import { GlowTile, HeroEyebrow } from '@/components/site/pages/kit';
import { GradientWords } from '@/components/site/pages/GradientWords';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Contact', description: 'Get in touch with the StringMind team.' };

const CHANNELS = [
  { icon: Building2, tone: 'gold' as const, t: 'Sales & enterprise', b: 'Plans, private networks and rollouts.', href: '/contact?topic=sales' },
  { icon: LifeBuoy, tone: 'electric' as const, t: 'Support', b: 'Signed in? Use Support in the app for account issues.', href: '/contact?topic=support' },
  { icon: ShieldAlert, tone: 'success' as const, t: 'Security', b: 'Choose “Security disclosure” for vulnerability reports.', href: '/contact?topic=security' },
  { icon: BookOpen, tone: 'violet' as const, t: 'Self-serve answers', b: 'Most questions are answered in the FAQ and API docs.', href: '/faq' },
];

export default function ContactPage() {
  return (
    <div className="aix-grain relative isolate overflow-hidden">
      <AuroraBackground palette="mixed" intensity="subtle" className="-z-10" />
      <GridBackground fade className="-z-10 opacity-50" />
      <div className="container-x relative grid gap-12 py-14 sm:py-20 lg:grid-cols-[1fr_1.25fr] lg:gap-14">
        <div>
          <Reveal><HeroEyebrow>Contact</HeroEyebrow></Reveal>
          <h1 className="mt-6 text-[40px] font-semibold leading-[1.05] tracking-[-0.025em] sm:text-6xl">Let’s <GradientWords text="talk." delay={0.1} /></h1>
          <Reveal delay={0.2}><p className="mt-5 text-fg-muted sm:text-lg">Questions about agents, training, enterprise plans or partnerships — send us a message and the team will get back to you.</p></Reveal>
          <Stagger className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
            {CHANNELS.map((c) => (
              <StaggerItem key={c.t} className="h-full">
                <Link href={c.href} scroll={false} className="block h-full rounded-2xl focus-visible:shadow-focus">
                  <SpotlightCard glow={c.tone === 'success' ? 'electric' : c.tone} className="h-full">
                    <div className="flex gap-3 p-4"><GlowTile tone={c.tone} size="sm"><c.icon className="h-4 w-4" /></GlowTile><div><p className="font-medium">{c.t}</p><p className="mt-0.5 text-sm text-fg-muted">{c.b}</p></div></div>
                  </SpotlightCard>
                </Link>
              </StaggerItem>
            ))}
          </Stagger>
        </div>
        <Reveal delay={0.15}>
          <div className="aix-conic-border relative overflow-hidden rounded-[28px] p-6 shadow-[0_40px_100px_-40px_rgb(0_0_0/0.9)] sm:p-8">
            <div aria-hidden className="pointer-events-none absolute -right-20 -top-20 h-64 w-64 rounded-full bg-electric/10 blur-3xl" />
            <div className="relative">
              <h2 className="text-xl font-semibold">Send a message</h2>
              <p className="mt-1 text-sm text-fg-muted">Pick a topic so it reaches the right people.</p>
              <div className="mt-6"><Suspense fallback={<div className="aix-shimmer h-96 rounded-xl" />}><ContactForm /></Suspense></div>
            </div>
          </div>
        </Reveal>
      </div>
    </div>
  );
}
