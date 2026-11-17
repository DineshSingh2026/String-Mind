'use client';
/** Animated verified-score ring. `null` → "—" (never invents a score). Draws in when scrolled into view. */
import { useId } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

export function scoreVar(s: number | null | undefined) {
  if (typeof s !== 'number') return '--ink-600';
  return s >= 85 ? '--success' : s >= 65 ? '--gold' : s >= 40 ? '--warning' : '--danger';
}
export function scoreColor(s: number | null | undefined, alpha = 1) {
  return `rgb(var(${scoreVar(s)}) / ${alpha})`;
}

export function ScoreRingFx({ score, size = 64, stroke = 5, label = 'Verified score', showLabel = false, className }: {
  score: number | null | undefined; size?: number; stroke?: number; label?: string; showLabel?: boolean; className?: string;
}) {
  const reduce = useReducedMotion();
  const gid = useId().replace(/:/g, '');
  const has = typeof score === 'number';
  const pct = has ? Math.max(0, Math.min(100, score as number)) : 0;
  const r = size / 2 - stroke - 1;
  const c = 2 * Math.PI * r;
  const col = scoreColor(has ? pct : null);
  return (
    <div className={className} style={{ width: size, height: size, position: 'relative' }} role="img"
      aria-label={has ? `${label} ${pct.toFixed(1)} out of 100` : `${label}: not assessed`}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <defs>
          <linearGradient id={`g${gid}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={col} stopOpacity="1" />
            <stop offset="100%" stopColor={col} stopOpacity="0.55" />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} stroke="rgb(var(--ink-800))" strokeWidth={stroke} fill="none" />
        {has && (
          <motion.circle cx={size / 2} cy={size / 2} r={r} stroke={`url(#g${gid})`} strokeWidth={stroke} fill="none" strokeLinecap="round"
            strokeDasharray={c}
            initial={reduce ? false : { strokeDashoffset: c }}
            whileInView={{ strokeDashoffset: c - (pct / 100) * c }}
            viewport={{ once: true, margin: '-40px' }}
            transition={{ duration: 1.2, ease: [0.2, 0.7, 0.2, 1] }}
            style={{ filter: `drop-shadow(0 0 6px ${scoreColor(pct, 0.55)})`, strokeDashoffset: reduce ? c - (pct / 100) * c : undefined }} />
        )}
      </svg>
      <span className="absolute inset-0 flex flex-col items-center justify-center leading-none">
        <span className="font-display font-semibold tabular-nums text-fg" style={{ fontSize: Math.max(11, size * 0.26) }}>{has ? (pct % 1 === 0 ? pct : pct.toFixed(1)) : '—'}</span>
        {showLabel && <span className="mt-1 text-[9px] uppercase tracking-wider text-fg-subtle">{has ? 'verified' : 'not assessed'}</span>}
      </span>
    </div>
  );
}
