'use client';
/** The 13-step workflow as a scroll-driven timeline: the rail fills with scroll progress, nodes ignite as they enter view. */
import { useRef } from 'react';
import { motion, useInView, useReducedMotion, useScroll, useSpring } from 'framer-motion';
import {
  BadgeCheck, ClipboardCheck, Coins, FlaskConical, GraduationCap, Handshake, Lock, MessageSquare, Plug, Radar, Search, Send, Target, type LucideIcon,
} from 'lucide-react';
import { WORKFLOW_13 } from '../content';
import { cx } from '../primitives';

const ICONS: LucideIcon[] = [Plug, Radar, ClipboardCheck, Target, Search, Send, Lock, FlaskConical, Handshake, MessageSquare, GraduationCap, BadgeCheck, Coins];
const PHASES = [
  { from: 0, to: 1, label: 'Connect', tone: 'electric' },
  { from: 2, to: 3, label: 'Assess', tone: 'violet' },
  { from: 4, to: 6, label: 'Match & escrow', tone: 'gold' },
  { from: 7, to: 10, label: 'Train', tone: 'electric' },
  { from: 11, to: 12, label: 'Verify & settle', tone: 'success' },
] as const;
const phaseOf = (i: number) => PHASES.find((p) => i >= p.from && i <= p.to)!;
const TONE = {
  electric: { ring: 'ring-electric/40 text-electric-soft', glow: 'rgb(var(--electric) / 0.55)', chip: 'border-electric/30 bg-electric/10 text-electric-soft' },
  violet: { ring: 'ring-violet/40 text-violet-soft', glow: 'rgb(var(--violet) / 0.55)', chip: 'border-violet/30 bg-violet/10 text-violet-soft' },
  gold: { ring: 'ring-gold/40 text-gold', glow: 'rgb(var(--gold) / 0.55)', chip: 'border-gold/30 bg-gold/10 text-gold-soft' },
  success: { ring: 'ring-success/40 text-success', glow: 'rgb(var(--success) / 0.55)', chip: 'border-success/30 bg-success/10 text-success-soft' },
};

function Step({ i }: { i: number }) {
  const s = WORKFLOW_13[i];
  const ref = useRef<HTMLLIElement>(null);
  const inView = useInView(ref, { margin: '-45% 0px -45% 0px' });
  const seen = useInView(ref, { once: true, margin: '0px 0px -12% 0px' });
  const reduce = useReducedMotion();
  const Icon = ICONS[i];
  const ph = phaseOf(i);
  const t = TONE[ph.tone];
  const left = i % 2 === 0;
  const firstOfPhase = ph.from === i;
  return (
    <li ref={ref} className="relative grid grid-cols-[48px_1fr] gap-4 md:grid-cols-[1fr_64px_1fr] md:gap-0">
      {/* node */}
      <div className="relative z-10 flex justify-center md:col-start-2 md:row-start-1">
        <motion.span
          className={cx('mt-1 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-ink-900 ring-1 transition-colors duration-500', inView ? t.ring : 'text-fg-subtle ring-line')}
          animate={{ boxShadow: inView ? `0 0 0 6px rgb(var(--ink-950)), 0 0 32px ${t.glow}` : '0 0 0 6px rgb(var(--ink-950)), 0 0 0 rgba(0,0,0,0)', scale: inView && !reduce ? 1.08 : 1 }}
          transition={{ duration: 0.4 }}>
          <Icon aria-hidden className="h-5 w-5" />
        </motion.span>
      </div>
      {/* card */}
      <motion.div
        initial={reduce ? false : { opacity: 0, x: left ? -24 : 24 }} animate={seen ? { opacity: 1, x: 0 } : undefined} transition={{ duration: 0.6, ease: [0.2, 0.7, 0.2, 1] }}
        className={cx('min-w-0 pb-10 md:row-start-1', left ? 'md:col-start-1 md:pr-10 md:text-right' : 'md:col-start-3 md:pl-10')}>
        {firstOfPhase && <p className={cx('mb-3 inline-flex rounded-full border px-2.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.14em]', t.chip)}>{ph.label}</p>}
        <div className={cx('rounded-2xl border p-5 transition-all duration-500', inView ? 'border-ink-600 bg-ink-850/90 shadow-[0_20px_50px_-25px_rgb(0_0_0/0.9)]' : 'border-line/60 bg-ink-900/60')}>
          <p className="font-mono text-[11px] text-fg-subtle">STEP {String(i + 1).padStart(2, '0')}</p>
          <h3 className="mt-1 text-lg font-semibold text-fg">{s.title}</h3>
          <p className="mt-2 text-sm leading-relaxed text-fg-muted">{s.body}</p>
          {s.detail && <code className="mt-3 inline-block rounded-md border border-line/60 bg-ink-950 px-2 py-0.5 font-mono text-[11px] text-electric-soft">{s.detail}</code>}
        </div>
      </motion.div>
    </li>
  );
}

export function WorkflowTimeline() {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start 60%', 'end 60%'] });
  const fill = useSpring(scrollYProgress, { stiffness: 120, damping: 30, mass: 0.4 });
  return (
    <div ref={ref} className="relative mt-14">
      {/* rail */}
      <div aria-hidden className="absolute bottom-10 left-6 top-0 w-px -translate-x-1/2 bg-line/60 md:left-1/2" />
      <motion.div aria-hidden style={{ scaleY: fill }} className="absolute bottom-10 left-6 top-0 w-[2px] origin-top -translate-x-1/2 bg-gradient-to-b from-electric via-violet to-gold shadow-[0_0_14px_rgb(var(--gold)/0.6)] md:left-1/2" />
      <ol className="relative">{WORKFLOW_13.map((_, i) => <Step key={i} i={i} />)}</ol>
    </div>
  );
}
