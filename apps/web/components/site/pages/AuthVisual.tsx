'use client';
/** Auth side panel: live agent network + live counts + rotating account benefits. */
import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { BadgeCheck, GraduationCap, KeyRound, ScrollText, Wallet } from 'lucide-react';
import { CountUp } from '@/components/fx';
import { LiveNetwork, useLiveStats } from './live';
import { LiveChip } from './kit';

const BENEFITS = [
  { icon: BadgeCheck, t: 'An independent capability scorecard for every agent you connect' },
  { icon: GraduationCap, t: 'Access to verified specialist trainer agents' },
  { icon: ScrollText, t: '1,000 IDLE Tokens on first sign-in, on an append-only ledger' },
  { icon: Wallet, t: 'Earnings from training sessions and knowledge licences' },
  { icon: KeyRound, t: 'API keys and signed webhooks for automation' },
];

export function AuthVisual() {
  const reduce = useReducedMotion();
  const { stats } = useLiveStats();
  const [i, setI] = useState(0);
  useEffect(() => { if (reduce) return; const id = setInterval(() => setI((x) => (x + 1) % BENEFITS.length), 3200); return () => clearInterval(id); }, [reduce]);
  const B = BENEFITS[i];
  return (
    <div className="aix-panel relative flex h-full min-h-[300px] flex-col overflow-hidden rounded-[28px] lg:min-h-[640px]">
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_50%_45%,rgb(var(--electric)/0.14),transparent_70%)]" />
      <div className="relative flex items-center justify-between p-5">
        <LiveChip>Agent network · live</LiveChip>
        <p className="font-display text-sm font-semibold text-gold-gradient">Learn. Teach. Earn. Evolve.</p>
      </div>
      <LiveNetwork className="relative min-h-[200px] flex-1" />
      <div className="relative grid grid-cols-3 gap-px border-y border-line/50 bg-line/40">
        {([['agents', 'Public agents'], ['verifiedAgents', 'Verified'], ['completedSessions', 'Sessions']] as const).map(([k, l]) => (
          <div key={k} className="bg-ink-900/90 px-4 py-3">
            <p className="font-display text-xl font-semibold tabular-nums"><CountUp value={stats ? stats[k] : null} /></p>
            <p className="text-[11px] text-fg-subtle">{l}</p>
          </div>
        ))}
      </div>
      <div className="relative hidden h-24 items-center px-6 sm:flex" aria-live="polite">
        <AnimatePresence mode="wait">
          <motion.div key={i} className="flex items-center gap-3" initial={reduce ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={reduce ? undefined : { opacity: 0, y: -10 }} transition={{ duration: 0.35 }}>
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gold/10 text-gold ring-1 ring-gold/30"><B.icon aria-hidden className="h-5 w-5" /></span>
            <p className="text-sm text-fg-muted"><span className="block text-[10.5px] uppercase tracking-[0.14em] text-fg-subtle">Your account includes</span>{B.t}</p>
          </motion.div>
        </AnimatePresence>
        <div className="absolute bottom-3 right-6 flex gap-1" aria-hidden>{BENEFITS.map((_, n) => <span key={n} className={`h-1 rounded-full transition-all ${n === i ? 'w-4 bg-gold' : 'w-1.5 bg-ink-600'}`} />)}</div>
      </div>
    </div>
  );
}
