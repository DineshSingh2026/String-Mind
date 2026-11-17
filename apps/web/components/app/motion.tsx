'use client';
/**
 * Motion helpers for the signed-in app & admin (framer-motion based, reduced-motion aware).
 * Data-honest: numbers animate only to real values; `null`/`undefined` renders "—".
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { animate, motion, useInView, useReducedMotion } from 'framer-motion';
import { clsx as cn } from 'clsx';

export { motion, AnimatePresence, LayoutGroup, useReducedMotion } from 'framer-motion';

export const EASE = [0.2, 0.7, 0.2, 1] as const;

/** Animated number: 0 → value (and value → value on change). `format` renders the in-flight value. */
export function AnimatedNumber({ value, format = (n) => Math.round(n).toLocaleString('en-IN'), duration = 1.1, className, empty = '—' }: {
  value: number | null | undefined; format?: (n: number) => ReactNode; duration?: number; className?: string; empty?: ReactNode;
}) {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: '0px 0px -40px 0px' });
  const [shown, setShown] = useState<number | null>(null);
  const from = useRef(0);
  useEffect(() => {
    if (value == null || !Number.isFinite(value)) return;
    if (reduce) { setShown(value); from.current = value; return; }
    if (!inView) return;
    // track the in-flight value so an interrupted run (StrictMode re-run, value change) resumes instead of freezing
    const c = animate(from.current, value, { duration, ease: EASE, onUpdate: (v) => { from.current = v; setShown(v); } });
    return () => c.stop();
  }, [value, inView, reduce, duration]);
  if (value == null || !Number.isFinite(value)) return <span ref={ref} className={className}>{empty}</span>;
  return <span ref={ref} className={cn('tabular-nums', className)}>{format(shown ?? (reduce ? value : 0))}</span>;
}

/** Staggered list container + item (fade/slide). */
export const listVariants = { hidden: {}, show: { transition: { staggerChildren: 0.055, delayChildren: 0.04 } } };
export const itemVariants = { hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: EASE } } };

export function StaggerList({ children, className, as = 'ul', ...rest }: { children: ReactNode; className?: string; as?: 'ul' | 'ol' | 'div' } & Record<string, unknown>) {
  const reduce = useReducedMotion();
  const C = as === 'ol' ? motion.ol : as === 'div' ? motion.div : motion.ul;
  return <C className={className} variants={listVariants} initial={reduce ? false : 'hidden'} animate="show" {...rest}>{children}</C>;
}
export function StaggerLi({ children, className, as = 'li', ...rest }: { children: ReactNode; className?: string; as?: 'li' | 'div' } & Record<string, unknown>) {
  const C = as === 'div' ? motion.div : motion.li;
  return <C className={className} variants={itemVariants} {...rest}>{children}</C>;
}

/** Fade/slide in once when scrolled into view. */
export function Rise({ children, className, delay = 0, y = 12 }: { children: ReactNode; className?: string; delay?: number; y?: number }) {
  const reduce = useReducedMotion();
  return (
    <motion.div className={className} initial={reduce ? false : { opacity: 0, y }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: '0px 0px -40px 0px' }}
      transition={{ duration: 0.5, ease: EASE, delay }}>{children}</motion.div>
  );
}

/** Live pulse dot. */
export function PulseDot({ tone = 'success', className, label }: { tone?: 'success' | 'warning' | 'danger' | 'electric' | 'gold' | 'idle'; className?: string; label?: string }) {
  return <span className={cn('ax-pulse', tone !== 'success' && `ax-pulse--${tone}`, className)} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}

/** Three bouncing dots. */
export function TypingDots({ className }: { className?: string }) {
  return <span className={cn('ax-typing inline-flex items-center gap-1', className)} aria-hidden><span /><span /><span /></span>;
}

/** Animated ring (stroke draws in). `value` 0..max; null → empty track. */
export function MotionRing({ value, max = 100, size = 64, stroke = 5, color, track = 'rgb(var(--ink-800))', glow, children, ariaLabel }: {
  value: number | null | undefined; max?: number; size?: number; stroke?: number; color: string; track?: string; glow?: boolean; children?: ReactNode; ariaLabel?: string;
}) {
  const reduce = useReducedMotion();
  const r = size / 2 - stroke / 2 - 1; const c = 2 * Math.PI * r;
  const pct = value == null ? 0 : Math.max(0, Math.min(1, value / max));
  return (
    <div className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }} role={ariaLabel ? 'img' : undefined} aria-label={ariaLabel}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} stroke={track} strokeWidth={stroke} fill="none" />
        {value != null && (
          <motion.circle cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth={stroke} fill="none" strokeLinecap="round" strokeDasharray={c}
            initial={reduce ? false : { strokeDashoffset: c }} animate={{ strokeDashoffset: c - pct * c }} transition={{ duration: 1.2, ease: EASE, delay: 0.1 }}
            style={glow ? { filter: `drop-shadow(0 0 ${Math.max(3, stroke)}px ${color})` } : undefined} />
        )}
      </svg>
      <span className="absolute inset-0 flex items-center justify-center">{children}</span>
    </div>
  );
}

/**
 * One-shot celebratory particle burst (canvas). Renders nothing when reduced motion is preferred.
 * Mount it only when a real positive outcome happened.
 */
export function Celebrate({ fire, className }: { fire: boolean; className?: string }) {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!fire || reduce) return;
    const cv = ref.current; if (!cv) return;
    const ctx = cv.getContext('2d'); if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = cv.clientWidth, h = cv.clientHeight;
    cv.width = w * dpr; cv.height = h * dpr; ctx.scale(dpr, dpr);
    const colors = ['240,214,150', '214,175,85', '72,148,255', '139,108,255', '52,199,133'];
    const ps = Array.from({ length: 90 }, () => ({
      x: w / 2, y: h * 0.35, vx: (Math.random() - 0.5) * 9, vy: -Math.random() * 9 - 3, r: Math.random() * 3 + 1.5,
      rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3, c: colors[Math.floor(Math.random() * colors.length)]!, life: 1,
    }));
    let raf = 0; const t0 = performance.now();
    const tick = (t: number) => {
      ctx.clearRect(0, 0, w, h);
      const el = (t - t0) / 1000;
      for (const p of ps) {
        p.vy += 0.22; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.life = Math.max(0, 1 - el / 2.6);
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillStyle = `rgba(${p.c},${p.life})`; ctx.fillRect(-p.r, -p.r / 2, p.r * 2, p.r); ctx.restore();
      }
      if (el < 2.6) raf = requestAnimationFrame(tick); else ctx.clearRect(0, 0, w, h);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [fire, reduce]);
  if (reduce) return null;
  return <canvas ref={ref} aria-hidden className={cn('pointer-events-none absolute inset-0 h-full w-full', className)} />;
}

/** Tracks the previous value of something (e.g. to detect a count increase). */
export function usePrevious<T>(v: T) {
  const r = useRef<T>(v);
  useEffect(() => { r.current = v; }, [v]);
  return r.current;
}
