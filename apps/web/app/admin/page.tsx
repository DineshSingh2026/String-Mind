'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Activity, Bot, Building2, Coins, Cpu, Database, GraduationCap, HeartPulse, Landmark, Percent, Plug, ServerCog, TriangleAlert, Users } from 'lucide-react';
import { Card, CardHeader, ErrorState, Skeleton, cn, fmtNumber } from '@/components/ui';
import { useApi } from '@/lib/api';
import { AdminHeader, AutoObject, StatusBadge, type Row } from '@/components/admin/kit';
import { AnimatedNumber, PulseDot, StaggerLi, StaggerList, motion, useReducedMotion } from '@/components/app/motion';
import { Sparkline } from '@/components/app/charts';
import { fmtIdle } from '@/lib/tokens';

/* Shapes per GET /admin/overview and GET /admin/system-health (read defensively; unknown extras are shown raw below). */
interface Overview {
  users?: { total?: number; active?: number }; orgs?: number; agents?: { total?: number; byStatus?: Record<string, number> };
  sessions?: { total?: number; byStatus?: Record<string, number> }; failedSessions?: number;
  tokens?: { currency?: string; welcomeBonusesGranted?: number; welcomeBonusIssued?: number; inCirculation?: number }; commissions?: { currency?: string; trainingCommissionCredits?: number; platformRevenueBalance?: number };
  jobs?: { completed?: number; queued?: number };
}
interface Health {
  status?: string; db?: { ok?: boolean; latencyMs?: number }; jobs?: { queued?: number; running?: number; failed?: number; completed?: number; oldestQueuedAgeSeconds?: number | null };
  agentsByHealth?: Record<string, number>; providersByStatus?: Record<string, number>; time?: string;
}
const KNOWN_OVERVIEW = ['users', 'orgs', 'agents', 'sessions', 'failedSessions', 'revenue', 'tokens', 'commissions', 'jobs'];

export default function AdminOverviewPage() {
  const ov = useApi<Overview>('/admin/overview', { refreshInterval: 30000 });
  const hq = useApi<Health>('/admin/system-health', { refreshInterval: 15000 });
  const o = ov.data; const h = hq.data;

  /* latency history measured live in this console session (real samples, not backfilled) */
  const [lat, setLat] = useState<number[]>([]);
  const lastT = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (h?.db?.latencyMs == null || h.time === lastT.current) return;
    lastT.current = h.time;
    setLat((x) => [...x, h.db!.latencyMs!].slice(-40));
  }, [h]);

  const extras = o ? Object.fromEntries(Object.entries(o as Row).filter(([k]) => !KNOWN_OVERVIEW.includes(k))) : {};

  return (
    <div className="space-y-6">
      <AdminHeader title="Platform overview" description={<span className="flex flex-wrap items-center gap-2"><PulseDot tone={hq.error ? 'danger' : 'success'} />Live database aggregates from GET /admin/overview &amp; /admin/system-health · auto-refresh 15–30s</span>} />

      {ov.error ? <ErrorState error={ov.error} onRetry={() => void ov.mutate()} /> : (
        <StaggerList as="div" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <OpsTile icon={<Users className="h-4 w-4" />} label="Users" value={o?.users?.total} sub={o?.users?.active != null ? `${fmtNumber(o.users.active)} active` : undefined} loading={ov.isLoading} tone="electric" />
          <OpsTile icon={<Building2 className="h-4 w-4" />} label="Organisations" value={o?.orgs} loading={ov.isLoading} tone="violet" />
          <OpsTile icon={<Bot className="h-4 w-4" />} label="Agents" value={o?.agents?.total} sub={o?.agents?.byStatus?.active != null ? `${fmtNumber(o.agents.byStatus.active)} active` : undefined} loading={ov.isLoading} tone="success" />
          <OpsTile icon={<GraduationCap className="h-4 w-4" />} label="Sessions" value={o?.sessions?.total} sub={o?.failedSessions ? `${fmtNumber(o.failedSessions)} failed` : o ? 'none failed' : undefined} warn={!!o?.failedSessions} loading={ov.isLoading} tone="electric" />
          <OpsTile icon={<Coins className="h-4 w-4" />} label="IDLE supply" value={o?.tokens?.inCirculation} sub={o?.tokens?.welcomeBonusesGranted != null ? `${fmtNumber(o.tokens.welcomeBonusesGranted)} welcome bonuses` : undefined} loading={ov.isLoading} tone="gold" />
          <OpsTile icon={<Percent className="h-4 w-4" />} label="Commission" value={o?.commissions?.trainingCommissionCredits} sub={o?.commissions?.platformRevenueBalance != null ? `${fmtIdle(o.commissions.platformRevenueBalance)} platform balance` : undefined} loading={ov.isLoading} tone="gold" />
        </StaggerList>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="ax-spot relative overflow-hidden lg:col-span-2">
          <CardHeader title={<span className="flex items-center gap-2"><HeartPulse className="h-4 w-4 text-success" aria-hidden />System health</span>}
            subtitle={h?.time ? `Last probe ${new Date(h.time).toLocaleTimeString('en-IN')}` : 'Probing…'} action={h ? <StatusBadge value={h.status} /> : undefined} />
          {hq.error ? <div className="p-5"><ErrorState error={hq.error} onRetry={() => void hq.mutate()} /></div> : hq.isLoading ? <div className="grid gap-3 p-5 sm:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-24" />)}</div> : (
            <div className="grid gap-3 p-5 sm:grid-cols-3">
              <HealthCell icon={<Database className="h-4 w-4" />} label="Database" ok={h?.db?.ok !== false}
                value={h?.db?.latencyMs != null ? <><AnimatedNumber value={h.db.latencyMs} format={(n) => n.toFixed(1)} /> <span className="text-xs font-normal text-fg-muted">ms</span></> : '—'}
                foot={lat.length > 1 ? <Sparkline values={lat} color="rgb(52 199 133)" width={120} height={26} /> : <span className="text-[11px] text-fg-subtle">Latency trend builds while this page is open</span>} />
              <HealthCell icon={<ServerCog className="h-4 w-4" />} label="Job queue" ok={!h?.jobs?.failed}
                value={<><AnimatedNumber value={h?.jobs?.queued ?? null} /> <span className="text-xs font-normal text-fg-muted">queued</span></>}
                foot={<span className="text-[11px] text-fg-subtle">{fmtNumber(h?.jobs?.running)} running · {fmtNumber(h?.jobs?.completed)} done · <span className={cn(h?.jobs?.failed ? 'text-danger-soft' : '')}>{fmtNumber(h?.jobs?.failed)} failed</span>{h?.jobs?.oldestQueuedAgeSeconds != null ? ` · oldest ${Math.round(h.jobs.oldestQueuedAgeSeconds)}s` : ''}</span>} />
              <HealthCell icon={<Cpu className="h-4 w-4" />} label="Agent fleet" ok={!h?.agentsByHealth?.down}
                value={<><AnimatedNumber value={h?.agentsByHealth?.healthy ?? 0} /> <span className="text-xs font-normal text-fg-muted">healthy</span></>}
                foot={<Distribution data={h?.agentsByHealth} colors={{ healthy: 'bg-success', degraded: 'bg-warning', down: 'bg-danger', unknown: 'bg-fg-subtle' }} />} />
            </div>
          )}
        </Card>
        <Card className="ax-spot">
          <CardHeader title={<span className="flex items-center gap-2"><Plug className="h-4 w-4 text-electric" aria-hidden />Providers</span>} subtitle="By integration status" />
          <div className="p-5">
            {hq.isLoading ? <Skeleton className="h-24" /> : <BreakdownBars data={h?.providersByStatus} colors={{ active: 'from-success/60 to-success', beta: 'from-electric/60 to-electric', disabled: 'from-danger/60 to-danger' }} />}
          </div>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="ax-spot">
          <CardHeader title={<span className="flex items-center gap-2"><Activity className="h-4 w-4 text-violet" aria-hidden />Sessions by status</span>} subtitle={o?.sessions?.total != null ? `${fmtNumber(o.sessions.total)} total` : undefined} />
          <div className="p-5">{ov.isLoading ? <Skeleton className="h-24" /> : <BreakdownBars data={o?.sessions?.byStatus} empty="No training sessions yet." colors={{ completed: 'from-success/60 to-success', active: 'from-electric/60 to-electric', failed: 'from-danger/60 to-danger', disputed: 'from-violet/60 to-violet', cancelled: 'from-ink-600 to-fg-subtle' }} />}</div>
        </Card>
        <Card className="ax-spot">
          <CardHeader title={<span className="flex items-center gap-2"><Landmark className="h-4 w-4 text-gold" aria-hidden />Agents by status</span>} subtitle={o?.agents?.total != null ? `${fmtNumber(o.agents.total)} total` : undefined} />
          <div className="p-5">{ov.isLoading ? <Skeleton className="h-24" /> : <BreakdownBars data={o?.agents?.byStatus} empty="No agents yet." colors={{ active: 'from-success/60 to-success', paused: 'from-warning/60 to-warning', suspended: 'from-danger/60 to-danger' }} />}</div>
        </Card>
      </div>

      {Object.keys(extras).length > 0 && <AutoObject data={extras} title="Other aggregates" />}
    </div>
  );
}

const TONES = {
  gold: 'text-gold border-gold/25 bg-gold/10', electric: 'text-electric border-electric/25 bg-electric/10', violet: 'text-violet border-violet/25 bg-violet/10', success: 'text-success border-success/25 bg-success/10',
} as const;

function OpsTile({ icon, label, value, sub, loading, tone, warn }: { icon: ReactNode; label: string; value?: number | null; sub?: ReactNode; loading?: boolean; tone: keyof typeof TONES; warn?: boolean }) {
  return (
    <StaggerLi as="div" className="card ax-spot ax-lift relative overflow-hidden p-4">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-line to-transparent" aria-hidden />
      <div className="flex items-center justify-between gap-2"><p className="truncate font-mono text-[10.5px] uppercase tracking-[0.14em] text-fg-subtle">{label}</p><span className={cn('rounded-lg border p-1.5', TONES[tone])} aria-hidden>{icon}</span></div>
      {loading ? <Skeleton className="mt-3 h-7 w-16" /> : <p className="mt-2 font-display text-2xl font-semibold tabular-nums"><AnimatedNumber value={value ?? null} /></p>}
      {sub && !loading && <p className={cn('mt-0.5 flex items-center gap-1 truncate text-[11px]', warn ? 'text-danger-soft' : 'text-fg-subtle')}>{warn && <TriangleAlert className="h-3 w-3" aria-hidden />}{sub}</p>}
    </StaggerLi>
  );
}

function HealthCell({ icon, label, value, ok, foot }: { icon: ReactNode; label: string; value: ReactNode; ok: boolean; foot?: ReactNode }) {
  return (
    <div className={cn('relative overflow-hidden rounded-xl border bg-ink-950/40 p-4', ok ? 'border-success/20' : 'border-danger/40')}>
      <div className={cn('pointer-events-none absolute -right-6 -top-6 h-16 w-16 rounded-full blur-2xl', ok ? 'bg-success/15' : 'bg-danger/20')} aria-hidden />
      <p className="relative flex items-center gap-2 text-xs text-fg-muted"><span className="text-fg-subtle">{icon}</span>{label}<span className="ml-auto"><PulseDot tone={ok ? 'success' : 'danger'} label={ok ? `${label} ok` : `${label} needs attention`} /></span></p>
      <p className="relative mt-2 font-display text-2xl font-semibold tabular-nums">{value}</p>
      <div className="relative mt-2 min-h-[26px]">{foot}</div>
    </div>
  );
}

function Distribution({ data, colors }: { data?: Record<string, number>; colors: Record<string, string> }) {
  const entries = Object.entries(data ?? {}).filter(([, v]) => v > 0);
  const total = entries.reduce((a, [, v]) => a + v, 0);
  if (!total) return <span className="text-[11px] text-fg-subtle">No agents reporting</span>;
  return (
    <div>
      <div className="flex h-1.5 overflow-hidden rounded-full bg-ink-800">{entries.map(([k, v]) => <motion.span key={k} className={cn('h-full', colors[k] ?? 'bg-fg-subtle')} initial={{ width: 0 }} animate={{ width: `${(v / total) * 100}%` }} transition={{ duration: 0.9 }} />)}</div>
      <p className="mt-1.5 text-[11px] text-fg-subtle">{entries.map(([k, v]) => `${v} ${k}`).join(' · ')}</p>
    </div>
  );
}

function BreakdownBars({ data, colors, empty = 'No data' }: { data?: Record<string, number>; colors: Record<string, string>; empty?: string }) {
  const reduce = useReducedMotion();
  const entries = Object.entries(data ?? {}).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map(([, v]) => v));
  if (!entries.length) return <p className="py-6 text-center text-sm text-fg-subtle">{empty}</p>;
  return (
    <ul className="space-y-3">
      {entries.map(([k, v], i) => (
        <li key={k}>
          <div className="mb-1 flex items-baseline justify-between text-sm"><span className="capitalize text-fg">{k.replace(/_/g, ' ')}</span><span className="tabular-nums text-fg-muted"><AnimatedNumber value={v} /></span></div>
          <div className="h-2 overflow-hidden rounded-full bg-ink-800"><motion.div className={cn('h-full rounded-full bg-gradient-to-r', colors[k] ?? 'from-electric/50 to-electric')} initial={reduce ? false : { width: 0 }} animate={{ width: `${(v / max) * 100}%` }} transition={{ duration: 0.9, delay: i * 0.08, ease: [0.2, 0.7, 0.2, 1] }} /></div>
        </li>
      ))}
    </ul>
  );
}
