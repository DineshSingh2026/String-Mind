'use client';
/**
 * The benchmark domains as a star map. Star size/brightness ∝ verifiedAgents (0 → dim), pulsing rings for
 * completedSessions, gold for high-impact domains. Keyboard/touch accessible: every star is a real <button>
 * positioned over the canvas, focus/hover shows a tooltip with the real numbers.
 */
import { useMemo, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { RGB, canvasFont, hash01, useCanvasLoop } from './hooks';
import type { ConstellationDomain } from './types';

const TAU = Math.PI * 2;

/** normalised (0..1) positions — a loose grid with deterministic jitter, re-flowed for narrow boxes */
function layout(domains: ConstellationDomain[], narrow: boolean) {
  const cols = narrow ? 4 : 5;
  const rows = Math.ceil(domains.length / cols);
  return domains.map((d, i) => {
    const c = i % cols, r = Math.floor(i / cols);
    const jx = (hash01(d.slug, 1) - 0.5) * 0.55, jy = (hash01(d.slug, 2) - 0.5) * 0.5;
    const stagger = r % 2 ? 0.25 : -0.1;
    return {
      x: 0.08 + ((c + 0.5 + jx * 0.6 + stagger) / cols) * 0.84,
      y: 0.1 + ((r + 0.5 + jy * 0.6) / rows) * 0.8,
    };
  });
}

export function DomainConstellation({ domains, className }: { domains: ConstellationDomain[]; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  const activeRef = useRef<number | null>(null);
  activeRef.current = active;

  const pos = useMemo(() => layout(domains, narrow), [domains, narrow]);
  const maxAgents = Math.max(1, ...domains.map((d) => d.verifiedAgents));
  const maxSessions = Math.max(1, ...domains.map((d) => d.completedSessions));
  // constellation lines: each star to its nearest neighbour + next in sequence (purely decorative)
  const edges = useMemo(() => {
    const e = new Set<string>();
    pos.forEach((p, i) => {
      let best = -1, bd = 9;
      pos.forEach((q, j) => { if (j !== i) { const d = Math.hypot(p.x - q.x, p.y - q.y); if (d < bd) { bd = d; best = j; } } });
      if (best >= 0) e.add([Math.min(i, best), Math.max(i, best)].join('-'));
    });
    return [...e].map((s) => s.split('-').map(Number) as [number, number]);
  }, [pos]);
  const key = domains.map((d) => `${d.slug}:${d.verifiedAgents}:${d.completedSessions}`).join('|') + narrow;

  useCanvasLoop(ref, ({ ctx, w, h, t, reduced }) => {
    const isNarrow = w < 640;
    if (isNarrow !== narrow) queueMicrotask(() => setNarrow(isNarrow));
    const P = (i: number) => ({ x: pos[i].x * w, y: pos[i].y * h });

    // background star dust
    for (let i = 0; i < 90; i++) {
      const x = hash01(`d${i}`, 1) * w, y = hash01(`d${i}`, 2) * h;
      const a = 0.08 + 0.18 * (0.5 + 0.5 * Math.sin(t * 0.8 + i));
      ctx.fillStyle = `rgba(${RGB.fg},${a.toFixed(3)})`; ctx.fillRect(x, y, 1, 1);
    }
    // edges
    for (const [a, b] of edges) {
      const p = P(a), q = P(b);
      const lit = domains[a].verifiedAgents > 0 && domains[b].verifiedAgents > 0;
      ctx.strokeStyle = lit ? `rgba(${RGB.gold},0.35)` : `rgba(${RGB.electric},0.12)`;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
    }
    // stars
    ctx.textAlign = 'center';
    domains.forEach((d, i) => {
      const { x, y } = P(i);
      const lit = d.verifiedAgents > 0;
      const k = d.verifiedAgents / maxAgents;
      const col = lit ? (d.highImpact ? RGB.gold : RGB.goldSoft) : RGB.electricSoft;
      const tw = reduced ? 0.6 : 0.5 + 0.5 * Math.sin(t * 1.5 + i * 1.7);
      const r = lit ? 3.2 + k * 4 : 1.8;
      const hov = activeRef.current === i;
      // sessions → expanding rings
      if (d.completedSessions > 0) {
        const n = 1 + Math.round((d.completedSessions / maxSessions) * 2);
        for (let q = 0; q < n; q++) {
          const u = reduced ? (q + 1) / (n + 1) : ((t * 0.35 + q / n) % 1);
          ctx.strokeStyle = `rgba(${RGB.success},${(0.5 * (1 - u)).toFixed(3)})`;
          ctx.beginPath(); ctx.arc(x, y, r + 4 + u * 22, 0, TAU); ctx.stroke();
        }
      }
      const glowR = r * (lit ? 5 + tw * 2 : 3) * (hov ? 1.4 : 1);
      const g = ctx.createRadialGradient(x, y, 0, x, y, glowR);
      g.addColorStop(0, `rgba(${col},${lit ? 0.5 : 0.18})`); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, glowR, 0, TAU); ctx.fill();
      // 4-point sparkle for lit stars
      if (lit) {
        ctx.strokeStyle = `rgba(${RGB.goldSoft},${(0.35 + tw * 0.4).toFixed(3)})`; ctx.lineWidth = 1;
        const s = r * (2.6 + tw);
        ctx.beginPath(); ctx.moveTo(x - s, y); ctx.lineTo(x + s, y); ctx.moveTo(x, y - s); ctx.lineTo(x, y + s); ctx.stroke();
      }
      ctx.fillStyle = lit ? '#fffaf0' : `rgba(${RGB.electricSoft},${hov ? 0.9 : 0.55})`;
      ctx.beginPath(); ctx.arc(x, y, lit ? r * 0.55 : r, 0, TAU); ctx.fill();
      if (lit || hov || w > 700) {
        ctx.font = canvasFont(lit ? 600 : 500, isNarrow ? 9.5 : 11);
        ctx.fillStyle = lit ? `rgba(${RGB.goldSoft},0.95)` : `rgba(${RGB.muted},${hov ? 0.95 : 0.55})`;
        const label = d.name.split(/\s*(?:&|,)\s*/)[0];
        ctx.fillText(label, x, y + r + (lit ? 18 : 15));
      }
    });
    ctx.textAlign = 'start';
  }, [key, edges]);

  const a = active != null ? domains[active] : null;
  const ap = active != null ? pos[active] : null;
  return (
    <div ref={box} className={clsx(!/\b(absolute|fixed)\b/.test(className ?? '') && 'relative', className)}>
      <canvas ref={ref} aria-hidden className="absolute inset-0 h-full w-full" />
      <ul className="absolute inset-0" aria-label="Capability domains">
        {domains.map((d, i) => (
          <li key={d.slug} className="absolute" style={{ left: `${pos[i].x * 100}%`, top: `${pos[i].y * 100}%` }}>
            <button
              type="button"
              className="absolute -left-4 -top-4 h-8 w-8 rounded-full focus-visible:ring-2 focus-visible:ring-gold"
              aria-label={`${d.name}: ${d.verifiedAgents} verified agent${d.verifiedAgents === 1 ? '' : 's'}${d.bestScore != null ? `, best score ${d.bestScore.toFixed(1)}` : ''}, ${d.completedSessions} completed training session${d.completedSessions === 1 ? '' : 's'}`}
              onPointerEnter={() => setActive(i)} onPointerLeave={() => setActive((v) => (v === i ? null : v))}
              onFocus={() => setActive(i)} onBlur={() => setActive((v) => (v === i ? null : v))}
              onClick={() => setActive((v) => (v === i ? null : i))}
            />
          </li>
        ))}
      </ul>
      {a && ap && (
        <div
          role="status"
          className={clsx(
            'pointer-events-none absolute z-10 w-[230px] rounded-xl border border-line/80 bg-ink-900/95 p-3 text-xs shadow-2xl backdrop-blur',
            ap.y > 0.5 ? '-translate-y-[calc(100%+22px)]' : 'translate-y-[22px]',
            ap.x > 0.7 ? '-translate-x-[90%]' : ap.x < 0.3 ? '-translate-x-[10%]' : '-translate-x-1/2',
          )}
          style={{ left: `${ap.x * 100}%`, top: `${ap.y * 100}%` }}
        >
          <p className="font-semibold text-fg">{a.name}</p>
          {a.highImpact && <p className="mt-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-warning">High-impact domain</p>}
          <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5">
            <dt className="text-fg-subtle">Verified agents</dt><dd className="text-right font-semibold tabular-nums text-fg">{a.verifiedAgents}</dd>
            <dt className="text-fg-subtle">Best score</dt><dd className="text-right font-semibold tabular-nums text-gold">{a.bestScore != null ? a.bestScore.toFixed(1) : '—'}</dd>
            <dt className="text-fg-subtle">Sessions</dt><dd className="text-right font-semibold tabular-nums text-fg">{a.completedSessions}</dd>
            <dt className="text-fg-subtle">Avg. improvement</dt><dd className="text-right font-semibold tabular-nums text-success">{a.avgImprovement != null ? `${a.avgImprovement > 0 ? '+' : ''}${a.avgImprovement.toFixed(1)}` : '—'}</dd>
          </dl>
        </div>
      )}
    </div>
  );
}
