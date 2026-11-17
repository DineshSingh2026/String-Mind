'use client';
import { useState } from 'react';
import { Activity, FlaskConical, Rocket, ShieldCheck, ScrollText } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  Badge, Button, Card, CardBody, CardHeader, EmptyState, ErrorState, Select, Skeleton, Stat, Table, Td, cn, fmtDateTime, fmtNumber, fmtPct,
} from '@/components/ui';
import { useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { asList } from '@/components/training/model';
import { NoPermission } from './common';
import { type ApiKey, useKeys } from './KeysTab';

interface LogRow { id: string; method: string; path: string; statusCode: number; latencyMs: number; apiKeyId?: string | null; createdAt: string }
interface Paged<T> { items: T[]; total: number; page: number; pageSize: number }

export function LogsTab() {
  const { can } = useSession();
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const allowed = can('developer.logs.read');
  const q = useApi<Paged<LogRow> | LogRow[]>(allowed ? `/developer/logs?status=${status}&page=${page}` : null);
  const all = asList<LogRow>(q.data);
  // Also filter client-side by status class in case the server ignores the param.
  const rows = status ? all.filter((r) => String(r.statusCode).startsWith(status[0]!)) : all;
  const total = !Array.isArray(q.data) && q.data ? q.data.total : rows.length;
  const pageSize = !Array.isArray(q.data) && q.data ? q.data.pageSize : rows.length || 20;
  const pages = Math.max(1, Math.ceil(total / (pageSize || 20)));
  return (
    <Card>
      <CardHeader title="Request logs" subtitle="API requests made by your organisation (keys and sessions)"
        action={<Select aria-label="Filter by status" className="h-8 w-36 text-xs" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">All statuses</option><option value="2xx">2xx success</option><option value="4xx">4xx client error</option><option value="5xx">5xx server error</option>
        </Select>} />
      {!allowed ? <div className="p-5"><NoPermission perm="developer.logs.read" /></div>
        : q.isLoading ? <div className="space-y-2 p-5">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-9" />)}</div>
          : q.error ? <div className="p-5"><ErrorState error={q.error} onRetry={() => void q.mutate()} /></div>
            : !rows.length ? <div className="p-5"><EmptyState icon={<ScrollText className="h-5 w-5" />} title="No requests logged" description={status ? 'No requests match this filter.' : 'Requests appear here once you call the API with a key.'} /></div>
              : (<>
                <Table head={['Time', 'Method', 'Path', 'Status', 'Latency']}>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <Td className="whitespace-nowrap text-xs text-fg-muted">{fmtDateTime(r.createdAt)}</Td>
                      <Td><code className="font-mono text-xs text-electric-soft">{r.method}</code></Td>
                      <Td><code className="break-all font-mono text-xs">{r.path}</code></Td>
                      <Td><Badge tone={r.statusCode < 300 ? 'success' : r.statusCode < 500 ? 'warning' : 'danger'}>{r.statusCode}</Badge></Td>
                      <Td className="tabular-nums text-xs">{r.latencyMs} ms</Td>
                    </tr>
                  ))}
                </Table>
                <div className="flex items-center justify-between border-t border-line/60 px-5 py-3 text-xs text-fg-muted">
                  <span>Page {page} of {pages}</span>
                  <div className="flex gap-2"><Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button><Button size="sm" variant="outline" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button></div>
                </div>
              </>)}
    </Card>
  );
}

interface Usage { byDay: { date: string; requests: number; errors: number }[]; totals?: { requests?: number; errors?: number; [k: string]: unknown } | null; rateLimitPerMin?: number | null }

export function UsageTab() {
  const q = useApi<Usage>('/developer/usage');
  const d = q.data;
  const byDay = d?.byDay ?? [];
  const req = d?.totals?.requests ?? byDay.reduce((a, b) => a + b.requests, 0);
  const err = d?.totals?.errors ?? byDay.reduce((a, b) => a + b.errors, 0);
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.mutate()} />;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Requests (period)" value={fmtNumber(req)} loading={q.isLoading} icon={<Activity className="h-4 w-4" />} tone="electric" />
        <Stat label="Error rate" value={req ? fmtPct((err / req) * 100) : '—'} hint={`${fmtNumber(err)} errors`} loading={q.isLoading} icon={<ShieldCheck className="h-4 w-4" />} tone="violet" />
        <Stat label="Rate limit" value={d?.rateLimitPerMin ? `${fmtNumber(d.rateLimitPerMin)}/min` : '—'} hint="Per API key; 429 when exceeded" loading={q.isLoading} icon={<Rocket className="h-4 w-4" />} tone="gold" />
      </div>
      <Card>
        <CardHeader title="Requests & errors by day" />
        <CardBody>
          {q.isLoading ? <Skeleton className="h-64" /> : !byDay.length ? <EmptyState title="No usage yet" description="Daily request counts appear after your first API calls." /> : (
            <>
              <div className="h-64" role="img" aria-label="Bar chart of daily API requests and errors">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={byDay} barGap={2} margin={{ left: -12, right: 8, top: 8 }}>
                    <CartesianGrid vertical={false} stroke="rgb(var(--line))" strokeOpacity={0.4} />
                    <XAxis dataKey="date" tick={{ fill: 'rgb(var(--fg-subtle))', fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={(v: string) => v.slice(5)} />
                    <YAxis tick={{ fill: 'rgb(var(--fg-subtle))', fontSize: 11 }} tickLine={false} axisLine={false} allowDecimals={false} />
                    <Tooltip cursor={{ fill: 'rgb(var(--ink-800))', opacity: 0.5 }} contentStyle={{ background: 'rgb(var(--ink-850))', border: '1px solid rgb(var(--line))', borderRadius: 12, fontSize: 12 }} labelStyle={{ color: 'rgb(var(--fg))' }} />
                    <Legend wrapperStyle={{ fontSize: 12, color: 'rgb(var(--fg-muted))' }} iconType="circle" />
                    <Bar dataKey="requests" name="Requests" fill="rgb(var(--electric))" radius={[4, 4, 0, 0]} maxBarSize={22} />
                    <Bar dataKey="errors" name="Errors" fill="rgb(var(--gold))" radius={[4, 4, 0, 0]} maxBarSize={22} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <details className="mt-3 text-xs text-fg-muted"><summary className="cursor-pointer">View as table</summary>
                <Table head={['Date', 'Requests', 'Errors']} className="mt-2">{byDay.map((r) => <tr key={r.date}><Td>{r.date}</Td><Td className="tabular-nums">{fmtNumber(r.requests)}</Td><Td className="tabular-nums">{fmtNumber(r.errors)}</Td></tr>)}</Table>
              </details>
            </>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

export function EnvironmentsTab() {
  const q = useKeys();
  const keys = asList<ApiKey>(q.data).filter((k) => !k.revokedAt);
  const envs = [
    { id: 'sandbox', icon: FlaskConical, title: 'Sandbox', tone: 'electric' as const, body: 'Build safely. Use the StringMind Sandbox Agent provider. Ideal for local development.', keys: keys.filter((k) => k.environment === 'sandbox') },
    { id: 'testing', icon: ShieldCheck, title: 'Testing', tone: 'violet' as const, body: 'Run end-to-end tests with sandbox keys against real provider agents you own, plus webhook test deliveries. IDLE used here is recorded as real ledger entries.', keys: [] as ApiKey[] },
    { id: 'production', icon: Rocket, title: 'Production', tone: 'gold' as const, body: 'Live marketplace, real IDLE balances and settlements. Use separate keys with the minimum scopes and rotate them regularly.', keys: keys.filter((k) => k.environment === 'production') },
  ];
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {envs.map((e) => (
        <Card key={e.id} className="flex flex-col">
          <CardHeader title={<span className="flex items-center gap-2"><e.icon className={cn('h-4 w-4', e.tone === 'gold' ? 'text-gold' : e.tone === 'violet' ? 'text-violet' : 'text-electric')} />{e.title}</span>} />
          <CardBody className="flex-1 space-y-3">
            <p className="text-sm text-fg-muted">{e.body}</p>
            {e.id === 'testing' ? <p className="text-xs text-fg-subtle">Uses your sandbox keys.</p> : q.isLoading ? <Skeleton className="h-10" /> : (
              <div>
                <p className="mb-1.5 text-xs font-medium text-fg-subtle">Active keys ({e.keys.length})</p>
                {e.keys.length ? <ul className="space-y-1">{e.keys.map((k) => <li key={k.id} className="flex items-center justify-between text-sm"><span>{k.name}</span><code className="font-mono text-xs text-fg-subtle">{k.prefix ?? ''}…</code></li>)}</ul>
                  : <p className="text-xs text-fg-subtle">No keys in this environment.</p>}
              </div>
            )}
          </CardBody>
        </Card>
      ))}
    </div>
  );
}
