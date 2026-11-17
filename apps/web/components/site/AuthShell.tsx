import type { ReactNode } from 'react';
import { AuroraBackground, GridBackground, Reveal } from '@/components/fx';
import { HeroEyebrow } from './pages/kit';
import { AuthVisual } from './pages/AuthVisual';

/** Split auth layout: form card + live network panel (panel collapses to a compact strip on mobile). */
export function AuthShell({ title, subtitle, children, aside, eyebrow = 'StringMind account' }: { title: string; subtitle?: ReactNode; children: ReactNode; aside?: ReactNode; eyebrow?: string }) {
  return (
    <div className="aix-grain relative isolate overflow-hidden">
      <AuroraBackground palette="mixed" intensity="subtle" className="-z-10" />
      <GridBackground fade className="-z-10 opacity-40" />
      <div className="container-x relative grid gap-10 py-10 sm:py-16 lg:grid-cols-[1fr_1fr] lg:items-stretch lg:gap-12">
        <div className="mx-auto w-full max-w-lg lg:mx-0 lg:py-4">
          <Reveal><HeroEyebrow>{eyebrow}</HeroEyebrow></Reveal>
          <Reveal delay={0.05}><h1 className="mt-5 text-[34px] font-semibold leading-[1.08] tracking-[-0.02em] sm:text-5xl">{title}</h1></Reveal>
          {subtitle && <Reveal delay={0.1}><p className="mt-3 text-fg-muted">{subtitle}</p></Reveal>}
          <Reveal delay={0.15}>
            <div className="aix-panel relative mt-8 overflow-hidden rounded-[24px] p-6 sm:p-8">
              <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-gold/50 to-transparent" />
              {children}
            </div>
          </Reveal>
        </div>
        <Reveal delay={0.2} className="min-w-0">{aside ?? <AuthVisual />}</Reveal>
      </div>
    </div>
  );
}

/** Only allow same-site relative redirects. */
export function safeNext(next: string | null | undefined, fallback = '/app') {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback;
  return next;
}
