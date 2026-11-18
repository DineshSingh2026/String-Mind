import { useId, type CSSProperties } from 'react';
import { clsx as cn } from 'clsx';
import { agentColor, hashSeed, hexPoints, honeycomb } from './hex';

/**
 * Living agent logo: a hexagon in the agent's own colour with a honeycomb pattern picked from its id, wrapped in a
 * rotating spectrum ring, with a breathing glow and twinkling cells. Every agent gets its own pattern, speed and spin
 * direction (all derived from the seed), so no two agents look or move alike. Same seed → same logo, always.
 * Motion is CSS-only and switched off under prefers-reduced-motion. `still` renders the static logo.
 */
export function HexAvatar({ seed, name, size = 36, className, initials = true, still = false }: {
  /** agent id (preferred) or any stable string */
  seed: string; name?: string; size?: number; className?: string; initials?: boolean; still?: boolean;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const c = agentColor(seed);
  const h = hashSeed(seed);
  const bits = hashSeed(seed + '#cells');
  const cells = honeycomb(24, 24, 9.4).slice(1).filter((_, i) => (bits >> i) & 1);
  const label = (name ?? '').split(/\s+/).filter(Boolean).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  const g = `hx-${uid}`; const ring = `hxr-${uid}`;
  const rich = !still && size >= 26; // tiny avatars (lists, chips) keep the calm static mark
  const style = {
    color: c.solid,
    '--hx-speed': `${9 + (h % 9)}s`,
    '--hx-dir': h & 1 ? 'normal' : 'reverse',
    '--hx-glow': `${2.6 + ((h >> 3) % 20) / 10}s`,
  } as CSSProperties;
  return (
    <svg width={size} height={size} viewBox="-3 -3 54 54" aria-hidden className={cn('shrink-0 overflow-visible', rich && 'hx-live', className)} style={style}>
      <defs>
        <linearGradient id={g} x1="6" y1="4" x2="42" y2="44" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={c.solid} />
          <stop offset="1" stopColor={c.deep} />
        </linearGradient>
        <linearGradient id={ring} x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffb547" /><stop offset="0.25" stopColor="#ff4fa3" /><stop offset="0.5" stopColor="#8b5cf6" />
          <stop offset="0.75" stopColor="#22d3ee" /><stop offset="1" stopColor="#34d399" />
        </linearGradient>
      </defs>
      {rich && (
        <g className="hx-ring">
          <polygon points={hexPoints(24, 24, 26)} fill="none" stroke={`url(#${ring})`} strokeWidth="1.6" strokeLinecap="round" strokeDasharray="10 6 2 6" />
        </g>
      )}
      <g className={rich ? 'hx-core' : undefined}>
        <polygon points={hexPoints(24, 24, 22)} fill={`url(#${g})`} />
        <polygon points={hexPoints(24, 24, 22)} fill="none" stroke="white" strokeOpacity="0.22" strokeWidth="1" />
        {cells.map(([x, y], i) => (
          <polygon key={i} className={rich ? 'hx-cell' : undefined} style={rich ? { animationDelay: `${((h >> (i % 16)) % 23) / 10}s` } : undefined}
            points={hexPoints(x, y, 4.4)} fill="white" fillOpacity={initials && label ? 0.14 : 0.3} />
        ))}
        {rich && <polygon className="hx-sheen" points={hexPoints(24, 24, 22)} fill="white" fillOpacity="0.12" />}
      </g>
      {initials && label && (
        <text x="24" y="24" dy="0.36em" textAnchor="middle" fill="white" fontSize={label.length > 1 ? 14 : 17} fontWeight="700" fontFamily="var(--font-display), system-ui, sans-serif">{label}</text>
      )}
    </svg>
  );
}
