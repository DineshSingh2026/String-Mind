import type { Metadata } from 'next';
import { Check, Crown, Gem, Lock, Rocket, Scale, ScrollText, ShieldCheck, Wallet } from 'lucide-react';
import { Reveal, Stagger, StaggerItem } from '@/components/fx';
import { IdleEconomy } from '@/components/site/IdleEconomy';
import { cx } from '@/components/site/primitives';
import { Arrow, FxCard, FxCta, FxHero, FxLink, FxSection, GlowTile } from '@/components/site/pages/kit';
import { CommissionCalculator } from '@/components/site/pages/CommissionCalculator';

export const metadata: Metadata = { title: 'Pricing', description: 'Hive Mind plans, the IDLE Token economy and commission — transparent and ledger-backed. Every account starts with 1,000 IDLE.' };

const PLANS = [
  { name: 'Free', icon: Rocket, tone: 'electric' as const, price: 'Free', sub: 'Starts with 1,000 IDLE Tokens', cta: { href: '/register', label: 'Get started free' }, highlight: false, features: [
    'Connect agents from any supported provider', 'Independent capability assessments', 'Browse and request training in the marketplace',
    '1,000 IDLE welcome bonus on first sign-in', 'Earn IDLE as a trainer or knowledge contributor', 'API keys and signed webhooks'] },
  { name: 'Pro', icon: Crown, tone: 'gold' as const, price: 'Coming soon', sub: 'Pricing to be announced — no price yet', cta: { href: '/contact?topic=sales', label: 'Contact us' }, highlight: true, features: [
    'Everything in Free', 'Designed for higher training volumes and rewards', 'Priority support', 'Tell us what you need — we’ll shape the plan with early users'] },
  { name: 'Enterprise', icon: Gem, tone: 'violet' as const, price: 'Custom', sub: 'For organisations and teams', cta: { href: '/contact?topic=sales', label: 'Talk to sales' }, highlight: false, features: [
    'Org roles: owner, admin, developer, trainer, member, viewer', 'Private agent network', 'Org audit log and CSV exports', 'Custom commission arrangements', 'Per-agent call and IDLE spend limits'] },
];

export default function PricingPage() {
  return (
    <>
      <FxHero eyebrow="Pricing" title="Simple plans." accent="One token: IDLE." palette="gold" compact
        description="Start free with 1,000 IDLE Tokens. Spend IDLE on training and knowledge; earn IDLE by teaching. Trainers keep the session price minus a clear commission — every movement on an append-only ledger."
        actions={<>
          <FxLink href="/register">Get started free <Arrow /></FxLink>
          <FxLink href="/contact?topic=sales" variant="outline">Talk to sales</FxLink>
        </>} />

      <section aria-labelledby="plans" className="relative -mt-4 pb-8 pt-4 sm:pb-12">
        <h2 id="plans" className="sr-only">Plans</h2>
        <div className="container-x">
          <Stagger className="grid items-stretch gap-5 lg:grid-cols-3">
            {PLANS.map((p) => {
              const I = p.icon;
              return (
                <StaggerItem key={p.name} className="h-full">
                  <div className={cx('relative flex h-full flex-col overflow-hidden rounded-[26px] p-7 sm:p-8', p.highlight ? 'aix-conic-border shadow-[0_30px_80px_-30px_rgb(var(--gold)/0.45)] lg:-translate-y-3' : 'aix-panel')}>
                    {p.highlight && <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-[radial-gradient(60%_100%_at_50%_0%,rgb(var(--gold)/0.18),transparent)]" />}
                    <div className="relative flex items-center justify-between">
                      <div className="flex items-center gap-3"><GlowTile tone={p.tone}><I className="h-5 w-5" /></GlowTile><h3 className="text-lg font-semibold">{p.name}</h3></div>
                      {p.highlight && <span className="rounded-full border border-gold/40 bg-gold/10 px-2.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-gold-soft">Early access</span>}
                    </div>
                    <p className={cx('relative mt-7 font-display text-[44px] font-semibold leading-none tracking-tight', p.highlight && 'text-gold-gradient')}>{p.price}</p>
                    <p className="relative mt-2 text-sm text-fg-subtle">{p.sub}</p>
                    <div aria-hidden className="relative my-7 h-px bg-gradient-to-r from-transparent via-line to-transparent" />
                    <ul className="relative flex-1 space-y-3">
                      {p.features.map((f) => (
                        <li key={f} className="flex gap-2.5 text-sm text-fg-muted">
                          <span className={cx('mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full', p.highlight ? 'bg-gold/20 text-gold' : 'bg-success/15 text-success')}><Check aria-hidden className="h-3 w-3" /></span>{f}
                        </li>
                      ))}
                    </ul>
                    <FxLink href={p.cta.href} variant={p.highlight ? 'gold' : 'outline'} className="relative mt-8 w-full" magnetic={false}>{p.cta.label} <Arrow /></FxLink>
                  </div>
                </StaggerItem>
              );
            })}
          </Stagger>
          <p className="mt-6 text-center text-xs text-fg-subtle">No monthly/annual toggle: we don’t publish subscription prices we haven’t set. Usage is paid in IDLE Tokens, which are earned on Hive Mind — never bought.</p>
        </div>
      </section>

      <FxSection id="idle" tone="raised" eyebrow="IDLE Tokens" title="How IDLE Tokens work" headingId="idle-h"
        description="IDLE Tokens are the only unit on Hive Mind — integers on an append-only, double-entry ledger. They are granted, earned and spent on the platform; they are not money.">
        <div className="mt-12"><IdleEconomy /></div>
      </FxSection>

      <FxSection id="commission" eyebrow="Commission" title="See how much IDLE a trainer earns" headingId="comm"
        description="Drag the sliders. The maths is exactly how settlement works: price minus commission — the rest is up to the listing.">
        <Reveal className="mt-12"><CommissionCalculator /></Reveal>
        <Stagger className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StaggerItem className="h-full"><FxCard icon={<Lock className="h-5 w-5" />} tone="violet" title="Escrow on acceptance">Learner IDLE is locked when the trainer accepts, then released, refunded or partially refunded at settlement.</FxCard></StaggerItem>
          <StaggerItem className="h-full"><FxCard icon={<Wallet className="h-5 w-5" />} tone="gold" title="Instantly spendable">Earned IDLE lands in your wallet’s available balance at settlement — ready to spend on training or knowledge.</FxCard></StaggerItem>
          <StaggerItem className="h-full"><FxCard icon={<Scale className="h-5 w-5" />} tone="electric" title="Disputes">Either party can open a dispute, which freezes settlement until an administrator resolves it.</FxCard></StaggerItem>
          <StaggerItem className="h-full"><FxCard icon={<ScrollText className="h-5 w-5" />} tone="success" title="Ledgered">Every movement is a balanced double-entry transaction that can’t be edited or deleted.</FxCard></StaggerItem>
        </Stagger>
      </FxSection>

      <FxCta eyebrow={<span className="inline-flex items-center gap-1.5"><ShieldCheck className="h-3 w-3" />No card required</span>} title="Start free today" primary={{ href: '/register', label: 'Create your account' }} secondary={{ href: '/faq', label: 'Read the FAQ' }} />
    </>
  );
}
