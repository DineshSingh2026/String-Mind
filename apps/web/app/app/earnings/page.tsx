'use client';
import Link from 'next/link';
import { Award, Coins, GraduationCap, Wallet as WalletIcon } from 'lucide-react';
import { REPUTATION_LEVELS } from '@aix/shared';
import { Avatar, Button, EmptyState, ErrorState, PageHeader, Progress, Skeleton, Table, Td, fmtCredits, fmtDate, fmtNumber } from '@/components/ui';
import { useApi } from '@/lib/api';
import { BarTrend, ChartEmpty, C, fmtAxisMonth } from '@/components/app/charts';
import { KpiCard, ListSkeleton, Section, SignedCredits, reputationName, titleCase } from '@/components/app/primitives';
import { listOf, type Agent, type Paged } from '@/components/app/types';

interface Earnings {
  totalEarned: number;
  byMonth: { month: string; earned: number; sessions: number }[];
  bySource: { agentId: string; name: string; earned: number; sessions: number }[];
  recent: { id?: string; amount?: number; earned?: number; description?: string | null; agentName?: string | null; createdAt: string }[];
}
interface Reputation { score?: number | null; level?: string | null; components?: Record<string, number | null> }

export default function EarningsPage() {
  const { data, error, isLoading, mutate } = useApi<Earnings>('/wallet/earnings');
  const wallet = useApi<{ available: number }>('/wallet');
  const sessions = data?.byMonth.reduce((s, m) => s + m.sessions, 0);
  return (
    <div className="space-y-6">
      <PageHeader title="Earnings & Rewards" description="IDLE Tokens your agents earned by training others, net of StringMind platform commission. Earned IDLE is spendable immediately." actions={<Button variant="primary" href="/app/wallet" icon={<WalletIcon className="h-4 w-4" />}>Open IDLE wallet</Button>} />
      {error && <ErrorState error={error} onRetry={() => mutate()} />}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3">
        <KpiCard label="IDLE earned" value={fmtCredits(data?.totalEarned)} icon={<Coins className="h-5 w-5" />} loading={isLoading} />
        <KpiCard label="IDLE balance" value={fmtCredits(wallet.data?.available)} icon={<WalletIcon className="h-5 w-5" />} tone="success" loading={wallet.isLoading} href="/app/wallet" />
        <KpiCard label="Sessions taught" value={fmtNumber(sessions)} icon={<GraduationCap className="h-5 w-5" />} tone="electric" loading={isLoading} />
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <Section title="IDLE earned by month" className="lg:col-span-2">
          {isLoading ? <Skeleton className="h-56" /> : data?.byMonth.length ? <BarTrend data={data.byMonth} xKey="month" yKey="earned" name="IDLE earned" color={C.gold} xFormatter={fmtAxisMonth} /> : <ChartEmpty>No IDLE earned yet</ChartEmpty>}
        </Section>
        <Section title="By agent">
          {isLoading ? <ListSkeleton rows={3} /> : !data?.bySource.length ? (
            <EmptyState title="No earning agents" description="Enable “Be a trainer” on an agent with a verified score ≥ 70 and publish a listing." action={<Button size="sm" variant="primary" href="/app/agents">My agents</Button>} />
          ) : (
            <ul className="divide-y divide-line/50">
              {data.bySource.map((s) => (
                <li key={s.agentId}><Link href={`/app/agents/${s.agentId}`} className="flex items-center gap-3 py-2.5 hover:opacity-90"><Avatar name={s.name} size={32} /><span className="min-w-0 flex-1"><span className="block truncate text-sm">{s.name}</span><span className="text-[11px] text-fg-subtle">{s.sessions} sessions</span></span><span className="font-semibold text-gold">{fmtCredits(s.earned)}</span></Link></li>
              ))}
            </ul>
          )}
        </Section>
      </div>
      <Section title="Recent earnings" bodyClassName="p-0 pt-2">
        {isLoading ? <div className="p-5"><ListSkeleton /></div> : !data?.recent.length ? <p className="p-5 text-center text-sm text-fg-subtle">No earnings recorded yet.</p> : (
          <Table head={['Date', 'Description', 'Agent', 'Amount']}>
            {data.recent.map((r, i) => <tr key={r.id ?? i}><Td className="text-fg-muted">{fmtDate(r.createdAt)}</Td><Td>{r.description ?? 'Training earnings'}</Td><Td>{r.agentName ?? '—'}</Td><Td><SignedCredits amount={r.amount ?? r.earned ?? 0} /></Td></tr>)}
          </Table>
        )}
      </Section>
      <ReputationSection />
    </div>
  );
}

function ReputationSection() {
  const { data, isLoading } = useApi<Agent[] | Paged<Agent>>('/agents');
  const agents = listOf(data);
  return (
    <Section title="Reputation & achievements" subtitle="Levels are earned from verified scores, completed sessions, reviews and disputes">
      {isLoading ? <ListSkeleton rows={2} /> : !agents.length ? <p className="py-4 text-center text-sm text-fg-subtle">Connect an agent to start building reputation.</p> : (
        <div className="grid gap-4 md:grid-cols-2">{agents.map((a) => <AgentReputation key={a.id} agent={a} />)}</div>
      )}
    </Section>
  );
}

function AgentReputation({ agent }: { agent: Agent }) {
  const { data, error, isLoading } = useApi<Reputation>(`/reputation/agents/${agent.id}`);
  const idx = REPUTATION_LEVELS.findIndex((l) => l.slug === data?.level);
  const next = idx >= 0 ? REPUTATION_LEVELS[idx + 1] : REPUTATION_LEVELS[0];
  return (
    <div className="rounded-xl border border-line/70 p-4">
      <div className="flex items-center gap-3"><Avatar name={agent.name} size={36} /><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{agent.name}</p>
        <p className="flex items-center gap-1 text-xs text-gold-soft"><Award className="h-3.5 w-3.5" aria-hidden />{isLoading ? '…' : error ? 'Unavailable' : reputationName(data?.level) ?? 'No level yet'}</p></div>
        <span className="font-display text-lg font-semibold tabular-nums">{data?.score == null ? '—' : data.score.toFixed(0)}</span></div>
      {data?.score != null && (
        <div className="mt-3">
          <Progress value={data.score} tone="gold" label="Reputation score" />
          {next && <p className="mt-1 text-[11px] text-fg-subtle">Next: {next.name} at {next.min}</p>}
        </div>
      )}
      {data?.components && <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">{Object.entries(data.components).map(([k, v]) => <div key={k} className="flex justify-between"><dt className="text-fg-muted">{titleCase(k)}</dt><dd className="tabular-nums">{v == null ? '—' : Number(v).toFixed(0)}</dd></div>)}</dl>}
    </div>
  );
}
