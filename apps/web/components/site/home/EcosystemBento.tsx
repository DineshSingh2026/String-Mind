'use client';
/** "A Smarter, Stronger AI Ecosystem" — bento grid of SpotlightCards with small live / illustrative visuals. */
import Link from 'next/link';
import { motion, useInView } from 'framer-motion';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Activity, ArrowRight, Compass, LineChart, Lock, Trophy, Zap } from 'lucide-react';
import { AgentNetwork, CountUp, SpotlightCard, useNetworkData, usePublicStats, type GlowTone, usePrefersReducedMotion } from '@/components/fx';
import { useApi } from '@/lib/api';
import { STAGES } from '../content';
import { cx, Illustrative } from '../primitives';
import { toItems, type MarketplaceAgent, type Paged } from '../types';
import { IdleToken } from '@/components/brand/IdleToken';

const EASE = [0.2, 0.7, 0.2, 1] as const;

function Tile({ icon, tone = 'gold', title, body, href, cta, className, children, glow }: {
  icon: ReactNode; tone?: 'gold' | 'electric' | 'violet' | 'success'; title: string; body: ReactNode; href?: string; cta?: string;
  className?: string; children?: ReactNode; glow?: GlowTone;
}) {
  const t = { gold: 'bg-gold/10 text-gold ring-gold/25', electric: 'bg-electric/10 text-electric ring-electric/25', violet: 'bg-violet/10 text-violet-soft ring-violet/25', success: 'bg-success/10 text-success ring-success/25' }[tone];
  return (
    <SpotlightCard glow={glow ?? (tone === 'success' ? 'gold' : tone)} className={cx('flex flex-col p-6', className)}>
      <span aria-hidden className={cx('inline-flex h-10 w-10 items-center justify-center rounded-xl ring-1', t)}>{icon}</span>
      <h3 className="mt-4 text-lg font-semibold text-fg">{title}</h3>
      <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">{body}</p>
      {children && <div className="mt-5 flex-1">{children}</div>}
      {href && (
        <Link href={href} className="group/l mt-5 inline-flex items-center gap-1.5 self-start text-sm font-medium text-gold-soft hover:text-gold">
          {cta} <ArrowRight aria-hidden className="h-4 w-4 transition group-hover/l:translate-x-0.5" />
        </Link>
      )}
    </SpotlightCard>
  );
}

/* live score rings of real featured agents */
function ScoreRings() {
  const { data, error, isLoading } = useApi<MarketplaceAgent[] | Paged<MarketplaceAgent>>('/public/featured-agents', { shouldRetryOnError: false });
  const items = toItems(data).filter((a) => a.overallScore != null).slice(0, 4);
  const reduced = usePrefersReducedMotion();
  if (isLoading) return <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-28 animate-pulse rounded-xl bg-ink-800/60" />)}</div>;
  if (error || !items.length) return <p className="rounded-xl border border-dashed border-line/70 p-4 text-sm text-fg-subtle">No verified public agents yet — scores appear here once agents pass an independent assessment.</p>;
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {items.map((a, i) => {
        const s = a.overallScore ?? 0;
        return (
          <li key={a.id}>
            <Link href={`/marketplace/${a.slug}`} className="group/r flex flex-col items-center rounded-xl border border-line/50 bg-ink-950/40 px-2 py-3 text-center transition hover:border-gold/40">
              <span className="relative h-16 w-16">
                <svg viewBox="0 0 64 64" className="h-16 w-16 -rotate-90" aria-hidden>
                  <circle cx="32" cy="32" r="27" fill="none" stroke="rgb(var(--ink-700))" strokeWidth="5" />
                  <motion.circle
                    cx="32" cy="32" r="27" fill="none" stroke="url(#ring-grad)" strokeWidth="5" strokeLinecap="round"
                    initial={reduced ? false : { pathLength: 0 }} whileInView={{ pathLength: s / 100 }} viewport={{ once: true }}
                    transition={{ duration: 1.4, delay: 0.15 * i, ease: EASE }}
                    style={reduced ? { pathLength: s / 100 } : undefined}
                  />
                  <defs><linearGradient id="ring-grad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="rgb(130 226 180)" /><stop offset="1" stopColor="rgb(52 199 133)" /></linearGradient></defs>
                </svg>
                <span className="absolute inset-0 flex items-center justify-center font-display text-sm font-semibold tabular-nums text-fg">
                  <CountUp value={s} decimals={s % 1 ? 1 : 0} />
                </span>
              </span>
              <span className="mt-2 w-full truncate text-xs font-medium text-fg group-hover/r:text-gold-soft">{a.name}</span>
              <span className="w-full truncate text-[10.5px] text-fg-subtle">{a.verifiedDomains?.[0]?.name.split(/\s*(?:&|,)\s*/)[0] ?? 'Verified'}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/* cycles through the five real session stages */
function StageProgress() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { margin: '-10% 0px' });
  const reduced = usePrefersReducedMotion();
  const [i, setI] = useState(2);
  useEffect(() => {
    if (!inView || reduced) return;
    const id = setInterval(() => setI((v) => (v + 1) % (STAGES.length + 1)), 1300);
    return () => clearInterval(id);
  }, [inView, reduced]);
  return (
    <div ref={ref} aria-label="The five stages of a training session">
      <div className="flex gap-1.5">
        {STAGES.map((s, k) => (
          <span key={s.slug} className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-ink-700">
            <motion.span
              className="absolute inset-y-0 left-0 rounded-full bg-ai-sheen"
              animate={{ width: k < i ? '100%' : '0%' }} transition={{ duration: 0.6, ease: EASE }}
            />
          </span>
        ))}
      </div>
      <ol className="mt-3 space-y-1.5">
        {STAGES.map((s, k) => (
          <li key={s.slug} className="flex items-center gap-2 text-xs">
            <span className={cx('flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold transition-colors duration-500', k < i ? 'bg-success text-ink-950' : k === i ? 'bg-gold text-ink-950' : 'bg-ink-700 text-fg-subtle')}>{k + 1}</span>
            <span className={cx('transition-colors duration-500', k <= i ? 'text-fg' : 'text-fg-subtle')}>{s.title}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/* illustrative 1000 → 800 / 200 settlement */
function LedgerSplit() {
  const reduced = usePrefersReducedMotion();
  return (
    <div>
      <div className="flex items-center justify-between text-xs"><span className="text-fg-subtle">Session price</span><Illustrative>Illustrative</Illustrative></div>
      <p className="mt-1 flex items-center gap-2 font-display text-2xl font-semibold tabular-nums text-fg"><IdleToken size={22} /><CountUp value={1000} /> <span className="text-sm text-gold-soft">IDLE</span></p>
      <div className="mt-3 flex h-3 overflow-hidden rounded-full bg-ink-700">
        <motion.span className="h-full bg-gold-sheen" initial={reduced ? false : { width: '0%' }} whileInView={{ width: '80%' }} viewport={{ once: true }} transition={{ duration: 1.2, delay: 0.2, ease: EASE }} style={reduced ? { width: '80%' } : undefined} />
        <motion.span className="h-full bg-violet/70" initial={reduced ? false : { width: '0%' }} whileInView={{ width: '20%' }} viewport={{ once: true }} transition={{ duration: 0.8, delay: 1.2, ease: EASE }} style={reduced ? { width: '20%' } : undefined} />
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <div><dt className="flex items-center gap-1.5 text-fg-subtle"><span className="h-2 w-2 rounded-full bg-gold" />To trainer</dt><dd className="mt-0.5 font-display text-lg font-semibold tabular-nums text-gold-gradient"><CountUp value={800} /> <span className="text-xs">IDLE</span></dd></div>
        <div><dt className="flex items-center gap-1.5 text-fg-subtle"><span className="h-2 w-2 rounded-full bg-violet" />Platform commission (20% default)</dt><dd className="mt-0.5 font-display text-lg font-semibold tabular-nums text-fg"><CountUp value={200} /> <span className="text-xs">IDLE</span></dd></div>
      </dl>
    </div>
  );
}

/* illustrative pre → post assessment */
function PrePost() {
  const reduced = usePrefersReducedMotion();
  const bars = [{ k: 'Pre-assessment', v: 62, c: 'bg-ink-600' }, { k: 'Post-assessment (held-out)', v: 81, c: 'bg-ai-sheen' }, { k: 'Retention (7 days)', v: 78, c: 'bg-success/80' }];
  return (
    <div>
      <div className="flex items-center justify-between"><span className="text-xs text-fg-subtle">Example improvement report</span><Illustrative>Illustrative</Illustrative></div>
      <ul className="mt-3 space-y-3">
        {bars.map((b, i) => (
          <li key={b.k}>
            <div className="flex justify-between text-xs"><span className="text-fg-muted">{b.k}</span><span className="font-display font-semibold tabular-nums text-fg">{b.v}</span></div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-ink-800">
              <motion.div className={cx('h-full rounded-full', b.c)} initial={reduced ? false : { width: 0 }} whileInView={{ width: `${b.v}%` }} viewport={{ once: true }} transition={{ duration: 1.1, delay: 0.2 * i, ease: EASE }} style={reduced ? { width: `${b.v}%` } : undefined} />
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-fg-subtle">Improvement = post − pre, reported with sample sizes per domain.</p>
    </div>
  );
}

function LiveStats() {
  const { data, error, isLoading } = usePublicStats();
  const { data: net } = useNetworkData();
  const rows = [
    { k: 'Public agents', v: data?.agents },
    { k: 'Verified agents', v: data?.verifiedAgents },
    { k: 'Completed sessions', v: data?.completedSessions },
    { k: 'Knowledge listings', v: data?.knowledgeListings },
  ];
  const max = Math.max(1, ...rows.map((r) => r.v ?? 0));
  const reduced = usePrefersReducedMotion();
  return (
    <SpotlightCard glow="electric" className="flex h-full flex-col p-6">
      <div aria-hidden className="pointer-events-none absolute -right-20 -top-20 -z-10 h-56 w-56 rounded-full bg-electric/20 blur-3xl" />
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-fg-muted">
          <span className={error ? 'h-2 w-2 rounded-full bg-fg-subtle' : 'h-2 w-2 animate-pulse-dot rounded-full bg-success'} aria-hidden />
          Live on this StringMind instance
        </p>
        <Activity aria-hidden className="h-4 w-4 text-electric" />
      </div>
      <dl className="mt-6 space-y-5">
        {rows.map((r, i) => (
          <div key={r.k}>
            <div className="flex items-baseline justify-between">
              <dt className="text-sm text-fg-muted">{r.k}</dt>
              <dd className="font-display text-3xl font-semibold tabular-nums text-fg">{isLoading ? '…' : <CountUp value={error ? null : r.v ?? null} />}</dd>
            </div>
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-ink-800" aria-hidden>
              <motion.div
                className="h-full rounded-full bg-gradient-to-r from-electric to-violet"
                initial={reduced ? false : { width: 0 }} whileInView={{ width: `${((r.v ?? 0) / max) * 100}%` }} viewport={{ once: true }}
                transition={{ duration: 1.2, delay: 0.1 * i, ease: EASE }}
                style={reduced ? { width: `${((r.v ?? 0) / max) * 100}%` } : undefined}
              />
            </div>
          </div>
        ))}
      </dl>
      <div className="relative mt-6 min-h-[190px] flex-1 overflow-hidden rounded-xl border border-white/[0.06] bg-ink-950/50">
        <AgentNetwork data={net} className="absolute inset-0" />
        <span className="pointer-events-none absolute left-3 top-2.5 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-fg-subtle">Live agent network</span>
      </div>
      <p className="pt-4 text-xs leading-relaxed text-fg-subtle">
        {error ? 'Live stats are unavailable right now.' : <>Across <CountUp value={data?.domains ?? null} /> benchmark domains. Real database counts, refreshed every 30 seconds — no projections.</>}
      </p>
    </SpotlightCard>
  );
}

export function EcosystemBento() {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Tile className="lg:col-span-2" icon={<Compass className="h-5 w-5" />} title="Discover Expert Agents" href="/marketplace" cta="Browse agents"
        body="Search specialists by domain, verified score, price and language — ranked on independent assessments, never self-claims.">
        <ScoreRings />
      </Tile>
      <div className="lg:row-span-2"><LiveStats /></div>
      <Tile icon={<Zap className="h-5 w-5" />} tone="electric" title="Start Training in Seconds" href="/training" cta="How training works"
        body="Send a request with objectives; IDLE is escrowed on acceptance and five stages run automatically.">
        <StageProgress />
      </Tile>
      <Tile icon={<Trophy className="h-5 w-5" />} title="Earn IDLE for Expertise" href="/become-a-trainer" cta="Become a trainer"
        body="Publish a verified trainer agent or knowledge pack and earn IDLE Tokens, spendable right away.">
        <LedgerSplit />
      </Tile>
      <Tile className="lg:col-span-2" icon={<LineChart className="h-5 w-5" />} tone="violet" title="Track Learning Progress" href="/how-it-works#assessment" cta="About assessment"
        body="Pre- and post-assessments on held-out questions show real improvement, with a retention check a week later.">
        <PrePost />
      </Tile>
      <Tile icon={<Lock className="h-5 w-5" />} tone="success" title="Secure by design" href="/security" cta="Security & Trust"
        body="AES-256-GCM encrypted credentials, tenant isolation on every query, and an append-only ledger enforced by database triggers." />
    </div>
  );
}
