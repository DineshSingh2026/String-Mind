'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Activity, Bot, Gauge, LayoutGrid, List, Pause, Plug, Plus, RefreshCw } from 'lucide-react';
import { Avatar, Badge, Button, EmptyState, ErrorState, PageHeader, ScoreRing, Table, Td, cn, fmtRelative } from '@/components/ui';
import { api, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { GridSkeleton, StatusPill, reputationName, titleCase, useAction } from '@/components/app/primitives';
import { listOf, reputationLevel, type Agent, type Paged } from '@/components/app/types';
import { PromptStatusBadge, isPromptAgent } from '@/components/app/PromptConnect';
import { agentColor } from '@/components/brand/hex';

const AgentStatus = ({ a }: { a: Agent }) => (<>
  {isPromptAgent(a) && a.status !== 'suspended' ? <PromptStatusBadge agentId={a.id} /> : <StatusPill status={a.status} />}
  {(a as Agent & { pausedAt?: string | null }).pausedAt && <Badge tone="warning" icon={<Pause className="h-3 w-3" aria-hidden />}>Paused</Badge>}
</>);

function HealthDot({ health }: { health: string | null | undefined }) {
  const h = health ?? 'unknown';
  const c = h === 'healthy' ? 'bg-success' : h === 'degraded' ? 'bg-warning' : h === 'down' ? 'bg-danger' : 'bg-ink-600';
  return <span className="inline-flex items-center gap-1.5 text-xs text-fg-muted"><span className={cn('h-2 w-2 rounded-full', c)} aria-hidden />API {titleCase(h)}</span>;
}

export default function AgentsPage() {
  const { can } = useSession();
  const router = useRouter();
  const { data, error, isLoading, mutate } = useApi<Agent[] | Paged<Agent>>('/agents');
  const agents = listOf(data);
  const [view, setView] = useState<'grid' | 'table'>('grid');
  const { busy, run } = useAction();

  const test = (a: Agent) => run(`test-${a.id}`, () => api.post<{ ok: boolean; latencyMs?: number; error?: string }>(`/agents/${a.id}/test`), (r) => r.ok ? `${a.name} connected · ${r.latencyMs ?? '—'} ms` : `Test failed: ${r.error ?? 'unknown error'}`).then(() => mutate());
  const assess = async (a: Agent) => {
    const r = await run(`assess-${a.id}`, () => api.post<{ id: string }>('/assessments', { agentId: a.id }), 'Assessment queued');
    if (r?.id) router.push(`/app/assessments/${r.id}`);
  };

  return (
    <div>
      <PageHeader title={<span className="font-lux text-5xl font-medium"><span className="lux-title italic">Your agents</span></span>} description="Every agent, its living mark and its record — connect, test, assess and open its command deck."
        actions={<>
          <div className="flex rounded-xl border border-line p-0.5" role="group" aria-label="View mode">
            <button onClick={() => setView('grid')} aria-pressed={view === 'grid'} aria-label="Grid view" className={cn('rounded-lg p-1.5', view === 'grid' ? 'bg-ink-800 text-fg' : 'text-fg-muted')}><LayoutGrid className="h-4 w-4" /></button>
            <button onClick={() => setView('table')} aria-pressed={view === 'table'} aria-label="Table view" className={cn('rounded-lg p-1.5', view === 'table' ? 'bg-ink-800 text-fg' : 'text-fg-muted')}><List className="h-4 w-4" /></button>
          </div>
          {can('agents.create') && <Button variant="primary" href="/app/agents/new" icon={<Plus className="h-4 w-4" />}>Connect agent</Button>}
        </>} />

      {error ? <ErrorState error={error} onRetry={() => mutate()} />
        : isLoading ? <GridSkeleton />
        : agents.length === 0 ? (
          <EmptyState icon={<Bot className="h-6 w-6" />} title="No agents connected yet"
            description="Connect an agent from xAI Grok, OpenAI, Anthropic, Gemini, a custom REST endpoint, webhook, A2A or MCP server — or start with the Hive Mind sandbox agent. Then run an independent capability assessment."
            action={can('agents.create') ? <Button variant="primary" href="/app/agents/new" icon={<Plug className="h-4 w-4" />}>Connect your first agent</Button> : <p className="text-xs text-fg-subtle">Ask an organisation admin to connect an agent.</p>} />
        ) : view === 'grid' ? (
          <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
            {agents.map((a) => (
              <article key={a.id} className="lux-card lux-panel flex flex-col p-6">
                <div aria-hidden className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full opacity-60 blur-2xl" style={{ background: `radial-gradient(circle, ${agentColor(a.id).solid}33, transparent 65%)` }} />
                <div className="relative flex items-start justify-between gap-3">
                  <span className="lux-halo rounded-full p-1" style={{ ['--halo' as string]: agentColor(a.id).solid }}><Avatar name={a.name} seed={a.id} src={a.avatarUrl} size={68} /></span>
                  <ScoreRing score={a.overallScore} size={54} label="Overall score" />
                </div>
                <div className="relative mt-5 min-w-0">
                  <Link href={`/app/agents/${a.id}`} className="block truncate font-lux text-[28px] font-medium leading-tight text-fg hover:text-[color:var(--lux-gold)]">{a.name}</Link>
                  <p className="mt-1 truncate text-[11px] uppercase tracking-[0.22em] text-[color:var(--lux-gold)]/70">{isPromptAgent(a) ? 'Connected via prompt' : `${a.provider?.name ?? '—'} · ${a.modelName ?? '—'}`}</p>
                  <div className="mt-3 flex flex-wrap items-center gap-2"><AgentStatus a={a} />{a.isPublic && <Badge tone="gold">Public</Badge>}</div>
                </div>
                <div className="lux-hair relative my-5" />
                <div className="relative space-y-1.5 text-xs text-fg-muted">
                  {isPromptAgent(a) ? <p>Prompt connection · no API key stored</p> : <>
                    <HealthDot health={a.health} />
                    <p>Last test {fmtRelative(a.connection?.lastTestedAt)}</p>
                  </>}
                  {reputationLevel(a.reputation) && <p>Reputation · {reputationName(reputationLevel(a.reputation))}</p>}
                  {a.connection?.lastError && <p className="text-danger-soft">Last error: {a.connection.lastError}</p>}
                </div>
                <div className="relative mt-auto flex flex-wrap gap-2 pt-5">
                  <Link href={`/app/agents/${a.id}`} className="lux-btn flex-1 rounded-full px-4 py-2 text-center text-xs font-medium">Open command deck</Link>
                  {can('agents.connect') && <Button size="sm" variant="ghost" loading={busy === `test-${a.id}`} onClick={() => test(a)} icon={<Activity className="h-3.5 w-3.5" />}>Test</Button>}
                  {can('assessments.run') && <Button size="sm" variant="ghost" loading={busy === `assess-${a.id}`} onClick={() => assess(a)} icon={<Gauge className="h-3.5 w-3.5" />}>Assess</Button>}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="card">
            <Table head={['Agent', 'Status', 'Health', 'Connection', 'Score', 'Last test', 'Actions']}>
              {agents.map((a) => (
                <tr key={a.id}>
                  <Td><div className="flex items-center gap-2.5"><Avatar name={a.name} src={a.avatarUrl} size={32} /><div className="min-w-0"><Link href={`/app/agents/${a.id}`} className="font-medium hover:underline">{a.name}</Link><p className="text-xs text-fg-subtle">{a.provider?.name} · {a.modelName}</p></div></div></Td>
                  <Td><div className="flex flex-wrap items-center gap-1.5"><AgentStatus a={a} /></div></Td>
                  <Td><HealthDot health={a.health} /></Td>
                  <Td className="text-xs text-fg-muted">{titleCase(a.connection?.method)} · {titleCase(a.connection?.status)}</Td>
                  <Td><ScoreRing score={a.overallScore} size={36} /></Td>
                  <Td className="text-xs text-fg-muted">{fmtRelative(a.connection?.lastTestedAt)}</Td>
                  <Td><div className="flex gap-1">
                    {can('agents.connect') && <Button size="sm" variant="ghost" aria-label={`Test ${a.name}`} loading={busy === `test-${a.id}`} onClick={() => test(a)}><RefreshCw className="h-3.5 w-3.5" /></Button>}
                    {can('assessments.run') && <Button size="sm" variant="ghost" aria-label={`Assess ${a.name}`} loading={busy === `assess-${a.id}`} onClick={() => assess(a)}><Gauge className="h-3.5 w-3.5" /></Button>}
                    <Button size="sm" variant="outline" href={`/app/agents/${a.id}`}>Open</Button>
                  </div></Td>
                </tr>
              ))}
            </Table>
          </div>
        )}
    </div>
  );
}
