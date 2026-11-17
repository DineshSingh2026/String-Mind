'use client';
/**
 * Admin toolkit: paged data tables with loading/empty/error states, status badges, generic renderers for
 * loosely-specified payloads (overview, health, security) and a mutation helper (toast + refetch).
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Search } from 'lucide-react';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Input, Skeleton, Table, Td, fmtDateTime, fmtNumber, useToast } from '@/components/ui';
import { useSWRConfig } from 'swr';
import { errorMessage, useApi } from '@/lib/api';
import { asList } from '@/components/training/model';
import { AnimatedNumber } from '@/components/app/motion';

export type Row = Record<string, any>;
export interface Col<T = Row> { header: string; cell: (r: T) => ReactNode; className?: string }

export function AdminHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div><h1 className="text-xl font-semibold sm:text-2xl">{title}</h1>{description && <p className="mt-1 max-w-3xl text-sm text-fg-muted">{description}</p>}</div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

const GOOD = ['active', 'ok', 'healthy', 'verified', 'approved', 'visible', 'succeeded', 'delivered', 'completed', 'paid', 'settled', 'resolved_release', 'actioned', 'confirmed', 'up', 'true'];
const WARN = ['pending', 'queued', 'running', 'requested', 'under_review', 'open', 'degraded', 'paused', 'scheduled', 'escrowed', 'beta', 'draft', 'medium', 'past_due'];
const BAD = ['suspended', 'failed', 'rejected', 'down', 'error', 'hidden', 'disabled', 'deleted', 'refunded', 'disputed', 'high', 'cancelled', 'false', 'resolved_refund'];
export function StatusBadge({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === '') return <span className="text-fg-subtle">—</span>;
  const v = String(value).toLowerCase();
  const tone = GOOD.includes(v) ? 'success' : WARN.includes(v) ? 'warning' : BAD.includes(v) ? 'danger' : 'neutral';
  return <Badge tone={tone}>{tone === 'success' && /^(ok|healthy|up|active|running)$/.test(v) && <span className="ax-pulse !h-1.5 !w-1.5" aria-hidden />}{String(value).replace(/_/g, ' ')}</Badge>;
}

/** Revalidate every SWR key starting with `prefix` (e.g. '/admin/users'). */
export function useRevalidate() {
  const { mutate } = useSWRConfig();
  return (...prefixes: string[]) => mutate((k) => typeof k === 'string' && prefixes.some((p) => k.startsWith(p)));
}

export function useMutate(...prefixes: string[]) {
  const revalidate = useRevalidate();
  const after = () => revalidate(...prefixes);
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (id: string, fn: () => Promise<unknown>, success: string) => {
    setBusy(id);
    try { await fn(); toast('success', success); await after(); } catch (e) { toast('danger', errorMessage(e)); } finally { setBusy(null); }
  };
  return { busy, run };
}

/** Paged admin list. `path` may already contain a query string. */
export function useAdminList<T = Row>(path: string, page: number) {
  const sep = path.includes('?') ? '&' : '?';
  const q = useApi<unknown>(`${path}${sep}page=${page}`);
  const items = asList<T>(q.data);
  const meta = q.data && !Array.isArray(q.data) ? (q.data as { total?: number; pageSize?: number }) : {};
  const pages = meta.total != null ? Math.max(1, Math.ceil(meta.total / (meta.pageSize || 20))) : 1;
  return { ...q, items, total: meta.total ?? items.length, pages };
}

export function DataCard<T = Row>({ title, subtitle, action, path, columns, empty = 'Nothing here yet', rowKey = (r: any) => r.id }: {
  title: ReactNode; subtitle?: ReactNode; action?: ReactNode; path: string | null; columns: Col<T>[]; empty?: string;
  rowKey?: (r: T) => string;
}) {
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [path]);
  return (
    <Card>
      <CardHeader title={title} subtitle={subtitle} action={action} />
      {path ? <DataBody<T> key={path} path={path} page={page} setPage={setPage} columns={columns} empty={empty} rowKey={rowKey} />
        : <div className="p-5"><EmptyState title="Select an item" /></div>}
    </Card>
  );
}

function DataBody<T>({ path, page, setPage, columns, empty, rowKey }: { path: string; page: number; setPage: (n: number) => void; columns: Col<T>[]; empty: string; rowKey: (r: T) => string }) {
  const q = useAdminList<T>(path, page);
  if (q.isLoading) return <div className="space-y-2 p-5">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-10" />)}</div>;
  if (q.error) return <div className="p-5"><ErrorState error={q.error} onRetry={() => void q.mutate()} /></div>;
  if (!q.items.length) return <div className="p-5"><EmptyState title={empty} /></div>;
  return (
    <>
      <Table head={columns.map((c) => c.header)}>
        {q.items.map((r, i) => <tr key={rowKey(r) ?? i} className="ax-rise transition-colors hover:bg-ink-850/60" style={{ animationDelay: `${Math.min(i, 12) * 30}ms` }}>{columns.map((c, j) => <Td key={j} className={c.className}>{c.cell(r)}</Td>)}</tr>)}
      </Table>
      {q.pages > 1 && (
        <div className="flex items-center justify-between border-t border-line/60 px-5 py-3 text-xs text-fg-muted">
          <span>Page {page} of {q.pages} · {fmtNumber(q.total)} total</span>
          <div className="flex gap-2"><Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button><Button size="sm" variant="outline" disabled={page >= q.pages} onClick={() => setPage(page + 1)}>Next</Button></div>
        </div>
      )}
    </>
  );
}

export function SearchBox({ value, onChange, placeholder = 'Search…' }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [v, setV] = useState(value);
  return (
    <form onSubmit={(e) => { e.preventDefault(); onChange(v.trim()); }} className="relative w-full sm:w-64" role="search">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
      <Input aria-label={placeholder} value={v} onChange={(e) => setV(e.target.value)} placeholder={placeholder} className="h-9 pl-9" />
    </form>
  );
}

export const when = (s: unknown) => <span className="whitespace-nowrap text-xs text-fg-muted">{fmtDateTime(s as string)}</span>;
export const mono = (s: unknown) => <code className="font-mono text-[11px] text-fg-muted">{s == null ? '—' : String(s).slice(0, 8)}</code>;
export const nameOf = (o: any, ...keys: string[]) => { for (const k of keys) { const v = o?.[k]; if (v && typeof v === 'object' && v.name) return v.name as string; if (typeof v === 'string' && v) return v; } return '—'; };

/** Render an arbitrary value compactly. */
export function Val({ v }: { v: unknown }) {
  if (v === null || v === undefined) return <span className="text-fg-subtle">—</span>;
  if (typeof v === 'boolean') return <StatusBadge value={v ? 'true' : 'false'} />;
  if (typeof v === 'number') return <span className="tabular-nums">{fmtNumber(v, 2)}</span>;
  if (typeof v === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T/.test(v)) return when(v);
    if (/^(ok|healthy|degraded|down|error|up|active|failed|open)$/i.test(v)) return <StatusBadge value={v} />;
    return <span className="break-words">{v.length > 120 ? v.slice(0, 120) + '…' : v}</span>;
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x === null || typeof x !== 'object');
    if (!entries.length) return <span className="text-fg-subtle">None</span>;
    if (entries.length === Object.keys(v as object).length) {
      return (
        <span className="inline-flex flex-wrap justify-end gap-1.5">
          {entries.map(([k, x]) => (
            <span key={k} className="inline-flex items-center gap-1 rounded-full border border-line bg-ink-800 px-2 py-0.5 text-[11px]">
              <span className="text-fg-muted">{k.replace(/_/g, ' ')}</span><span className="font-medium tabular-nums text-fg">{typeof x === 'number' ? fmtNumber(x, 2) : String(x ?? '—')}</span>
            </span>
          ))}
        </span>
      );
    }
  }
  return <code className="block max-w-xs truncate font-mono text-[11px] text-fg-muted">{JSON.stringify(v)}</code>;
}

/** Table for an array of objects with unknown shape. */
export function AutoTable({ rows, max = 8 }: { rows: Row[]; max?: number }) {
  if (!rows.length) return <EmptyState title="No records" />;
  const cols = Array.from(new Set(rows.flatMap((r) => Object.keys(r)))).filter((k) => !/hash|secret|password/i.test(k)).slice(0, max);
  return <Table head={cols}>{rows.map((r, i) => <tr key={r.id ?? i}>{cols.map((c) => <Td key={c}><Val v={r[c]} /></Td>)}</tr>)}</Table>;
}

/** Key/value grid for objects with unknown shape: numbers become tiles, arrays become tables, objects nest. */
export function AutoObject({ data, title }: { data: Row; title?: string }) {
  const scalars = Object.entries(data).filter(([, v]) => v === null || typeof v !== 'object');
  const nested = Object.entries(data).filter(([, v]) => v !== null && typeof v === 'object' && !Array.isArray(v));
  const arrays = Object.entries(data).filter(([, v]) => Array.isArray(v));
  const label = (k: string) => k.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  return (
    <div className="space-y-4">
      {title && <h2 className="text-base font-semibold">{title}</h2>}
      {scalars.length > 0 && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {scalars.map(([k, v]) => <div key={k} className="card ax-spot ax-lift p-4"><p className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-fg-subtle">{label(k)}</p><div className="mt-1.5 font-display text-lg font-semibold">{typeof v === 'number' ? <AnimatedNumber value={v} format={(n) => fmtNumber(n, Number.isInteger(v) ? 0 : 2)} /> : <Val v={v} />}</div></div>)}
        </div>
      )}
      {nested.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2">
          {nested.map(([k, v]) => (
            <Card key={k} className="ax-spot"><CardHeader title={label(k)} />
              <dl className="divide-y divide-line/50 px-5 py-2 text-sm">
                {Object.entries(v as Row).map(([kk, vv]) => <div key={kk} className="flex items-center justify-between gap-3 py-2"><dt className="text-fg-muted">{label(kk)}</dt><dd className="text-right"><Val v={vv} /></dd></div>)}
              </dl>
            </Card>
          ))}
        </div>
      )}
      {arrays.map(([k, v]) => <Card key={k}><CardHeader title={label(k)} subtitle={`${(v as unknown[]).length} records`} /><AutoTable rows={(v as unknown[]).map((x) => (x && typeof x === 'object' ? x as Row : { value: x }))} /></Card>)}
    </div>
  );
}

export function AutoEndpoint({ path, title }: { path: string; title?: string }) {
  const q = useApi<Row>(path, { refreshInterval: 30000 });
  if (q.isLoading) return <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-20" />)}</div>;
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.mutate()} />;
  if (!q.data || typeof q.data !== 'object') return <EmptyState title="No data" />;
  return Array.isArray(q.data) ? <Card><AutoTable rows={q.data as Row[]} /></Card> : <AutoObject data={q.data} title={title} />;
}
