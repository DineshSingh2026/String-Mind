'use client';
/**
 * Data-driven agent network (hand-written canvas + spring/force layout).
 * - one node per real public agent: radius ∝ verified score, gold = trainer, electric/violet = other
 * - domain hubs (only domains that real agents are verified in), labelled with real domain names
 * - pulses travel along real training links (trainer → learner)
 * - with no links: faint "discovery" arcs between same-domain agents and from agents to their hub
 * - empty data: idle orbit rings only (no invented nodes)
 * The whole system drifts slowly around the centre; `orbit` reserves a central disc (e.g. for a HoloGlobe).
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { useRouter } from 'next/navigation';
import { clsx } from 'clsx';
import { RGB, canvasFont, hash01, useCanvasLoop } from './hooks';
import type { NetworkData, NetworkNode } from './types';

const TAU = Math.PI * 2;

interface SimNode { fresh?: boolean; n: NetworkNode; x: number; y: number; vx: number; vy: number; hub: number; r: number; sx: number; sy: number; depth: number }
interface Hub { slug: string; label: string; agents: number; x: number; y: number; depth: number }

const shortName = (name: string) => name.split(/\s*(?:&|,| and )\s*/)[0];

export function AgentNetwork({ data, className, interactive = true, orbit = false, showLabels = true }: {
  data: NetworkData | null; className?: string; interactive?: boolean;
  /** reserve the centre for another visual (e.g. HoloGlobe) and lay agents on a tilted orbit */
  orbit?: boolean;
  showLabels?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const router = useRouter();
  const [hover, setHover] = useState<{ node: NetworkNode; x: number; y: number } | null>(null);
  const hoverId = useRef<string | null>(null);
  const sim = useRef<{ nodes: SimNode[]; hubs: Hub[]; key: string }>({ nodes: [], hubs: [], key: '' });

  const nodes = data?.nodes ?? [];
  const links = data?.links ?? [];
  const nameOf = useMemo(() => new Map((data?.constellation ?? []).map((d) => [d.slug, d.name])), [data]);
  const key = nodes.map((n) => `${n.id}:${n.score}:${n.role}:${n.domains.join(',')}`).join('|') + '#' + links.length;

  // (re)build simulation when the real data changes; keep positions of surviving nodes
  useEffect(() => {
    const prev = new Map(sim.current.nodes.map((s) => [s.n.id, s]));
    const hubSlugs: string[] = [];
    for (const n of nodes) for (const d of n.domains) if (!hubSlugs.includes(d)) hubSlugs.push(d);
    const hubs: Hub[] = hubSlugs.map((slug) => ({
      slug, label: shortName(nameOf.get(slug) ?? slug), agents: nodes.filter((n) => n.domains.includes(slug)).length, x: 0, y: 0, depth: 1,
    }));
    sim.current = {
      key,
      hubs,
      nodes: nodes.map((n, i) => {
        const p = prev.get(n.id);
        const hub = n.domains.length ? hubSlugs.indexOf(n.domains[0]) : -1;
        const r = 4 + ((n.score ?? 40) / 100) * 7;
        return p ? { ...p, n, hub, r } : { fresh: true, n, hub, r, x: (hash01(n.id) - 0.5) * 40, y: (hash01(n.id, 2) - 0.5) * 40, vx: 0, vy: 0, sx: 0, sy: 0, depth: 1 + i * 0 };
      }),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nameOf]);

  const linkIdx = useMemo(() => {
    const idx = new Map(nodes.map((n, i) => [n.id, i]));
    return links.map((l) => ({ a: idx.get(l.source) ?? -1, b: idx.get(l.target) ?? -1, imp: l.improvement })).filter((l) => l.a >= 0 && l.b >= 0);
  }, [nodes, links]);

  useCanvasLoop(ref, ({ ctx, w, h, t, dt, reduced }) => {
    const { nodes: S, hubs } = sim.current;
    const cx = w / 2, cy = h / 2;
    const m = Math.min(w, h);
    // orbit ellipse (tilted ring) or flat ring for hubs
    const rx = orbit ? Math.min(w * 0.47, m * 0.47) : m * 0.36;
    const ry = orbit ? m * 0.36 : m * 0.36;
    const rot = reduced ? 0.6 : t * 0.045;

    // idle orbit rings (always, very faint) — no data implied
    ctx.lineWidth = 1;
    for (let k = 0; k < 2; k++) {
      ctx.beginPath(); ctx.ellipse(cx, cy, rx * (0.92 + k * 0.16), ry * (0.92 + k * 0.16), 0, 0, TAU);
      ctx.strokeStyle = `rgba(${RGB.electric},${S.length ? 0.07 : 0.12})`; ctx.setLineDash([1, 6]); ctx.stroke(); ctx.setLineDash([]);
    }
    if (!S.length) {
      for (let k = 0; k < 3; k++) {
        const a = rot * 3 + (k * TAU) / 3;
        const x = cx + Math.cos(a) * rx, y = cy + Math.sin(a) * ry;
        ctx.fillStyle = `rgba(${RGB.electricSoft},0.4)`; ctx.beginPath(); ctx.arc(x, y, 1.6, 0, TAU); ctx.fill();
      }
      return;
    }

    // hub anchors on the ring
    hubs.forEach((hb, i) => {
      const a = rot + (i / hubs.length) * TAU + 0.3;
      hb.x = cx + Math.cos(a) * rx; hb.y = cy + Math.sin(a) * ry;
      hb.depth = orbit ? 0.75 + 0.25 * (0.5 + 0.5 * Math.sin(a)) : 1; // lower = farther (top of the ellipse)
    });

    // physics (px, px/s): spring toward a slot beside the hub (outward from the centre), pairwise repulsion
    // fixed 60 Hz sub-steps so the layout converges even when the browser drops frames
    const step = 1 / 60;
    const steps = reduced ? 90 : Math.max(1, Math.min(8, Math.round(dt / step)));
    const damp = Math.exp(-9 * step);
    const rank = new Map<number, number>();
    const slot = S.map((s) => { const k = rank.get(s.hub) ?? 0; rank.set(s.hub, k + 1); return k; });
    for (let it = 0; it < steps; it++) {
      for (let i = 0; i < S.length; i++) {
        const s = S[i];
        const hb = hubs[s.hub];
        let tx = 0, ty = 0;
        if (hb) {
          const n = hb.agents, k = slot[i];
          const ux = (hb.x - cx) / rx, uy = (hb.y - cy) / ry; const ul = Math.hypot(ux, uy) || 1;
          const nx = ux / ul, ny = uy / ul; // outward normal
          const spread = (k - (n - 1) / 2) * Math.max(30, s.r * 5);
          tx = hb.x - cx + nx * (orbit ? 6 : 26) - ny * spread;
          ty = hb.y - cy + ny * (orbit ? 6 : 26) + nx * spread;
        }
        // new nodes enter from 60% of the way out (short, calm fly-out instead of a burst from the centre)
        if (s.fresh) { s.fresh = false; s.x = tx * 0.6; s.y = ty * 0.6; }
        let ax = (tx - s.x) * 30, ay = (ty - s.y) * 30;
        for (let j = 0; j < S.length; j++) {
          if (j === i) continue;
          const dx = s.x - S[j].x, dy = s.y - S[j].y; const d2 = dx * dx + dy * dy + 40; const d = Math.sqrt(d2);
          if (d < 90) { const f = 60000 / d2; ax += (dx / d) * f; ay += (dy / d) * f; }
        }
        s.vx = (s.vx + ax * step) * damp; s.vy = (s.vy + ay * step) * damp;
        s.x += s.vx * step; s.y += s.vy * step;
        s.sx = cx + s.x; s.sy = cy + s.y;
        s.depth = orbit ? 0.74 + 0.26 * Math.max(0, Math.min(1, 0.5 + s.y / (ry * 2))) : 1;
      }
    }

    // discovery arcs: agent ↔ hub and between same-domain agents (only when there are no real links)
    const arc = (x1: number, y1: number, x2: number, y2: number, bend: number) => {
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2; const dx = x2 - x1, dy = y2 - y1;
      const qx = mx - dy * bend, qy = my + dx * bend;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.quadraticCurveTo(qx, qy, x2, y2);
      return { qx, qy };
    };
    ctx.lineWidth = 1;
    for (const s of S) {
      const hb = hubs[s.hub]; if (!hb) continue;
      arc(hb.x, hb.y, s.sx, s.sy, 0.18);
      ctx.strokeStyle = `rgba(${RGB.electricSoft},${(0.18 * s.depth).toFixed(3)})`; ctx.stroke();
    }
    if (!linkIdx.length) {
      for (let i = 0; i < S.length; i++) for (let j = i + 1; j < S.length; j++) {
        if (S[i].hub !== S[j].hub) continue;
        arc(S[i].sx, S[i].sy, S[j].sx, S[j].sy, 0.25);
        ctx.strokeStyle = `rgba(${RGB.violetSoft},0.16)`; ctx.setLineDash([2, 5]); ctx.stroke(); ctx.setLineDash([]);
      }
      // neighbouring hubs: very faint dashed ring segments ("discovery" between domains)
      for (let i = 0; i < hubs.length && hubs.length > 1; i++) {
        const a = hubs[i], b = hubs[(i + 1) % hubs.length];
        const { qx, qy } = arc(a.x, a.y, b.x, b.y, -0.12);
        ctx.strokeStyle = `rgba(${RGB.gold},0.10)`; ctx.setLineDash([1, 5]); ctx.stroke(); ctx.setLineDash([]);
        if (!reduced) {
          const u = (t * 0.12 + i / hubs.length) % 1, iu = 1 - u;
          const px = iu * iu * a.x + 2 * iu * u * qx + u * u * b.x, py = iu * iu * a.y + 2 * iu * u * qy + u * u * b.y;
          ctx.fillStyle = `rgba(${RGB.goldSoft},${(0.5 * Math.sin(u * Math.PI)).toFixed(3)})`; ctx.beginPath(); ctx.arc(px, py, 1.5, 0, TAU); ctx.fill();
        }
      }
    }

    // real training links with travelling pulses
    linkIdx.forEach((l, i) => {
      const a = S[l.a], b = S[l.b];
      const { qx, qy } = arc(a.sx, a.sy, b.sx, b.sy, 0.2);
      ctx.strokeStyle = `rgba(${RGB.gold},0.35)`; ctx.lineWidth = 1.2; ctx.stroke(); ctx.lineWidth = 1;
      if (reduced) return;
      for (let k = 0; k < 2; k++) {
        const u = (t * 0.4 + i * 0.21 + k * 0.5) % 1, iu = 1 - u;
        const px = iu * iu * a.sx + 2 * iu * u * qx + u * u * b.sx, py = iu * iu * a.sy + 2 * iu * u * qy + u * u * b.sy;
        const g = ctx.createRadialGradient(px, py, 0, px, py, 7);
        g.addColorStop(0, `rgba(${RGB.goldSoft},0.95)`); g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(px, py, 7, 0, TAU); ctx.fill();
      }
    });

    // hubs
    ctx.textAlign = 'center';
    for (const hb of hubs) {
      const r = 3 + hb.depth * 2;
      ctx.strokeStyle = `rgba(${RGB.electric},${0.5 * hb.depth})`; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(hb.x, hb.y, r + 4, 0, TAU); ctx.stroke();
      ctx.fillStyle = `rgba(${RGB.electricSoft},${0.8 * hb.depth})`; ctx.beginPath(); ctx.arc(hb.x, hb.y, r * 0.55, 0, TAU); ctx.fill();
      // skip the hub caption when an agent sits close to it (its own label already names the domain area)
      const crowded = S.some((s) => Math.hypot(s.sx - hb.x, s.sy - hb.y) < 64);
      if (showLabels && !orbit && m > 260 && !crowded) {
        ctx.font = canvasFont(600, 9.5);
        ctx.fillStyle = `rgba(${RGB.electricSoft},${(0.75 * hb.depth).toFixed(3)})`;
        ctx.fillText(hb.label.toUpperCase(), hb.x, hb.y + (hb.y > cy ? r + 18 : -(r + 10)));
      }
    }

    // agents (far → near)
    const order = [...S].sort((a, b) => a.depth - b.depth);
    for (const s of order) {
      const trainer = s.n.role === 'trainer';
      const col = trainer ? RGB.gold : hash01(s.n.id, 9) > 0.5 ? RGB.violet : RGB.electric;
      const soft = trainer ? RGB.goldSoft : RGB.electricSoft;
      const r = s.r * s.depth;
      const hov = hoverId.current === s.n.id;
      const pulse = reduced ? 0.5 : 0.5 + 0.5 * Math.sin(t * 2 + hash01(s.n.id) * 6);
      let g = ctx.createRadialGradient(s.sx, s.sy, 0, s.sx, s.sy, r * (3.2 + pulse));
      g.addColorStop(0, `rgba(${col},${hov ? 0.6 : 0.38})`); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(s.sx, s.sy, r * (3.2 + pulse), 0, TAU); ctx.fill();
      g = ctx.createRadialGradient(s.sx - r * 0.3, s.sy - r * 0.3, 0, s.sx, s.sy, r);
      g.addColorStop(0, '#ffffff'); g.addColorStop(0.35, `rgb(${soft})`); g.addColorStop(1, `rgb(${col})`);
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(s.sx, s.sy, r, 0, TAU); ctx.fill();
      // score arc ring (verified score as % of circle)
      if (s.n.score != null) {
        ctx.strokeStyle = `rgba(${soft},${0.85 * s.depth})`; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(s.sx, s.sy, r + 3.5, -Math.PI / 2, -Math.PI / 2 + TAU * (s.n.score / 100)); ctx.stroke();
      }
      if (showLabels && m > 260) {
        const below = s.sy >= cy - 4;
        const sub = [s.n.score != null ? s.n.score.toFixed(1) : null, orbit && hubs[s.hub] ? hubs[s.hub].label : null].filter(Boolean).join(' · ');
        ctx.font = canvasFont(hov ? 600 : 500, 11.5);
        const wName = ctx.measureText(s.n.name).width;
        ctx.font = canvasFont(600, 10, 'display');
        const wSub = ctx.measureText(sub).width;
        const half = Math.max(wName, wSub) / 2 + 4;
        const lx = Math.max(half, Math.min(w - half, s.sx));
        // keep both label lines inside the canvas
        const yBelow = s.sy + r + 18, yAbove = s.sy - r - 22;
        // flip to the other side of the node if the preferred side would leave the canvas
        const y1 = below ? (yBelow + 13 > h - 4 ? yAbove : yBelow) : (yAbove < 14 ? yBelow : yAbove);
        ctx.font = canvasFont(hov ? 600 : 500, 11.5);
        ctx.fillStyle = `rgba(${RGB.fg},${(hov ? 1 : 0.9 * s.depth).toFixed(3)})`;
        ctx.fillText(s.n.name, lx, y1);
        if (sub) {
          ctx.font = canvasFont(600, 10, 'display');
          ctx.fillStyle = `rgba(${trainer ? RGB.goldSoft : RGB.electricSoft},${(0.9 * s.depth).toFixed(3)})`;
          ctx.fillText(sub, lx, y1 + 13);
        }
      }
    }
    ctx.textAlign = 'start';
  }, [key, linkIdx, orbit, showLabels]);

  const onMove = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!interactive) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    let best: SimNode | null = null, bd = 22;
    for (const s of sim.current.nodes) { const d = Math.hypot(s.sx - x, s.sy - y); if (d < Math.max(bd, s.r + 6)) { bd = d; best = s; } }
    hoverId.current = best?.n.id ?? null;
    e.currentTarget.style.cursor = best ? 'pointer' : 'default';
    setHover(best ? { node: best.n, x: best.sx, y: best.sy } : null);
  };
  const onLeave = () => { hoverId.current = null; setHover(null); };
  const onClick = () => { if (interactive && hover) router.push(`/marketplace/${hover.node.slug}`); };

  return (
    <div className={clsx(!/\b(absolute|fixed)\b/.test(className ?? '') && 'relative', className)}>
      <canvas
        ref={ref}
        aria-hidden
        className={clsx('absolute inset-0 h-full w-full', !interactive && 'pointer-events-none')}
        onPointerMove={onMove} onPointerLeave={onLeave} onClick={onClick}
      />
      {hover && (
        <div
          role="status"
          className="pointer-events-none absolute z-10 w-max max-w-[220px] -translate-x-1/2 -translate-y-[calc(100%+18px)] rounded-xl border border-line/80 bg-ink-900/95 px-3 py-2 text-xs shadow-2xl backdrop-blur"
          style={{ left: hover.x, top: hover.y }}
        >
          <p className="font-semibold text-fg">{hover.node.name}</p>
          <p className="mt-0.5 text-fg-muted">
            {hover.node.role === 'trainer' ? 'Trainer' : 'Agent'} · {hover.node.domains.map((d) => shortName(nameOf.get(d) ?? d)).join(', ') || 'No verified domain'}
          </p>
          <p className="mt-1 font-display text-sm font-semibold text-gold">
            {hover.node.score != null ? `${hover.node.score.toFixed(1)} verified score` : 'Not yet scored'}
          </p>
        </div>
      )}
      {/* accessible equivalent of the canvas */}
      <ul className="sr-only">
        {nodes.map((n) => (
          <li key={n.id}>
            <a href={`/marketplace/${n.slug}`}>
              {n.name} — {n.role === 'trainer' ? 'trainer' : 'agent'}
              {n.score != null ? `, verified score ${n.score.toFixed(1)}` : ''}
              {n.domains.length ? `, ${n.domains.map((d) => nameOf.get(d) ?? d).join(', ')}` : ''}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
