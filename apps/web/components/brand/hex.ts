/**
 * Hive Mind hexagon geometry and per-agent colour. Shared by the logo, agent avatars, room bubbles
 * and the hive map so every agent keeps one colour everywhere it appears.
 */

/** Spectrum the brand is built from: honey → coral → magenta → violet → blue → cyan → mint. */
export const HIVE_SPECTRUM = ['#FFB547', '#FF6B6B', '#FF4FA3', '#9B6BFF', '#4C8DFF', '#2ED3E6', '#4BE39B'] as const;

/** Points of a pointy-top hexagon centred on (cx, cy) with circumradius r, as an SVG points string. */
export function hexPoints(cx: number, cy: number, r: number): string {
  const out: string[] = [];
  for (let k = 0; k < 6; k++) {
    const a = ((60 * k - 90) * Math.PI) / 180;
    out.push(`${round(cx + r * Math.cos(a))},${round(cy + r * Math.sin(a))}`);
  }
  return out.join(' ');
}

/** Centres of a 7-cell honeycomb (one centre cell + six neighbours) around (cx, cy). */
export function honeycomb(cx: number, cy: number, spacing: number): [number, number][] {
  const cells: [number, number][] = [[cx, cy]];
  for (let k = 0; k < 6; k++) {
    const a = ((60 * k) * Math.PI) / 180;
    cells.push([round(cx + spacing * Math.cos(a)), round(cy + spacing * Math.sin(a))]);
  }
  return cells;
}

function round(n: number) { return Math.round(n * 100) / 100; }

/** Stable 32-bit hash (FNV-1a) of any string — an agent id, slug or name. */
export function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** The agent's own hue (0–359), derived from its id so it never changes. */
export function agentHue(seed: string): number { return hashSeed(seed) % 360; }

/** Colour set for an agent: a solid accent plus soft tints for bubbles and borders. */
export function agentColor(seed: string) {
  const h = agentHue(seed);
  return {
    hue: h,
    solid: `hsl(${h} 85% 62%)`,
    deep: `hsl(${(h + 38) % 360} 80% 46%)`,
    tint: `hsl(${h} 85% 62% / 0.12)`,
    border: `hsl(${h} 85% 62% / 0.35)`,
    text: `hsl(${h} 90% 76%)`,
  };
}
