'use client';
import { useState } from 'react';
import { AlertTriangle, Download, Repeat } from 'lucide-react';
import { ErrorState, PageHeader, Select, Skeleton, Table, Td, fmtCredits, fmtDate, fmtNumber, fmtPct } from '@/components/ui';
import { useApi } from '@/lib/api';
import { AreaTrend, BarList, BarTrend, BigRing, ChartEmpty, C } from '@/components/app/charts';
import { Delta, Section, StatusPill, domainName } from '@/components/app/primitives';

/* Assumed shape for GET /analytics/performance (API.md lists fields only). All fields optional & read defensively. */
interface Perf {
  learningImprovement?: { value: number | null; delta?: number | null; series?: { date: string; value: number }[] } | null;
  byDomain?: { domainSlug?: string; slug?: string; improvement: number | null; sessions?: number }[];
  topSkills?: { name?: string; skill?: string; slug?: string; value?: number | null; improvement?: number | null; score?: number | null }[];
  earningsTrend?: { date: string; earnings?: number; value?: number }[];
  trainingCosts?: { total?: number; series?: { date: string; spend?: number; value?: number }[] } | { date: string; spend?: number; value?: number }[];
  repeatTraining?: { count?: number; rate?: number | null } | number | null;
  failedSessions?: { count?: number; items?: { id: string; domainSlug?: string; createdAt: string; reason?: string | null; status?: string }[] } | number | null;
}

const PERIODS = [{ v: '30d', l: 'Last 30 Days' }, { v: '90d', l: 'Last 90 Days' }, { v: '365d', l: 'Last 12 Months' }, { v: 'all', l: 'All time' }];
const num = (x: unknown, k: string) => (typeof x === 'number' ? x : x && typeof x === 'object' ? ((x as Record<string, unknown>)[k] as number | undefined) ?? null : null);

export default function AnalyticsPage() {
  const [period, setPeriod] = useState('30d');
  const { data, error, isLoading, mutate } = useApi<Perf>(`/analytics/performance?period=${period}`);
  const li = data?.learningImprovement;
  const costSeries = Array.isArray(data?.trainingCosts) ? data!.trainingCosts : data?.trainingCosts?.series ?? [];
  const costTotal = !Array.isArray(data?.trainingCosts) ? data?.trainingCosts?.total : costSeries.reduce((s, r) => s + (r.spend ?? r.value ?? 0), 0);
  const failed = data?.failedSessions;
  const failedItems = typeof failed === 'object' && failed ? failed.items ?? [] : [];

  return (
    <div className="space-y-6">
      <PageHeader title="Performance Analytics" description="Verified learning outcomes, earnings and training costs across your agents."
        actions={<>
          <Select aria-label="Period" value={period} onChange={(e) => setPeriod(e.target.value)} className="w-40">{PERIODS.map((p) => <option key={p.v} value={p.v}>{p.l}</option>)}</Select>
          {(['sessions', 'transactions', 'assessments'] as const).map((r) => (
            <a key={r} href={`/api/analytics/export?report=${r}&format=csv`} download className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-line px-3 text-sm hover:bg-ink-800"><Download className="h-4 w-4" aria-hidden />{r[0]!.toUpperCase() + r.slice(1)} CSV</a>
          ))}
        </>} />
      {error && <ErrorState error={error} onRetry={() => mutate()} />}

      <div className="grid gap-6 lg:grid-cols-3">
        <Section title="Learning Improvement" subtitle="Average post − pre score across completed training">
          {isLoading ? <Skeleton className="mx-auto h-36 w-36 rounded-full" /> : (
            <div className="flex flex-col items-center gap-3">
              <BigRing value={li?.value ?? null} label="Learning improvement" sub="avg improvement" />
              {li?.delta != null && <Delta value={li.delta} suffix=" pts" />}
              {li?.series && li.series.length > 1 && <div className="w-full"><BarTrend data={li.series} xKey="date" yKey="value" name="Improvement" height={80} color={C.success} xFormatter={(s) => fmtDate(s)} /></div>}
              {li?.value == null && <p className="text-center text-xs text-fg-subtle">No completed training with post-assessment yet.</p>}
            </div>
          )}
        </Section>
        <Section title="Top Skills Acquired" className="lg:col-span-2">
          {isLoading ? <Skeleton className="h-44" /> : (
            <BarList items={(data?.topSkills ?? []).slice(0, 6).map((s) => ({ label: s.name ?? s.skill ?? s.slug ?? '—', value: s.value ?? s.improvement ?? s.score ?? null }))}
              empty={<ChartEmpty height={160}>Skills appear after verified training improvements.</ChartEmpty>} />
          )}
        </Section>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Earnings Trend">
          {isLoading ? <Skeleton className="h-56" /> : data?.earningsTrend?.length ? (
            <AreaTrend data={data.earningsTrend.map((r) => ({ date: r.date, v: r.earnings ?? r.value ?? 0 }))} xKey="date" yKey="v" name="IDLE earned" />
          ) : <ChartEmpty />}
        </Section>
        <Section title="IDLE spent on training" subtitle={costTotal != null ? `Total ${fmtCredits(costTotal)}` : undefined}>
          {isLoading ? <Skeleton className="h-56" /> : costSeries.length ? (
            <BarTrend data={costSeries.map((r) => ({ date: r.date, v: r.spend ?? r.value ?? 0 }))} xKey="date" yKey="v" name="IDLE spent" color={C.gold} xFormatter={(s) => fmtDate(s)} />
          ) : <ChartEmpty />}
        </Section>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Section title="Improvement by domain" className="lg:col-span-2">
          {isLoading ? <Skeleton className="h-40" /> : (
            <BarList tone="success" format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} pts`} max={Math.max(10, ...(data?.byDomain ?? []).map((d) => Math.abs(d.improvement ?? 0)))}
              items={(data?.byDomain ?? []).map((d) => ({ key: d.domainSlug ?? d.slug, label: domainName(d.domainSlug ?? d.slug), value: d.improvement, hint: d.sessions != null ? `${d.sessions} sessions` : undefined }))}
              empty={<p className="py-6 text-center text-sm text-fg-subtle">No domain-level results yet.</p>} />
          )}
        </Section>
        <div className="space-y-4">
          <div className="card p-4"><p className="flex items-center gap-1.5 text-xs text-fg-muted"><Repeat className="h-3.5 w-3.5" aria-hidden />Repeat training</p><p className="mt-1 font-display text-2xl font-semibold">{isLoading ? '…' : fmtNumber(num(data?.repeatTraining, 'count'))}</p>{num(data?.repeatTraining, 'rate') != null && <p className="text-xs text-fg-subtle">{fmtPct(num(data?.repeatTraining, 'rate'))} of sessions</p>}</div>
          <div className="card p-4"><p className="flex items-center gap-1.5 text-xs text-fg-muted"><AlertTriangle className="h-3.5 w-3.5 text-warning" aria-hidden />Failed sessions</p><p className="mt-1 font-display text-2xl font-semibold">{isLoading ? '…' : fmtNumber(num(failed, 'count') ?? (failedItems.length || null))}</p></div>
        </div>
      </div>

      {failedItems.length > 0 && (
        <Section title="Failed sessions" bodyClassName="p-0 pt-2">
          <Table head={['Date', 'Domain', 'Status', 'Reason']}>
            {failedItems.map((f) => <tr key={f.id}><Td>{fmtDate(f.createdAt)}</Td><Td>{domainName(f.domainSlug)}</Td><Td><StatusPill status={f.status ?? 'failed'} /></Td><Td className="text-fg-muted">{f.reason ?? '—'}</Td></tr>)}
          </Table>
        </Section>
      )}
    </div>
  );
}
