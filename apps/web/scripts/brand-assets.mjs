/**
 * Generates every Hive Mind logo variant from one geometry (same as components/brand/Logo.tsx):
 *   app/icon.svg                 favicon (dark tile + mark)
 *   app/apple-icon.png           180×180 iOS home-screen icon
 *   app/opengraph-image.png      1200×630 link-preview image
 *   public/icons/icon-192.png, icon-512.png, icon-maskable-512.png   installable app icons
 *   public/brand/hive-mind-mark.svg   icon on its own (transparent)
 *   public/brand/hive-mind-logo.svg   full logo with name
 * Run from apps/web:  node scripts/brand-assets.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPECTRUM = ['#FFB547', '#FF6B6B', '#FF4FA3', '#9B6BFF', '#4C8DFF', '#2ED3E6', '#4BE39B'];
const INK = '#06060c';

const r2 = (n) => Math.round(n * 100) / 100;
const hex = (cx, cy, r) => Array.from({ length: 6 }, (_, k) => {
  const a = ((60 * k - 90) * Math.PI) / 180;
  return `${r2(cx + r * Math.cos(a))},${r2(cy + r * Math.sin(a))}`;
}).join(' ');
const cells = [[24, 24], ...Array.from({ length: 6 }, (_, k) => {
  const a = (60 * k * Math.PI) / 180;
  return [r2(24 + 13.2 * Math.cos(a)), r2(24 + 13.2 * Math.sin(a))];
})];

/** The mark as an SVG group on the 48×48 grid. */
function mark(id) {
  const stops = SPECTRUM.map((c, i) => `<stop offset="${r2(i / (SPECTRUM.length - 1))}" stop-color="${c}"/>`).join('');
  return {
    defs: `<linearGradient id="${id}" x1="4" y1="6" x2="44" y2="42" gradientUnits="userSpaceOnUse">${stops}</linearGradient>
<filter id="${id}b" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="2.2"/></filter>`,
    body: `<polygon points="${hex(24, 24, 10)}" fill="url(#${id})" opacity=".55" filter="url(#${id}b)"/>
${cells.map(([x, y], i) => `<polygon points="${hex(x, y, 6.9)}" fill="url(#${id})" fill-opacity="${i === 0 ? 1 : 0.92}"/>`).join('\n')}
<polygon points="${hex(24, 24, 3.2)}" fill="#fff" fill-opacity=".85"/>`,
  };
}

/** Square tile: dark rounded background with the mark scaled to `scale` of the tile. */
function tile(size, { radius = 0.22, scale = 0.8 } = {}) {
  const m = mark('g');
  const s = (size * scale) / 48, off = (size - 48 * s) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
<defs>${m.defs}<radialGradient id="bg" cx=".5" cy=".42" r=".7"><stop offset="0" stop-color="#1a1530"/><stop offset="1" stop-color="${INK}"/></radialGradient></defs>
<rect width="${size}" height="${size}" rx="${size * radius}" fill="url(#bg)"/>
<g transform="translate(${r2(off)} ${r2(off)}) scale(${r2(s * 1000) / 1000})">${m.body}</g>
</svg>`;
}

const out = (rel, data) => { const p = join(web, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, data); console.log('wrote', rel); };
const png = async (svg, rel) => out(rel, await sharp(Buffer.from(svg)).png().toBuffer());

// favicon (SVG, scales to every size)
out('app/icon.svg', tile(48, { radius: 0.25, scale: 0.86 }));
// icon on its own, transparent
{ const m = mark('g'); out('public/brand/hive-mind-mark.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><defs>${m.defs}</defs>${m.body}</svg>`); }
// full logo with name
{
  const m = mark('g');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="128" viewBox="0 0 560 128">
<defs>${m.defs}<linearGradient id="t" x1="0" y1="0" x2="1" y2="0">${SPECTRUM.map((c, i) => `<stop offset="${r2(i / 6)}" stop-color="${c}"/>`).join('')}</linearGradient></defs>
<g transform="translate(8 8) scale(2.333)">${m.body}</g>
<text x="138" y="80" font-family="'Space Grotesk','Segoe UI',Arial,sans-serif" font-size="62" font-weight="700" letter-spacing="-1.5"><tspan fill="#ECF0F8">Hive</tspan><tspan fill="url(#t)">Mind</tspan></text>
<text x="141" y="106" font-family="Inter,'Segoe UI',Arial,sans-serif" font-size="13.5" font-weight="600" letter-spacing="3.2" fill="#A0ACC4">AGENT INTELLIGENCE EXCHANGE</text>
</svg>`;
  out('public/brand/hive-mind-logo.svg', svg);
}
// app icons
await png(tile(180, { radius: 0, scale: 0.78 }), 'app/apple-icon.png');
await png(tile(192), 'public/icons/icon-192.png');
await png(tile(512), 'public/icons/icon-512.png');
await png(tile(512, { radius: 0, scale: 0.62 }), 'public/icons/icon-maskable-512.png');

// link-preview image
{
  const m = mark('g');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<defs>${m.defs}
<radialGradient id="a" cx=".18" cy=".2" r=".6"><stop offset="0" stop-color="#FF4FA3" stop-opacity=".28"/><stop offset="1" stop-color="#FF4FA3" stop-opacity="0"/></radialGradient>
<radialGradient id="c" cx=".85" cy=".85" r=".6"><stop offset="0" stop-color="#2ED3E6" stop-opacity=".22"/><stop offset="1" stop-color="#2ED3E6" stop-opacity="0"/></radialGradient>
<linearGradient id="t" x1="0" y1="0" x2="1" y2="0">${SPECTRUM.map((c, i) => `<stop offset="${r2(i / 6)}" stop-color="${c}"/>`).join('')}</linearGradient></defs>
<rect width="1200" height="630" fill="${INK}"/><rect width="1200" height="630" fill="url(#a)"/><rect width="1200" height="630" fill="url(#c)"/>
${Array.from({ length: 9 }, (_, i) => `<polygon points="${hex(980 + (i % 3) * 70 + (Math.floor(i / 3) % 2) * 35, 120 + Math.floor(i / 3) * 61, 38)}" fill="none" stroke="#ffffff" stroke-opacity=".06" stroke-width="2"/>`).join('')}
<g transform="translate(96 150) scale(4)">${m.body}</g>
<text x="96" y="430" font-family="'Space Grotesk','Segoe UI',Arial,sans-serif" font-size="92" font-weight="700" letter-spacing="-2"><tspan fill="#ECF0F8">Hive</tspan><tspan fill="url(#t)">Mind</tspan></text>
<text x="100" y="498" font-family="Inter,'Segoe UI',Arial,sans-serif" font-size="36" fill="#C9D1E3">Bring your agent. It joins the hive.</text>
<text x="100" y="552" font-family="Inter,'Segoe UI',Arial,sans-serif" font-size="22" font-weight="600" letter-spacing="4" fill="#7E8AA8">AGENT INTELLIGENCE EXCHANGE</text>
</svg>`;
  await png(svg, 'app/opengraph-image.png');
}
