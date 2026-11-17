'use client';
/** Layered defence diagram. Each ring is a control that exists in the StringMind codebase. */
import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Fingerprint, Building2, KeyRound, ScrollText, Scale, ShieldAlert, type LucideIcon } from 'lucide-react';
import { cx } from '../primitives';

export const LAYERS: { key: string; title: string; icon: LucideIcon; color: string; short: string; body: string; proof: string }[] = [
  { key: 'account', title: 'Account protection', icon: Fingerprint, color: '--electric-soft', short: 'bcrypt · TOTP 2FA · rate limits',
    body: 'Passwords hashed with bcrypt; session tokens and API keys stored only as hashes (keys shown once). Optional TOTP two-factor sign-in and request rate limiting.', proof: 'auth service · api-key rate limit' },
  { key: 'tenant', title: 'Tenant isolation', icon: Building2, color: '--violet', short: 'Org-scoped every query',
    body: 'Every resource is scoped to an organisation, and membership is verified on every request. Asking for another org’s resource returns “not found” — existence isn’t leaked.', proof: 'lib/tenancy' },
  { key: 'crypto', title: 'Credential encryption', icon: KeyRound, color: '--success', short: 'AES-256-GCM at rest',
    body: 'Provider API keys are encrypted with AES-256-GCM before storage, decrypted only inside server-side adapter calls, and never returned — only the last four characters are shown.', proof: 'lib/crypto' },
  { key: 'ledger', title: 'Append-only ledger', icon: ScrollText, color: '--gold', short: 'Balanced, immutable entries',
    body: 'Every IDLE Token movement is a balanced double-entry transaction. Database triggers reject UPDATE and DELETE on ledger entries and reject unbalanced transactions.', proof: 'db triggers · wallet/ledger' },
  { key: 'evaluator', title: 'Evaluator independence', icon: Scale, color: '--electric', short: 'Held-out ground truth',
    body: 'Assessments are graded by an independent evaluator against held-out benchmark sets. Post-training tests use different questions, and ground truth is never exposed to agents or non-admins.', proof: 'engine/assessment' },
  { key: 'leakage', title: 'Leakage & injection guard', icon: ShieldAlert, color: '--gold-soft', short: 'Every trainer message screened',
    body: 'Trainer content is sanitised for prompt-injection patterns and compared against held-out questions; anything too similar is blocked and raises a high-severity flag for administrators.', proof: 'engine/training' },
];

export function DefenceDiagram({ className }: { className?: string }) {
  const reduce = useReducedMotion();
  const [active, setActive] = useState(0);
  const [hold, setHold] = useState(false);
  useEffect(() => {
    if (reduce || hold) return;
    const id = setInterval(() => setActive((a) => (a + 1) % LAYERS.length), 2800);
    return () => clearInterval(id);
  }, [reduce, hold]);
  const L = LAYERS[active];
  const n = LAYERS.length;
  return (
    <div className={cx('grid items-center gap-8 lg:grid-cols-[1fr_1fr]', className)} onMouseLeave={() => setHold(false)}>
      <div className="relative mx-auto aspect-square w-full max-w-[460px]" role="img" aria-label="Six concentric layers of protection around your agents, data and IDLE Tokens">
        <div aria-hidden className="absolute inset-[18%] rounded-full bg-[radial-gradient(circle,rgb(var(--gold)/0.18),transparent_70%)]" />
        <svg viewBox="0 0 200 200" className="absolute inset-0 h-full w-full" aria-hidden>
          {LAYERS.map((l, i) => {
            const r = 96 - i * 12.5;
            const on = i === active;
            return (
              <g key={l.key} onMouseEnter={() => { setActive(i); setHold(true); }} className="cursor-pointer">
                <circle cx="100" cy="100" r={r} fill={on ? `rgb(var(${l.color}) / 0.07)` : 'transparent'} stroke={`rgb(var(${l.color}) / ${on ? 0.95 : 0.28})`} strokeWidth={on ? 1.6 : 0.8}
                  style={{ transition: 'all .5s', filter: on ? `drop-shadow(0 0 6px rgb(var(${l.color}) / .8))` : undefined }} />
                <g className={i % 2 ? 'aix-spin-slower' : 'aix-spin-slow'} style={{ transformOrigin: '100px 100px' }}>
                  <circle cx="100" cy="100" r={r} fill="none" stroke={`rgb(var(${l.color}) / ${on ? 1 : 0.5})`} strokeWidth={on ? 2.6 : 1.4} strokeLinecap="round"
                    strokeDasharray={`${8 + i * 2} ${2 * Math.PI * r - (8 + i * 2)}`} strokeDashoffset={i * 23} />
                </g>
              </g>
            );
          })}
        </svg>
        {/* layer icons along a diagonal */}
        {LAYERS.map((l, i) => {
          const r = (96 - i * 12.5) / 2; // % of box
          const a = -Math.PI / 2 + (i / n) * Math.PI * 1.4 - 0.35;
          const I = l.icon; const on = i === active;
          return (
            <button key={l.key} type="button" onClick={() => { setActive(i); setHold(true); }} onFocus={() => { setActive(i); setHold(true); }}
              aria-label={l.title} aria-pressed={on}
              className="absolute inline-flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border bg-ink-950 transition-all duration-300 sm:h-9 sm:w-9"
              style={{ left: `${50 + Math.cos(a) * r}%`, top: `${50 + Math.sin(a) * r}%`, borderColor: `rgb(var(${l.color}) / ${on ? 0.9 : 0.35})`, color: `rgb(var(${l.color}))`, boxShadow: on ? `0 0 22px rgb(var(${l.color}) / .7)` : 'none', transform: `translate(-50%,-50%) scale(${on ? 1.15 : 1})` }}>
              <I aria-hidden className="h-4 w-4" />
            </button>
          );
        })}
        <div className="absolute left-1/2 top-1/2 flex h-[22%] w-[22%] -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center rounded-full border border-gold/40 bg-ink-900 text-center shadow-[0_0_40px_-6px_rgb(var(--gold)/0.7)]">
          <span className="text-[9px] font-semibold uppercase leading-tight tracking-[0.12em] text-gold-soft sm:text-[10px]">Your agents,<br />data & IDLE</span>
        </div>
      </div>

      <div>
        <ol className="space-y-1.5" aria-label="Protection layers">
          {LAYERS.map((l, i) => {
            const on = i === active; const I = l.icon;
            return (
              <li key={l.key}>
                <button type="button" onMouseEnter={() => { setActive(i); setHold(true); }} onClick={() => { setActive(i); setHold(true); }} aria-expanded={on}
                  className={cx('relative w-full rounded-2xl px-4 py-3 text-left transition', on ? 'bg-ink-850' : 'hover:bg-ink-900')}>
                  {on && <motion.span layoutId="def-active" className="absolute inset-0 rounded-2xl border" style={{ borderColor: `rgb(var(${l.color}) / .45)`, boxShadow: `0 0 30px -14px rgb(var(${l.color}))` }} transition={{ type: 'spring', stiffness: 400, damping: 34 }} />}
                  <span className="relative flex items-center gap-3">
                    <span className="font-mono text-[10px] text-fg-subtle">L{i + 1}</span>
                    <I aria-hidden className="h-4 w-4 shrink-0" style={{ color: `rgb(var(${l.color}))` }} />
                    <span className="flex-1 text-sm font-medium text-fg">{l.title}</span>
                    <span className="hidden text-xs text-fg-subtle sm:inline">{l.short}</span>
                  </span>
                  <AnimatePresence initial={false}>
                    {on && (
                      <motion.div initial={reduce ? false : { height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={reduce ? undefined : { height: 0, opacity: 0 }} transition={{ duration: 0.3 }} className="relative overflow-hidden">
                        <p className="pl-[52px] pt-2 text-sm leading-relaxed text-fg-muted">{l.body}</p>
                        <p className="pl-[52px] pt-2 font-mono text-[10.5px] text-fg-subtle">implemented in: {l.proof}</p>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </button>
              </li>
            );
          })}
        </ol>
        <p className="sr-only" aria-live="polite">{L.title}</p>
      </div>
    </div>
  );
}
