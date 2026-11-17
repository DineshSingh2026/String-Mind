/** Decorative SVG art per the reference (gold trophy, gold wallet & coins). Purely decorative: aria-hidden. */
import { useId } from 'react';

export function TrophyArt({ size = 180, className }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="0 0 200 200" className={className} aria-hidden>
      <defs>
        <linearGradient id={`g${id}`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="rgb(250 228 168)" /><stop offset=".45" stopColor="rgb(255 181 71)" /><stop offset="1" stopColor="rgb(140 104 34)" /></linearGradient>
        <linearGradient id={`h${id}`} x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="rgb(255 255 255 / .55)" /><stop offset="1" stopColor="rgb(255 255 255 / 0)" /></linearGradient>
        <radialGradient id={`r${id}`} cx=".5" cy=".45" r=".5"><stop offset="0" stopColor="rgb(255 181 71 / .45)" /><stop offset="1" stopColor="rgb(255 181 71 / 0)" /></radialGradient>
      </defs>
      <circle cx="100" cy="92" r="92" fill={`url(#r${id})`} />
      {[[30, 40], [168, 52], [40, 130], [162, 120], [100, 14]].map(([x, y], i) => <path key={i} d={`M${x} ${y - 5}l1.6 3.4 3.4 1.6-3.4 1.6L${x} ${y + 5}l-1.6-3.4-3.4-1.6 3.4-1.6z`} fill="rgb(255 214 150)" opacity=".8" />)}
      <path d="M62 44c-22 0-28 10-26 22 3 18 22 30 36 32" fill="none" stroke={`url(#g${id})`} strokeWidth="8" strokeLinecap="round" />
      <path d="M138 44c22 0 28 10 26 22-3 18-22 30-36 32" fill="none" stroke={`url(#g${id})`} strokeWidth="8" strokeLinecap="round" />
      <path d="M58 34h84v34c0 30-18 50-42 50S58 98 58 68z" fill={`url(#g${id})`} />
      <path d="M68 40h14v30c0 18 6 30 14 36-16-3-28-18-28-36z" fill={`url(#h${id})`} />
      <path d="M100 58l5.3 10.8 11.9 1.7-8.6 8.4 2 11.8L100 85.1l-10.6 5.6 2-11.8-8.6-8.4 11.9-1.7z" fill="rgb(255 244 210 / .9)" />
      <rect x="92" y="116" width="16" height="22" rx="3" fill={`url(#g${id})`} />
      <path d="M74 138h52l6 18H68z" fill={`url(#g${id})`} />
      <rect x="60" y="156" width="80" height="16" rx="4" fill="rgb(140 104 34)" />
      <rect x="60" y="156" width="80" height="5" rx="2.5" fill="rgb(250 228 168 / .5)" />
    </svg>
  );
}

export function WalletArt({ size = 150, className }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg width={size} height={size * 0.8} viewBox="0 0 200 160" className={className} aria-hidden>
      <defs>
        <linearGradient id={`w${id}`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="rgb(255 214 150)" /><stop offset=".5" stopColor="rgb(255 181 71)" /><stop offset="1" stopColor="rgb(120 90 30)" /></linearGradient>
        <radialGradient id={`c${id}`} cx=".35" cy=".35" r=".7"><stop offset="0" stopColor="rgb(255 240 200)" /><stop offset=".6" stopColor="rgb(255 181 71)" /><stop offset="1" stopColor="rgb(150 112 38)" /></radialGradient>
        <radialGradient id={`gl${id}`} cx=".5" cy=".5" r=".5"><stop offset="0" stopColor="rgb(255 181 71 / .35)" /><stop offset="1" stopColor="rgb(255 181 71 / 0)" /></radialGradient>
      </defs>
      <ellipse cx="100" cy="86" rx="96" ry="70" fill={`url(#gl${id})`} />
      <rect x="34" y="40" width="112" height="80" rx="14" fill="rgb(28 38 60)" stroke={`url(#w${id})`} strokeWidth="3" />
      <path d="M44 40l66-22 10 22" fill="none" stroke={`url(#w${id})`} strokeWidth="3" strokeLinejoin="round" />
      <rect x="112" y="66" width="40" height="28" rx="8" fill={`url(#w${id})`} />
      <circle cx="126" cy="80" r="5" fill="rgb(28 38 60)" />
      {[[160, 118, 18], [176, 98, 14], [150, 136, 14]].map(([x, y, r], i) => (
        <g key={i}><circle cx={x} cy={y} r={r} fill={`url(#c${id})`} stroke="rgb(150 112 38)" strokeWidth="1.5" /><circle cx={x} cy={y} r={r! * 0.62} fill="none" stroke="rgb(255 240 200 / .6)" strokeWidth="1.2" /></g>
      ))}
    </svg>
  );
}
