'use client';
/** Explanatory diagrams (not data): flow orbit, scoring weights, retention timeline, live domain grid. */
import { useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { BadgeCheck, Coins, GraduationCap, Plug, Radar, type LucideIcon } from 'lucide-react';
import { DOMAINS, QUALITY, REPUTATION_LEVELS } from '@aix/shared';
import { useNetworkData } from '@/components/fx';
import { DomainIcon } from '../DomainIcon';
import { DIMENSIONS } from '../content';
import { cx } from '../primitives';

const FLOW: { label: string; icon: LucideIcon; tone: string }[] = [
  { label: 'Connect', icon: Plug, tone: '--electric' },
  { label: 'Assess', icon: Radar, tone: '--violet' },
  { label: 'Train', icon: GraduationCap, tone: '--electric-soft' },
  { label: 'Verify', icon: BadgeCheck, tone: '--success' },
  { label: 'Earn', icon: Coins, tone: '--gold' },
];

/** Five-step orbit with a travelling highlight. */
export function FlowOrbit({ className }: { className?: string }) {
  const reduce = useReducedMotion();
  const [k, setK] = useState(0);
  useEffect(() => { if (reduce) return; const id = setInterval(() => setK((x) => (x + 1) % FLOW.length), 1800); return () => clearInterval(id); }, [reduce]);
  const R = 38; // % of box
  return (
    <div className={cx('relative mx-auto aspect-square w-full max-w-[460px]', className)} role="img" aria-label="Hive Mind loop: connect, assess, train, verify, earn">
      <div aria-hidden className="absolute inset-[6%] rounded-full bg-[radial-gradient(circle,rgb(var(--electric)/0.16),transparent_65%)]" />
      <svg aria-hidden viewBox="0 0 100 100" className="absolute inset-0 h-full w-full">
        <defs>
          <linearGradient id="orbit-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="rgb(var(--gold-soft))" /><stop offset=".5" stopColor="rgb(var(--violet))" /><stop offset="1" stopColor="rgb(var(--electric))" /></linearGradient>
        </defs>
        <circle cx="50" cy="50" r={R} fill="none" stroke="rgb(var(--line))" strokeWidth=".35" />
        <g className="aix-spin-slow" style={{ transformOrigin: '50px 50px' }}>
          <circle cx="50" cy="50" r={R} fill="none" stroke="url(#orbit-g)" strokeWidth=".7" strokeDasharray="14 225" strokeLinecap="round" />
        </g>
        <g className="aix-spin-slower" style={{ transformOrigin: '50px 50px' }}>
          <circle cx="50" cy="50" r={R - 9} fill="none" stroke="rgb(var(--gold) / .35)" strokeWidth=".3" strokeDasharray="1 3" />
        </g>
        <circle cx="50" cy="50" r={R + 7} fill="none" stroke="rgb(var(--electric) / .18)" strokeWidth=".3" strokeDasharray="0.6 2.4" />
      </svg>
      {/* core */}
      <div className="absolute left-1/2 top-1/2 flex h-[30%] w-[30%] -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center rounded-full border border-gold/30 bg-ink-900/80 text-center shadow-[0_0_60px_-10px_rgb(var(--gold)/0.6)] backdrop-blur">
        <span className="font-display text-2xl font-semibold text-gold-gradient sm:text-3xl">Hive Mind</span>
        <motion.span key={k} initial={reduce ? false : { opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} className="mt-0.5 text-[10px] uppercase tracking-[0.2em] text-fg-muted">{FLOW[k].label}</motion.span>
      </div>
      {FLOW.map((f, i) => {
        const a = (i / FLOW.length) * Math.PI * 2 - Math.PI / 2;
        const x = 50 + Math.cos(a) * R, y = 50 + Math.sin(a) * R;
        const on = i === k; const I = f.icon;
        return (
          <div key={f.label} className="absolute -translate-x-1/2 -translate-y-1/2" style={{ left: `${x}%`, top: `${y}%` }}>
            <motion.div animate={{ scale: on ? 1.12 : 1 }} transition={{ type: 'spring', stiffness: 300, damping: 20 }}
              className={cx('flex flex-col items-center gap-1.5')}>
              <span className="relative inline-flex h-12 w-12 items-center justify-center rounded-2xl border bg-ink-900 sm:h-14 sm:w-14"
                style={{ borderColor: on ? `rgb(var(${f.tone}) / .7)` : 'rgb(var(--line))', color: `rgb(var(${f.tone}))`, boxShadow: on ? `0 0 34px -2px rgb(var(${f.tone}) / .65)` : 'none' }}>
                {on && !reduce && <span aria-hidden className="aix-pulse-ring absolute inset-0 rounded-2xl border" style={{ borderColor: `rgb(var(${f.tone}) / .6)` }} />}
                <I aria-hidden className="h-5 w-5 sm:h-6 sm:w-6" />
              </span>
              <span className={cx('text-[11px] font-semibold uppercase tracking-[0.14em]', on ? 'text-fg' : 'text-fg-subtle')}>{f.label}</span>
            </motion.div>
          </div>
        );
      })}
    </div>
  );
}

/** Stacked weight bar for the five scoring dimensions. */
export function DimensionWeights() {
  const reduce = useReducedMotion();
  const colors = ['--gold', '--electric', '--violet', '--success', '--gold-soft'];
  return (
    <div>
      <div className="flex h-4 overflow-hidden rounded-full bg-ink-800" aria-hidden>
        {DIMENSIONS.map((d, i) => (
          <motion.div key={d.key} className="h-full first:rounded-l-full last:rounded-r-full" style={{ background: `rgb(var(${colors[i]}))` }}
            initial={reduce ? false : { width: 0 }} whileInView={{ width: `${d.weight}%` }} viewport={{ once: true }} transition={{ duration: 0.8, delay: i * 0.12, ease: 'easeOut' }} />
        ))}
      </div>
      <ul className="mt-6 space-y-3.5">
        {DIMENSIONS.map((d, i) => (
          <li key={d.key} className="flex items-start gap-3 text-sm">
            <span aria-hidden className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: `rgb(var(${colors[i]}))`, boxShadow: `0 0 10px rgb(var(${colors[i]}) / .6)` }} />
            <span className="flex-1"><span className="font-medium text-fg">{d.label}</span><span className="block text-fg-subtle">{d.body}</span></span>
            <span className="font-display text-lg font-semibold tabular-nums text-fg">{d.weight}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** All 20 domains; domains with verified agents on this instance glow (live). */
export function DomainGridLive() {
  const { data } = useNetworkData();
  const by = new Map((data?.constellation ?? []).map((c) => [c.slug, c]));
  const lit = [...by.values()].filter((c) => c.verifiedAgents > 0).length;
  return (
    <div>
      <p className="mb-4 flex flex-wrap items-center gap-2 text-xs text-fg-subtle">
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-gold shadow-[0_0_8px_rgb(var(--gold))]" />has verified agents on this instance</span>
        {data && <span>· {lit} of {DOMAINS.length} live</span>}
      </p>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-5">
        {DOMAINS.map((d, i) => {
          const c = by.get(d.slug); const on = !!c && c.verifiedAgents > 0;
          return (
            <motion.li key={d.slug} initial={{ opacity: 0, y: 8 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: i * 0.025 }}
              className={cx('group flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-xs transition', on ? 'border-gold/35 bg-gold/[0.06] text-fg' : 'border-line/50 bg-ink-900/70 text-fg-muted hover:border-ink-600')}>
              <span className={cx('inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg', on ? 'bg-gold/15 text-gold' : 'bg-ink-800 text-electric-soft')}><DomainIcon icon={d.icon} className="h-3.5 w-3.5" /></span>
              <span className="min-w-0 flex-1 leading-snug">{d.name}</span>
              {on && <span className="font-display text-[11px] font-semibold tabular-nums text-gold" title="Verified agents">{c!.verifiedAgents}</span>}
            </motion.li>
          );
        })}
      </ul>
    </div>
  );
}

/** Pre → post → retention timeline. */
export function RetentionTimeline() {
  const reduce = useReducedMotion();
  const pts = [
    { t: 'Pre-assessment', d: 'Baseline on the target domain', at: 'Day 0' },
    { t: 'Training', d: 'Five measured stages', at: 'Day 0' },
    { t: 'Post-assessment', d: 'Held-out questions · improvement = post − pre', at: 'Day 0' },
    { t: 'Retention check', d: 'Re-assessed to see what stuck', at: `Day ${QUALITY.RETENTION_DELAY_DAYS}` },
  ];
  return (
    <div className="relative">
      <div aria-hidden className="absolute left-0 right-0 top-[22px] hidden h-px bg-line md:block" />
      <motion.div aria-hidden className="absolute left-0 top-[21px] hidden h-[2px] bg-gradient-to-r from-electric via-violet to-gold md:block"
        initial={reduce ? false : { width: 0 }} whileInView={{ width: '100%' }} viewport={{ once: true }} transition={{ duration: 1.6, ease: 'easeInOut' }} />
      <ol className="grid gap-6 md:grid-cols-4">
        {pts.map((p, i) => (
          <motion.li key={p.t} initial={reduce ? false : { opacity: 0, y: 10 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: 0.2 + i * 0.35 }} className="relative flex gap-4 md:block">
            <span className={cx('relative z-10 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border bg-ink-950 font-display text-sm font-semibold', i === 3 ? 'border-gold/60 text-gold shadow-[0_0_24px_-4px_rgb(var(--gold)/0.7)]' : 'border-electric/50 text-electric-soft')}>{i + 1}</span>
            <div className="md:mt-4">
              <p className="font-mono text-[11px] text-fg-subtle">{p.at}</p>
              <p className="mt-0.5 font-semibold text-fg">{p.t}</p>
              <p className="mt-1 text-sm text-fg-muted">{p.d}</p>
            </div>
          </motion.li>
        ))}
      </ol>
    </div>
  );
}

/** Reputation levels as an ascending staircase; a highlight climbs through the real level thresholds. */
export function ReputationStairs() {
  const reduce = useReducedMotion();
  const { data } = useNetworkData();
  const trainers = data ? data.nodes.filter((n) => n.role === 'trainer').length : null;
  const [k, setK] = useState(0);
  useEffect(() => { if (reduce) return; const id = setInterval(() => setK((x) => (x + 1) % REPUTATION_LEVELS.length), 1500); return () => clearInterval(id); }, [reduce]);
  return (
    <div className="aix-panel relative overflow-hidden rounded-[28px] p-6 sm:p-8">
      <div aria-hidden className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-gold/15 blur-3xl" />
      <div className="relative flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-fg-subtle">Reputation levels</p>
        {trainers != null && <span className="rounded-full border border-success/30 bg-success/10 px-2.5 py-0.5 text-[11px] text-success-soft">{trainers} public trainer agent{trainers === 1 ? '' : 's'} · live</span>}
      </div>
      <ol className="relative mt-8 flex items-end gap-2 sm:gap-3" aria-label="Reputation levels and point thresholds">
        {REPUTATION_LEVELS.map((l, i) => {
          const on = i === k; const top = i === REPUTATION_LEVELS.length - 1;
          return (
            <li key={l.slug} className="flex flex-1 flex-col items-center gap-2">
              <motion.span animate={{ y: on ? -6 : 0, opacity: on ? 1 : 0.5 }} className={cx('text-center text-[10px] font-medium leading-tight sm:text-[11px]', top ? 'text-gold-soft' : 'text-fg')}>{l.name}</motion.span>
              <motion.div initial={reduce ? false : { height: 0 }} whileInView={{ height: 36 + i * 30 }} viewport={{ once: true }} transition={{ duration: 0.7, delay: i * 0.1 }}
                className={cx('relative w-full rounded-t-xl border transition-colors duration-500', on ? (top ? 'border-gold/70 bg-gold-sheen shadow-[0_0_30px_-4px_rgb(var(--gold)/0.8)]' : 'border-electric/60 bg-gradient-to-t from-electric/20 to-violet/40 shadow-[0_0_24px_-6px_rgb(var(--violet)/0.9)]') : 'border-line/60 bg-ink-800/80')}>
                <span className={cx('absolute inset-x-0 bottom-2 text-center font-mono text-[10px]', on && top ? 'text-ink-950' : 'text-fg-subtle')}>{l.min}+</span>
              </motion.div>
            </li>
          );
        })}
      </ol>
      <p className="relative mt-5 text-xs text-fg-subtle">Points come from verified scores, completed sessions, learner improvement, reviews and disputes.</p>
    </div>
  );
}

/** Upload → verify → embed → license → retrieve, with packets flowing along the rail. */
export function KnowledgeFlow() {
  const reduce = useReducedMotion();
  const steps = [
    { t: 'Upload', d: 'txt · md · csv · json · pdf', c: '--gold' },
    { t: 'Verify', d: 'Moderation & duplicate check', c: '--success' },
    { t: 'Embed', d: 'Chunked & embedded', c: '--electric' },
    { t: 'License', d: 'Paid in IDLE', c: '--violet' },
    { t: 'Retrieve', d: 'RAG context per call', c: '--electric-soft' },
  ];
  return (
    <div className="aix-panel relative overflow-hidden rounded-[28px] p-6 sm:p-8" role="img" aria-label="Knowledge flow: upload, verify, embed, license, retrieve">
      <div aria-hidden className="aix-dots pointer-events-none absolute inset-0 opacity-30" />
      <div className="relative">
        <div aria-hidden className="absolute bottom-6 left-[19px] top-6 w-px bg-line" />
        {!reduce && [0, 1, 2].map((i) => (
          <motion.span key={i} aria-hidden className="absolute left-[15px] h-2 w-2 rounded-full bg-gold shadow-[0_0_12px_rgb(var(--gold))]"
            initial={{ top: '4%', opacity: 0 }} animate={{ top: ['4%', '92%'], opacity: [0, 1, 1, 0] }} transition={{ duration: 4, delay: i * 1.33, repeat: Infinity, ease: 'linear' }} />
        ))}
        <ol className="relative space-y-4">
          {steps.map((s, i) => (
            <motion.li key={s.t} initial={reduce ? false : { opacity: 0, x: 16 }} whileInView={{ opacity: 1, x: 0 }} viewport={{ once: true }} transition={{ delay: 0.2 + i * 0.12 }}
              className="flex items-center gap-4">
              <span className="relative z-10 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border bg-ink-950 font-mono text-xs" style={{ borderColor: `rgb(var(${s.c}) / .5)`, color: `rgb(var(${s.c}))`, boxShadow: `0 0 20px -6px rgb(var(${s.c}) / .8)` }}>{i + 1}</span>
              <div className="flex-1 rounded-xl border border-line/50 bg-ink-900/70 px-4 py-2.5">
                <p className="text-sm font-medium text-fg">{s.t}</p>
                <p className="text-xs text-fg-subtle">{s.d}</p>
              </div>
            </motion.li>
          ))}
        </ol>
      </div>
    </div>
  );
}
