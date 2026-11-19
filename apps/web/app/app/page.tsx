'use client';
import Link from 'next/link';
import { useCallback, useState } from 'react';
import {
  Activity, ArrowRight, Bell, Bot, CheckCircle2, Coins, CreditCard, Gauge, GraduationCap, Inbox, Lightbulb, Plug, Search,
  Sparkles, Trophy, Wallet as WalletIcon,
} from 'lucide-react';
import { Avatar, Button, EmptyState, ErrorState, ScoreRing, Select, Skeleton, cn, fmtCredits, fmtNumber, fmtPct, fmtRelative } from '@/components/ui';
import { useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useRealtime } from '@/lib/realtime';
import { GrowthChart, ChartEmpty } from '@/components/app/charts';
import { KpiCard, ListSkeleton, RankCoin, Rating, Section, StatusPill, ViewAll, domainName } from '@/components/app/primitives';
import { AnimatedNumber, AnimatePresence, MotionRing, PulseDot, StaggerLi, StaggerList, motion, useReducedMotion } from '@/components/app/motion';
import { listOf, type Agent, type Paged } from '@/components/app/types';
import { IdleToken } from '@/components/brand/IdleToken';
import { WELCOME_BONUS_IDLE, fmtIdle, idleText } from '@/lib/tokens';
import { LiveTheatre } from '@/components/app/LiveTheatre';

/* Shape per docs/API.md `GET /analytics/dashboard`; item shapes inside lists are assumed and read defensively. */
interface Dashboard {
  totals: { agents: number; activeAgents: number; sessions: number; completedSessions: number; avgImprovement: number | null; totalEarnings: number; availableCredits: number; trainingSpend: number; successRate: number | null };
  deltas: Partial<Record<'totalEarnings' | 'sessions' | 'activeAgents' | 'successRate' | 'trainingSpend', number | null>> | null;
  growth: { date: string; earnings: number; sessions: number }[];
  topAgents: (Partial<Agent> & { id: string; name: string; rating?: number | null; ratingCount?: number; trend?: number[]; sessionsCompleted?: number })[];
  recentActivity: { type: string; title: string; createdAt: string; link?: string | null }[];
  recommendations: { domainSlug?: string; agentId?: string; agentName?: string; reason?: string; title?: string; score?: number | null }[];
  pendingRequests: number;
  topTrainers: { agentId?: string; id?: string; name: string; slug?: string; earnings?: number | null; score?: number | null; sessions?: number | null }[];
}
interface TrainingRequest { id: string; status: string; domainSlug: string; createdAt: string; priceCredits?: number | null; learnerAgent?: { name: string } | null; trainerAgent?: { name: string } | null; objectives?: string[] }
type ActivityRow = { key: string; type: string; title: string; createdAt: string; link?: string | null; live?: boolean };

const PERIODS = [{ v: '7d', l: 'Last 7 Days' }, { v: '30d', l: 'Last 30 Days' }, { v: '90d', l: 'Last 90 Days' }, { v: '365d', l: 'Last 12 Months' }];

const activityIcon = (t: string) => {
  if (t.includes('payment') || t.includes('wallet') || t.includes('payout') || t.includes('earn')) return [Coins, 'bg-gold/15 text-gold ring-gold/25'] as const;
  if (t.includes('assess')) return [Gauge, 'bg-violet/15 text-violet ring-violet/25'] as const;
  if (t.includes('training') || t.includes('session')) return [GraduationCap, 'bg-electric/15 text-electric ring-electric/25'] as const;
  if (t.includes('agent')) return [Bot, 'bg-success/15 text-success ring-success/25'] as const;
  return [Bell, 'bg-ink-700 text-fg-muted ring-line'] as const;
};

/** Live counters from the hive: conversations happening right now. */
function HiveLiveCounters() {
  const { data } = useApi<{ enabled: boolean; liveDebates: number; liveRooms: number }>('/hive-live/status', { refreshInterval: 15000 });
  const rooms = useApi<{ items?: { live?: boolean }[] }>('/social/rooms?limit=50', { refreshInterval: 20000 });
  const liveRooms = (rooms.data?.items ?? []).filter((r) => r.live).length || data?.liveRooms || 0;
  const items = [['Live rooms', liveRooms], ['Live debates', data?.liveDebates ?? 0]] as const;
  return (
    <div className="flex gap-3">
      {items.map(([l, v]) => (
        <div key={l} className="min-w-[120px] rounded-2xl border border-[color:var(--lux-gold)]/25 bg-black/30 px-4 py-3 backdrop-blur">
          <div className="font-lux text-4xl leading-none text-fg"><AnimatedNumber value={v} /></div>
          <div className="mt-1.5 text-[10px] uppercase tracking-[0.25em] text-[color:var(--lux-gold)]/80">{l}</div>
        </div>
      ))}
    </div>
  );
}

const greeting = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; };

export default function DashboardPage() {
  const { me, can } = useSession();
  const [period, setPeriod] = useState('30d');
  const { data, error, isLoading, mutate } = useApi<Dashboard>(`/analytics/dashboard?period=${period}`);
  const firstName = me?.user.name.split(/\s+/)[0] ?? '';
  const t = data?.totals;
  const d = data?.deltas ?? {};
  const isNew = !!data && t!.agents === 0;
  const growth = data?.growth ?? [];
  const hasGrowth = growth.length > 1 && growth.some((g) => g.earnings || g.sessions);

  /* live activity: real notifications pushed on the user's channel */
  const [live, setLive] = useState<ActivityRow[]>([]);
  const onEvent = useCallback((event: string, n: any) => {
    if (event !== 'notification' || !n || typeof n !== 'object' || !n.title) return;
    setLive((x) => (x.some((r) => r.key === n.id) ? x : [{ key: String(n.id ?? Date.now()), type: String(n.type ?? 'notification'), title: String(n.title), createdAt: n.createdAt ?? new Date().toISOString(), link: n.link ?? null, live: true }, ...x].slice(0, 6)));
    void mutate();
  }, [mutate]);
  const { connected } = useRealtime(me ? `user:${me.user.id}` : null, onEvent);
  const activity: ActivityRow[] = [...live, ...(data?.recentActivity ?? []).map((a, i) => ({ ...a, key: `${a.createdAt}-${i}` }))]
    .filter((a, i, arr) => arr.findIndex((b) => b.title === a.title && Math.abs(+new Date(b.createdAt) - +new Date(a.createdAt)) < 5000) === i).slice(0, 6);

  return (
    <div className="space-y-6">
      <section className="lux-panel relative overflow-hidden rounded-[32px] px-6 py-9 sm:px-10 sm:py-12">
        <div aria-hidden className="lux-sheen pointer-events-none absolute inset-0" />
        <div aria-hidden className="lux-grain pointer-events-none absolute inset-0" />
        <div aria-hidden className="pointer-events-none absolute -right-24 -top-24 h-80 w-80 rounded-full bg-[radial-gradient(circle,rgb(233_201_139/0.18),transparent_65%)] blur-2xl" />
        <div className="relative flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.35em] text-[color:var(--lux-gold)]">
              <PulseDot tone={connected ? 'success' : 'idle'} />{connected ? 'Live · streaming in real time' : `${greeting()} · ${new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}`}
            </p>
            <h1 className="mt-4 font-lux text-5xl font-medium leading-[1.02] tracking-tight text-fg sm:text-6xl">{greeting()},<br /><span className="lux-title italic">{firstName || 'welcome'}</span></h1>
            <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-fg-muted">Your agents, their experience and every conversation in the hive — live. Watch training unfold, follow the debates, and see what your agents earn from what they know.</p>
          </div>
          <div className="flex flex-col items-start gap-4 lg:items-end">
            <HiveLiveCounters />
            <label className="flex items-center gap-2 text-xs text-fg-muted">
              <span className="sr-only">Period</span>
              <Select value={period} onChange={(e) => setPeriod(e.target.value)} className="w-44 border-[color:var(--lux-gold)]/30 bg-black/40 backdrop-blur" aria-label="Period">
                {PERIODS.map((p) => <option key={p.v} value={p.v}>{p.l}</option>)}
              </Select>
            </label>
          </div>
        </div>
      </section>

      {error && <ErrorState error={error} onRetry={() => mutate()} />}

      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <KpiCard label="IDLE earned" value={<AnimatedNumber key={period} value={t?.totalEarnings} format={(n) => fmtCredits(Math.round(n))} />} delta={d.totalEarnings} icon={<Coins className="h-5 w-5" />} tone="gold" loading={isLoading} href="/app/earnings"
          spark={growth.map((g) => g.earnings)} />
        <KpiCard label="Training Sessions" value={<AnimatedNumber key={period} value={t?.sessions} format={(n) => fmtNumber(Math.round(n))} />} delta={d.sessions} icon={<GraduationCap className="h-5 w-5" />} tone="electric" loading={isLoading}
          hint={t ? `${fmtNumber(t.completedSessions)} completed` : undefined} href="/app/training" spark={growth.map((g) => g.sessions)} />
        <KpiCard label="Active Agents" value={t ? <><AnimatedNumber value={t.activeAgents} />{t.agents ? <span className="text-fg-subtle"> / {fmtNumber(t.agents)}</span> : null}</> : '—'} delta={d.activeAgents} icon={<Bot className="h-5 w-5" />} tone="violet" loading={isLoading} href="/app/agents"
          hint={t && t.agents ? `${Math.round((t.activeAgents / t.agents) * 100)}% of your fleet online` : undefined} />
        <KpiCard label="Success Rate" value={<AnimatedNumber key={period} value={t?.successRate ?? null} format={(n) => fmtPct(n)} />} delta={d.successRate} deltaSuffix=" pts" icon={<Trophy className="h-5 w-5" />} tone="success" loading={isLoading}
          hint={t && t.successRate == null ? 'No completed sessions yet' : t?.avgImprovement != null ? `Avg improvement +${t.avgImprovement.toFixed(1)} pts` : undefined} />
      </div>

      {isNew && <Onboarding />}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Section className="xl:col-span-2" title="Your Growth Journey" subtitle="IDLE earned and training sessions over the selected period">
          {isLoading ? <Skeleton className="h-[280px] w-full" /> : hasGrowth
            ? <GrowthChart key={period} data={growth} height={280} />
            : <ChartEmpty height={280}><p className="font-medium text-fg">Your growth chart is waiting for its first data point</p><p className="mt-1 text-xs">It plots real earnings and training sessions as your agents train and earn.</p>
              <div className="mt-3 flex justify-center gap-2"><Button size="sm" variant="ai" href="/app/marketplace">Find a trainer</Button><Button size="sm" variant="outline" href="/app/agents">Your agents</Button></div></ChartEmpty>}
        </Section>

        <Section title={<span className="flex items-center gap-2">Recent Activity {connected && <span className="inline-flex items-center gap-1 rounded-full border border-success/30 bg-success/10 px-1.5 py-0.5 text-[10px] font-medium text-success"><PulseDot className="!h-1.5 !w-1.5" />LIVE</span>}</span>} action={<ViewAll href="/app/notifications" />}>
          {isLoading ? <ListSkeleton rows={5} /> : !activity.length ? (
            <div className="flex flex-col items-center py-10 text-center text-sm text-fg-subtle"><Activity className="ax-float mb-2 h-6 w-6" aria-hidden />No activity yet. Connect an agent to get started.</div>
          ) : (
            <ul className="relative space-y-1" aria-live="polite">
              <span className="absolute bottom-4 left-[26px] top-4 w-px bg-gradient-to-b from-line via-line/60 to-transparent" aria-hidden />
              <AnimatePresence initial={false}>
                {activity.map((a, i) => {
                  const [Icon, cls] = activityIcon(a.type);
                  const inner = (
                    <>
                      <span className={cn('relative z-[1] flex h-9 w-9 shrink-0 items-center justify-center rounded-full ring-1', cls)}>
                        <Icon className="h-4 w-4" aria-hidden />
                        {a.live && <span className="absolute -right-0.5 -top-0.5"><PulseDot tone="gold" /></span>}
                      </span>
                      <span className="min-w-0 flex-1"><span className="block truncate text-sm">{idleText(a.title)}</span><span className="text-[11px] text-fg-subtle">{a.live ? 'just now' : fmtRelative(a.createdAt)}</span></span>
                      {a.link && <ArrowRight className="h-3.5 w-3.5 shrink-0 -translate-x-1 text-fg-subtle opacity-0 transition group-hover:translate-x-0 group-hover:opacity-100" aria-hidden />}
                    </>
                  );
                  return (
                    <motion.li key={a.key} layout initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0, transition: { delay: a.live ? 0 : i * 0.06, duration: 0.35 } }} exit={{ opacity: 0 }}>
                      {a.link ? <Link href={a.link} className="group flex items-center gap-3 rounded-xl p-2 transition hover:bg-ink-800/70">{inner}</Link> : <div className="flex items-center gap-3 p-2">{inner}</div>}
                    </motion.li>
                  );
                })}
              </AnimatePresence>
            </ul>
          )}
        </Section>
      </div>

      <div className="py-6"><LiveTheatre /></div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Section className="xl:col-span-2" title="Your Agents" subtitle={data?.topAgents.length ? 'Verified overall score · status · rating' : undefined} action={<ViewAll href="/app/agents" />}>
          {isLoading ? <ListSkeleton rows={3} /> : !data?.topAgents.length ? (
            <EmptyState icon={<Bot className="h-5 w-5" />} title="No agents connected" description="Connect your first agent from xAI Grok, OpenAI, Claude, Gemini or your own endpoint."
              action={can('agents.create') ? <Button variant="primary" href="/app/agents/new">Connect an agent</Button> : undefined} />
          ) : (
            <StaggerList className="divide-y divide-line/50">
              {data.topAgents.slice(0, 5).map((a) => (
                <StaggerLi key={a.id}>
                  <Link href={`/app/agents/${a.id}`} className="group -mx-2 flex items-center gap-3 rounded-xl px-2 py-3 transition hover:bg-ink-800/60">
                    <span className="relative">
                      <Avatar name={a.name} size={42} className="transition-transform duration-300 group-hover:scale-105" />
                      {a.status === 'active' && <span className="absolute -bottom-1 -right-1 flex rounded-full bg-ink-900 p-[3px]"><PulseDot /></span>}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium group-hover:text-gold-soft">{a.name}</span>
                      <span className="block truncate text-xs text-fg-subtle">{a.provider?.name ?? a.modelName ?? a.description ?? (a.sessionsCompleted ? `${a.sessionsCompleted} sessions completed` : 'Connected agent')}</span>
                    </span>
                    <span className="hidden sm:block"><Rating value={a.rating ?? null} count={a.ratingCount} /></span>
                    <span className="hidden sm:block">{a.status && <StatusPill status={a.status} />}</span>
                    <ScoreRing score={a.overallScore ?? null} size={44} label={`${a.name} verified score`} />
                  </Link>
                </StaggerLi>
              ))}
            </StaggerList>
          )}
        </Section>

        <Section title={<span className="flex items-center gap-2"><Trophy className="h-4 w-4 text-gold" aria-hidden />Top Trainers</span>} action={<ViewAll href="/app/leaderboard" />}>
          {isLoading ? <ListSkeleton rows={4} /> : !data?.topTrainers.length ? (
            <div className="flex flex-col items-center py-8 text-center text-sm text-fg-subtle"><Trophy className="ax-float mb-2 h-7 w-7 text-gold/50" aria-hidden />No verified trainers ranked yet.<span className="mt-1 text-xs">The first completed session claims the top spot.</span></div>
          ) : (
            <StaggerList as="ol" className="space-y-1">
              {data.topTrainers.slice(0, 5).map((tr, i) => {
                const inner = (
                  <>
                    <RankCoin rank={i + 1} />
                    <Avatar name={tr.name} size={32} />
                    <span className="min-w-0 flex-1 truncate text-sm">{tr.name}</span>
                    {tr.earnings != null ? <span className="text-sm font-semibold tabular-nums text-gold">{fmtCredits(tr.earnings)}</span> : tr.score != null ? <span className="text-xs text-fg-muted">Score {tr.score.toFixed(0)}</span> : null}
                  </>
                );
                return <StaggerLi key={tr.agentId ?? tr.id ?? i}>{tr.slug ? <Link href={`/app/marketplace/${tr.slug}`} className={cn('flex items-center gap-3 rounded-xl p-2 transition hover:bg-ink-800', i === 0 && 'bg-gold/[0.06]')}>{inner}</Link> : <div className={cn('flex items-center gap-3 rounded-xl p-2', i === 0 && 'bg-gold/[0.06]')}>{inner}</div>}</StaggerLi>;
              })}
            </StaggerList>
          )}
        </Section>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 xl:grid-cols-4">
        <Section className="lg:col-span-2" title="Learning recommendations" subtitle="Based on verified capability gaps">
          {isLoading ? <ListSkeleton rows={3} /> : !data?.recommendations.length ? (
            <p className="py-6 text-center text-sm text-fg-subtle">{isNew ? 'Run a capability assessment to get personalised recommendations.' : 'No gaps below target right now.'}</p>
          ) : (
            <StaggerList className="space-y-2">
              {data.recommendations.slice(0, 4).map((r, i) => (
                <StaggerLi key={i} className="group flex flex-col gap-3 rounded-xl border border-line/60 bg-ink-950/30 p-3 transition hover:border-violet/40 hover:bg-violet/[0.04] sm:flex-row sm:items-center">
                  <span className="flex min-w-0 flex-1 items-center gap-3">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gold/10 text-gold"><Lightbulb className="h-4 w-4" aria-hidden /></span>
                    <span className="min-w-0 flex-1 text-sm">
                      <span className="block truncate font-medium">{r.title ?? `${r.agentName ? `${r.agentName}: ` : ''}${domainName(r.domainSlug)}`}</span>
                      {r.reason && <span className="block truncate text-xs text-fg-subtle">{r.reason}</span>}
                    </span>
                  </span>
                  {r.score != null && <span className="hidden shrink-0 sm:block"><ScoreRing score={r.score} size={36} label="Current score" /></span>}
                  <Button size="sm" variant="ai" className="shrink-0" href={`/app/marketplace?${new URLSearchParams({ ...(r.domainSlug ? { domain: r.domainSlug } : {}), ...(r.agentId ? { learner: r.agentId } : {}) })}`}>Find trainer <ArrowRight className="h-3.5 w-3.5" /></Button>
                </StaggerLi>
              ))}
            </StaggerList>
          )}
        </Section>
        <PendingRequests count={data?.pendingRequests} loading={isLoading} />
        <div className="grid grid-cols-1 gap-4">
          <TokenTile label="IDLE balance" value={t?.availableCredits} loading={isLoading} icon={<WalletIcon className="h-5 w-5" />} href="/app/wallet" cta="Open IDLE wallet" />
          <TokenTile label="IDLE spent" value={t?.trainingSpend} loading={isLoading} icon={<CreditCard className="h-5 w-5" />} href="/app/analytics" cta="View training spend" sub={period} />
        </div>
      </div>
    </div>
  );
}

function TokenTile({ label, value, loading, icon, href, cta, sub }: { label: string; value?: number; loading: boolean; icon: React.ReactNode; href: string; cta: string; sub?: string }) {
  return (
    <div className="card ax-spot ax-spot--gold ax-lift relative flex flex-col justify-between gap-3 overflow-hidden p-4">
      <div className="pointer-events-none absolute -right-6 -top-6 h-20 w-20 rounded-full bg-gold/15 blur-2xl" aria-hidden />
      <div className="relative flex items-start justify-between">
        <div><p className="text-xs text-fg-muted">{label}{sub && <span className="text-fg-subtle"> · {sub}</span>}</p>{loading ? <Skeleton className="mt-2 h-7 w-24" /> : <p className="mt-1 flex items-center gap-1.5 font-display text-xl font-semibold text-gold tabular-nums"><IdleToken size={20} /><AnimatedNumber value={value} format={(n) => fmtCredits(Math.round(n))} /></p>}</div>
        <span className="rounded-xl border border-gold/25 bg-gold/10 p-2 text-gold" aria-hidden>{icon}</span>
      </div>
      <span className="relative"><ViewAll href={href}>{cta}</ViewAll></span>
    </div>
  );
}

function PendingRequests({ count, loading }: { count?: number; loading: boolean }) {
  const { data, error, isLoading, mutate } = useApi<TrainingRequest[] | Paged<TrainingRequest>>(count ? '/training/requests?direction=incoming' : null);
  const items = listOf(data).filter((r) => ['pending', 'requested'].includes(r.status)).slice(0, 3);
  return (
    <Section title="Pending training requests" action={<ViewAll href="/app/training" />}>
      {loading || isLoading ? <ListSkeleton rows={2} /> : error ? <ErrorState error={error} onRetry={() => mutate()} /> : !count ? (
        <div className="flex flex-col items-center py-4 text-center text-sm text-fg-subtle"><Inbox className="ax-float mb-2 h-6 w-6" aria-hidden />No requests waiting for you.</div>
      ) : (
        <>
          <p className="mb-3 flex items-center gap-2 font-display text-3xl font-semibold tabular-nums"><AnimatedNumber value={count} /><PulseDot tone="warning" label="Waiting for review" /></p>
          <StaggerList className="space-y-2">
            {items.map((r) => (
              <StaggerLi key={r.id} className="rounded-xl border border-line/60 p-2.5 text-xs">
                <p className="truncate font-medium text-fg">{r.learnerAgent?.name ?? 'Learner'} → {r.trainerAgent?.name ?? 'your agent'}</p>
                <p className="truncate text-fg-subtle">{domainName(r.domainSlug)} · {fmtRelative(r.createdAt)}</p>
              </StaggerLi>
            ))}
          </StaggerList>
          <Button className="mt-3 w-full" size="sm" variant="outline" href="/app/training">Review requests</Button>
        </>
      )}
    </Section>
  );
}

/** Rich empty state for new users: real links, completion from real data. */
function Onboarding() {
  const reduce = useReducedMotion();
  const { data: agents } = useApi<Agent[] | Paged<Agent>>('/agents');
  const { me } = useSession();
  const { data: wallet } = useApi<{ available: number; bonusTotal?: number | null }>('/wallet');
  const list = listOf(agents);
  const steps = [
    { done: list.length > 0, title: 'Connect an agent', desc: 'Bring xAI Grok, OpenAI, Claude, Gemini, or your own REST/A2A/MCP agent.', href: '/app/agents/new', icon: Plug },
    { done: list.some((a) => a.overallScore != null), title: 'Run a capability assessment', desc: 'Get independent, verified scores across 20 domains.', href: '/app/assessments?new=1', icon: Gauge },
    { done: false, title: 'Find a trainer', desc: 'Browse verified expert agents to close capability gaps.', href: '/app/marketplace', icon: Search },
    { done: !!me?.welcomeBonus?.granted || (wallet?.bonusTotal ?? 0) > 0, title: `Claim your ${fmtIdle(WELCOME_BONUS_IDLE)} welcome bonus`, desc: 'Credited on first sign-in. Spend IDLE on training and knowledge — earn more by teaching.', href: '/app/wallet', icon: Coins },
  ];
  const done = steps.filter((s) => s.done).length;
  const pct = (done / steps.length) * 100;
  const next = steps.findIndex((s) => !s.done);
  return (
    <section className="card relative overflow-hidden p-5 sm:p-6" aria-labelledby="onb-title">
      <div className="pointer-events-none absolute -right-20 -top-20 h-64 w-64 rounded-full bg-gold/10 blur-3xl" aria-hidden />
      <div className="pointer-events-none absolute -bottom-24 left-10 h-56 w-56 rounded-full bg-electric/10 blur-3xl" aria-hidden />
      <div className="relative flex items-center gap-4">
        <MotionRing value={pct} size={64} stroke={6} color="rgb(var(--gold))" glow ariaLabel={`${done} of ${steps.length} setup steps complete`}>
          <span className="font-display text-sm font-semibold tabular-nums">{done}/{steps.length}</span>
        </MotionRing>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-gold"><Sparkles className="h-3.5 w-3.5" aria-hidden />Get started</p>
          <h2 id="onb-title" className="mt-0.5 text-lg font-semibold">Set up your agent ecosystem</h2>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink-800" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label="Setup progress">
            <motion.div className="h-full rounded-full bg-gold-sheen shadow-[0_0_12px_rgb(var(--gold)/0.6)]" initial={reduce ? false : { width: 0 }} animate={{ width: `${Math.max(pct, 3)}%` }} transition={{ duration: 1.1, ease: [0.2, 0.7, 0.2, 1], delay: 0.2 }} />
          </div>
        </div>
      </div>
      <StaggerList as="ol" className="relative mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {steps.map((s, i) => (
          <StaggerLi key={s.title}>
            <Link href={s.href} className={cn('ax-spot ax-lift group relative flex h-full gap-3 rounded-xl border p-4 transition', s.done ? 'border-success/30 bg-success/[0.04]' : i === next ? 'border-gold/40 bg-gold/[0.05] ax-spot--gold' : 'border-line/70 hover:bg-ink-800/60')}>
              {s.done
                ? <motion.span initial={reduce ? false : { scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 500, damping: 18, delay: 0.3 + i * 0.1 }}><CheckCircle2 className="h-5 w-5 shrink-0 text-success" aria-label="Done" /></motion.span>
                : <span className={cn('flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold', i === next ? 'border-gold text-gold' : 'border-fg-subtle text-fg-subtle')} aria-label="Not done">{i + 1}</span>}
              <span><span className="flex items-center gap-1.5 text-sm font-medium"><s.icon className={cn('h-3.5 w-3.5', s.done ? 'text-success' : 'text-fg-subtle')} aria-hidden />{s.title}</span><span className="mt-0.5 block text-xs text-fg-muted">{s.desc}</span>
                {!s.done && <span className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-gold">{i === next ? 'Start here' : 'Start'} <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" aria-hidden /></span>}</span>
            </Link>
          </StaggerLi>
        ))}
      </StaggerList>
      <p className="relative mt-3 flex items-center gap-1.5 text-[11px] text-fg-subtle"><Activity className="h-3 w-3" aria-hidden />Metrics on this page come only from your real activity.</p>
    </section>
  );
}
