import { useId } from 'react';
import Link from 'next/link';
import { clsx as cn } from 'clsx';

/**
 * StringMind mark: one continuous string drawn as an S that runs through three agent nodes
 * (learn · teach · earn) and leaves through an open ring, the "mind". The two ends sit in the
 * ring's openings and the centre node glows where the knowledge passes through.
 * Geometry is on a 48×48 grid and is shared with app/icon.svg and the IDLE token coin.
 */
export const STRING_S_PATH = 'M38.85 9.15C32 5 15.2 7.2 15.6 16C16 21.8 32 26.2 32.4 32C33 40.8 16 43 9.15 38.85';
export const STRING_NODES = [[38.85, 9.15], [24, 24], [9.15, 38.85]] as const;

/** Open ring arcs (r=21) with 15° gaps where the string ends exit. */
const RING_PATH = 'M42.19 13.5A21 21 0 0 1 13.5 42.19M5.81 34.5A21 21 0 0 1 34.5 5.81';

export function LogoMark({ size = 36, className, animate = false, tone = 'gold' }: {
  size?: number; className?: string;
  /** draw the string in once on mount (skipped under prefers-reduced-motion) */
  animate?: boolean;
  /** 'mono' renders a flat single-colour mark using currentColor */
  tone?: 'gold' | 'mono';
}) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const gold = `sm-gold-${uid}`, node = `sm-node-${uid}`, glow = `sm-glow-${uid}`;
  const mono = tone === 'mono';
  const ink = mono ? 'currentColor' : `url(#${gold})`;
  const dot = mono ? 'currentColor' : `url(#${node})`;
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" className={cn('shrink-0', animate && 'sm-mark-draw', className)} aria-hidden fill="none">
      {!mono && (
        <defs>
          <linearGradient id={gold} x1="8" y1="6" x2="40" y2="42" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="rgb(251 238 198)" />
            <stop offset="0.28" stopColor="rgb(240 214 150)" />
            <stop offset="0.6" stopColor="rgb(214 175 85)" />
            <stop offset="1" stopColor="rgb(166 128 46)" />
          </linearGradient>
          <radialGradient id={node} cx="0.38" cy="0.35" r="0.7">
            <stop offset="0" stopColor="rgb(255 248 226)" />
            <stop offset="0.55" stopColor="rgb(240 214 150)" />
            <stop offset="1" stopColor="rgb(199 154 63)" />
          </radialGradient>
          <filter id={glow} x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.6" /></filter>
        </defs>
      )}
      {!mono && <circle cx="24" cy="24" r="4.6" fill="rgb(240 214 150)" opacity="0.55" filter={`url(#${glow})`} className="sm-mark-node" style={{ animationDelay: "0.43s" }} />}
      <path d={RING_PATH} stroke={ink} strokeOpacity={mono ? 0.5 : 0.45} strokeWidth="1.2" strokeLinecap="round" className="sm-mark-ring" />
      <path d={STRING_S_PATH} stroke={ink} strokeWidth="3.6" strokeLinecap="round" pathLength={1} className="sm-mark-string" />
      {!mono && <path d={STRING_S_PATH} stroke="rgb(255 248 226)" strokeOpacity="0.35" strokeWidth="0.9" strokeLinecap="round" transform="translate(-0.5 -0.6)" pathLength={1} className="sm-mark-string" />}
      {STRING_NODES.map(([cx, cy], i) => (
        <circle key={i} cx={cx} cy={cy} r={i === 1 ? 3.6 : 3.1} fill={dot} className="sm-mark-node" style={{ animationDelay: `${0.15 + i * 0.28}s` }} />
      ))}
    </svg>
  );
}

/** "String" + gold "Mind" wordmark. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('whitespace-nowrap font-display font-bold tracking-[-0.02em]', className)}>
      <span className="text-fg">String</span><span className="text-gold-gradient">Mind</span>
    </span>
  );
}

export function Logo({ href = '/', compact, className }: { href?: string; compact?: boolean; className?: string }) {
  return (
    <Link href={href} className={cn('flex items-center gap-2.5', className)} aria-label="StringMind — Agent Intelligence Exchange, home">
      <LogoMark animate />
      <span className="flex flex-col leading-none">
        <Wordmark className="text-[21px] leading-none" />
        {!compact && <span className="mt-[5px] whitespace-nowrap text-[7.6px] font-semibold uppercase leading-none tracking-[0.13em] text-fg-muted">Agent Intelligence Exchange</span>}
      </span>
    </Link>
  );
}
