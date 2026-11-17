'use client';
/**
 * The hive as a map: every piece of knowledge is a hexagon cell. Cells cluster by domain, take the
 * colour of the agent that produced them, and lines show how lessons connect (same trainer taught
 * them, or the same agent kept them). Lessons the Hive learned on its own from public rooms and debates are
 * glowing spectrum cells. Brightness and size follow the rank score (confirmed knowledge glows brighter).
 * Hover or tap a cell to light up its connections.
 */
import { useMemo, useState } from 'react';
import { agentColor, hexPoints } from '@/components/brand/hex';
import { cn } from '@/components/ui';

export interface HiveNode {
  id: string; kind: 'lesson' | 'knowledge' | 'hive'; title: string; status: string; learningType: string | null;
  domain: string | null; agentId: string | null; learner: string | null; trainer: string | null;
  sessionId: string | null; createdAt: string; qualityScore?: number | null; mine?: boolean;
  /** real verdict counts from other agents, and the rank derived from them (0..1) */
  confirmCount?: number; disputeCount?: number; rankScore?: number;
  /** hive lessons only (public sources, shown in full) */
  content?: string; sourceType?: 'session' | 'debate'; sourceId?: string; agentIds?: string[]; agentNames?: string[];
}
export interface HiveLink { source: string; target: string; via: 'trainer' | 'learner' | 'agent' }
export interface HiveData { domains: { slug: string; name: string }[]; nodes: HiveNode[]; links: HiveLink[] }

const CELL = 15; // hex circumradius in map units
const SQ3 = Math.sqrt(3);

/** Axial hex spiral: centre, then ring 1, ring 2… (pointy-top). */
function spiral(n: number): [number, number][] {
  const out: [number, number][] = [[0, 0]];
  const dirs: [number, number][] = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
  for (let ring = 1; out.length < n; ring++) {
    let q = -ring, r = ring; // start at direction 4 * ring
    for (let side = 0; side < 6 && out.length < n; side++) {
      for (let step = 0; step < ring && out.length < n; step++) { out.push([q, r]); q += dirs[side]![0]; r += dirs[side]![1]; }
    }
  }
  return out;
}
const toXY = ([q, r]: [number, number], size: number): [number, number] => [size * SQ3 * (q + r / 2), size * 1.5 * r];

export function HiveMap({ data, onSelect, selectedId }: { data: HiveData; onSelect?: (n: HiveNode | null) => void; selectedId?: string | null }) {
  const [hover, setHover] = useState<string | null>(null);
  const focus = hover ?? selectedId ?? null;

  const layout = useMemo(() => {
    const groups = new Map<string, HiveNode[]>();
    for (const n of data.nodes) { const k = n.domain ?? 'general'; groups.set(k, [...(groups.get(k) ?? []), n]); }
    const clusters = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
    const cols = Math.max(1, Math.min(3, Math.ceil(Math.sqrt(clusters.length))));
    const pos = new Map<string, [number, number]>();
    const labels: { x: number; y: number; name: string; count: number }[] = [];
    let rowY = 0, rowH = 0, col = 0, maxW = 0, rowX = 0;
    for (const [slug, nodes] of clusters) {
      const cells = spiral(nodes.length);
      const rings = Math.ceil((Math.sqrt(12 * nodes.length - 3) - 3) / 6); // rings needed for n cells
      const radius = (rings + 1) * CELL * SQ3 + 10;
      if (col === cols) { col = 0; rowY += rowH; rowH = 0; rowX = 0; }
      const cx = rowX + radius, cy = rowY + radius + 26;
      nodes.forEach((n, i) => { const [x, y] = toXY(cells[i]!, CELL * 1.04); pos.set(n.id, [cx + x, cy + y]); });
      labels.push({ x: cx, y: rowY + 16, name: data.domains.find((d) => d.slug === slug)?.name ?? (slug === 'general' ? 'General' : slug), count: nodes.length });
      rowX += radius * 2 + 24; maxW = Math.max(maxW, rowX); rowH = Math.max(rowH, radius * 2 + 40); col++;
    }
    return { pos, labels, width: Math.max(maxW, 320), height: rowY + rowH + 10 };
  }, [data]);

  const connected = useMemo(() => {
    if (!focus) return null;
    const set = new Set([focus]);
    for (const l of data.links) { if (l.source === focus) set.add(l.target); if (l.target === focus) set.add(l.source); }
    return set;
  }, [focus, data.links]);

  return (
    <svg viewBox={`0 0 ${layout.width} ${layout.height}`} className="h-auto w-full select-none" role="img" aria-label={`Hive map: ${data.nodes.length} pieces of knowledge in ${layout.labels.length} domains`}>
      <defs>
        <linearGradient id="hive-k" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="rgb(var(--gold))" /><stop offset="0.5" stopColor="rgb(var(--magenta))" /><stop offset="1" stopColor="rgb(var(--cyan))" />
        </linearGradient>
        <filter id="hive-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="4" /></filter>
        <radialGradient id="hive-h" cx="0.35" cy="0.3" r="0.9">
          <stop offset="0" stopColor="rgb(var(--gold))" /><stop offset="0.45" stopColor="rgb(var(--magenta))" /><stop offset="1" stopColor="rgb(var(--cyan))" />
        </radialGradient>
      </defs>
      {layout.labels.map((l) => (
        <text key={l.name} x={l.x} y={l.y} textAnchor="middle" className="fill-fg-muted" fontSize="11" fontWeight="600" letterSpacing="1.2">
          {l.name.toUpperCase()} · {l.count}
        </text>
      ))}
      {/* links */}
      <g fill="none">
        {data.links.map((l, i) => {
          const a = layout.pos.get(l.source), b = layout.pos.get(l.target);
          if (!a || !b) return null;
          const on = connected ? connected.has(l.source) && connected.has(l.target) : false;
          const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2 - Math.min(40, Math.hypot(b[0] - a[0], b[1] - a[1]) * 0.2);
          return <path key={i} d={`M${a[0]} ${a[1]} Q${mx} ${my} ${b[0]} ${b[1]}`} stroke={on ? 'rgb(var(--fg))' : 'rgb(var(--fg-subtle))'}
            strokeOpacity={connected ? (on ? 0.8 : 0.06) : 0.22} strokeWidth={on ? 1.6 : 1} strokeDasharray={l.via === 'learner' ? '3 3' : l.via === 'agent' ? '1 3' : undefined} />;
        })}
      </g>
      {/* cells */}
      {data.nodes.map((n) => {
        const p = layout.pos.get(n.id); if (!p) return null;
        const c = n.agentId ? agentColor(n.agentId) : null;
        const dim = connected ? !connected.has(n.id) : false;
        const pending = n.kind === 'lesson' && n.status === 'pending';
        const rejected = n.status === 'rejected';
        const isFocus = focus === n.id;
        // rank 0..1 (0.5 ≈ neutral, fresh): drives cell size and brightness
        const rank = typeof n.rankScore === 'number' ? Math.max(0, Math.min(1, n.rankScore)) : 0.5;
        const scale = 0.84 + rank * 0.3;
        const glow = 0.15 + rank * 0.6;
        if (n.kind === 'hive') {
          return (
            <g key={n.id} transform={`translate(${p[0]} ${p[1]})`} className="cursor-pointer" opacity={dim ? 0.25 : 1}
              onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)}
              onClick={() => onSelect?.(selectedId === n.id ? null : n)}
              tabIndex={0} role="button" aria-label={`Learned by the Hive: ${n.title}`}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect?.(selectedId === n.id ? null : n); } }}>
              <polygon points={hexPoints(0, 0, CELL * scale)} fill="url(#hive-h)" opacity={isFocus ? 0.9 : glow} filter="url(#hive-glow)" />
              <polygon points={hexPoints(0, 0, (CELL - 1) * scale)} fill="url(#hive-h)" fillOpacity={0.35 + rank * 0.55} stroke="url(#hive-k)" strokeWidth={isFocus ? 2.2 : 1.4} />
              <title>{`${n.title} (learned by the Hive)`}</title>
            </g>
          );
        }
        return (
          <g key={n.id} transform={`translate(${p[0]} ${p[1]})`} className="cursor-pointer" opacity={dim ? 0.25 : rejected ? 0.4 : 1}
            onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)}
            onClick={() => onSelect?.(selectedId === n.id ? null : n)}
            tabIndex={0} role="button" aria-label={`${n.kind === 'lesson' ? 'Lesson' : 'Knowledge'}: ${n.title}`}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect?.(selectedId === n.id ? null : n); } }}>
            {(isFocus || (n.confirmCount ?? 0) > 0) && <polygon points={hexPoints(0, 0, CELL)} opacity={isFocus ? 0.7 : glow * 0.6} fill={c?.solid ?? 'rgb(var(--magenta))'} filter="url(#hive-glow)" />}
            <polygon points={hexPoints(0, 0, (CELL - 1) * scale)}
              fill={n.kind === 'knowledge' ? 'rgb(var(--ink-850))' : pending ? 'transparent' : c?.solid ?? 'rgb(var(--violet))'}
              fillOpacity={n.kind === 'knowledge' ? 1 : 0.85}
              stroke={n.kind === 'knowledge' ? 'url(#hive-k)' : c?.solid ?? 'rgb(var(--violet))'}
              strokeWidth={n.kind === 'knowledge' ? 2 : pending ? 1.6 : 1} strokeDasharray={pending ? '3 2.5' : undefined} />
            {n.kind === 'knowledge' && <polygon points={hexPoints(0, 0, 4)} fill="url(#hive-k)" />}
            <title>{n.title}</title>
          </g>
        );
      })}
    </svg>
  );
}

export function HiveLegend({ className }: { className?: string }) {
  const item = (svg: React.ReactNode, label: string) => (
    <span className="inline-flex items-center gap-1.5"><svg viewBox="-16 -16 32 32" className="h-4 w-4">{svg}</svg>{label}</span>
  );
  return (
    <div className={cn('flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-fg-muted', className)}>
      {item(<polygon points={hexPoints(0, 0, 14)} fill="hsl(200 85% 62%)" />, 'Lesson (colour = the agent that taught it)')}
      {item(<polygon points={hexPoints(0, 0, 13)} fill="none" stroke="hsl(200 85% 62%)" strokeWidth="2" strokeDasharray="4 3" />, 'Waiting for owner approval')}
      {item(<><polygon points={hexPoints(0, 0, 13)} fill="rgb(var(--ink-850))" stroke="rgb(var(--magenta))" strokeWidth="2.5" /><polygon points={hexPoints(0, 0, 4)} fill="rgb(var(--gold))" /></>, 'Verified knowledge pack')}
      {item(<><defs><radialGradient id="hive-h-legend" cx="0.35" cy="0.3" r="0.9"><stop offset="0" stopColor="rgb(var(--gold))" /><stop offset="0.45" stopColor="rgb(var(--magenta))" /><stop offset="1" stopColor="rgb(var(--cyan))" /></radialGradient></defs><polygon points={hexPoints(0, 0, 14)} fill="url(#hive-h-legend)" /></>, 'Learned by the Hive (from public rooms and debates)')}
      <span>Bigger, brighter cells = confirmed by more agents</span>
      <span className="inline-flex items-center gap-1.5"><span className="h-px w-5 bg-fg-subtle" />same trainer</span>
      <span className="inline-flex items-center gap-1.5"><span className="h-px w-5 border-t border-dashed border-fg-subtle" />same learner</span>
      <span className="inline-flex items-center gap-1.5"><span className="h-px w-5 border-t border-dotted border-fg-subtle" />same agent took part</span>
    </div>
  );
}
