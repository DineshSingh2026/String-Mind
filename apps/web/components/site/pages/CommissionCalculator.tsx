'use client';
/** Illustrative earnings calculator: session price × configurable commission (default = platform default). */
import { useId, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Building2, GraduationCap, Lock, RotateCcw, Wallet } from 'lucide-react';
import { DEFAULT_COMMISSION_BPS } from '@aix/shared';
import { IdleToken } from '@/components/brand/IdleToken';
import { WELCOME_BONUS_IDLE } from '@/lib/tokens';
import { cx } from '../primitives';

const DEFAULT_RATE = DEFAULT_COMMISSION_BPS / 100;
const fmt = (n: number) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(n);

function Num({ v, className }: { v: number; className?: string }) {
  const reduce = useReducedMotion();
  return (
    <motion.span key={Math.round(v)} initial={reduce ? false : { opacity: 0.4, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }} className={cx('inline-block tabular-nums', className)}>
      {fmt(v)}
    </motion.span>
  );
}

export function CommissionCalculator() {
  const id = useId();
  const [price, setPrice] = useState(1000);
  const [rate, setRate] = useState(DEFAULT_RATE);
  const [sessions, setSessions] = useState(10);
  const commission = Math.round((price * rate) / 100);
  const earn = price - commission;
  const total = earn * sessions;
  const toBonus = earn > 0 ? Math.ceil(WELCOME_BONUS_IDLE / earn) : null;
  const reduce = useReducedMotion();

  const slider = (label: string, v: number, set: (n: number) => void, min: number, max: number, step: number, suffix: string, hint?: string) => (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={`${id}-${label}`} className="text-sm font-medium text-fg">{label}</label>
        <span className="font-display text-lg font-semibold tabular-nums text-gold-soft">{fmt(v)}{suffix}</span>
      </div>
      <input id={`${id}-${label}`} type="range" min={min} max={max} step={step} value={v} onChange={(e) => set(Number(e.target.value))}
        className="aix-range mt-2" style={{ ['--fill' as string]: `${((v - min) / (max - min)) * 100}%` }} aria-valuetext={`${fmt(v)}${suffix}`} />
      {hint && <p className="mt-1 text-xs text-fg-subtle">{hint}</p>}
    </div>
  );

  return (
    <div className="aix-conic-border relative overflow-hidden rounded-[28px]">
      <div aria-hidden className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-gold/10 blur-3xl" />
      <div className="relative grid gap-0 lg:grid-cols-[1fr_1.1fr]">
        <div className="space-y-7 border-b border-line/50 p-6 sm:p-8 lg:border-b-0 lg:border-r">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-fg-subtle">Earnings calculator</p>
            <span className="inline-flex items-center rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-warning">Illustrative</span>
          </div>
          {slider('Session price', price, setPrice, 0, 5000, 50, ' IDLE', 'Trainers set their own price in IDLE per listing.')}
          {slider('Platform commission', rate, setRate, 0, 40, 1, '%', `Default is ${DEFAULT_RATE}%; it can be configured per domain or organisation.`)}
          {slider('Settled sessions', sessions, setSessions, 1, 100, 1, '')}
          {rate !== DEFAULT_RATE && (
            <button type="button" onClick={() => setRate(DEFAULT_RATE)} className="inline-flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg"><RotateCcw aria-hidden className="h-3.5 w-3.5" />Reset to default {DEFAULT_RATE}%</button>
          )}
        </div>

        <div className="p-6 sm:p-8" aria-live="polite">
          {/* flow */}
          <div className="grid grid-cols-[auto_1fr_auto_1fr_auto] items-center gap-2 text-center text-[11px] text-fg-muted">
            <span className="flex flex-col items-center gap-1.5"><span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-electric/10 text-electric-soft ring-1 ring-electric/30"><GraduationCap aria-hidden className="h-4 w-4" /></span>Learner</span>
            <svg aria-hidden viewBox="0 0 100 8" preserveAspectRatio="none" className="h-2 w-full"><line x1="0" y1="4" x2="100" y2="4" stroke="rgb(var(--electric))" strokeWidth="2" strokeDasharray="6 6" className="aix-dash-flow" vectorEffect="non-scaling-stroke" /></svg>
            <span className="flex flex-col items-center gap-1.5"><span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-violet/10 text-violet-soft ring-1 ring-violet/30"><Lock aria-hidden className="h-4 w-4" /></span>Escrow</span>
            <svg aria-hidden viewBox="0 0 100 8" preserveAspectRatio="none" className="h-2 w-full"><line x1="0" y1="4" x2="100" y2="4" stroke="rgb(var(--gold))" strokeWidth="2" strokeDasharray="6 6" className="aix-dash-flow" vectorEffect="non-scaling-stroke" /></svg>
            <span className="flex flex-col items-center gap-1.5"><span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-gold/10 text-gold ring-1 ring-gold/30"><Wallet aria-hidden className="h-4 w-4" /></span>Trainer</span>
          </div>

          <div className="mt-8">
            <p className="text-sm text-fg-muted">Trainer receives per session</p>
            <p className="mt-1 font-display text-5xl font-semibold tracking-tight text-gold-gradient sm:text-6xl"><IdleToken size={44} className="mr-3 align-[-0.1em]" /><Num v={earn} /><span className="ml-2 text-xl text-gold">IDLE</span></p>
          </div>

          <div className="mt-6 h-3 overflow-hidden rounded-full bg-ink-800" role="img" aria-label={`${100 - rate}% to trainer, ${rate}% commission`}>
            <div className="flex h-full">
              <motion.div className="h-full bg-gold-sheen" animate={{ width: `${100 - rate}%` }} transition={{ duration: reduce ? 0 : 0.45, ease: [0.2, 0.7, 0.2, 1] }} />
              <motion.div className="h-full bg-danger/70" animate={{ width: `${rate}%` }} transition={{ duration: reduce ? 0 : 0.45, ease: [0.2, 0.7, 0.2, 1] }} />
            </div>
          </div>

          <dl className="mt-6 grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-xl border border-line/60 bg-ink-950/50 p-3"><dt className="text-xs text-fg-subtle">Session price</dt><dd className="mt-0.5 font-semibold"><Num v={price} /> IDLE</dd></div>
            <div className="rounded-xl border border-line/60 bg-ink-950/50 p-3"><dt className="flex items-center gap-1 text-xs text-fg-subtle"><Building2 aria-hidden className="h-3 w-3" />Commission ({rate}%)</dt><dd className="mt-0.5 font-semibold text-danger-soft">− <Num v={commission} /> IDLE</dd></div>
            <div className="rounded-xl border border-line/60 bg-ink-950/50 p-3"><dt className="text-xs text-fg-subtle">{sessions} settled sessions</dt><dd className="mt-0.5 font-semibold text-success-soft"><Num v={total} /> IDLE</dd></div>
            <div className="rounded-xl border border-line/60 bg-ink-950/50 p-3"><dt className="text-xs text-fg-subtle">Sessions to earn a welcome bonus</dt><dd className="mt-0.5 font-semibold">{toBonus ?? '—'}<span className="text-xs font-normal text-fg-subtle"> · {fmt(WELCOME_BONUS_IDLE)} IDLE</span></dd></div>
          </dl>
          <p className="mt-4 text-xs text-fg-subtle">Example only — not a forecast. Actual price, commission and settlement mode come from each listing and your organisation’s terms. Refunds or partial refunds apply per the settlement outcome.</p>
        </div>
      </div>
    </div>
  );
}
