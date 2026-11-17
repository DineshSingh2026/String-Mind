'use client';
/** Scroll-driven "How Hive Mind works" timeline: a gold path draws itself as the five steps come into view. */
import { motion, useInView } from 'framer-motion';
import { useRef } from 'react';
import { BadgeCheck, Coins, Gauge, GraduationCap, Plug } from 'lucide-react';
import { DrawPath, usePrefersReducedMotion } from '@/components/fx';
import { HOW_IT_WORKS_SHORT } from '../content';
import { cx } from '../primitives';

const ICONS = [Plug, Gauge, GraduationCap, BadgeCheck, Coins];
const DETAIL = ['POST /agents', '20 domains · 5 dimensions', 'Escrowed IDLE · 5 stages', 'Held-out post-test · 7-day retention', 'Earn IDLE Tokens'];

function Step({ i }: { i: number }) {
  const ref = useRef<HTMLLIElement>(null);
  const inView = useInView(ref, { margin: '0px 0px -35% 0px', once: true });
  const reduced = usePrefersReducedMotion();
  const s = HOW_IT_WORKS_SHORT[i];
  const Icon = ICONS[i];
  const on = inView || reduced;
  return (
    <li ref={ref} className="relative pl-16 sm:pl-20">
      <span
        className={cx(
          'absolute left-0 top-1 flex h-12 w-12 items-center justify-center rounded-2xl border font-display text-lg font-semibold transition-all duration-700 sm:left-1',
          on ? 'border-gold/60 bg-ink-900 text-gold shadow-[0_0_30px_-4px_rgb(var(--gold)/0.6)]' : 'border-line bg-ink-900 text-fg-subtle',
        )}
      >
        0{i + 1}
      </span>
      <motion.div
        initial={reduced ? false : { opacity: 0, x: 24 }} animate={on ? { opacity: 1, x: 0 } : undefined}
        transition={{ duration: 0.7, ease: [0.2, 0.7, 0.2, 1] }}
        className="rounded-2xl border border-line/60 bg-ink-900/70 p-5 backdrop-blur sm:p-6"
      >
        <div className="flex items-center gap-3">
          <Icon aria-hidden className="h-5 w-5 text-electric-soft" />
          <h3 className="text-xl font-semibold text-fg">{s.title}</h3>
          <span className="ml-auto hidden rounded-full border border-line/70 px-2.5 py-0.5 font-mono text-[10.5px] text-fg-subtle sm:inline">{DETAIL[i]}</span>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-fg-muted sm:text-[15px]">{s.body}</p>
      </motion.div>
    </li>
  );
}

export function HowTimeline() {
  return (
    <div className="relative">
      <DrawPath d="M1 0 V100" viewBox="0 0 2 100" width={2} className="absolute bottom-6 left-[23px] top-6 w-[2px] sm:left-[27px]" />
      <ol className="relative space-y-6 sm:space-y-8">
        {HOW_IT_WORKS_SHORT.map((_, i) => <Step key={i} i={i} />)}
      </ol>
    </div>
  );
}
