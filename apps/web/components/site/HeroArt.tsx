/**
 * Original layered SVG hero illustration: a holographic wireframe globe with two gold orbital rings,
 * two stylised AI agents facing each other whose beams meet at the globe's core, and floating particles.
 * Purely decorative (aria-hidden). Motion classes live in site.css and are gated by prefers-reduced-motion.
 */
import type { ReactElement } from 'react';
import { cx } from './primitives';

const CX = 300;
const CY = 262;
const R = 132;

const PARTICLES: [number, number, number, number][] = [
  [62, 70, 1.6, 0], [140, 40, 1.1, 0.6], [228, 92, 1.4, 1.4], [372, 54, 1.2, 0.3], [470, 84, 1.7, 2.1], [548, 150, 1.1, 1.1],
  [36, 160, 1.2, 2.6], [574, 260, 1.5, 0.9], [26, 300, 1.1, 1.8], [512, 420, 1.3, 2.4], [96, 452, 1.5, 0.4], [182, 496, 1.1, 1.6],
  [420, 488, 1.6, 0.8], [300, 24, 1.3, 2.9], [560, 360, 1.0, 1.3], [44, 400, 1.0, 2.2], [250, 452, 1.0, 0.2], [356, 446, 1.2, 1.9],
];

function parallels() {
  const rows: ReactElement[] = [];
  for (let i = -3; i <= 3; i++) {
    const dy = (i * R) / 4;
    const rx = Math.sqrt(R * R - dy * dy);
    rows.push(<ellipse key={`p${i}`} cx={CX} cy={CY + dy} rx={rx} ry={rx * 0.16} />);
  }
  return rows;
}

function meridians() {
  const ratios = [1, 0.82, 0.58, 0.3];
  return ratios.map((k) => <ellipse key={`m${k}`} cx={CX} cy={CY} rx={R * k} ry={R} />).concat(<line key="m0" x1={CX} y1={CY - R} x2={CX} y2={CY + R} />);
}

/** One stylised agent bust, drawn facing right (towards the globe). Mirrored for the second agent. */
function Agent({ tone }: { tone: 'electric' | 'violet' }) {
  const stroke = tone === 'electric' ? 'url(#hx-stroke-blue)' : 'url(#hx-stroke-violet)';
  const visor = tone === 'electric' ? 'rgb(var(--electric-soft))' : 'rgb(var(--violet-soft))';
  return (
    <g>
      {/* torso */}
      <path d="M8 432 C 10 352 36 306 86 300 C 136 306 160 352 164 432 Z" fill="url(#hx-body)" stroke={stroke} strokeWidth="1.4" />
      <path d="M40 432 C 44 378 60 346 86 340 C 112 346 128 378 132 432" fill="none" stroke={stroke} strokeOpacity=".35" strokeWidth="1" />
      <path d="M86 340 L86 432 M62 372 L50 404 M110 372 L122 404" stroke={stroke} strokeOpacity=".28" strokeWidth="1" />
      <circle cx="86" cy="366" r="7" fill="url(#hx-core)" />
      {/* neck */}
      <path d="M72 268 L74 302 L98 302 L100 268" fill="url(#hx-body)" stroke={stroke} strokeWidth="1.2" />
      {/* head */}
      <path d="M50 222 C 50 184 72 164 92 164 C 120 164 134 188 134 220 C 134 252 116 272 92 272 C 68 272 50 256 50 222 Z" fill="url(#hx-head)" stroke={stroke} strokeWidth="1.5" />
      <path d="M58 200 C 74 186 104 184 128 198" fill="none" stroke={stroke} strokeOpacity=".4" strokeWidth="1" />
      {/* visor */}
      <rect x="98" y="208" width="36" height="13" rx="6.5" fill={visor} opacity=".95" filter="url(#hx-glow)" />
      <circle cx="68" cy="226" r="9" fill="none" stroke={stroke} strokeWidth="1.2" />
      <circle cx="68" cy="226" r="3" fill={visor} opacity=".7" />
      {/* arm reaching towards the globe */}
      <path d="M140 330 C 160 316 170 300 184 290" fill="none" stroke="url(#hx-body-stroke)" strokeWidth="13" strokeLinecap="round" />
      <path d="M140 330 C 160 316 170 300 184 290" fill="none" stroke={stroke} strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="190" cy="286" r="6" fill="rgb(var(--gold-soft))" filter="url(#hx-glow)" />
    </g>
  );
}

export function HeroArt({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cx('relative mx-auto aspect-[600/520] w-full select-none', className)}>
      <div className="absolute inset-[12%] rounded-full bg-electric/20 blur-[70px]" />
      <div className="absolute bottom-[8%] left-1/2 h-[18%] w-[60%] -translate-x-1/2 rounded-full bg-gold/15 blur-[50px]" />
      <svg viewBox="0 0 600 520" className="relative h-full w-full overflow-visible" role="presentation">
        <defs>
          <radialGradient id="hx-globe" cx="42%" cy="38%" r="70%">
            <stop offset="0" stopColor="rgb(var(--electric))" stopOpacity=".34" />
            <stop offset=".55" stopColor="rgb(var(--electric))" stopOpacity=".08" />
            <stop offset="1" stopColor="rgb(var(--ink-950))" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="hx-grid" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="rgb(var(--electric-soft))" />
            <stop offset="1" stopColor="rgb(var(--electric))" />
          </linearGradient>
          <linearGradient id="hx-gold" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="rgb(var(--gold-deep))" stopOpacity=".2" />
            <stop offset=".5" stopColor="rgb(var(--gold-soft))" />
            <stop offset="1" stopColor="rgb(var(--gold-deep))" stopOpacity=".2" />
          </linearGradient>
          <linearGradient id="hx-stroke-blue" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="rgb(var(--electric-soft))" stopOpacity=".9" />
            <stop offset="1" stopColor="rgb(var(--electric))" stopOpacity=".35" />
          </linearGradient>
          <linearGradient id="hx-stroke-violet" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="rgb(var(--violet-soft))" stopOpacity=".9" />
            <stop offset="1" stopColor="rgb(var(--violet))" stopOpacity=".35" />
          </linearGradient>
          <linearGradient id="hx-body" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="rgb(var(--ink-700))" stopOpacity=".95" />
            <stop offset="1" stopColor="rgb(var(--ink-950))" stopOpacity=".2" />
          </linearGradient>
          <linearGradient id="hx-body-stroke" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="rgb(var(--ink-700))" />
            <stop offset="1" stopColor="rgb(var(--ink-600))" />
          </linearGradient>
          <radialGradient id="hx-head" cx="60%" cy="35%" r="75%">
            <stop offset="0" stopColor="rgb(var(--ink-600))" />
            <stop offset="1" stopColor="rgb(var(--ink-850))" />
          </radialGradient>
          <radialGradient id="hx-core">
            <stop offset="0" stopColor="rgb(var(--gold-soft))" />
            <stop offset="1" stopColor="rgb(var(--gold))" stopOpacity="0" />
          </radialGradient>
          <filter id="hx-glow" x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur stdDeviation="3" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <filter id="hx-soft" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="1.2" />
          </filter>
          <clipPath id="hx-clip"><circle cx={CX} cy={CY} r={R} /></clipPath>
        </defs>

        {/* back half of orbit ring A (behind globe) */}
        <g transform={`rotate(-16 ${CX} ${CY})`}>
          <ellipse cx={CX} cy={CY} rx="248" ry="62" fill="none" stroke="url(#hx-gold)" strokeOpacity=".35" strokeWidth="1.2" />
        </g>

        {/* globe */}
        <circle cx={CX} cy={CY} r={R + 18} fill="url(#hx-globe)" />
        <circle cx={CX} cy={CY} r={R} fill="rgb(var(--ink-950))" fillOpacity=".55" />
        <g clipPath="url(#hx-clip)" fill="none" stroke="url(#hx-grid)" strokeWidth="0.9">
          <g strokeOpacity=".55">{parallels()}</g>
          <g strokeOpacity=".5">{meridians()}</g>
          {/* continents as dot clusters */}
          <g fill="rgb(var(--electric-soft))" stroke="none" opacity=".55">
            {[[250, 210], [262, 220], [274, 214], [258, 232], [282, 228], [330, 196], [342, 204], [352, 214], [338, 222], [318, 290], [328, 302], [340, 296], [232, 300], [246, 312], [366, 258], [376, 270]].map(([x, y], i) => (
              <circle key={i} cx={x} cy={y} r="1.6" />
            ))}
          </g>
        </g>
        <circle cx={CX} cy={CY} r={R} fill="none" stroke="rgb(var(--electric-soft))" strokeOpacity=".7" strokeWidth="1.4" />
        <circle cx={CX} cy={CY} r={R + 7} fill="none" stroke="rgb(var(--electric))" strokeOpacity=".18" strokeWidth="6" filter="url(#hx-soft)" />

        {/* agents */}
        <g className="aix-float-slow"><g transform="translate(-6 0)"><Agent tone="electric" /></g></g>
        <g className="aix-float"><g transform="translate(606 0) scale(-1 1)"><Agent tone="violet" /></g></g>

        {/* beams from hands meeting at the globe core */}
        <g fill="none" strokeLinecap="round">
          <path d={`M184 286 Q 240 ${CY - 10} ${CX} ${CY}`} stroke="rgb(var(--electric-soft))" strokeOpacity=".85" strokeWidth="1.6" strokeDasharray="4 10" className="aix-beam" />
          <path d={`M416 286 Q 360 ${CY - 10} ${CX} ${CY}`} stroke="rgb(var(--violet-soft))" strokeOpacity=".85" strokeWidth="1.6" strokeDasharray="4 10" className="aix-beam" />
        </g>
        <circle cx={CX} cy={CY} r="22" fill="url(#hx-core)" opacity=".55" />
        <circle cx={CX} cy={CY} r="5" fill="rgb(var(--gold-soft))" filter="url(#hx-glow)" />

        {/* front orbit ring A (lower arc, in front of globe) with travelling light */}
        <g transform={`rotate(-16 ${CX} ${CY})`} fill="none">
          <path d={`M ${CX - 248} ${CY} A 248 62 0 0 0 ${CX + 248} ${CY}`} stroke="url(#hx-gold)" strokeWidth="2" />
          <path d={`M ${CX - 248} ${CY} A 248 62 0 0 0 ${CX + 248} ${CY}`} stroke="rgb(var(--gold-soft))" strokeWidth="2.6" strokeDasharray="22 900" className="aix-orbit-flow-fast" filter="url(#hx-glow)" />
        </g>
        {/* orbit ring B — dashes flow slowly around the orbit (reads as rotation) */}
        <g transform={`rotate(14 ${CX} ${CY})`} fill="none">
          <ellipse cx={CX} cy={CY} rx="198" ry="46" stroke="url(#hx-gold)" strokeOpacity=".75" strokeWidth="1.2" strokeDasharray="2 6" className="aix-orbit-flow" />
          <ellipse cx={CX} cy={CY} rx="198" ry="46" stroke="rgb(var(--gold-soft))" strokeWidth="2.2" strokeDasharray="22 900" className="aix-orbit-flow-fast" filter="url(#hx-glow)" />
        </g>

        {/* particles */}
        <g fill="rgb(var(--electric-soft))">
          {PARTICLES.map(([x, y, r, d], i) => (
            <circle key={i} cx={x} cy={y} r={r} className="aix-twinkle" style={{ animationDelay: `${d}s` }} fill={i % 4 === 0 ? 'rgb(var(--gold-soft))' : undefined} />
          ))}
        </g>
      </svg>
    </div>
  );
}
