'use client';
import './pages.css';
/** Docs helpers: scrollspy TOC with reading progress, and an animated (illustrative) terminal. */
import { useEffect, useRef, useState } from 'react';
import { motion, useInView, useReducedMotion, useScroll, useSpring } from 'framer-motion';
import { cx } from '../primitives';

export function DocsToc({ items }: { items: { id: string; label: string }[] }) {
  const [active, setActive] = useState(items[0]?.id);
  const { scrollYProgress } = useScroll();
  const prog = useSpring(scrollYProgress, { stiffness: 120, damping: 30 });
  useEffect(() => {
    const els = items.map((i) => document.getElementById(i.id)).filter((e): e is HTMLElement => !!e);
    const io = new IntersectionObserver((entries) => {
      const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (vis[0]) setActive(vis[0].target.id);
    }, { rootMargin: '-15% 0px -70% 0px' });
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, [items]);
  return (
    <nav aria-label="On this page" className="aix-panel rounded-2xl p-4 lg:border-0 lg:bg-transparent lg:p-0 lg:shadow-none lg:backdrop-blur-0">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-fg-subtle">On this page</p>
      <div className="relative mt-3 lg:pl-3">
        <div aria-hidden className="absolute bottom-0 left-0 top-0 hidden w-px bg-line lg:block" />
        <motion.div aria-hidden style={{ scaleY: prog }} className="absolute bottom-0 left-0 top-0 hidden w-px origin-top bg-gradient-to-b from-gold to-electric lg:block" />
        <ul className="grid grid-cols-2 gap-1 sm:grid-cols-4 lg:grid-cols-1">
          {items.map((t) => {
            const on = active === t.id;
            return (
              <li key={t.id} className="relative">
                {on && <motion.span layoutId="toc-active" className="absolute inset-0 rounded-lg bg-gold/10 ring-1 ring-gold/25" transition={{ type: 'spring', stiffness: 420, damping: 36 }} />}
                <a href={`#${t.id}`} aria-current={on ? 'location' : undefined} className={cx('relative block rounded-lg px-2.5 py-1.5 text-sm transition', on ? 'font-medium text-gold-soft' : 'text-fg-muted hover:text-fg')}>{t.label}</a>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}

type Line = { kind: 'cmd' | 'out' | 'ok' | 'dim'; text: string };

/** Types commands and reveals output when scrolled into view. Output is illustrative (labelled). */
export function AnimatedTerminal({ lines, title = 'terminal', className }: { lines: Line[]; title?: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: '-10% 0px' });
  const reduce = useReducedMotion();
  const [n, setN] = useState(0);      // fully shown lines
  const [chars, setChars] = useState(0); // chars of current cmd line
  useEffect(() => {
    if (!inView) return;
    if (reduce) { setN(lines.length); return; }
    if (n >= lines.length) return;
    const l = lines[n];
    if (l.kind === 'cmd' && chars < l.text.length) { const id = setTimeout(() => setChars((c) => c + 1), 22 + Math.random() * 30); return () => clearTimeout(id); }
    const id = setTimeout(() => { setN((x) => x + 1); setChars(0); }, l.kind === 'cmd' ? 380 : 90);
    return () => clearTimeout(id);
  }, [inView, reduce, n, chars, lines]);
  const color = { cmd: 'text-fg', out: 'text-fg-muted', ok: 'text-success-soft', dim: 'text-fg-subtle' };
  return (
    <div ref={ref} className={cx('overflow-hidden rounded-2xl border border-line bg-ink-950/95 shadow-[0_40px_80px_-30px_rgb(0_0_0/0.9),0_0_0_1px_rgb(255_255_255/0.03)_inset]', className)}>
      <div className="flex items-center gap-2 border-b border-line/70 bg-ink-900/80 px-4 py-2.5">
        <span aria-hidden className="flex gap-1.5"><i className="h-2.5 w-2.5 rounded-full bg-danger/70" /><i className="h-2.5 w-2.5 rounded-full bg-warning/70" /><i className="h-2.5 w-2.5 rounded-full bg-success/70" /></span>
        <span className="ml-2 font-mono text-[11px] text-fg-subtle">{title}</span>
        <span className="ml-auto inline-flex items-center rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider text-warning">Illustrative output</span>
      </div>
      <pre className="min-h-[260px] overflow-x-auto p-4 font-mono text-[12px] leading-relaxed sm:text-[12.5px]" aria-label="Example terminal session">
        {lines.slice(0, Math.min(lines.length, n + 1)).map((l, i) => {
          const typing = i === n && l.kind === 'cmd';
          if (i === n && l.kind !== 'cmd') return null;
          return (
            <div key={i} className={color[l.kind]}>
              {l.kind === 'cmd' && <span className="select-none text-gold">$ </span>}
              {typing ? l.text.slice(0, chars) : l.text}
              {typing && <span aria-hidden className="aix-caret ml-0.5 inline-block h-[1.05em] w-[7px] translate-y-[2px] bg-gold" />}
            </div>
          );
        })}
        {n >= lines.length && <div className="text-fg"><span className="text-gold">$ </span><span aria-hidden className="aix-caret inline-block h-[1.05em] w-[7px] translate-y-[2px] bg-gold" /></div>}
      </pre>
    </div>
  );
}
