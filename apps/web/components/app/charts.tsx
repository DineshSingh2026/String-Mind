'use client';
/**
 * Recharts wrappers styled per the Hive Mind reference: dark tooltip card, gold = IDLE tokens, electric blue = activity.
 * Rules: one y-axis per chart (two measures of different scale → synced small multiples), thin 2px lines,
 * recessive grid, rounded bar ends, tooltip on hover. Every chart must be fed real API data only.
 */
import { useId, type ReactNode } from 'react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
  type TooltipProps,
} from 'recharts';
import { cn } from '@/components/ui';
import { fmtIdle } from '@/lib/tokens';
import { motion, useReducedMotion } from 'framer-motion';

export const C = {
  gold: 'rgb(255 181 71)',
  goldSoft: 'rgb(255 214 150)',
  electric: 'rgb(72 148 255)',
  violet: 'rgb(139 108 255)',
  success: 'rgb(52 199 133)',
  danger: 'rgb(239 83 80)',
  warning: 'rgb(245 166 35)',
  grid: 'rgb(38 50 76 / 0.55)',
  axis: 'rgb(112 126 154)',
  surface: 'rgb(9 13 22)',
};

const axisProps = { stroke: C.axis, fontSize: 11, tickLine: false, axisLine: false } as const;

export const fmtAxisDate = (s: string) => {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};
export const fmtAxisMonth = (s: string) => {
  const d = new Date(/^\d{4}-\d{2}$/.test(s) ? `${s}-01` : s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
};
const compact = (n: number) => new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 }).format(n);

type Fmt = (v: number, key: string) => string;

/** Dark tooltip card. */
export function ChartTooltip({ active, payload, label, labelFormatter, valueFormatter }: TooltipProps<number, string> & { labelFormatter?: (l: string) => string; valueFormatter?: Fmt }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border border-line bg-ink-850/95 px-3 py-2 text-xs shadow-2xl backdrop-blur">
      {label != null && <p className="mb-1 font-medium text-fg">{labelFormatter ? labelFormatter(String(label)) : String(label)}</p>}
      {payload.map((p) => (
        <p key={String(p.dataKey)} className="flex items-center gap-2 text-fg-muted">
          <span className="h-2 w-2 rounded-full" style={{ background: (p.color as string) ?? (p.stroke as string) }} aria-hidden />
          <span>{p.name}</span>
          <span className="ml-auto pl-3 font-semibold tabular-nums text-fg">{typeof p.value === 'number' ? (valueFormatter ? valueFormatter(p.value, String(p.dataKey)) : p.value.toLocaleString('en-IN')) : '—'}</span>
        </p>
      ))}
    </div>
  );
}

export function Legend({ items, className }: { items: { label: string; color: string; kind?: 'line' | 'area' | 'bar' }[]; className?: string }) {
  return (
    <ul className={cn('flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-muted', className)}>
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <span aria-hidden className={i.kind === 'line' ? 'h-0.5 w-3.5 rounded' : 'h-2.5 w-2.5 rounded-sm'} style={{ background: i.color }} />{i.label}
        </li>
      ))}
    </ul>
  );
}

/** Rich tooltip for the growth chart: shows both measures for the hovered day. */
function GrowthTooltip({ active, payload, label, earningsLabel }: TooltipProps<number, string> & { earningsLabel: string }) {
  if (!active || !payload?.length) return null;
  const row = payload[0]!.payload as { earnings: number; sessions: number };
  return (
    <div className="min-w-[180px] rounded-xl border border-line bg-ink-850/95 px-3.5 py-2.5 text-xs shadow-2xl backdrop-blur">
      <p className="mb-1.5 font-medium text-fg">{label != null ? fmtAxisDate(String(label)) : ''}</p>
      <p className="flex items-center gap-2 text-fg-muted"><span className="h-2 w-2 rounded-full" style={{ background: C.gold, boxShadow: `0 0 8px ${C.gold}` }} aria-hidden />{earningsLabel}<span className="ml-auto pl-3 font-semibold tabular-nums text-gold-soft">{row.earnings.toLocaleString('en-IN')}</span></p>
      <p className="mt-1 flex items-center gap-2 text-fg-muted"><span className="h-2 w-2 rounded-full" style={{ background: C.electric, boxShadow: `0 0 8px ${C.electric}` }} aria-hidden />Training sessions<span className="ml-auto pl-3 font-semibold tabular-nums text-electric-soft">{row.sessions.toLocaleString('en-IN')}</span></p>
    </div>
  );
}

/**
 * "Your Growth Journey": earnings (gold) and training sessions (blue) as two synced panels
 * sharing one x-axis and hover — never a dual-axis chart. Lines draw in on mount.
 */
export function GrowthChart({ data, height = 260, earningsLabel = 'IDLE earned' }: { data: { date: string; earnings: number; sessions: number }[]; height?: number; earningsLabel?: string }) {
  const sync = useId();
  const gid = useId().replace(/:/g, '');
  const reduce = useReducedMotion();
  const top = Math.round(height * 0.58);
  const bottom = height - top;
  // Recharts' own animation is unreliable under React 19 StrictMode, so the "draw" is a clip-path reveal instead.
  const anim = { isAnimationActive: false };
  const reveal = reduce ? {} : { initial: { clipPath: 'inset(0 100% 0 0)' }, animate: { clipPath: 'inset(0 0% 0 0)' }, transition: { duration: 1.4, ease: [0.2, 0.7, 0.2, 1] as const } };
  const totals = data.reduce((a, d) => ({ e: a.e + d.earnings, s: a.s + d.sessions }), { e: 0, s: 0 });
  return (
    <div role="img" aria-label={`Growth chart with ${data.length} points: ${totals.e} IDLE earned and ${totals.s} training sessions over the period`}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <Legend items={[{ label: earningsLabel, color: C.gold, kind: 'line' }, { label: 'Training sessions', color: C.electric, kind: 'area' }]} />
        <p className="text-[11px] text-fg-subtle">Period total: <span className="font-medium text-gold-soft">{fmtIdle(totals.e)}</span> · <span className="font-medium text-electric-soft">{totals.s.toLocaleString('en-IN')} sessions</span></p>
      </div>
      <motion.div {...reveal}>
      <ResponsiveContainer width="100%" height={top}>
        <AreaChart data={data} syncId={sync} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
          <defs>
            <linearGradient id={`e${gid}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={C.gold} stopOpacity={0.32} /><stop offset="1" stopColor={C.gold} stopOpacity={0} /></linearGradient>
          </defs>
          <CartesianGrid stroke={C.grid} vertical={false} strokeDasharray="2 4" />
          <XAxis dataKey="date" hide />
          <YAxis {...axisProps} width={48} tickFormatter={compact} allowDecimals={false} />
          <Tooltip cursor={{ stroke: C.gold, strokeOpacity: 0.4, strokeDasharray: '3 3' }} content={<GrowthTooltip earningsLabel={earningsLabel} />} />
          <Area type="monotone" dataKey="earnings" name="Earnings" stroke={C.gold} strokeWidth={2.25} fill={`url(#e${gid})`} className="ax-glow-gold" dot={false}
            activeDot={{ r: 5, stroke: C.surface, strokeWidth: 2, fill: C.gold }} {...anim} />
        </AreaChart>
      </ResponsiveContainer>
      <ResponsiveContainer width="100%" height={bottom}>
        <AreaChart data={data} syncId={sync} margin={{ top: 6, right: 8, left: -12, bottom: 0 }}>
          <defs>
            <linearGradient id={`s${gid}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={C.electric} stopOpacity={0.38} /><stop offset="1" stopColor={C.violet} stopOpacity={0} /></linearGradient>
          </defs>
          <CartesianGrid stroke={C.grid} vertical={false} strokeDasharray="2 4" />
          <XAxis dataKey="date" {...axisProps} tickFormatter={fmtAxisDate} minTickGap={24} />
          <YAxis {...axisProps} width={48} allowDecimals={false} tickFormatter={compact} />
          <Tooltip cursor={{ stroke: C.electric, strokeOpacity: 0.4, strokeDasharray: '3 3' }} content={() => null} />
          <Area type="monotone" dataKey="sessions" name="Sessions" stroke={C.electric} strokeWidth={2} fill={`url(#s${gid})`} className="ax-glow-electric"
            activeDot={{ r: 4, stroke: C.surface, strokeWidth: 2, fill: C.electric }} {...anim} />
        </AreaChart>
      </ResponsiveContainer>
      </motion.div>
    </div>
  );
}

/** Single-series area trend (e.g. Earnings Trend). */
export function AreaTrend({ data, xKey, yKey, name, color = C.electric, height = 220, xFormatter = fmtAxisDate, valueFormatter, ariaLabel }: {
  data: Record<string, any>[]; xKey: string; yKey: string; name: string; color?: string; height?: number;
  xFormatter?: (s: string) => string; valueFormatter?: Fmt; ariaLabel?: string;
}) {
  const gid = useId().replace(/:/g, '');
  const reduce = useReducedMotion();
  return (
    <motion.div role="img" aria-label={ariaLabel ?? `${name} over time`} initial={reduce ? false : { clipPath: 'inset(0 100% 0 0)' }} animate={{ clipPath: 'inset(0 0% 0 0)' }} transition={{ duration: 1.2, ease: [0.2, 0.7, 0.2, 1] }}>
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
          <defs><linearGradient id={`a${gid}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={color} stopOpacity={0.35} /><stop offset="1" stopColor={color} stopOpacity={0} /></linearGradient></defs>
          <CartesianGrid stroke={C.grid} vertical={false} />
          <XAxis dataKey={xKey} {...axisProps} tickFormatter={xFormatter} minTickGap={20} />
          <YAxis {...axisProps} width={48} tickFormatter={compact} />
          <Tooltip cursor={{ stroke: C.axis, strokeDasharray: '3 3' }} content={<ChartTooltip labelFormatter={xFormatter} valueFormatter={valueFormatter} />} />
          <Area type="monotone" dataKey={yKey} name={name} stroke={color} strokeWidth={2} fill={`url(#a${gid})`} activeDot={{ r: 4, stroke: C.surface, strokeWidth: 2 }} style={{ filter: `drop-shadow(0 0 5px ${color})` }} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </motion.div>
  );
}

/** Vertical bars (single series), optional target reference line. */
export function BarTrend({ data, xKey, yKey, name, color = C.electric, height = 220, xFormatter, valueFormatter, target, targetLabel, yDomain, colorFor, ariaLabel }: {
  data: Record<string, any>[]; xKey: string; yKey: string; name: string; color?: string; height?: number; xFormatter?: (s: string) => string;
  valueFormatter?: Fmt; target?: number; targetLabel?: string; yDomain?: [number, number]; colorFor?: (row: Record<string, any>) => string; ariaLabel?: string;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.div role="img" aria-label={ariaLabel ?? `${name} bar chart`} initial={reduce ? false : { clipPath: 'inset(100% 0 0 0)' }} animate={{ clipPath: 'inset(0% 0 0 0)' }} transition={{ duration: 0.9, ease: [0.2, 0.7, 0.2, 1] }}>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} margin={{ top: 12, right: 8, left: -12, bottom: 0 }} barCategoryGap="28%">
          <CartesianGrid stroke={C.grid} vertical={false} />
          <XAxis dataKey={xKey} {...axisProps} tickFormatter={xFormatter} interval="preserveStartEnd" minTickGap={8} />
          <YAxis {...axisProps} width={48} domain={yDomain} tickFormatter={compact} />
          <Tooltip cursor={{ fill: 'rgb(255 255 255 / 0.04)' }} content={<ChartTooltip labelFormatter={xFormatter} valueFormatter={valueFormatter} />} />
          {target != null && <ReferenceLine y={target} stroke={C.gold} strokeDasharray="4 4" label={{ value: targetLabel ?? `Target ${target}`, position: 'insideTopRight', fill: C.goldSoft, fontSize: 11 }} />}
          <Bar dataKey={yKey} name={name} fill={color} radius={[4, 4, 0, 0]} maxBarSize={36} isAnimationActive={false}>
            {colorFor && data.map((row, i) => <Cell key={i} fill={colorFor(row)} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </motion.div>
  );
}

/** Horizontal labelled bars ("Top Skills Acquired", per-domain scores). Pure HTML for crisp mobile layout. */
export function BarList({ items, max = 100, tone = 'electric', format = (v) => `${Math.round(v)}%`, empty }: {
  items: { label: ReactNode; value: number | null; hint?: ReactNode; key?: string }[]; max?: number; tone?: 'electric' | 'gold' | 'success' | 'violet';
  format?: (v: number) => string; empty?: ReactNode;
}) {
  if (!items.length) return <>{empty ?? null}</>;
  const bar = { electric: 'bg-gradient-to-r from-electric/70 to-electric', gold: 'bg-gradient-to-r from-gold-deep to-gold', success: 'bg-gradient-to-r from-success/70 to-success', violet: 'bg-gradient-to-r from-violet/70 to-violet' }[tone];
  return (
    <ul className="space-y-3">
      {items.map((it, i) => (
        <li key={it.key ?? i}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate text-fg">{it.label}</span>
            <span className="shrink-0 tabular-nums text-fg-muted">{it.value == null ? 'Not assessed' : format(it.value)}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-ink-800" role="progressbar" aria-valuenow={it.value ?? undefined} aria-valuemin={0} aria-valuemax={max}>
            {it.value != null && <motion.div className={cn('h-full rounded-full', bar)} initial={{ width: 0 }} whileInView={{ width: `${Math.max(0, Math.min(100, (it.value / max) * 100))}%` }} viewport={{ once: true }} transition={{ duration: 0.9, ease: [0.2, 0.7, 0.2, 1], delay: Math.min(i, 8) * 0.06 }} />}
          </div>
          {it.hint && <div className="mt-1 text-[11px] text-fg-subtle">{it.hint}</div>}
        </li>
      ))}
    </ul>
  );
}

/** Tiny inline sparkline (no axes, no tooltip — decorative trend beside a labelled number). Draws in on mount. */
export function Sparkline({ values, color = C.success, width = 72, height = 24 }: { values: number[]; color?: string; width?: number; height?: number }) {
  const gid = useId().replace(/:/g, '');
  const reduce = useReducedMotion();
  if (values.length < 2) return null;
  const min = Math.min(...values); const max = Math.max(...values); const span = max - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * (width - 2) + 1, height - 2 - ((v - min) / span) * (height - 4)] as const);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${d} L${pts[pts.length - 1]![0].toFixed(1)},${height} L${pts[0]![0].toFixed(1)},${height} Z`;
  const last = pts[pts.length - 1]!;
  return (
    <svg width={width} height={height} aria-hidden className="shrink-0 overflow-visible">
      <defs><linearGradient id={`sp${gid}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={color} stopOpacity={0.3} /><stop offset="1" stopColor={color} stopOpacity={0} /></linearGradient></defs>
      <motion.path d={area} fill={`url(#sp${gid})`} initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.8, delay: 0.6 }} />
      <motion.path d={d} fill="none" stroke={color} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" initial={reduce ? false : { pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1.1, ease: [0.2, 0.7, 0.2, 1] }} />
      <motion.circle cx={last[0]} cy={last[1]} r={2.25} fill={color} initial={reduce ? false : { scale: 0 }} animate={{ scale: 1 }} transition={{ delay: 1.05 }} style={{ filter: `drop-shadow(0 0 3px ${color})` }} />
    </svg>
  );
}

/** Big progress ring for headline percentages (e.g. learning improvement). `null` renders "—". */
export function BigRing({ value, label, sub, size = 148, color = C.success, max = 100 }: { value: number | null; label: string; sub?: ReactNode; size?: number; color?: string; max?: number }) {
  const r = size / 2 - 10; const c = 2 * Math.PI * r;
  const pct = value == null ? 0 : Math.max(0, Math.min(1, Math.abs(value) / max));
  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }} role="img" aria-label={value == null ? `${label}: no data` : `${label}: ${value.toFixed(1)}%`}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} stroke="rgb(var(--ink-800))" strokeWidth={10} fill="none" />
        {value != null && <motion.circle cx={size / 2} cy={size / 2} r={r} stroke={value < 0 ? C.danger : color} strokeWidth={10} fill="none" strokeLinecap="round" strokeDasharray={c}
          initial={{ strokeDashoffset: c }} whileInView={{ strokeDashoffset: c - pct * c }} viewport={{ once: true }} transition={{ duration: 1.3, ease: [0.2, 0.7, 0.2, 1] }}
          style={{ filter: `drop-shadow(0 0 6px ${value < 0 ? C.danger : color})` }} />}
      </svg>
      <span className="absolute text-center">
        <span className="block font-display text-3xl font-semibold tabular-nums">{value == null ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(1)}%`}</span>
        {sub && <span className="block text-[11px] text-fg-subtle">{sub}</span>}
      </span>
    </div>
  );
}

/** Wrapper shown when a series has no points: a clearly decorative dashed ghost line (no fake values). */
export function ChartEmpty({ children = 'No data for this period yet', height = 220 }: { children?: ReactNode; height?: number }) {
  return (
    <div className="ax-ghost-grid relative flex items-center justify-center overflow-hidden rounded-xl border border-dashed border-line px-4 text-sm text-fg-subtle" style={{ height }}>
      <svg className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 w-full opacity-50" viewBox="0 0 400 100" preserveAspectRatio="none" aria-hidden>
        <path d="M0 80 C 60 78, 90 60, 140 64 S 230 40, 280 46 S 360 20, 400 24" fill="none" stroke="rgb(var(--ink-600))" strokeWidth="1.5" strokeDasharray="4 6" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="relative max-w-sm rounded-xl border border-line/60 bg-ink-900/85 px-4 py-3 text-center backdrop-blur">{children}</div>
    </div>
  );
}
