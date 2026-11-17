/**
 * Shared building blocks for public inner pages (server-safe; composes client FX from '@/components/fx').
 * Every page hero = Aurora + Grid backdrop, WordReveal headline, Reveal-staggered copy, optional data visual.
 */
import './pages.css';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowRight } from 'lucide-react';
import { AuroraBackground, GridBackground, GlowDivider, MagneticButton, Reveal, SpotlightCard, WordReveal } from '@/components/fx';
import { cx } from '../primitives';
import { GradientWords } from './GradientWords';

type Glow = 'gold' | 'electric' | 'violet';
type Tone = 'gold' | 'electric' | 'violet' | 'success';

export function HeroEyebrow({ children, tone = 'gold' }: { children: ReactNode; tone?: 'gold' | 'electric' }) {
  return (
    <span className={cx('inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] backdrop-blur',
      tone === 'gold' ? 'border-gold/30 bg-gold/[0.07] text-gold-soft' : 'border-electric/30 bg-electric/[0.07] text-electric-soft')}>
      <span aria-hidden className="relative flex h-1.5 w-1.5">
        <span className={cx('aix-pulse-ring absolute inline-flex h-full w-full rounded-full', tone === 'gold' ? 'bg-gold' : 'bg-electric')} />
        <span className={cx('relative inline-flex h-1.5 w-1.5 rounded-full', tone === 'gold' ? 'bg-gold' : 'bg-electric')} />
      </span>
      {children}
    </span>
  );
}

/** Cinematic page hero. `title` + optional `accent` (second line, gradient). */
export function FxHero({ eyebrow, title, accent, accentTone = 'gold', description, actions, visual, palette = 'mixed', align = 'left', className, children, compact }: {
  eyebrow?: ReactNode; title: string; accent?: string; accentTone?: 'gold' | 'ai'; description?: ReactNode; actions?: ReactNode; visual?: ReactNode;
  palette?: 'gold' | 'ai' | 'mixed'; align?: 'left' | 'center'; className?: string; children?: ReactNode; compact?: boolean;
}) {
  const center = align === 'center' || !visual;
  return (
    <header className={cx('aix-grain relative isolate overflow-hidden border-b border-line/40', className)}>
      <AuroraBackground palette={palette} intensity="subtle" className="-z-10" />
      <GridBackground fade className="-z-10 opacity-70" />
      <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-40 bg-gradient-to-b from-transparent to-ink-950" />
      <div className={cx('container-x relative', compact ? 'py-14 sm:py-20' : 'py-16 sm:py-24 lg:py-28', visual && !center && 'grid items-center gap-12 lg:grid-cols-[1.05fr_0.95fr] lg:gap-10')}>
        <div className={cx(center ? 'mx-auto max-w-3xl text-center' : 'max-w-2xl')}>
          {eyebrow && <Reveal><HeroEyebrow tone={accentTone === 'ai' ? 'electric' : 'gold'}>{eyebrow}</HeroEyebrow></Reveal>}
          <h1 className="mt-6 text-[40px] font-semibold leading-[1.04] tracking-[-0.025em] text-fg sm:text-6xl lg:text-[68px]">
            <WordReveal text={title} />
            {accent && (
              <span className="mt-1 block"><GradientWords text={accent} tone={accentTone} delay={0.25} /></span>
            )}
          </h1>
          {description && <Reveal delay={0.35}><p className={cx('mt-6 text-base leading-relaxed text-fg-muted sm:text-lg', center && 'mx-auto max-w-2xl')}>{description}</p></Reveal>}
          {actions && <Reveal delay={0.5}><div className={cx('mt-9 flex flex-col gap-3 sm:flex-row sm:flex-wrap', center ? 'items-center sm:justify-center' : 'items-start')}>{actions}</div></Reveal>}
          {children && <Reveal delay={0.6}><div className="mt-10">{children}</div></Reveal>}
        </div>
        {visual && !center && <Reveal delay={0.25} className="relative min-w-0">{visual}</Reveal>}
        {visual && center && <Reveal delay={0.4} className="relative mx-auto mt-14 max-w-5xl">{visual}</Reveal>}
      </div>
    </header>
  );
}

/** CTA pill with magnetic hover. */
export function FxLink({ href, children, variant = 'gold', className, magnetic = true }: { href: string; children: ReactNode; variant?: 'gold' | 'outline' | 'ai'; className?: string; magnetic?: boolean }) {
  const v = {
    gold: 'bg-gold-sheen text-ink-950 font-semibold shadow-gold hover:brightness-110',
    outline: 'border border-line/80 bg-ink-900/40 text-fg font-medium backdrop-blur hover:bg-ink-800 hover:border-ink-600',
    ai: 'bg-ai-sheen text-white font-semibold shadow-[0_8px_24px_-10px_rgb(var(--violet)/0.7)] hover:brightness-110',
  }[variant];
  const link = <Link href={href} className={cx('group inline-flex h-12 items-center justify-center gap-2 rounded-full px-6 text-[15px] transition', v, className)}>{children}</Link>;
  return magnetic ? <MagneticButton strength={0.25}>{link}</MagneticButton> : link;
}
export const Arrow = () => <ArrowRight aria-hidden className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />;

const TILE: Record<Tone, string> = {
  gold: 'from-gold/25 to-gold/5 text-gold ring-gold/30',
  electric: 'from-electric/25 to-electric/5 text-electric-soft ring-electric/30',
  violet: 'from-violet/25 to-violet/5 text-violet-soft ring-violet/30',
  success: 'from-success/25 to-success/5 text-success ring-success/30',
};
export function GlowTile({ children, tone = 'gold', size = 'md', className }: { children: ReactNode; tone?: Tone; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const s = { sm: 'h-9 w-9 rounded-lg', md: 'h-11 w-11 rounded-xl', lg: 'h-14 w-14 rounded-2xl' }[size];
  return <span aria-hidden className={cx('inline-flex shrink-0 items-center justify-center bg-gradient-to-br ring-1 shadow-[inset_0_1px_0_rgb(255_255_255/0.08)]', s, TILE[tone], className)}>{children}</span>;
}

const toneGlow = (t: Tone): Glow => (t === 'success' ? 'electric' : t);

/** Feature card on a SpotlightCard surface. */
export function FxCard({ icon, title, children, tone = 'gold', href, cta, className, kicker }: {
  icon?: ReactNode; title: ReactNode; children?: ReactNode; tone?: Tone; href?: string; cta?: string; className?: string; kicker?: ReactNode;
}) {
  return (
    <SpotlightCard glow={toneGlow(tone)} className={cx('group h-full', className)}>
      <div className="flex h-full flex-col p-6">
        <div className="flex items-start justify-between gap-3">
          {icon && <GlowTile tone={tone}>{icon}</GlowTile>}
          {kicker && <span className="font-mono text-[11px] text-fg-subtle">{kicker}</span>}
        </div>
        <h3 className="mt-5 text-lg font-semibold text-fg">{title}</h3>
        {children && <div className="mt-2 flex-1 text-sm leading-relaxed text-fg-muted">{children}</div>}
        {href && (
          <Link href={href} className="mt-5 inline-flex items-center gap-1.5 text-sm font-medium text-gold-soft hover:text-gold">
            {cta ?? 'Learn more'} <ArrowRight aria-hidden className="h-4 w-4 transition group-hover:translate-x-0.5" />
          </Link>
        )}
      </div>
    </SpotlightCard>
  );
}

/** Section with optional animated heading. */
export function FxSection({ id, eyebrow, title, description, align = 'left', children, className, tone = 'plain', headingId, aside }: {
  id?: string; eyebrow?: ReactNode; title?: ReactNode; description?: ReactNode; align?: 'left' | 'center'; children?: ReactNode; className?: string;
  tone?: 'plain' | 'raised' | 'deep'; headingId?: string; aside?: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={title ? headingId : undefined} className={cx('relative scroll-mt-24 py-20 sm:py-28',
      tone === 'raised' && 'border-y border-line/40 bg-ink-900/40', tone === 'deep' && 'overflow-hidden border-y border-line/40 bg-[radial-gradient(60%_80%_at_50%_0%,rgb(var(--electric)/0.08),transparent_70%)]', className)}>
      <div className="container-x">
        {title && (
          <Reveal>
            <div className={cx('flex flex-col gap-6', align === 'center' ? 'items-center text-center' : 'lg:flex-row lg:items-end lg:justify-between')}>
              <div className={cx('max-w-3xl', align === 'center' && 'mx-auto')}>
                {eyebrow && (
                  <p className={cx('inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-gold', align === 'center' && 'justify-center')}>
                    <span aria-hidden className="h-px w-6 bg-gradient-to-r from-transparent to-gold/70" />{eyebrow}
                    {align === 'center' && <span aria-hidden className="h-px w-6 bg-gradient-to-l from-transparent to-gold/70" />}
                  </p>
                )}
                <h2 id={headingId} className="mt-3 text-[30px] font-semibold leading-[1.1] tracking-[-0.02em] text-fg sm:text-[44px]">{title}</h2>
                {description && <p className="mt-4 text-base leading-relaxed text-fg-muted sm:text-lg">{description}</p>}
              </div>
              {aside}
            </div>
          </Reveal>
        )}
        {children}
      </div>
    </section>
  );
}

/** Closing CTA with aurora + gold conic border. */
export function FxCta({ title, description, primary, secondary, eyebrow }: {
  title: string; description?: ReactNode; primary: { href: string; label: string }; secondary?: { href: string; label: string }; eyebrow?: ReactNode;
}) {
  return (
    <section aria-label="Get started" className="py-20 sm:py-28">
      <div className="container-x">
        <Reveal>
          <div className="aix-conic-border aix-grain relative isolate overflow-hidden rounded-[28px] px-6 py-14 text-center sm:px-12 sm:py-20">
            <AuroraBackground palette="gold" intensity="subtle" className="-z-10 opacity-80" />
            <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(50%_80%_at_50%_0%,rgb(var(--gold)/0.16),transparent_70%)]" />
            <div className="relative mx-auto max-w-2xl">
              {eyebrow && <div className="mb-5 flex justify-center"><HeroEyebrow>{eyebrow}</HeroEyebrow></div>}
              <h2 className="text-3xl font-semibold leading-tight tracking-[-0.02em] text-fg sm:text-5xl"><WordReveal text={title} /></h2>
              {description && <p className="mt-5 text-base text-fg-muted sm:text-lg">{description}</p>}
              <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
                <FxLink href={primary.href}>{primary.label} <Arrow /></FxLink>
                {secondary && <FxLink href={secondary.href} variant="outline">{secondary.label}</FxLink>}
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

export { GlowDivider };

/** Small "live" chip. */
export function LiveChip({ children = 'Live on this Hive Mind instance', className }: { children?: ReactNode; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-full border border-success/30 bg-success/10 px-2.5 py-0.5 text-[11px] font-medium text-success-soft', className)}>
      <span aria-hidden className="relative flex h-1.5 w-1.5"><span className="aix-pulse-ring absolute inline-flex h-full w-full rounded-full bg-success" /><span className="relative h-1.5 w-1.5 rounded-full bg-success" /></span>
      {children}
    </span>
  );
}

export function IllustrativeTag({ children = 'Illustrative', className }: { children?: ReactNode; className?: string }) {
  return <span className={cx('inline-flex items-center rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-warning', className)}>{children}</span>;
}
