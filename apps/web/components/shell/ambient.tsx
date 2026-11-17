'use client';
/**
 * Shell-level ambient layers shared by the app and admin shells:
 * - <AmbientBackground>: low-opacity aurora + grain (+ optional data-driven particle drift / ops grid)
 * - useSpotlightDelegation(): one passive pointer listener that feeds --mx/--my to the hovered `.ax-spot` card
 */
import { useEffect } from 'react';
import { ParticleField } from '@/components/fx';
import { useReducedMotion } from 'framer-motion';

export function AmbientBackground({ particles, particleColor, ops }: {
  /** 0..1 density; 0/undefined disables the canvas. Callers derive it from real data. */
  particles?: number; particleColor?: string; ops?: boolean;
}) {
  const reduce = useReducedMotion();
  return (
    <div className="ax-bg" aria-hidden>
      <div className="ax-bg__blob ax-bg__blob--gold" />
      <div className="ax-bg__blob ax-bg__blob--blue" />
      <div className="ax-bg__blob ax-bg__blob--violet" />
      {ops && <><div className="ax-ops-grid" /><div className="ax-scan" /></>}
      {!reduce && !!particles && particles > 0 && <ParticleField density={particles} color={particleColor} className="opacity-60" />}
      <div className="ax-noise" />
      <div className="ax-vignette" />
    </div>
  );
}

export function useSpotlightDelegation() {
  useEffect(() => {
    let last: HTMLElement | null = null;
    let raf = 0;
    let ev: PointerEvent | null = null;
    const apply = () => {
      raf = 0;
      if (!ev) return;
      const el = (ev.target as Element | null)?.closest?.('.ax-spot') as HTMLElement | null;
      if (!el) { last = null; return; }
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', `${ev.clientX - r.left}px`);
      el.style.setProperty('--my', `${ev.clientY - r.top}px`);
      last = el;
    };
    const onMove = (e: PointerEvent) => { if (e.pointerType !== 'mouse') return; ev = e; if (!raf) raf = requestAnimationFrame(apply); };
    document.addEventListener('pointermove', onMove, { passive: true });
    return () => { document.removeEventListener('pointermove', onMove); if (raf) cancelAnimationFrame(raf); void last; };
  }, []);
}
