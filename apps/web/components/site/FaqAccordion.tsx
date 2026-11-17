'use client';
/** Accessible animated accordion: buttons with aria-expanded/aria-controls, regions labelled by their headings. */
import { useId, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Plus } from 'lucide-react';
import { cx } from './primitives';

export function FaqAccordion({ items, defaultOpen = 0, highlight }: { items: { q: string; a: string }[]; defaultOpen?: number | null; highlight?: (s: string) => ReactNode }) {
  const [open, setOpen] = useState<number | null>(defaultOpen);
  const base = useId();
  const reduce = useReducedMotion();
  return (
    <div className="divide-y divide-line/50 overflow-hidden rounded-2xl border border-line/70 bg-ink-900/60 backdrop-blur">
      {items.map((it, i) => {
        const isOpen = open === i;
        const bid = `${base}-b${i}`; const pid = `${base}-p${i}`;
        return (
          <div key={it.q} className={cx('relative transition-colors duration-300', isOpen && 'bg-ink-850/70')}>
            {isOpen && <motion.span layoutId={`${base}-bar`} aria-hidden className="absolute bottom-0 left-0 top-0 w-0.5 bg-gradient-to-b from-gold to-electric" />}
            <h3>
              <button id={bid} type="button" aria-expanded={isOpen} aria-controls={pid} onClick={() => setOpen(isOpen ? null : i)}
                className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left text-[15px] font-medium text-fg transition hover:bg-ink-800/40 sm:px-6">
                <span>{highlight ? highlight(it.q) : it.q}</span>
                <span className={cx('inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border transition-all duration-300', isOpen ? 'rotate-45 border-gold/50 bg-gold/15 text-gold' : 'border-line text-gold')}>
                  <Plus aria-hidden className="h-4 w-4" />
                </span>
              </button>
            </h3>
            <AnimatePresence initial={false}>
              {isOpen && (
                <motion.div id={pid} role="region" aria-labelledby={bid} key="c"
                  initial={reduce ? false : { height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={reduce ? undefined : { height: 0, opacity: 0 }}
                  transition={{ duration: 0.3, ease: [0.2, 0.7, 0.2, 1] }} className="overflow-hidden">
                  <div className="px-5 pb-5 text-sm leading-relaxed text-fg-muted sm:px-6">{highlight ? highlight(it.a) : it.a}</div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        );
      })}
    </div>
  );
}
