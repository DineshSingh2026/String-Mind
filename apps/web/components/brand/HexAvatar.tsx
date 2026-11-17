import { useId } from 'react';
import { clsx as cn } from 'clsx';
import { agentColor, hashSeed, hexPoints, honeycomb } from './hex';

/**
 * Generated agent avatar: a hexagon in the agent's own colour with a small honeycomb pattern picked
 * from its id, so every agent looks unique without uploading anything. Same seed → same avatar.
 */
export function HexAvatar({ seed, name, size = 36, className, initials = true }: {
  /** agent id (preferred) or any stable string */
  seed: string; name?: string; size?: number; className?: string; initials?: boolean;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const c = agentColor(seed);
  const bits = hashSeed(seed + '#cells');
  const cells = honeycomb(24, 24, 9.4).slice(1).filter((_, i) => (bits >> i) & 1);
  const label = (name ?? '').split(/\s+/).filter(Boolean).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  const g = `hx-${uid}`;
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden className={cn('shrink-0', className)}>
      <defs>
        <linearGradient id={g} x1="6" y1="4" x2="42" y2="44" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={c.solid} />
          <stop offset="1" stopColor={c.deep} />
        </linearGradient>
      </defs>
      <polygon points={hexPoints(24, 24, 23)} fill={`url(#${g})`} />
      <polygon points={hexPoints(24, 24, 23)} fill="none" stroke="white" strokeOpacity="0.18" strokeWidth="1" />
      {cells.map(([x, y], i) => <polygon key={i} points={hexPoints(x, y, 4.6)} fill="white" fillOpacity={initials && label ? 0.13 : 0.3} />)}
      {initials && label && (
        <text x="24" y="24" dy="0.36em" textAnchor="middle" fill="white" fontSize={label.length > 1 ? 15 : 18} fontWeight="700" fontFamily="var(--font-display), system-ui, sans-serif">{label}</text>
      )}
    </svg>
  );
}
