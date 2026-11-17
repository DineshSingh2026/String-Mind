/**
 * Server-safe layout primitives for the public site.
 * NOTE: do not call helpers exported from '@/components/ui' (a 'use client' module) in server components —
 * use `cx` from here instead. Rendering ui *components* (Button, Badge, Card) from server code is fine.
 */
import { clsx } from 'clsx';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowRight } from 'lucide-react';

export const cx = clsx;

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cx('inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-gold', className)}>
      <span aria-hidden className="h-px w-6 bg-gold/60" />{children}
    </p>
  );
}

export function SectionHeading({ eyebrow, title, description, align = 'left', className, id }: {
  eyebrow?: ReactNode; title: ReactNode; description?: ReactNode; align?: 'left' | 'center'; className?: string; id?: string;
}) {
  return (
    <div className={cx('max-w-3xl', align === 'center' && 'mx-auto text-center', className)}>
      {eyebrow && <Eyebrow className={align === 'center' ? 'justify-center' : undefined}>{eyebrow}</Eyebrow>}
      <h2 id={id} className="mt-3 text-[28px] font-semibold leading-[1.15] text-fg sm:text-4xl">{title}</h2>
      {description && <p className="mt-4 text-base leading-relaxed text-fg-muted sm:text-lg">{description}</p>}
    </div>
  );
}

export function Section({ children, className, id, labelledBy, tone = 'plain' }: {
  children: ReactNode; className?: string; id?: string; labelledBy?: string; tone?: 'plain' | 'raised';
}) {
  return (
    <section id={id} aria-labelledby={labelledBy} className={cx('relative scroll-mt-24 py-16 sm:py-24', tone === 'raised' && 'border-y border-line/40 bg-ink-900/40', className)}>
      <div className="container-x">{children}</div>
    </section>
  );
}

/** Inner-page hero. */
export function PageHero({ eyebrow, title, description, children, className }: {
  eyebrow?: ReactNode; title: ReactNode; description?: ReactNode; children?: ReactNode; className?: string;
}) {
  return (
    <header className={cx('relative overflow-hidden border-b border-line/40', className)}>
      <div aria-hidden className="aix-hero-glow pointer-events-none absolute inset-0" />
      <div aria-hidden className="aix-grid-bg pointer-events-none absolute inset-0 opacity-60" />
      <div className="container-x relative py-16 sm:py-24">
        <div className="aix-reveal max-w-3xl">
          {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
          <h1 className="mt-4 text-4xl font-semibold leading-[1.08] text-fg sm:text-5xl lg:text-[56px]">{title}</h1>
          {description && <p className="mt-5 text-base leading-relaxed text-fg-muted sm:text-lg">{description}</p>}
          {children && <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap">{children}</div>}
        </div>
      </div>
    </header>
  );
}

type TileTone = 'gold' | 'electric' | 'violet' | 'success';
/** Icon tile used across feature cards. */
export function IconTile({ children, tone = 'gold', className }: { children: ReactNode; tone?: TileTone; className?: string }) {
  const t = { gold: 'bg-gold/10 text-gold ring-gold/25', electric: 'bg-electric/10 text-electric ring-electric/25', violet: 'bg-violet/10 text-violet-soft ring-violet/25', success: 'bg-success/10 text-success ring-success/25' }[tone];
  return <span aria-hidden className={cx('inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ring-1', t, className)}>{children}</span>;
}

export function FeatureCard({ icon, title, children, tone = 'gold', href, cta }: {
  icon: ReactNode; title: string; children: ReactNode; tone?: TileTone; href?: string; cta?: string;
}) {
  return (
    <div className="card group flex h-full flex-col p-6 transition hover:border-ink-600">
      <IconTile tone={tone}>{icon}</IconTile>
      <h3 className="mt-5 text-lg font-semibold text-fg">{title}</h3>
      <div className="mt-2 flex-1 text-sm leading-relaxed text-fg-muted">{children}</div>
      {href && (
        <Link href={href} className="mt-5 inline-flex items-center gap-1.5 text-sm font-medium text-gold-soft hover:text-gold">
          {cta ?? 'Learn more'} <ArrowRight aria-hidden className="h-4 w-4 transition group-hover:translate-x-0.5" />
        </Link>
      )}
    </div>
  );
}

export function CheckList({ items, tone = 'success', className }: { items: ReactNode[]; tone?: 'success' | 'gold' | 'electric'; className?: string }) {
  const c = { success: 'text-success', gold: 'text-gold', electric: 'text-electric' }[tone];
  return (
    <ul className={cx('space-y-2.5', className)}>
      {items.map((it, i) => (
        <li key={i} className="flex gap-2.5 text-sm text-fg-muted">
          <svg aria-hidden viewBox="0 0 20 20" className={cx('mt-0.5 h-4 w-4 shrink-0', c)} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 10.5l4 4 8-9" /></svg>
          <span>{it}</span>
        </li>
      ))}
    </ul>
  );
}

/** Pill links (gold / outline / ai) — server-safe alternatives to <Button href>. */
export function PillLink({ href, children, variant = 'gold', size = 'lg', className }: { href: string; children: ReactNode; variant?: 'gold' | 'outline' | 'ai'; size?: 'md' | 'lg'; className?: string }) {
  const v = { gold: 'bg-gold-sheen text-ink-950 font-semibold shadow-gold hover:brightness-110', outline: 'border border-line text-fg font-medium hover:bg-ink-800 hover:border-ink-600', ai: 'bg-ai-sheen text-white font-semibold hover:brightness-110' }[variant];
  const s = size === 'lg' ? 'h-12 px-6 text-[15px]' : 'h-10 px-4 text-sm';
  return <Link href={href} className={cx('inline-flex items-center justify-center gap-2 rounded-full transition', v, s, className)}>{children}</Link>;
}

/** Closing call-to-action banner. */
export function CtaBanner({ title, description, primary, secondary }: {
  title: ReactNode; description?: ReactNode; primary: { href: string; label: string }; secondary?: { href: string; label: string };
}) {
  return (
    <section aria-label="Get started" className="py-16 sm:py-24">
      <div className="container-x">
        <div className="aix-gold-border relative overflow-hidden rounded-3xl px-6 py-12 text-center sm:px-12 sm:py-16">
          <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(50%_80%_at_50%_0%,rgb(var(--gold)/0.14),transparent_70%)]" />
          <div className="relative mx-auto max-w-2xl">
            <h2 className="text-3xl font-semibold leading-tight text-fg sm:text-4xl">{title}</h2>
            {description && <p className="mt-4 text-base text-fg-muted sm:text-lg">{description}</p>}
            <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
              <PillLink href={primary.href}>{primary.label} <ArrowRight aria-hidden className="h-4 w-4" /></PillLink>
              {secondary && <PillLink href={secondary.href} variant="outline">{secondary.label}</PillLink>}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export function Illustrative({ children = 'Illustrative' }: { children?: ReactNode }) {
  return <span className="inline-flex items-center rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-warning">{children}</span>;
}
