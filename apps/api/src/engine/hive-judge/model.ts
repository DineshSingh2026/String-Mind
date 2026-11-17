/**
 * Hive Judge — small learners implemented in plain TypeScript (no dependencies, deterministic).
 *
 *  - standardise: per-feature mean / std
 *  - logistic regression with soft labels (targets in 0..1), L2, full-batch Adam → reproducible (no random init)
 *  - isotonic regression (pool-adjacent-violators) → monotone calibration of a score to a fraction
 *  - kNN regression in standardised feature space (distance-weighted)
 *  - seeded PRNG (mulberry32) for fold assignment
 */

export interface Scaler { mean: number[]; std: number[] }

export function fitScaler(X: number[][]): Scaler {
  const d = X[0]?.length ?? 0;
  const mean = new Array(d).fill(0), std = new Array(d).fill(0);
  for (const x of X) for (let j = 0; j < d; j++) mean[j] += x[j]!;
  for (let j = 0; j < d; j++) mean[j] /= X.length || 1;
  for (const x of X) for (let j = 0; j < d; j++) std[j] += (x[j]! - mean[j]) ** 2;
  for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j] / (X.length || 1)) || 1;
  return { mean, std };
}

export const scale = (s: Scaler, x: number[]) => x.map((v, j) => (v - s.mean[j]!) / s.std[j]!);

const sigmoid = (z: number) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

export interface Logistic { w: number[]; b: number; scaler: Scaler }

/** Fit logistic regression on soft targets y ∈ [0,1] with sample weights. Deterministic (zero init, full batch). */
export function fitLogistic(X: number[][], y: number[], opts: { l2?: number; iters?: number; lr?: number; weights?: number[] } = {}): Logistic {
  const scaler = fitScaler(X);
  const Z = X.map((x) => scale(scaler, x));
  const n = Z.length, d = Z[0]?.length ?? 0;
  const l2 = opts.l2 ?? 0.01, iters = opts.iters ?? 600, lr = opts.lr ?? 0.05;
  const sw = opts.weights ?? new Array(n).fill(1);
  const swSum = sw.reduce((a, b) => a + b, 0) || 1;
  const w = new Array(d).fill(0);
  let b = 0;
  const m = new Array(d + 1).fill(0), v = new Array(d + 1).fill(0);
  const b1 = 0.9, b2 = 0.999, eps = 1e-8;
  for (let it = 1; it <= iters; it++) {
    const g = new Array(d + 1).fill(0);
    for (let i = 0; i < n; i++) {
      const z = Z[i]!;
      let s = b;
      for (let j = 0; j < d; j++) s += w[j] * z[j]!;
      const e = (sigmoid(s) - y[i]!) * sw[i]!;
      for (let j = 0; j < d; j++) g[j] += e * z[j]!;
      g[d] += e;
    }
    for (let j = 0; j < d; j++) g[j] = g[j] / swSum + l2 * w[j];
    g[d] /= swSum;
    for (let j = 0; j <= d; j++) {
      m[j] = b1 * m[j] + (1 - b1) * g[j];
      v[j] = b2 * v[j] + (1 - b2) * g[j] * g[j];
      const step = (lr * (m[j] / (1 - b1 ** it))) / (Math.sqrt(v[j] / (1 - b2 ** it)) + eps);
      if (j < d) w[j] -= step; else b -= step;
    }
  }
  return { w, b, scaler };
}

export function predictLogistic(m: Logistic, x: number[]): number {
  const z = scale(m.scaler, x);
  let s = m.b;
  for (let j = 0; j < z.length; j++) s += m.w[j]! * z[j]!;
  return sigmoid(s);
}

/** Isotonic (non-decreasing) regression via pool-adjacent-violators. Stored as breakpoints for interpolation. */
export interface Isotonic { xs: number[]; ys: number[] }

export function fitIsotonic(x: number[], y: number[], w?: number[]): Isotonic {
  const idx = x.map((_, i) => i).sort((a, b) => x[a]! - x[b]!);
  const blocks: { sx: number; sy: number; sw: number; n: number }[] = [];
  for (const i of idx) {
    const wi = w?.[i] ?? 1;
    blocks.push({ sx: x[i]! * wi, sy: y[i]! * wi, sw: wi, n: 1 });
    while (blocks.length > 1) {
      const a = blocks[blocks.length - 2]!, b = blocks[blocks.length - 1]!;
      if (a.sy / a.sw <= b.sy / b.sw) break;
      blocks.splice(blocks.length - 2, 2, { sx: a.sx + b.sx, sy: a.sy + b.sy, sw: a.sw + b.sw, n: a.n + b.n });
    }
  }
  return { xs: blocks.map((b) => b.sx / b.sw), ys: blocks.map((b) => b.sy / b.sw) };
}

export function predictIsotonic(m: Isotonic, x: number): number {
  const { xs, ys } = m;
  if (!xs.length) return x;
  if (x <= xs[0]!) return ys[0]!;
  if (x >= xs[xs.length - 1]!) return ys[ys.length - 1]!;
  let lo = 0, hi = xs.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid]! <= x) lo = mid; else hi = mid; }
  const t = (x - xs[lo]!) / (xs[hi]! - xs[lo]! || 1);
  return ys[lo]! + t * (ys[hi]! - ys[lo]!);
}

/** kNN regression in standardised space (inverse-distance weighted). */
export interface Knn { k: number; scaler: Scaler; X: number[][]; y: number[] }

export function fitKnn(X: number[][], y: number[], k = 15, maxRows = 2500): Knn {
  const scaler = fitScaler(X);
  let rows = X.map((x, i) => ({ x: scale(scaler, x).map((v) => Math.round(v * 1000) / 1000), y: y[i]! }));
  if (rows.length > maxRows) { const step = rows.length / maxRows; rows = Array.from({ length: maxRows }, (_, i) => rows[Math.floor(i * step)]!); }
  return { k, scaler, X: rows.map((r) => r.x), y: rows.map((r) => Math.round(r.y * 1000) / 1000) };
}

export function predictKnn(m: Knn, x: number[], weights?: number[]): { value: number; meanDist: number } {
  const z = scale(m.scaler, x);
  const best: { d: number; y: number }[] = [];
  for (let i = 0; i < m.X.length; i++) {
    const r = m.X[i]!;
    let d = 0;
    for (let j = 0; j < z.length; j++) { const diff = (z[j]! - r[j]!) * (weights?.[j] ?? 1); d += diff * diff; }
    if (best.length < m.k) { best.push({ d, y: m.y[i]! }); best.sort((a, b) => a.d - b.d); }
    else if (d < best[best.length - 1]!.d) { best[best.length - 1] = { d, y: m.y[i]! }; best.sort((a, b) => a.d - b.d); }
  }
  if (!best.length) return { value: 0.5, meanDist: Infinity };
  let sw = 0, sy = 0, sd = 0;
  for (const b of best) { const dist = Math.sqrt(b.d); const w = 1 / (0.5 + dist); sw += w; sy += w * b.y; sd += dist; }
  return { value: sy / sw, meanDist: sd / best.length };
}

/** Seeded PRNG (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Assign groups to k folds deterministically (seeded shuffle of the sorted group keys). */
export function groupFolds(groups: string[], k: number, seed: number): Map<string, number> {
  const uniq = [...new Set(groups)].sort();
  const r = rng(seed);
  for (let i = uniq.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [uniq[i], uniq[j]] = [uniq[j]!, uniq[i]!]; }
  const out = new Map<string, number>();
  uniq.forEach((g, i) => out.set(g, i % k));
  return out;
}

export const roundArr = (a: number[], d = 5) => a.map((v) => Math.round(v * 10 ** d) / 10 ** d);
