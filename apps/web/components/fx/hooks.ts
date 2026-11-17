'use client';
/** Shared hooks for the FX library: live data, reduced motion, and a battery-friendly canvas loop. */
import { useEffect, useRef, useState, type RefObject } from 'react';
import { useApi } from '@/lib/api';
import type { NetworkData, PublicStatsData } from './types';

/** SWR fetch of GET /public/network (refreshes every 30s). */
export function useNetworkData() {
  const { data, error, isLoading } = useApi<NetworkData>('/public/network', { refreshInterval: 30_000, shouldRetryOnError: false });
  return { data: data ?? null, error, isLoading };
}

/** SWR fetch of GET /public/stats (refreshes every 30s). */
export function usePublicStats() {
  const { data, error, isLoading } = useApi<PublicStatsData>('/public/stats', { refreshInterval: 30_000, shouldRetryOnError: false });
  return { data: data ?? null, error, isLoading };
}

/** `true` when the user prefers reduced motion. SSR-safe (false until mounted). */
export function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduced(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

/** `true` for fine pointers (mouse) — used to skip hover-physics on touch devices. */
export function useFinePointer() {
  const [fine, setFine] = useState(false);
  useEffect(() => { setFine(window.matchMedia('(hover: hover) and (pointer: fine)').matches); }, []);
  return fine;
}

export interface CanvasFrame {
  ctx: CanvasRenderingContext2D;
  /** CSS pixel size */
  w: number;
  h: number;
  /** seconds since start (frozen at a pleasant value under reduced motion) */
  t: number;
  /** seconds since last frame (0 under reduced motion) */
  dt: number;
  reduced: boolean;
}

/**
 * Drives a 2D canvas: DPR-aware sizing (capped at 2), ResizeObserver, and a rAF loop that pauses when the
 * canvas is off-screen or the tab is hidden. Under reduced motion it draws a single static frame
 * (re-drawn on resize / when `deps` change).
 */
export function useCanvasLoop(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  draw: (f: CanvasFrame) => void,
  deps: unknown[] = [],
  opts: { staticTime?: number } = {},
) {
  const drawRef = useRef(draw);
  drawRef.current = draw;
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let w = 0, h = 0, raf = 0, last = 0, t = 0;
    let visible = true, inView = false;
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    const size = () => {
      const r = canvas.getBoundingClientRect();
      w = Math.max(1, r.width); h = Math.max(1, r.height);
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const frame = (now: number) => {
      raf = 0;
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
      last = now; t += dt;
      ctx.clearRect(0, 0, w, h);
      drawRef.current({ ctx, w, h, t, dt, reduced: false });
      schedule();
    };
    const schedule = () => { if (!raf && visible && inView && !reduced) raf = requestAnimationFrame(frame); };
    const drawStatic = () => { ctx.clearRect(0, 0, w, h); drawRef.current({ ctx, w, h, t: opts.staticTime ?? 6, dt: 0, reduced: true }); };
    const stop = () => { if (raf) cancelAnimationFrame(raf); raf = 0; last = 0; };

    size();
    if (reduced) drawStatic();
    const ro = new ResizeObserver(() => {
      size();
      if (reduced) drawStatic();
      else if (!raf) { ctx.clearRect(0, 0, w, h); drawRef.current({ ctx, w, h, t, dt: 0, reduced: false }); }
    });
    ro.observe(canvas);
    const io = new IntersectionObserver(([e]) => { inView = e.isIntersecting; if (inView) schedule(); else stop(); }, { rootMargin: '80px' });
    io.observe(canvas);
    const onVis = () => { visible = document.visibilityState === 'visible'; if (visible) schedule(); else stop(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { stop(); ro.disconnect(); io.disconnect(); document.removeEventListener('visibilitychange', onVis); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced, ...deps]);

  return reduced;
}

/** Brand colours as RGB triplets for canvas drawing (mirrors globals.css). */
export const RGB = {
  gold: '214,175,85',
  goldSoft: '240,214,150',
  electric: '72,148,255',
  electricSoft: '140,190,255',
  violet: '139,108,255',
  violetSoft: '186,168,255',
  success: '52,199,133',
  fg: '236,240,248',
  muted: '160,172,196',
  line: '38,50,76',
} as const;

/** Deterministic 0..1 hash of a string — stable layouts without randomness between renders. */
export function hash01(s: string, salt = 0) {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}

let FAMS: { sans: string; display: string } | null = null;
/** Canvas font string using the page's next/font families (canvas can't resolve CSS variables itself). */
export function canvasFont(weight: number, size: number, kind: 'sans' | 'display' = 'sans') {
  if (!FAMS && typeof document !== 'undefined') {
    const cs = getComputedStyle(document.body);
    const sans = cs.getPropertyValue('--font-sans').trim();
    const display = cs.getPropertyValue('--font-display').trim();
    FAMS = { sans: sans ? `${sans}, system-ui, sans-serif` : 'system-ui, sans-serif', display: display ? `${display}, system-ui, sans-serif` : 'system-ui, sans-serif' };
  }
  return `${weight} ${size}px ${(FAMS ?? { sans: 'system-ui, sans-serif', display: 'system-ui, sans-serif' })[kind]}`;
}
