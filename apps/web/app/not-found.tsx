import type { Metadata } from 'next';
import Link from 'next/link';
import { Compass, Search } from 'lucide-react';
import { LogoMark } from '@/components/brand/Logo';
import { AuroraBackground, GridBackground, Reveal, WordReveal } from '@/components/fx';
import '@/components/site/pages/pages.css';

export const metadata: Metadata = { title: 'Page not found' };

export default function NotFound() {
  return (
    <main className="aix-grain relative isolate flex min-h-screen items-center justify-center overflow-hidden px-4 py-16">
      <AuroraBackground palette="ai" intensity="subtle" className="-z-10" />
      <GridBackground fade className="-z-10 opacity-60" />
      <div className="relative max-w-lg text-center">
        <Reveal><Link href="/" aria-label="Hive Mind home" className="inline-flex"><LogoMark size={48} /></Link></Reveal>
        <div className="relative mx-auto mt-8 flex h-44 w-44 items-center justify-center sm:h-52 sm:w-52" aria-hidden>
          <span className="aix-spin-slow absolute inset-0 rounded-full border border-dashed border-gold/30" />
          <span className="aix-spin-slower absolute inset-5 rounded-full border border-electric/25" />
          <span className="absolute inset-10 rounded-full bg-[radial-gradient(circle,rgb(var(--gold)/0.25),transparent_70%)]" />
          <span className="aix-spin-slow absolute inset-0"><span className="absolute -top-1 left-1/2 h-2 w-2 -translate-x-1/2 rounded-full bg-gold shadow-[0_0_12px_rgb(var(--gold))]" /></span>
          <span className="relative font-display text-7xl font-semibold tracking-tight text-gold-gradient sm:text-8xl">404</span>
        </div>
        <h1 className="mt-6 text-2xl font-semibold sm:text-3xl"><WordReveal text="This page isn’t on the exchange" /></h1>
        <Reveal delay={0.3}><p className="mt-3 text-fg-muted">The link may be broken or the page may have moved.</p></Reveal>
        <Reveal delay={0.45}>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            <Link href="/" className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-gold-sheen px-6 text-sm font-semibold text-ink-950 shadow-gold hover:brightness-110"><Compass aria-hidden className="h-4 w-4" />Back to home</Link>
            <Link href="/marketplace" className="inline-flex h-12 items-center justify-center gap-2 rounded-full border border-line bg-ink-900/50 px-6 text-sm font-medium backdrop-blur hover:bg-ink-800"><Search aria-hidden className="h-4 w-4" />Explore Marketplace</Link>
          </div>
        </Reveal>
      </div>
    </main>
  );
}
