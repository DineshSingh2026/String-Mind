'use client';
/**
 * Holographic globe — hand-written 2D canvas with 3D projection.
 * Wireframe (lat/long) + dotted shell in electric blue, gold orbit rings with occlusion (back half behind the
 * sphere, front half over it), satellites, and `points` drawn as glowing nodes on the surface. Arcs connect
 * weighted points (decorative "discovery" arcs — they carry no numbers).
 */
import { useMemo, useRef } from 'react';
import { clsx } from 'clsx';
import { RGB, canvasFont, hash01, useCanvasLoop } from './hooks';

export interface GlobePoint { label: string; weight: number }

interface V3 { x: number; y: number; z: number }
const TAU = Math.PI * 2;

function sph(lat: number, lon: number): V3 {
  const c = Math.cos(lat);
  return { x: c * Math.sin(lon), y: -Math.sin(lat), z: c * Math.cos(lon) };
}
/** rotate around Y by a, then tilt around X by b */
function rot(p: V3, a: number, b: number): V3 {
  const ca = Math.cos(a), sa = Math.sin(a);
  const x = p.x * ca + p.z * sa, z1 = -p.x * sa + p.z * ca;
  const cb = Math.cos(b), sb = Math.sin(b);
  return { x, y: p.y * cb - z1 * sb, z: p.y * sb + z1 * cb };
}

/** Even distribution of n points on a sphere (fibonacci), returned as lat/lon. */
function fib(n: number, i: number) {
  const y = 1 - (i + 0.5) / n * 2;
  return { lat: Math.asin(y), lon: i * Math.PI * (3 - Math.sqrt(5)) };
}

const RINGS = [
  { r: 1.32, tilt: 1.18, yaw: 0.35, speed: 0.22, sats: 2, alpha: 0.55 },
  { r: 1.55, tilt: 1.32, yaw: -0.5, speed: -0.14, sats: 1, alpha: 0.38 },
  { r: 1.16, tilt: 0.42, yaw: 1.1, speed: 0.3, sats: 1, alpha: 0.28 },
];

export function HoloGlobe({ className, size, points = [], showLabels = true }: {
  className?: string; size?: number; points?: { label: string; weight: number }[]; showLabels?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const dots = useMemo(() => Array.from({ length: 260 }, (_, i) => fib(260, i)), []);
  const maxW = Math.max(1, ...points.map((p) => p.weight));
  const placed = useMemo(() => points.map((p, i) => {
    // stable position per label (fibonacci slot chosen by index, nudged by label hash)
    const f = fib(Math.max(points.length, 8), i);
    const lat = Math.max(-1.1, Math.min(1.1, f.lat * 0.85 + (hash01(p.label, 3) - 0.5) * 0.25));
    return { ...p, lat, lon: f.lon + hash01(p.label, 7) * 0.6 };
  }), [points]);
  const key = placed.map((p) => `${p.label}:${p.weight}`).join('|');

  useCanvasLoop(ref, ({ ctx, w, h, t }) => {
    const cx = w / 2, cy = h / 2;
    const R = Math.min(w, h) * 0.3;
    const spin = t * 0.12, tilt = -0.32;
    const P = (v: V3) => ({ x: cx + v.x * R, y: cy + v.y * R, z: v.z });

    // ambient glow
    let g = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 2.1);
    g.addColorStop(0, `rgba(${RGB.electric},0.22)`); g.addColorStop(0.45, `rgba(${RGB.violet},0.08)`); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);

    // orbit rings — back halves first
    const ringPts = RINGS.map((rg) => {
      const pts: { x: number; y: number; z: number }[] = [];
      for (let k = 0; k <= 96; k++) {
        const a = (k / 96) * TAU;
        let v: V3 = { x: Math.cos(a) * rg.r, y: 0, z: Math.sin(a) * rg.r };
        v = rot(rot(v, rg.yaw, rg.tilt), spin * 0.25, 0);
        pts.push(P(v));
      }
      return pts;
    });
    const strokeRing = (front: boolean) => {
      RINGS.forEach((rg, i) => {
        const pts = ringPts[i];
        ctx.beginPath();
        let pen = false;
        for (const p of pts) {
          if ((p.z >= 0) === front) { if (!pen) { ctx.moveTo(p.x, p.y); pen = true; } else ctx.lineTo(p.x, p.y); } else pen = false;
        }
        ctx.strokeStyle = `rgba(${RGB.gold},${front ? rg.alpha : rg.alpha * 0.35})`;
        ctx.lineWidth = front ? 1.4 : 1;
        ctx.stroke();
      });
    };
    strokeRing(false);

    // sphere body
    g = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.1, cx, cy, R);
    g.addColorStop(0, 'rgba(30,52,96,0.85)'); g.addColorStop(0.7, 'rgba(12,20,40,0.92)'); g.addColorStop(1, 'rgba(8,12,24,0.96)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.fill();
    // rim light
    g = ctx.createRadialGradient(cx, cy, R * 0.82, cx, cy, R * 1.08);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.75, `rgba(${RGB.electric},0.35)`); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, R * 1.08, 0, TAU); ctx.fill();

    // wireframe
    const back = new Path2D(), front = new Path2D();
    const line = (gen: (k: number) => V3, n: number) => {
      let prev: { x: number; y: number; z: number } | null = null;
      for (let k = 0; k <= n; k++) {
        const p = P(rot(gen(k / n), spin, tilt));
        if (prev) { const path = (p.z + prev.z) / 2 >= 0 ? front : back; path.moveTo(prev.x, prev.y); path.lineTo(p.x, p.y); }
        prev = p;
      }
    };
    for (let la = -60; la <= 60; la += 30) { const lat = (la * Math.PI) / 180; line((u) => sph(lat, u * TAU), 64); }
    for (let lo = 0; lo < 180; lo += 30) { const lon = (lo * Math.PI) / 180; line((u) => sph(-Math.PI / 2 + u * Math.PI * 2, lon), 72); }
    ctx.lineWidth = 0.8;
    ctx.strokeStyle = `rgba(${RGB.electric},0.07)`; ctx.stroke(back);
    ctx.strokeStyle = `rgba(${RGB.electricSoft},0.26)`; ctx.stroke(front);

    // dotted shell (front only)
    for (const d of dots) {
      const p = P(rot(sph(d.lat, d.lon), spin, tilt));
      if (p.z < 0.05) continue;
      ctx.fillStyle = `rgba(${RGB.electricSoft},${(0.1 + p.z * 0.45).toFixed(3)})`;
      ctx.fillRect(p.x - 0.7, p.y - 0.7, 1.4, 1.4);
    }

    // data points + discovery arcs
    const proj = placed.map((pt) => ({ pt, p: P(rot(sph(pt.lat, pt.lon), spin, tilt)) }));
    const lit = proj.filter((q) => q.pt.weight > 0);
    for (let i = 0; i < lit.length; i++) {
      const a = lit[i], b = lit[(i + 1) % lit.length];
      if (lit.length < 2 || a === b) break;
      if (a.p.z < -0.2 && b.p.z < -0.2) continue;
      const mx = (a.p.x + b.p.x) / 2, my = (a.p.y + b.p.y) / 2;
      const dx = mx - cx, dy = my - cy, dl = Math.hypot(dx, dy) || 1;
      const lift = R * 0.45;
      const qx = mx + (dx / dl) * lift, qy = my + (dy / dl) * lift;
      const alpha = 0.12 + 0.25 * Math.max(0, Math.min(1, (a.p.z + b.p.z) / 2 + 0.5));
      ctx.beginPath(); ctx.moveTo(a.p.x, a.p.y); ctx.quadraticCurveTo(qx, qy, b.p.x, b.p.y);
      ctx.strokeStyle = `rgba(${RGB.goldSoft},${alpha.toFixed(3)})`; ctx.lineWidth = 1; ctx.setLineDash([2, 4]); ctx.stroke(); ctx.setLineDash([]);
      // travelling spark
      const u = (t * 0.25 + i * 0.37) % 1, iu = 1 - u;
      const sx = iu * iu * a.p.x + 2 * iu * u * qx + u * u * b.p.x, sy = iu * iu * a.p.y + 2 * iu * u * qy + u * u * b.p.y;
      ctx.fillStyle = `rgba(${RGB.goldSoft},${(alpha * 2.2).toFixed(3)})`; ctx.beginPath(); ctx.arc(sx, sy, 1.6, 0, TAU); ctx.fill();
    }
    ctx.font = canvasFont(500, 10.5);
    for (const { pt, p } of proj.sort((a, b) => a.p.z - b.p.z)) {
      const vis = p.z >= 0 ? 1 : 0.25;
      const on = pt.weight > 0;
      const r = on ? 2.4 + 3.2 * (pt.weight / maxW) : 1.6;
      const col = on ? RGB.gold : RGB.electricSoft;
      const pulse = on ? 0.5 + 0.5 * Math.sin(t * 2.2 + hash01(pt.label) * 6) : 0;
      g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * (4 + pulse * 2));
      g.addColorStop(0, `rgba(${col},${0.55 * vis})`); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, r * (4 + pulse * 2), 0, TAU); ctx.fill();
      ctx.fillStyle = `rgba(${on ? RGB.goldSoft : RGB.electricSoft},${(on ? 1 : 0.5) * vis})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, r * 0.6, 0, TAU); ctx.fill();
      if (showLabels && on && p.z > 0.25 && R > 90) {
        ctx.fillStyle = `rgba(${RGB.fg},${Math.min(0.85, (p.z - 0.25) * 2).toFixed(3)})`;
        // flip to the left of the point when the label would run past the canvas edge
        const tw = ctx.measureText(pt.label).width;
        if (p.x + r + 5 + tw > w - 6) { ctx.textAlign = 'right'; ctx.fillText(pt.label, p.x - r - 5, p.y + 3.5); ctx.textAlign = 'left'; }
        else ctx.fillText(pt.label, p.x + r + 5, p.y + 3.5);
      }
    }

    strokeRing(true);
    // satellites on rings
    RINGS.forEach((rg, i) => {
      for (let s = 0; s < rg.sats; s++) {
        const a = t * rg.speed + (s / rg.sats) * TAU + i;
        let v: V3 = { x: Math.cos(a) * rg.r, y: 0, z: Math.sin(a) * rg.r };
        v = rot(rot(v, rg.yaw, rg.tilt), spin * 0.25, 0);
        const p = P(v);
        const behind = p.z < 0 && Math.hypot(p.x - cx, p.y - cy) < R;
        if (behind) continue;
        g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 10);
        g.addColorStop(0, `rgba(${RGB.goldSoft},0.9)`); g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, 10, 0, TAU); ctx.fill();
        ctx.fillStyle = '#fff6dc'; ctx.beginPath(); ctx.arc(p.x, p.y, 1.8, 0, TAU); ctx.fill();
      }
    });
  }, [key, showLabels]);

  return (
    <canvas
      ref={ref}
      aria-hidden
      className={clsx('block', !size && 'h-full w-full', className)}
      style={size ? { width: size, height: size } : undefined}
    />
  );
}
