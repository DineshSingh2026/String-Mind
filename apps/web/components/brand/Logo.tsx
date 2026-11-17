import { useId } from 'react';
import Link from 'next/link';
import { clsx as cn } from 'clsx';
import { HIVE_SPECTRUM, hexPoints, honeycomb } from './hex';

/**
 * Hive Mind mark: seven hive cells cut from one shifting colour gradient. Each cell is an agent with
 * its own colour; together they form the hive. The gradient slowly shifts hue (motion-safe only).
 * Geometry is on a 48×48 grid and is shared with app/icon.svg, the app icons and the OG image.
 */
export const HIVE_CELLS = honeycomb(24, 24, 13.2);
export const HIVE_CELL_R = 6.9;

export function LogoMark({ size = 36, className, animate = false, tone = 'color' }: {
  size?: number; className?: string;
  /** cells pop in one by one on mount (skipped under prefers-reduced-motion) */
  animate?: boolean;
  /** 'mono' renders a flat single-colour mark using currentColor */
  tone?: 'color' | 'mono';
}) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const grad = `hm-grad-${uid}`, glow = `hm-glow-${uid}`;
  const mono = tone === 'mono';
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" className={cn('shrink-0', !mono && 'hm-hue-shift', animate && 'hm-mark-pop', className)} aria-hidden fill="none">
      {!mono && (
        <defs>
          <linearGradient id={grad} x1="4" y1="6" x2="44" y2="42" gradientUnits="userSpaceOnUse">
            {HIVE_SPECTRUM.map((c, i) => <stop key={c} offset={i / (HIVE_SPECTRUM.length - 1)} stopColor={c} />)}
          </linearGradient>
          <filter id={glow} x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="2.2" /></filter>
        </defs>
      )}
      {!mono && <polygon points={hexPoints(24, 24, 10)} fill={`url(#${grad})`} opacity="0.55" filter={`url(#${glow})`} />}
      {HIVE_CELLS.map(([x, y], i) => (
        <polygon key={i} points={hexPoints(x, y, HIVE_CELL_R)} fill={mono ? 'currentColor' : `url(#${grad})`}
          fillOpacity={i === 0 ? 1 : 0.92} className="hm-cell" style={{ animationDelay: `${0.08 + i * 0.07}s` }} />
      ))}
      {!mono && <polygon points={hexPoints(24, 24, 3.2)} fill="white" fillOpacity="0.85" className="hm-cell" style={{ animationDelay: '0.6s' }} />}
    </svg>
  );
}

/** "Hive" + spectrum "Mind" wordmark. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('whitespace-nowrap font-display font-bold tracking-[-0.02em]', className)}>
      <span className="text-fg">Hive</span><span className="text-gold-gradient">Mind</span>
    </span>
  );
}

export function Logo({ href = '/', compact, className }: { href?: string; compact?: boolean; className?: string }) {
  return (
    <Link href={href} className={cn('flex items-center gap-2.5', className)} aria-label="Hive Mind — Agent Intelligence Exchange, home">
      <LogoMark animate />
      <span className="flex flex-col leading-none">
        <Wordmark className="text-[21px] leading-none" />
        {!compact && <span className="mt-[5px] whitespace-nowrap text-[7.6px] font-semibold uppercase leading-none tracking-[0.13em] text-fg-muted">Agent Intelligence Exchange</span>}
      </span>
    </Link>
  );
}
