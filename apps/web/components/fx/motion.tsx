'use client';
/** Scroll reveals, counters, headline effects, marquees and SVG path drawing. */
import './fx.css';
import { motion, useInView, useScroll, useSpring, useTransform, type Variants } from 'framer-motion';
import { Children, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { usePrefersReducedMotion } from './hooks';
import type { ActivityItem } from './types';

const EASE = [0.2, 0.7, 0.2, 1] as const;

/* ───────────── Reveal ───────────── */
export function Reveal({ children, delay = 0, y = 18, className, as = 'div' }: {
  children: ReactNode; delay?: number; y?: number; className?: string; as?: 'div' | 'section' | 'li';
}) {
  const reduced = usePrefersReducedMotion();
  const Comp = as === 'section' ? motion.section : as === 'li' ? motion.li : motion.div;
  return (
    <Comp
      className={className}
      initial={reduced ? false : { opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '0px 0px -8% 0px' }}
      transition={reduced ? { duration: 0 } : { duration: 0.7, delay, ease: EASE }}
    >
      {children}
    </Comp>
  );
}

/* ───────────── Stagger ───────────── */
const staggerItem: Variants = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.6, ease: EASE } },
};

export function Stagger({ children, className, gap = 0.08 }: { children: ReactNode; className?: string; gap?: number }) {
  const reduced = usePrefersReducedMotion();
  return (
    <motion.div
      className={className}
      initial={reduced ? false : 'hidden'}
      whileInView="show"
      viewport={{ once: true, margin: '0px 0px -8% 0px' }}
      variants={{ hidden: {}, show: { transition: { staggerChildren: reduced ? 0 : gap } } }}
    >
      {children}
    </motion.div>
  );
}

export function StaggerItem({ children, className }: { children: ReactNode; className?: string; gap?: number }) {
  const reduced = usePrefersReducedMotion();
  return <motion.div className={className} variants={reduced ? staggerItemReduced : staggerItem}>{children}</motion.div>;
}

const staggerItemReduced: Variants = { hidden: { opacity: 0 }, show: { opacity: 1, transition: { duration: 0 } } };

/* ───────────── CountUp ───────────── */
export function CountUp({ value, decimals = 0, prefix = '', suffix = '', duration = 1.6, className }: {
  value: number | null; decimals?: number; prefix?: string; suffix?: string; duration?: number; className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: '0px 0px -5% 0px' });
  const reduced = usePrefersReducedMotion();
  const [shown, setShown] = useState(0);
  const from = useRef(0);

  useEffect(() => {
    if (value == null || !inView) return;
    if (reduced) { setShown(value); from.current = value; return; }
    const start = performance.now(); const a = from.current; const b = value;
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / (duration * 1000));
      const e = 1 - Math.pow(1 - p, 4);
      setShown(a + (b - a) * e);
      if (p < 1) raf = requestAnimationFrame(tick); else from.current = b;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, inView, reduced, duration]);

  const fmt = (n: number) => new Intl.NumberFormat('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(n);
  return (
    <span ref={ref} className={clsx('tabular-nums', className)}>
      {value == null ? '—' : <>{prefix}{fmt(inView ? shown : 0)}{suffix}</>}
    </span>
  );
}

/* ───────────── WordReveal ───────────── */
const NL = String.fromCharCode(10);
/** Per-word blur-in. Use a newline character in `text` for an explicit line break. */
export function WordReveal({ text, className, delay = 0 }: { text: string; className?: string; delay?: number }) {
  const reduced = usePrefersReducedMotion();
  const lines = text.split(NL).map((l) => l.split(/\s+/).filter(Boolean));
  let k = 0;
  return (
    <span className={className}>
      <span className="sr-only">{text.split(NL).join(' ')}</span>
      {lines.map((words, li) => (
        <span key={li} aria-hidden className={lines.length > 1 ? 'block' : undefined}>
          {words.map((w, i) => {
            const idx = k++;
            return (
              <span key={i} className="inline-block whitespace-pre">
                <motion.span
                  className="inline-block"
                  initial={reduced ? false : { opacity: 0.0001, y: '0.35em', filter: 'blur(10px)' }}
                  animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                  transition={reduced ? { duration: 0 } : { duration: 0.8, delay: delay + idx * 0.08, ease: EASE }}
                >
                  {w}
                </motion.span>
                {i < words.length - 1 ? ' ' : ''}
              </span>
            );
          })}
        </span>
      ))}
    </span>
  );
}

/* ───────────── TextShimmer ───────────── */
export function TextShimmer({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={clsx('fx-shimmer', className)}>{children}</span>;
}

/* ───────────── DrawPath ───────────── */
/**
 * Self-drawing SVG path tied to scroll progress. Renders its own <svg>; pass `viewBox` when `d` is in a
 * custom coordinate space (default: 0 0 100 100, stretched to the element box).
 */
export function DrawPath({ d, className, stroke, width = 2, viewBox = '0 0 100 100', preserveAspectRatio = 'none' }: {
  d: string; className?: string; stroke?: string; width?: number; viewBox?: string; preserveAspectRatio?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const gid = `fx-draw-${useId().replace(/:/g, '')}`;
  const reduced = usePrefersReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start 85%', 'end 55%'] });
  const len = useSpring(scrollYProgress, { stiffness: 90, damping: 24, mass: 0.4 });
  const opacity = useTransform(len, [0, 0.04], [0.25, 1]);
  const [vx, vy, vw, vh] = viewBox.split(/[\s,]+/).map(Number);
  return (
    <div ref={ref} aria-hidden className={className}>
      <svg className="block h-full w-full overflow-visible" viewBox={viewBox} preserveAspectRatio={preserveAspectRatio} fill="none">
        <defs>
          {/* userSpaceOnUse so straight (zero-width) paths still get the gradient */}
          <linearGradient id={gid} gradientUnits="userSpaceOnUse" x1={vx} y1={vy} x2={vx + vw} y2={vy + vh}>
            <stop offset="0" stopColor="rgb(240 214 150)" />
            <stop offset="0.55" stopColor="rgb(214 175 85)" />
            <stop offset="1" stopColor="rgb(72 148 255)" />
          </linearGradient>
        </defs>
        <path d={d} stroke="rgb(38 50 76)" strokeWidth={width} vectorEffect="non-scaling-stroke" strokeLinecap="round" />
        <motion.path
          d={d} stroke={stroke ?? `url(#${gid})`} strokeWidth={width} vectorEffect="non-scaling-stroke" strokeLinecap="round"
          style={reduced ? undefined : { pathLength: len, opacity }}
        />
      </svg>
    </div>
  );
}

/* ───────────── GlowDivider ───────────── */
export function GlowDivider({ className }: { className?: string }) {
  return <div aria-hidden className={clsx('fx-divider', className)} />;
}

/* ───────────── Marquee ───────────── */
/** Infinite marquee. `speed` is in px/second (default 40). Pauses on hover/focus; static & scrollable under reduced motion. */
export function Marquee({ children, speed = 40, reverse, className }: { children: ReactNode; speed?: number; reverse?: boolean; className?: string }) {
  const track = useRef<HTMLDivElement>(null);
  const [dur, setDur] = useState(40);
  useEffect(() => {
    const el = track.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setDur(Math.max(8, el.scrollWidth / 2 / Math.max(5, speed))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [speed]);
  const items = Children.toArray(children);
  return (
    <div className={clsx('fx-marquee-wrap fx-marquee-mask overflow-hidden motion-reduce:overflow-x-auto', className)}>
      <div ref={track} className={clsx('fx-marquee', reverse && 'fx-reverse')} style={{ '--fx-dur': `${dur}s` } as CSSProperties}>
        <div className="flex shrink-0 items-center">{items}</div>
        <div className="flex shrink-0 items-center motion-reduce:hidden" aria-hidden>{items}</div>
      </div>
    </div>
  );
}

/* ───────────── LiveTicker ───────────── */
function ago(at: string) {
  const s = Math.max(0, (Date.now() - new Date(at).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Infinite marquee of real platform activity. Renders nothing when there is no activity. */
export function LiveTicker({ items, className }: { items: ActivityItem[]; className?: string }) {
  const [, force] = useState(0);
  useEffect(() => { const id = setInterval(() => force((n) => n + 1), 60_000); return () => clearInterval(id); }, []);
  if (!items?.length) return null;
  return (
    <div className={clsx('relative', className)} role="region" aria-label="Recent platform activity">
      <Marquee speed={36}>
        {items.map((it, i) => (
          <span key={i} className="mx-3 inline-flex items-center gap-2.5 whitespace-nowrap rounded-full border border-line/60 bg-ink-900/60 px-3.5 py-1.5 text-[13px] text-fg-muted backdrop-blur">
            {it.type === 'assessment' ? (
              <>
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-success shadow-[0_0_8px_rgb(var(--success))]" />
                <span className="font-medium text-fg">{it.agent}</span>
                <span>assessed in {it.domain}</span>
                {it.score != null && <span className="font-display font-semibold tabular-nums text-gold">{it.score.toFixed(1)}</span>}
              </>
            ) : (
              <>
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-electric shadow-[0_0_8px_rgb(var(--electric))]" />
                <span className="font-medium text-fg">{it.agent}</span>
                <span>trained {it.learner}{it.domain ? ` in ${it.domain}` : ''}</span>
                {it.improvement != null && <span className="font-display font-semibold tabular-nums text-success">{it.improvement >= 0 ? '+' : ''}{it.improvement.toFixed(1)}</span>}
              </>
            )}
            <span className="text-fg-subtle">· {ago(it.at)}</span>
          </span>
        ))}
      </Marquee>
    </div>
  );
}
