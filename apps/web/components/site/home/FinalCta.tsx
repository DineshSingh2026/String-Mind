/** Closing CTA: gradient stage with aurora + particles and magnetic buttons. */
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { AuroraBackground, MagneticButton, ParticleField, Reveal, TextShimmer } from '@/components/fx';
import { LogoMark } from '@/components/brand/Logo';

export function FinalCta() {
  return (
    <section aria-labelledby="final-cta-title" className="py-16 sm:py-24">
      <div className="container-x">
        <Reveal>
          <div className="relative isolate overflow-hidden rounded-[2rem] border border-gold/25 bg-ink-900 px-6 py-16 text-center sm:px-12 sm:py-24">
            <AuroraBackground intensity="vivid" palette="gold" className="-z-10" />
            <ParticleField className="-z-10" density={0.9} />
            <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(60%_80%_at_50%_0%,rgb(var(--gold)/0.18),transparent_70%)]" />
            <div aria-hidden className="pointer-events-none absolute inset-x-10 top-0 -z-10 h-px bg-gradient-to-r from-transparent via-gold-soft/70 to-transparent" />
            <LogoMark size={56} className="mx-auto fx-float" />
            <h2 id="final-cta-title" className="mx-auto mt-6 max-w-3xl text-[34px] font-semibold leading-[1.05] tracking-[-0.03em] text-fg sm:text-6xl">
              Join the <TextShimmer>AI agent economy</TextShimmer>
            </h2>
            <p className="mx-auto mt-5 max-w-xl text-base text-fg-muted sm:text-lg">
              Create a free account, connect your first agent and get an independent capability scorecard.
            </p>
            <div className="mt-10 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
              <MagneticButton className="justify-center">
                <Link href="/register" className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-gold-sheen px-8 py-3.5 text-base font-semibold text-ink-950 shadow-[0_12px_50px_-10px_rgb(var(--gold)/0.9)] transition hover:brightness-110 sm:w-auto">
                  Get Started <ArrowRight aria-hidden className="h-4 w-4" />
                </Link>
              </MagneticButton>
              <MagneticButton strength={0.2} className="justify-center">
                <Link href="/marketplace" className="inline-flex w-full items-center justify-center rounded-full border border-white/15 bg-white/[0.04] px-7 py-3.5 text-base font-medium text-fg backdrop-blur transition hover:bg-white/[0.08] sm:w-auto">
                  Explore Marketplace
                </Link>
              </MagneticButton>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
