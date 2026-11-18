'use client';
/**
 * Admin command centre. The admin is the controller and monitor of the platform — not a participant —
 * so this page is read-first: what needs a decision, how the platform is moving, where the money is,
 * and a launcher into every control module. Every figure comes from GET /admin/command-center
 * (live aggregates; nothing estimated or back-filled).
 */
import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Activity, ArrowDownRight, ArrowRight, ArrowUpRight, Award, Bot, CheckCircle2, Coins, Cpu, Database, Gavel, GraduationCap, Landmark, Lock, Minus, Percent,
  ScrollText, ServerCog, ShieldAlert, ShieldCheck, Siren, Store, Swords, TriangleAlert, Users, Vault, FlaskConical, ClipboardCheck, Scale, Sparkles, Plug, Settings, HeartPulse, CreditCard,
} from 'lucide-react';
import { Card, CardHeader, ErrorState, Skeleton, cn, fmtNumber, fmtRelative } from '@/components/ui';
import { useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { StatusBadge } from '@/components/admin/kit';
import { AnimatedNumber, PulseDot, StaggerLi, StaggerList, motion, useReducedMotion } from '@/components/app/motion';
import { AreaTrend, C, Sparkline } from '@/components/app/charts';
import { fmtIdle } from '@/lib/tokens';

type Point = { date: string; value: number };
interface CC {
  generatedAt: string;
  members: { total: number; active: number; suspended: number; admins: number; new7: number; prev7: number; signedIn24h: number; orgs: number };
  agents: { total: number; active: number; verified: number; public: number; avgScore: number; new7: number; prev7: number; byStatus: Record<string, number>; byHealth: Record<string, number>; suspended: number };
  training: { total: number; live: number; completed: number; failed: number; disputed: number; new7: number; prev7: number; byStatus: Record<string, number> };
  marketplace: { activeListings: number; listingsUnderReview: number; listingsTotal: number; debates: number; liveDebates: number; certifications: number; certificationLevels: Record<string, number> };
  economy: { inCirculation: number; lockedInEscrow: number; platformRevenue: number; commissionEarned: number; welcomeBonuses: number; welcomeIssued: number };
  attention: { disputes: number; fraudFlags: number; highSeverityFraud: number; reports: number; humanReview: number; failedJobs: number; reconciliation: number; payouts: number; pendingVerification: number; listingsUnderReview: number };
  ops: { jobs: Record<string, number>; queued: number; providers: Record<string, number>; adminMfa: { enabled: number; total: number } };
  series: { signups: Point[]; sessions: Point[]; agents: Point[]; transactions: Point[] };
  topAgents: { id: string; name: string; score: number; verification: string; orgName: string }[];
  recent: { id: string; action: string; actorType: string; targetType: string | null; createdAt: string; email: string | null }[];
}
interface Health { status?: string; db?: { ok?: boolean; latencyMs?: number }; jobs?: { queued?: number; running?: number; failed?: number }; time?: string }

export default function AdminCommandCenter() {
  const { me } = useSession();
  const cc = useApi<CC>('/admin/command-center', { refreshInterval: 30000 });
  const hq = useApi<Health>('/admin/system-health', { refreshInterval: 15000 });
  const d = cc.data; const h = hq.data;

  const [lat, setLat] = useState<number[]>([]);
  const lastT = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (h?.db?.latencyMs == null || h.time === lastT.current) return;
    lastT.current = h.time;
    setLat((x) => [...x, h.db!.latencyMs!].slice(-30));
  }, [h]);

  const [series, setSeries] = useState<keyof CC['series']>('signups');
  const hello = new Date().getHours() < 12 ? 'Good morning' : new Date().getHours() < 18 ? 'Good afternoon' : 'Good evening';
  const status = hq.error ? 'down' : h?.status === 'ok' && h.db?.ok !== false ? (h?.jobs?.failed ? 'warning' : 'ok') : h ? 'warning' : 'checking';

  return (
    <div className="space-y-6">
      {/* ── Hero ── */}
      <section className="relative overflow-hidden rounded-2xl border border-line/70 bg-gradient-to-br from-ink-900 via-ink-950 to-black p-5 sm:p-7">
        <div className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-gold/10 blur-3xl" aria-hidden />
        <div className="pointer-events-none absolute -bottom-28 left-1/3 h-64 w-64 rounded-full bg-electric/10 blur-3xl" aria-hidden />
        <div className="relative flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.2em] text-gold"><ShieldCheck className="h-3.5 w-3.5" aria-hidden />Platform command centre</p>
            <h1 className="mt-2 font-display text-2xl font-semibold sm:text-3xl">{hello}{me?.user.name ? `, ${me.user.name.split(' ')[0]}` : ''}.</h1>
            <p className="mt-1.5 max-w-xl text-sm text-fg-muted">
              {d ? <><AttentionSummary a={d.attention} /> Everything below is live from the platform database.</> : 'Loading the platform…'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <StatusPill tone={status}>{status === 'ok' ? 'All systems operational' : status === 'warning' ? 'Degraded — review health' : status === 'down' ? 'API unreachable' : 'Checking systems…'}</StatusPill>
            {h?.db?.latencyMs != null && <span className="rounded-full border border-line/70 bg-ink-900/70 px-3 py-1 font-mono text-fg-muted">DB {h.db.latencyMs.toFixed(1)} ms</span>}
            {d && <span className="rounded-full border border-line/70 bg-ink-900/70 px-3 py-1 font-mono text-fg-subtle" suppressHydrationWarning>Updated {fmtRelative(d.generatedAt)}</span>}
          </div>
        </div>
      </section>

      {cc.error ? <ErrorState error={cc.error} onRetry={() => void cc.mutate()} /> : (
        <>
          {/* ── Needs attention ── */}
          <AttentionQueue d={d} loading={cc.isLoading} />

          {/* ── KPIs ── */}
          <StaggerList as="div" className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Kpi icon={<Users className="h-4 w-4" />} tone="electric" label="Members" loading={cc.isLoading} value={d?.members.total} href="/admin/users"
              sub={d ? `${fmtNumber(d.members.active)} active · ${fmtNumber(d.members.signedIn24h)} signed in 24h` : undefined} delta={d && delta(d.members.new7, d.members.prev7)} deltaLabel="new vs prior 7d" spark={d?.series.signups} />
            <Kpi icon={<Bot className="h-4 w-4" />} tone="success" label="Agents" loading={cc.isLoading} value={d?.agents.total} href="/admin/agents"
              sub={d ? `${fmtNumber(d.agents.verified)} verified · ${fmtNumber(d.agents.public)} public` : undefined} delta={d && delta(d.agents.new7, d.agents.prev7)} deltaLabel="new vs prior 7d" spark={d?.series.agents} />
            <Kpi icon={<GraduationCap className="h-4 w-4" />} tone="violet" label="Training sessions" loading={cc.isLoading} value={d?.training.total} href="/admin/training"
              sub={d ? `${fmtNumber(d.training.live)} live · ${fmtNumber(d.training.completed)} completed` : undefined} delta={d && delta(d.training.new7, d.training.prev7)} deltaLabel="new vs prior 7d" spark={d?.series.sessions} />
            <Kpi icon={<Store className="h-4 w-4" />} tone="gold" label="Active listings" loading={cc.isLoading} value={d?.marketplace.activeListings} href="/admin/moderation"
              sub={d ? `${fmtNumber(d.marketplace.certifications)} certifications · ${fmtNumber(d.marketplace.debates)} debates` : undefined} />
            <Kpi icon={<Coins className="h-4 w-4" />} tone="gold" label="IDLE in circulation" loading={cc.isLoading} value={d?.economy.inCirculation} href="/admin/finance"
              sub={d ? `${fmtIdle(d.economy.lockedInEscrow)} in escrow` : undefined} spark={d?.series.transactions} />
            <Kpi icon={<Landmark className="h-4 w-4" />} tone="gold" label="Platform revenue" loading={cc.isLoading} value={d?.economy.platformRevenue} href="/admin/finance" idle
              sub={d ? `${fmtIdle(d.economy.commissionEarned)} commission settled` : undefined} />
            <Kpi icon={<Activity className="h-4 w-4" />} tone="success" label="Avg agent score" loading={cc.isLoading} value={d?.agents.avgScore} href="/admin/benchmarks" decimals={1}
              sub={d ? `${fmtNumber(d.agents.active)} active agents` : undefined} />
            <Kpi icon={<Swords className="h-4 w-4" />} tone="violet" label="Live debates" loading={cc.isLoading} value={d?.marketplace.liveDebates} href="/admin/hive"
              sub={d ? `${fmtNumber(d.marketplace.debates)} total` : undefined} />
          </StaggerList>

          {/* ── Trend + economy ── */}
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="ax-spot lg:col-span-2">
              <CardHeader title={<span className="flex items-center gap-2"><Activity className="h-4 w-4 text-electric" aria-hidden />Platform activity · last 14 days</span>} subtitle="Daily counts, zero-filled from real rows"
                action={<Segmented value={series} onChange={setSeries} options={[['signups', 'Sign-ups'], ['agents', 'Agents'], ['sessions', 'Sessions'], ['transactions', 'Transactions']]} />} />
              <div className="p-4 pt-2">
                {cc.isLoading || !d ? <Skeleton className="h-[240px]" /> : (
                  <AreaTrend data={d.series[series]} xKey="date" yKey="value" name={SERIES_NAME[series]} color={SERIES_COLOR[series]} height={240} ariaLabel={`${SERIES_NAME[series]} per day for the last 14 days`} />
                )}
              </div>
            </Card>
            <Card className="ax-spot">
              <CardHeader title={<span className="flex items-center gap-2"><Vault className="h-4 w-4 text-gold" aria-hidden />Token economy</span>} subtitle="IDLE — ledger-backed" action={<Link href="/admin/finance" className="text-xs text-gold-soft hover:underline">Open</Link>} />
              <div className="space-y-3 p-5">
                {cc.isLoading || !d ? <Skeleton className="h-40" /> : (<>
                  <EconRow label="In member wallets" value={d.economy.inCirculation} tone="bg-gold" total={d.economy.inCirculation + d.economy.platformRevenue} />
                  <EconRow label="Locked in escrow" value={d.economy.lockedInEscrow} tone="bg-electric" total={d.economy.inCirculation + d.economy.platformRevenue} />
                  <EconRow label="Platform revenue" value={d.economy.platformRevenue} tone="bg-success" total={d.economy.inCirculation + d.economy.platformRevenue} />
                  <div className="mt-1 grid grid-cols-2 gap-2 border-t border-line/60 pt-3 text-xs">
                    <Mini label="Commission settled" value={fmtIdle(d.economy.commissionEarned)} icon={<Percent className="h-3.5 w-3.5" />} />
                    <Mini label="Welcome bonuses" value={`${fmtNumber(d.economy.welcomeBonuses)} · ${fmtIdle(d.economy.welcomeIssued)}`} icon={<Sparkles className="h-3.5 w-3.5" />} />
                  </div>
                </>)}
              </div>
            </Card>
          </div>

          {/* ── Distributions ── */}
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <DistCard title="Training pipeline" icon={<GraduationCap className="h-4 w-4 text-violet" />} loading={cc.isLoading} data={d?.training.byStatus} empty="No sessions yet"
              colors={{ completed: 'bg-success', active: 'bg-electric', scheduled: 'bg-gold', paused: 'bg-warning', failed: 'bg-danger', disputed: 'bg-violet', cancelled: 'bg-fg-subtle' }} />
            <DistCard title="Agent fleet health" icon={<Cpu className="h-4 w-4 text-success" />} loading={cc.isLoading} data={d?.agents.byHealth} empty="No agents yet"
              colors={{ healthy: 'bg-success', degraded: 'bg-warning', down: 'bg-danger', unknown: 'bg-fg-subtle' }} />
            <DistCard title="Certifications" icon={<Award className="h-4 w-4 text-gold" />} loading={cc.isLoading} data={d ? Object.fromEntries(Object.entries(d.marketplace.certificationLevels).filter(([k]) => k !== 'none')) : undefined} empty="None awarded yet"
              colors={{ practitioner: 'bg-electric', professional: 'bg-violet', expert: 'bg-gold' }} />
            <DistCard title="Providers" icon={<Plug className="h-4 w-4 text-electric" />} loading={cc.isLoading} data={d?.ops.providers} empty="No providers"
              colors={{ active: 'bg-success', beta: 'bg-electric', disabled: 'bg-danger' }} />
          </div>

          {/* ── Top agents + live audit ── */}
          <div className="grid gap-4 lg:grid-cols-5">
            <Card className="ax-spot lg:col-span-2">
              <CardHeader title={<span className="flex items-center gap-2"><Award className="h-4 w-4 text-gold" aria-hidden />Top agents by score</span>} action={<Link href="/admin/agents" className="text-xs text-gold-soft hover:underline">All agents</Link>} />
              <ol className="divide-y divide-line/50">
                {cc.isLoading ? [0, 1, 2, 3].map((i) => <li key={i} className="p-4"><Skeleton className="h-8" /></li>) : !d?.topAgents.length ? <li className="p-8 text-center text-sm text-fg-subtle">No scored agents yet.</li> : d.topAgents.map((a, i) => (
                  <li key={a.id} className="flex items-center gap-3 px-5 py-3">
                    <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-lg font-mono text-xs font-semibold', i === 0 ? 'bg-gold/20 text-gold' : 'bg-ink-800 text-fg-muted')}>{i + 1}</span>
                    <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{a.name}</p><p className="truncate text-xs text-fg-subtle">{a.orgName}</p></div>
                    <StatusBadge value={a.verification} />
                    <span className="w-12 text-right font-display text-lg font-semibold tabular-nums">{a.score.toFixed(0)}</span>
                  </li>
                ))}
              </ol>
            </Card>
            <Card className="ax-spot lg:col-span-3">
              <CardHeader title={<span className="flex items-center gap-2"><ScrollText className="h-4 w-4 text-electric" aria-hidden />Live audit feed</span>} subtitle="Most recent platform actions" action={<Link href="/admin/audit" className="text-xs text-gold-soft hover:underline">Full log</Link>} />
              <ul className="divide-y divide-line/50">
                {cc.isLoading ? [0, 1, 2, 3, 4].map((i) => <li key={i} className="p-3"><Skeleton className="h-6" /></li>) : !d?.recent.length ? <li className="p-8 text-center text-sm text-fg-subtle">No activity recorded yet.</li> : d.recent.map((r) => (
                  <li key={r.id} className="flex items-center gap-3 px-5 py-2.5 text-sm">
                    <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', r.actorType === 'admin' ? 'bg-gold' : r.actorType === 'system' ? 'bg-electric' : 'bg-success')} aria-hidden />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg">{r.action}</span>
                    <span className="hidden max-w-[11rem] truncate text-xs text-fg-subtle sm:block">{r.email ?? r.actorType}</span>
                    <span className="shrink-0 text-[11px] tabular-nums text-fg-subtle" suppressHydrationWarning>{fmtRelative(r.createdAt)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          </div>

          {/* ── System + security ── */}
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="ax-spot lg:col-span-2">
              <CardHeader title={<span className="flex items-center gap-2"><HeartPulse className="h-4 w-4 text-success" aria-hidden />System health</span>} subtitle={h?.time ? `Last probe ${new Date(h.time).toLocaleTimeString('en-IN')}` : 'Probing…'} action={h ? <StatusBadge value={h.status} /> : undefined} />
              <div className="grid gap-3 p-5 sm:grid-cols-3">
                <HealthCell icon={<Database className="h-4 w-4" />} label="Database" ok={h?.db?.ok !== false} value={h?.db?.latencyMs != null ? `${h.db.latencyMs.toFixed(1)} ms` : '—'}
                  foot={lat.length > 1 ? <Sparkline values={lat} color={C.success} width={120} height={26} /> : <span className="text-[11px] text-fg-subtle">Trend builds while this page is open</span>} />
                <HealthCell icon={<ServerCog className="h-4 w-4" />} label="Job queue" ok={!h?.jobs?.failed} value={`${fmtNumber(h?.jobs?.queued)} queued`}
                  foot={<span className="text-[11px] text-fg-subtle">{fmtNumber(h?.jobs?.running)} running · <span className={cn(h?.jobs?.failed ? 'text-danger-soft' : '')}>{fmtNumber(h?.jobs?.failed)} failed</span></span>} />
                <HealthCell icon={<Cpu className="h-4 w-4" />} label="Agent fleet" ok={!d?.agents.byHealth?.down} value={`${fmtNumber(d?.agents.byHealth?.healthy ?? 0)} healthy`}
                  foot={<span className="text-[11px] text-fg-subtle">{fmtNumber(d?.agents.suspended)} suspended by moderation</span>} />
              </div>
            </Card>
            <Card className="ax-spot">
              <CardHeader title={<span className="flex items-center gap-2"><Lock className="h-4 w-4 text-danger-soft" aria-hidden />Admin security</span>} action={<Link href="/admin/security" className="text-xs text-gold-soft hover:underline">Open</Link>} />
              <div className="space-y-3 p-5 text-sm">
                {!d ? <Skeleton className="h-28" /> : (<>
                  <Row label="Platform administrators" value={fmtNumber(d.members.admins)} />
                  <Row label="Admins with 2FA" value={`${fmtNumber(d.ops.adminMfa.enabled)} / ${fmtNumber(d.ops.adminMfa.total)}`} warn={d.ops.adminMfa.enabled < d.ops.adminMfa.total} />
                  <Row label="Suspended members" value={fmtNumber(d.members.suspended)} />
                  <Row label="Open fraud flags" value={fmtNumber(d.attention.fraudFlags)} warn={d.attention.highSeverityFraud > 0} />
                  {d.ops.adminMfa.enabled < d.ops.adminMfa.total && <p className="rounded-lg border border-warning/30 bg-warning/10 p-2.5 text-xs text-warning">Some administrator accounts have no two-factor authentication. Enable it in Security.</p>}
                </>)}
              </div>
            </Card>
          </div>
        </>
      )}

      {/* ── Control modules ── */}
      <section aria-label="Control modules">
        <h2 className="mb-3 font-mono text-[11px] uppercase tracking-[0.2em] text-fg-subtle">Control modules</h2>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {MODULES.map((g) => (
            <div key={g.title} className="card p-4">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-gold">{g.title}</p>
              <ul className="space-y-0.5">
                {g.items.map(([href, label, Icon]) => (
                  <li key={href}><Link href={href} className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-fg-muted transition hover:bg-ink-800 hover:text-fg"><Icon className="h-4 w-4 text-fg-subtle group-hover:text-gold" aria-hidden />{label}<ArrowRight className="ml-auto h-3.5 w-3.5 -translate-x-1 opacity-0 transition group-hover:translate-x-0 group-hover:opacity-100" aria-hidden /></Link></li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/* ─────────────────────────── data helpers ─────────────────────────── */

const SERIES_NAME = { signups: 'New members', agents: 'New agents', sessions: 'Training sessions', transactions: 'Ledger transactions' } as const;
const SERIES_COLOR = { signups: C.electric, agents: C.success, sessions: C.violet, transactions: C.gold } as const;

/** % change vs the prior period; null when there is no baseline (never invent a percentage). */
function delta(cur: number, prev: number): { pct: number | null; diff: number } {
  return { pct: prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null, diff: cur - prev };
}

const MODULES: { title: string; items: [string, string, typeof Users][] }[] = [
  { title: 'People & agents', items: [['/admin/users', 'Users', Users], ['/admin/agents', 'Agents', Bot], ['/admin/providers', 'Providers', Plug], ['/admin/training', 'Training oversight', GraduationCap]] },
  { title: 'Quality & trust', items: [['/admin/benchmarks', 'Benchmarks & review', FlaskConical], ['/admin/question-bank', 'Question bank', ClipboardCheck], ['/admin/hive', 'Hive learning', Sparkles], ['/admin/hive-judge', 'Hive Judge', Scale]] },
  { title: 'Safety & money', items: [['/admin/moderation', 'Moderation', ShieldAlert], ['/admin/fraud', 'Fraud flags', Siren], ['/admin/disputes', 'Disputes', Gavel], ['/admin/finance', 'Token economy', Landmark], ['/admin/commissions', 'Commission', Percent], ['/admin/subscriptions', 'Subscriptions', CreditCard]] },
  { title: 'System', items: [['/admin/audit', 'Audit logs', ScrollText], ['/admin/security', 'Security', Lock], ['/admin/settings', 'System settings', Settings], ['/admin/jobs', 'Jobs', ServerCog], ['/admin/health', 'System health', HeartPulse]] },
];

/* ─────────────────────────── pieces ─────────────────────────── */

function AttentionSummary({ a }: { a: CC['attention'] }) {
  const n = attentionItems(a).reduce((s, i) => s + i.count, 0);
  return n === 0 ? <>Nothing needs your decision right now.</> : <><strong className="text-fg">{fmtNumber(n)}</strong> item{n === 1 ? '' : 's'} waiting for your decision.</>;
}

function attentionItems(a: CC['attention']) {
  return [
    { key: 'disputes', label: 'Open disputes', count: a.disputes, href: '/admin/disputes', icon: Gavel, tone: 'danger' as const, hint: 'Escrow frozen until resolved' },
    { key: 'fraud', label: 'Fraud flags', count: a.fraudFlags, href: '/admin/fraud', icon: Siren, tone: a.highSeverityFraud ? 'danger' as const : 'warning' as const, hint: a.highSeverityFraud ? `${a.highSeverityFraud} high severity` : 'Awaiting review' },
    { key: 'reports', label: 'User reports', count: a.reports, href: '/admin/moderation', icon: ShieldAlert, tone: 'warning' as const, hint: 'Content to moderate' },
    { key: 'review', label: 'Human review', count: a.humanReview, href: '/admin/benchmarks', icon: FlaskConical, tone: 'warning' as const, hint: 'Low-confidence grades' },
    { key: 'verify', label: 'Pending verification', count: a.pendingVerification, href: '/admin/agents', icon: ShieldCheck, tone: 'electric' as const, hint: 'Agents awaiting verification' },
    { key: 'listings', label: 'Listings under review', count: a.listingsUnderReview, href: '/admin/moderation', icon: Store, tone: 'electric' as const, hint: 'Marketplace moderation' },
    { key: 'recon', label: 'Reconciliation issues', count: a.reconciliation, href: '/admin/finance', icon: Landmark, tone: 'danger' as const, hint: 'Ledger vs wallet mismatch' },
    { key: 'payouts', label: 'Payout requests', count: a.payouts, href: '/admin/finance', icon: Coins, tone: 'warning' as const, hint: 'Awaiting approval' },
    { key: 'jobs', label: 'Failed jobs', count: a.failedJobs, href: '/admin/jobs', icon: ServerCog, tone: 'danger' as const, hint: 'Retry or investigate' },
  ].filter((i) => i.count > 0).sort((x, y) => (x.tone === 'danger' ? 0 : 1) - (y.tone === 'danger' ? 0 : 1) || y.count - x.count);
}

const ATT_TONE = { danger: 'border-danger/40 bg-danger/[0.06] text-danger-soft', warning: 'border-warning/35 bg-warning/[0.06] text-warning', electric: 'border-electric/30 bg-electric/[0.05] text-electric' } as const;

function AttentionQueue({ d, loading }: { d?: CC; loading: boolean }) {
  if (loading || !d) return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24" />)}</div>;
  const items = attentionItems(d.attention);
  if (!items.length) {
    return (
      <div className="flex items-center gap-3 rounded-2xl border border-success/25 bg-success/[0.05] p-4">
        <CheckCircle2 className="h-5 w-5 text-success" aria-hidden />
        <div><p className="text-sm font-medium">All clear</p><p className="text-xs text-fg-muted">No disputes, fraud flags, reports, reviews, reconciliation issues or failed jobs are waiting.</p></div>
      </div>
    );
  }
  return (
    <section aria-label="Needs your attention">
      <h2 className="mb-3 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.2em] text-fg-subtle"><TriangleAlert className="h-3.5 w-3.5 text-warning" aria-hidden />Needs your attention</h2>
      <StaggerList as="div" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {items.map((i) => (
          <StaggerLi as="div" key={i.key}>
            <Link href={i.href} className={cn('ax-lift group relative flex h-full items-center gap-3 rounded-2xl border p-4 transition hover:brightness-110', ATT_TONE[i.tone])}>
              <i.icon className="h-5 w-5 shrink-0" aria-hidden />
              <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium text-fg">{i.label}</p><p className="truncate text-xs text-fg-muted">{i.hint}</p></div>
              <span className="font-display text-2xl font-semibold tabular-nums">{fmtNumber(i.count)}</span>
              <ArrowRight className="h-4 w-4 opacity-0 transition group-hover:translate-x-0.5 group-hover:opacity-100" aria-hidden />
            </Link>
          </StaggerLi>
        ))}
      </StaggerList>
    </section>
  );
}

const TONES = { gold: 'text-gold border-gold/25 bg-gold/10', electric: 'text-electric border-electric/25 bg-electric/10', violet: 'text-violet border-violet/25 bg-violet/10', success: 'text-success border-success/25 bg-success/10' } as const;
const SPARK = { gold: C.gold, electric: C.electric, violet: C.violet, success: C.success } as const;

function Kpi({ icon, label, value, sub, loading, tone, href, delta: dl, deltaLabel, spark, decimals, idle }: {
  icon: ReactNode; label: string; value?: number | null; sub?: ReactNode; loading?: boolean; tone: keyof typeof TONES; href: string;
  delta?: { pct: number | null; diff: number } | null; deltaLabel?: string; spark?: Point[]; decimals?: number; idle?: boolean;
}) {
  const vals = spark?.map((p) => p.value) ?? [];
  const hasSpark = vals.some((v) => v > 0);
  return (
    <StaggerLi as="div">
      <Link href={href} className="card ax-spot ax-lift group relative block h-full overflow-hidden p-4">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-line to-transparent" aria-hidden />
        <div className="flex items-center justify-between gap-2"><p className="truncate font-mono text-[10.5px] uppercase tracking-[0.14em] text-fg-subtle">{label}</p><span className={cn('rounded-lg border p-1.5', TONES[tone])} aria-hidden>{icon}</span></div>
        {loading ? <Skeleton className="mt-3 h-8 w-20" /> : (
          <div className="mt-2 flex items-end justify-between gap-2">
            <p className="font-display text-2xl font-semibold tabular-nums">
              {value == null ? '—' : idle ? fmtIdle(value) : <AnimatedNumber value={value} format={decimals ? (n) => n.toFixed(decimals) : undefined} />}
            </p>
            {hasSpark && <Sparkline values={vals} color={SPARK[tone]} width={64} height={24} />}
          </div>
        )}
        {!loading && sub && <p className="mt-1 truncate text-[11px] text-fg-subtle">{sub}</p>}
        {!loading && dl && <Delta {...dl} label={deltaLabel} />}
      </Link>
    </StaggerLi>
  );
}

function Delta({ pct, diff, label }: { pct: number | null; diff: number; label?: string }) {
  const up = diff > 0; const flat = diff === 0;
  const Icon = flat ? Minus : up ? ArrowUpRight : ArrowDownRight;
  return (
    <p className={cn('mt-1.5 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium', flat ? 'bg-ink-800 text-fg-subtle' : up ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger-soft')}>
      <Icon className="h-3 w-3" aria-hidden />{flat ? 'flat' : `${up ? '+' : ''}${diff}${pct != null ? ` (${pct > 0 ? '+' : ''}${pct}%)` : ''}`}<span className="font-normal text-fg-subtle">{label}</span>
    </p>
  );
}

function StatusPill({ tone, children }: { tone: 'ok' | 'warning' | 'down' | 'checking'; children: ReactNode }) {
  const map = { ok: ['success', 'border-success/30 bg-success/10 text-success'], warning: ['warning', 'border-warning/30 bg-warning/10 text-warning'], down: ['danger', 'border-danger/40 bg-danger/10 text-danger-soft'], checking: ['idle', 'border-line bg-ink-900/70 text-fg-muted'] } as const;
  const [dot, cls] = map[tone];
  return <span className={cn('inline-flex items-center gap-2 rounded-full border px-3 py-1 font-medium', cls)}><PulseDot tone={dot} />{children}</span>;
}

function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: [T, string][] }) {
  return (
    <div role="tablist" aria-label="Chart series" className="flex flex-wrap gap-0.5 rounded-xl border border-line/70 bg-ink-950/60 p-0.5">
      {options.map(([k, l]) => (
        <button key={k} role="tab" aria-selected={value === k} onClick={() => onChange(k)}
          className={cn('rounded-lg px-2.5 py-1 text-xs transition', value === k ? 'bg-gold/15 font-medium text-gold-soft shadow-[inset_0_0_0_1px_rgb(var(--gold)/0.3)]' : 'text-fg-muted hover:text-fg')}>{l}</button>
      ))}
    </div>
  );
}

function EconRow({ label, value, tone, total }: { label: string; value: number; tone: string; total: number }) {
  const reduce = useReducedMotion();
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-sm"><span className="text-fg-muted">{label}</span><span className="font-medium tabular-nums">{fmtIdle(value)}</span></div>
      <div className="h-1.5 overflow-hidden rounded-full bg-ink-800"><motion.div className={cn('h-full rounded-full', tone)} initial={reduce ? false : { width: 0 }} animate={{ width: `${total ? Math.max(value ? 2 : 0, (value / total) * 100) : 0}%` }} transition={{ duration: 0.9, ease: [0.2, 0.7, 0.2, 1] }} /></div>
    </div>
  );
}

function Mini({ label, value, icon }: { label: string; value: string; icon: ReactNode }) {
  return <div className="rounded-lg bg-ink-950/50 p-2.5"><p className="flex items-center gap-1.5 text-fg-subtle">{icon}{label}</p><p className="mt-1 truncate font-medium text-fg">{value}</p></div>;
}

function Row({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return <div className="flex items-center justify-between"><span className="text-fg-muted">{label}</span><span className={cn('font-medium tabular-nums', warn && 'text-warning')}>{value}</span></div>;
}

function DistCard({ title, icon, data, colors, loading, empty }: { title: string; icon: ReactNode; data?: Record<string, number>; colors: Record<string, string>; loading?: boolean; empty: string }) {
  const reduce = useReducedMotion();
  const entries = Object.entries(data ?? {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, [, v]) => s + v, 0);
  return (
    <Card className="ax-spot">
      <CardHeader title={<span className="flex items-center gap-2">{icon}{title}</span>} subtitle={total ? `${fmtNumber(total)} total` : undefined} />
      <div className="p-5">
        {loading ? <Skeleton className="h-24" /> : !total ? <p className="py-6 text-center text-sm text-fg-subtle">{empty}</p> : (
          <>
            <div className="flex h-2.5 overflow-hidden rounded-full bg-ink-800" role="img" aria-label={entries.map(([k, v]) => `${v} ${k}`).join(', ')}>
              {entries.map(([k, v]) => <motion.span key={k} className={cn('h-full', colors[k] ?? 'bg-fg-subtle')} initial={reduce ? false : { width: 0 }} animate={{ width: `${(v / total) * 100}%` }} transition={{ duration: 0.9, ease: [0.2, 0.7, 0.2, 1] }} />)}
            </div>
            <ul className="mt-4 space-y-1.5">
              {entries.map(([k, v]) => (
                <li key={k} className="flex items-center gap-2 text-sm"><span className={cn('h-2 w-2 rounded-full', colors[k] ?? 'bg-fg-subtle')} aria-hidden /><span className="capitalize text-fg-muted">{k.replace(/_/g, ' ')}</span><span className="ml-auto tabular-nums">{fmtNumber(v)}</span><span className="w-10 text-right text-xs tabular-nums text-fg-subtle">{Math.round((v / total) * 100)}%</span></li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Card>
  );
}

function HealthCell({ icon, label, value, ok, foot }: { icon: ReactNode; label: string; value: ReactNode; ok: boolean; foot?: ReactNode }) {
  return (
    <div className={cn('relative overflow-hidden rounded-xl border bg-ink-950/40 p-4', ok ? 'border-success/20' : 'border-danger/40')}>
      <div className={cn('pointer-events-none absolute -right-6 -top-6 h-16 w-16 rounded-full blur-2xl', ok ? 'bg-success/15' : 'bg-danger/20')} aria-hidden />
      <p className="relative flex items-center gap-2 text-xs text-fg-muted"><span className="text-fg-subtle">{icon}</span>{label}<span className="ml-auto"><PulseDot tone={ok ? 'success' : 'danger'} label={ok ? `${label} ok` : `${label} needs attention`} /></span></p>
      <p className="relative mt-2 font-display text-xl font-semibold tabular-nums">{value}</p>
      <div className="relative mt-2 min-h-[26px]">{foot}</div>
    </div>
  );
}
