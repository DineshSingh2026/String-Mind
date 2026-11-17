'use client';
/** Pointer-reactive surfaces: spotlight cards, 3D tilt and magnetic buttons. All inert on touch / reduced motion. */
import './fx.css';
import { motion, useMotionTemplate, useMotionValue, useSpring, useTransform } from 'framer-motion';
import { useRef, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { usePrefersReducedMotion } from './hooks';
import type { GlowTone } from './types';

const GLOW: Record<GlowTone, string> = {
  gold: 'var(--gold)',
  electric: 'var(--electric)',
  violet: 'var(--violet)',
};

/* ───────────── SpotlightCard ───────────── */
export function SpotlightCard({ children, className, glow = 'gold' }: { children: ReactNode; className?: string; glow?: GlowTone }) {
  const ref = useRef<HTMLDivElement>(null);
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const el = ref.current; if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--fx-mx', `${e.clientX - r.left}px`);
    el.style.setProperty('--fx-my', `${e.clientY - r.top}px`);
  };
  const c = GLOW[glow];
  return (
    <div
      ref={ref}
      onPointerMove={onMove}
      className={clsx('fx-spot group/spot relative isolate overflow-hidden rounded-2xl border border-line/70 bg-ink-900/80 shadow-card', className)}
      style={{ '--fx-glow': `rgb(${c} / 0.9)`, '--fx-mx': '50%', '--fx-my': '-20%' } as CSSProperties}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 opacity-0 transition-opacity duration-500 group-hover/spot:opacity-100"
        style={{ background: `radial-gradient(420px circle at var(--fx-mx) var(--fx-my), rgb(${c} / 0.13), transparent 60%)` }}
      />
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-px bg-gradient-to-r from-transparent via-white/15 to-transparent" />
      <span aria-hidden className="fx-border-spin" />
      {children}
    </div>
  );
}

/* ───────────── TiltCard ───────────── */
export function TiltCard({ children, className, max = 8 }: { children: ReactNode; className?: string; max?: number }) {
  const reduced = usePrefersReducedMotion();
  const px = useMotionValue(0.5), py = useMotionValue(0.5);
  const sx = useSpring(px, { stiffness: 180, damping: 18 }), sy = useSpring(py, { stiffness: 180, damping: 18 });
  const rotateY = useTransform(sx, [0, 1], [-max, max]);
  const rotateX = useTransform(sy, [0, 1], [max, -max]);
  const glareX = useTransform(sx, [0, 1], ['0%', '100%']);
  const glareY = useTransform(sy, [0, 1], ['0%', '100%']);
  const glare = useMotionTemplate`radial-gradient(300px circle at ${glareX} ${glareY}, rgb(255 255 255 / 0.08), transparent 60%)`;

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (reduced || e.pointerType !== 'mouse') return;
    const r = e.currentTarget.getBoundingClientRect();
    px.set((e.clientX - r.left) / r.width); py.set((e.clientY - r.top) / r.height);
  };
  const reset = () => { px.set(0.5); py.set(0.5); };
  return (
    <div style={{ perspective: 900 }} className={clsx('h-full', className)}>
      <motion.div
        onPointerMove={onMove} onPointerLeave={reset}
        style={reduced ? undefined : { rotateX, rotateY, transformStyle: 'preserve-3d' }}
        className="relative h-full will-change-transform"
      >
        {children}
        {!reduced && <motion.div aria-hidden className="pointer-events-none absolute inset-0 rounded-[inherit]" style={{ background: glare }} />}
      </motion.div>
    </div>
  );
}

/* ───────────── MagneticButton ───────────── */
/** Wraps a single interactive child (Link/button); the wrapper drifts toward the cursor. */
export function MagneticButton({ children, strength = 0.3, className }: { children: ReactNode; strength?: number; className?: string }) {
  const reduced = usePrefersReducedMotion();
  const x = useMotionValue(0), y = useMotionValue(0);
  const sx = useSpring(x, { stiffness: 220, damping: 15, mass: 0.4 }), sy = useSpring(y, { stiffness: 220, damping: 15, mass: 0.4 });
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (reduced || e.pointerType !== 'mouse') return;
    const r = e.currentTarget.getBoundingClientRect();
    x.set((e.clientX - (r.left + r.width / 2)) * strength);
    y.set((e.clientY - (r.top + r.height / 2)) * strength);
  };
  const reset = () => { x.set(0); y.set(0); };
  return (
    <motion.div onPointerMove={onMove} onPointerLeave={reset} style={{ x: sx, y: sy }} className={clsx('inline-flex', className)}>
      {children}
    </motion.div>
  );
}
