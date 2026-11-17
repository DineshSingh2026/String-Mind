'use client';
/** Ambient backgrounds: aurora gradient-mesh, perspective grid with scan line, floating particles. */
import './fx.css';
import { useMemo, useRef } from 'react';
import { clsx } from 'clsx';
import { RGB, useCanvasLoop } from './hooks';

/* ───────────── AuroraBackground ───────────── */
const PALETTES = {
  gold: ['var(--gold)', 'var(--gold-deep)', 'var(--electric)'],
  ai: ['var(--electric)', 'var(--violet)', 'var(--electric-soft)'],
  mixed: ['var(--electric)', 'var(--violet)', 'var(--gold)'],
} as const;
const INTENSITY = { subtle: 0.10, normal: 0.17, vivid: 0.26 } as const;

/** Animated gradient-mesh blobs. Absolutely positioned — parent needs `relative overflow-hidden`. */
export function AuroraBackground({ className, intensity = 'normal', palette = 'mixed' }: {
  className?: string; intensity?: 'subtle' | 'normal' | 'vivid'; palette?: 'gold' | 'ai' | 'mixed';
}) {
  const [a, b, c] = PALETTES[palette];
  const k = INTENSITY[intensity];
  return (
    <div aria-hidden className={clsx('pointer-events-none absolute inset-0 overflow-hidden', className)}>
      <div className="fx-aurora-blob fx-aurora-a" style={{ left: '-10%', top: '-20%', width: '60%', height: '70%', background: `radial-gradient(closest-side, rgb(${a} / ${k * 1.2}), transparent)` }} />
      <div className="fx-aurora-blob fx-aurora-b" style={{ right: '-12%', top: '-5%', width: '58%', height: '80%', background: `radial-gradient(closest-side, rgb(${b} / ${k * 1.1}), transparent)` }} />
      <div className="fx-aurora-blob fx-aurora-c" style={{ left: '25%', bottom: '-35%', width: '55%', height: '70%', background: `radial-gradient(closest-side, rgb(${c} / ${k * 0.8}), transparent)` }} />
      {/* film grain for depth */}
      <div className="absolute inset-0 opacity-[0.035] mix-blend-overlay" style={{ backgroundImage: GRAIN }} />
    </div>
  );
}
const GRAIN = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`;

/* ───────────── GridBackground ───────────── */
/** Flat hairline grid + receding perspective floor with a slow scan line. */
export function GridBackground({ className, fade = true }: { className?: string; fade?: boolean }) {
  return (
    <div aria-hidden className={clsx('pointer-events-none absolute inset-0 overflow-hidden', className)}>
      <div className={clsx('absolute inset-0', fade && 'fx-fade-mask')}>
        <div className="fx-grid-flat opacity-60" />
      </div>
      <div className="absolute inset-x-0 bottom-0 h-[45%] overflow-hidden" style={fade ? { maskImage: 'linear-gradient(to top, #000 0%, transparent 85%)', WebkitMaskImage: 'linear-gradient(to top, #000 0%, transparent 85%)' } : undefined}>
        <div className="fx-grid-plane fx-grid-move" />
      </div>
      <div className="fx-scanline" />
    </div>
  );
}

/* ───────────── ParticleField ───────────── */
interface P { x: number; y: number; z: number; vx: number; vy: number; tw: number }

/** Ambient floating particles (canvas). `density` = particles per 10,000 px² (default 0.6, max ~400 total). */
export function ParticleField({ className, density = 0.6, color = RGB.goldSoft }: { className?: string; density?: number; color?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const parts = useRef<P[]>([]);
  const area = useRef(0);
  // accept "r,g,b", "#rrggbb" or any CSS colour via a cached canvas parse
  const rgb = useMemo(() => toRgb(color), [color]);

  useCanvasLoop(ref, ({ ctx, w, h, dt, t }) => {
    if (Math.abs(area.current - w * h) > 1) {
      area.current = w * h;
      const n = Math.min(400, Math.round((w * h) / 10000 * density));
      parts.current = Array.from({ length: n }, (_, i) => ({
        x: rand(i, 1) * w, y: rand(i, 2) * h, z: 0.3 + rand(i, 3) * 0.7,
        vx: (rand(i, 4) - 0.5) * 6, vy: -4 - rand(i, 5) * 10, tw: rand(i, 6) * 6.28,
      }));
    }
    for (const p of parts.current) {
      p.x += p.vx * dt * p.z; p.y += p.vy * dt * p.z;
      if (p.y < -4) { p.y = h + 4; p.x = Math.random() * w; }
      if (p.x < -4) p.x = w + 4; else if (p.x > w + 4) p.x = -4;
      const a = (0.25 + 0.55 * (0.5 + 0.5 * Math.sin(t * 1.6 + p.tw))) * p.z;
      const r = 0.6 + p.z * 1.4;
      ctx.fillStyle = `rgba(${rgb},${a.toFixed(3)})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 6.283); ctx.fill();
      if (p.z > 0.85) { ctx.fillStyle = `rgba(${rgb},${(a * 0.18).toFixed(3)})`; ctx.beginPath(); ctx.arc(p.x, p.y, r * 4, 0, 6.283); ctx.fill(); }
    }
  }, [density, rgb]);

  return <canvas ref={ref} aria-hidden className={clsx('pointer-events-none absolute inset-0 h-full w-full', className)} />;
}

function rand(i: number, s: number) { const x = Math.sin(i * 127.1 + s * 311.7) * 43758.5453; return x - Math.floor(x); }

function toRgb(c: string): string {
  if (/^\d+\s*,\s*\d+\s*,\s*\d+$/.test(c)) return c;
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(c);
  if (m) return `${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)}`;
  const m2 = /rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(c);
  if (m2) return `${m2[1]},${m2[2]},${m2[3]}`;
  return RGB.goldSoft;
}
