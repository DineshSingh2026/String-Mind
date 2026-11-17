'use client';
/** Searchable, filterable FAQ with animated groups. */
import { useMemo, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import Link from 'next/link';
import { Search, X } from 'lucide-react';
import { FAQS } from '../content';
import { FaqAccordion } from '../FaqAccordion';
import { cx } from '../primitives';

const GROUPS = ['General', 'Training', 'IDLE Tokens & earnings', 'Security', 'Developers'] as const;

export function FaqExplorer() {
  const [q, setQ] = useState('');
  const [g, setG] = useState<string | null>(null);
  const term = q.trim().toLowerCase();
  const filtered = useMemo(() => FAQS.filter((f) => (!g || f.group === g) && (!term || `${f.q} ${f.a}`.toLowerCase().includes(term))), [g, term]);
  const mark = (s: string): ReactNode => {
    if (!term) return s;
    const i = s.toLowerCase().indexOf(term);
    if (i < 0) return s;
    return <>{s.slice(0, i)}<mark className="rounded bg-gold/25 px-0.5 text-fg">{s.slice(i, i + term.length)}</mark>{s.slice(i + term.length)}</>;
  };
  return (
    <div className="mx-auto max-w-3xl">
      <div className="relative">
        <Search aria-hidden className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
        <label htmlFor="faq-q" className="sr-only">Search questions</label>
        <input id="faq-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search questions — e.g. “fine-tuning”, “IDLE”, “API key”"
          className="h-14 w-full rounded-2xl border border-line bg-ink-900/80 pl-11 pr-11 text-[15px] text-fg shadow-[0_20px_50px_-30px_rgb(0_0_0/0.9)] backdrop-blur placeholder:text-fg-subtle focus:border-electric/60 focus:outline-none" />
        {q && <button type="button" onClick={() => setQ('')} aria-label="Clear search" className="absolute right-3 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-fg-subtle hover:text-fg"><X className="h-4 w-4" /></button>}
      </div>
      <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Filter by topic">
        {[null, ...GROUPS].map((x) => {
          const on = g === x;
          const n = FAQS.filter((f) => !x || f.group === x).length;
          return (
            <button key={x ?? 'all'} type="button" aria-pressed={on} onClick={() => setG(x)}
              className={cx('relative rounded-full border px-3.5 py-1.5 text-xs transition', on ? 'border-transparent text-ink-950' : 'border-line text-fg-muted hover:border-ink-600 hover:text-fg')}>
              {on && <motion.span layoutId="faq-chip" className="absolute inset-0 rounded-full bg-gold-sheen" transition={{ type: 'spring', stiffness: 450, damping: 34 }} />}
              <span className="relative font-medium">{x ?? 'All'} <span className={on ? 'text-ink-950/60' : 'text-fg-subtle'}>{n}</span></span>
            </button>
          );
        })}
      </div>
      <p className="mt-6 text-sm text-fg-subtle" aria-live="polite">{filtered.length} answer{filtered.length === 1 ? '' : 's'}</p>
      <div className="mt-4 space-y-10">
        <AnimatePresence mode="popLayout">
          {GROUPS.map((grp) => {
            const items = filtered.filter((f) => f.group === grp);
            if (!items.length) return null;
            return (
              <motion.section key={grp} layout initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.3 }} aria-labelledby={`faq-${grp}`}>
                <h2 id={`faq-${grp}`} className="mb-4 flex items-center gap-3 text-lg font-semibold">{grp}<span className="h-px flex-1 bg-gradient-to-r from-line to-transparent" /></h2>
                <FaqAccordion key={`${grp}-${term}`} items={items} defaultOpen={term ? 0 : null} highlight={mark} />
              </motion.section>
            );
          })}
        </AnimatePresence>
        {filtered.length === 0 && (
          <div className="rounded-2xl border border-dashed border-line px-6 py-12 text-center">
            <p className="font-medium">No answers match “{q}”</p>
            <p className="mt-1 text-sm text-fg-muted">Try a different word, or <Link href="/contact" className="text-gold-soft underline">ask us directly</Link>.</p>
          </div>
        )}
      </div>
    </div>
  );
}
