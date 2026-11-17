'use client';
import { useEffect, useState } from 'react';
import { Alert, Button, Card, CardBody, CardHeader, EmptyState, ErrorState, Input, Skeleton, cn, fmtDateTime } from '@/components/ui';
import { api, useApi } from '@/lib/api';
import { ConfirmModal } from '@/components/training/ConfirmModal';
import { asList } from '@/components/training/model';
import { AdminHeader, useRevalidate } from '@/components/admin/kit';

interface Setting { key: string; value: unknown; updatedAt?: string; updatedBy?: string | null }

/** Accepts [{key,value}], {items:[...]} or a plain {key: value} map. */
function toSettings(data: unknown): Setting[] {
  const list = asList<Setting>(data);
  if (list.length) return list;
  if (data && typeof data === 'object' && !Array.isArray(data) && !('items' in (data as object))) return Object.entries(data as Record<string, unknown>).map(([key, value]) => ({ key, value }));
  return [];
}

export default function AdminSettingsPage() {
  // GET /admin/settings (list) is assumed; per-key GET /admin/settings/:key is the documented fallback.
  const list = useApi<unknown>('/admin/settings', { shouldRetryOnError: false });
  const settings = toSettings(list.data);
  const [selected, setSelected] = useState<string | null>(null);
  const [lookup, setLookup] = useState('');
  useEffect(() => { if (!selected && settings[0]) setSelected(settings[0].key); }, [settings, selected]);

  return (
    <div>
      <AdminHeader title="System settings" description="Platform configuration stored in system_settings as JSON. Changes apply immediately and are audited." />
      <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        <Card>
          <CardHeader title="Keys" />
          <div className="p-3">
            <form className="mb-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (lookup.trim()) setSelected(lookup.trim()); }}>
              <Input aria-label="Setting key" placeholder="Open key…" value={lookup} onChange={(e) => setLookup(e.target.value)} className="h-9" />
              <Button size="sm" variant="outline" type="submit">Open</Button>
            </form>
            {list.isLoading ? <Skeleton className="h-32" /> : list.error && list.error.status !== 404 ? <ErrorState error={list.error} onRetry={() => void list.mutate()} />
              : !settings.length ? <p className="px-1 text-xs text-fg-subtle">No settings listed. Open a key by name above.</p> : (
                <ul className="space-y-0.5">
                  {settings.map((s) => (
                    <li key={s.key}><button onClick={() => setSelected(s.key)} className={cn('w-full truncate rounded-lg px-3 py-1.5 text-left font-mono text-xs', selected === s.key ? 'bg-gold/15 text-gold-soft' : 'text-fg-muted hover:bg-ink-800')}>{s.key}</button></li>
                  ))}
                </ul>
              )}
          </div>
        </Card>
        {selected ? <Editor key={selected} settingKey={selected} /> : <EmptyState title="Select a setting" description="Choose a key on the left, or open one by name." />}
      </div>
    </div>
  );
}

function Editor({ settingKey }: { settingKey: string }) {
  const revalidate = useRevalidate();
  const q = useApi<Setting | Record<string, unknown>>(`/admin/settings/${encodeURIComponent(settingKey)}`, { shouldRetryOnError: false });
  const isNew = q.error?.status === 404;
  const value = q.data && typeof q.data === 'object' && 'value' in q.data ? (q.data as Setting).value : q.data;
  const [text, setText] = useState('');
  const [confirm, setConfirm] = useState(false);
  useEffect(() => { if (q.data !== undefined) setText(JSON.stringify(value, null, 2)); else if (isNew) setText('{}'); }, [q.data, isNew]); // eslint-disable-line react-hooks/exhaustive-deps
  let parseErr: string | null = null;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (e) { parseErr = (e as Error).message; }
  const dirty = q.data !== undefined ? text !== JSON.stringify(value, null, 2) : isNew;

  return (
    <Card>
      <CardHeader title={<code className="font-mono">{settingKey}</code>} subtitle={q.data && 'updatedAt' in q.data ? `Updated ${fmtDateTime((q.data as Setting).updatedAt)}` : isNew ? 'New key — saving will create it' : undefined}
        action={<Button variant="primary" size="sm" disabled={!!parseErr || !dirty} onClick={() => setConfirm(true)}>Save</Button>} />
      <CardBody className="space-y-3">
        {q.isLoading ? <Skeleton className="h-64" /> : q.error && !isNew ? <ErrorState error={q.error} onRetry={() => void q.mutate()} /> : (
          <>
            <label htmlFor="setting-json" className="sr-only">JSON value</label>
            <textarea id="setting-json" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)}
              className={cn('min-h-[320px] w-full rounded-xl border bg-ink-950 p-4 font-mono text-xs leading-relaxed text-fg focus:outline-none focus:shadow-focus', parseErr ? 'border-danger/60' : 'border-line focus:border-electric')} />
            {parseErr ? <Alert tone="danger" title="Invalid JSON">{parseErr}</Alert> : <p className="text-xs text-success-soft">Valid JSON</p>}
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" disabled={!!parseErr} onClick={() => setText(JSON.stringify(parsed, null, 2))}>Format</Button>
              <Button size="sm" variant="ghost" disabled={!dirty || isNew} onClick={() => setText(JSON.stringify(value, null, 2))}>Revert</Button>
            </div>
          </>
        )}
      </CardBody>
      <ConfirmModal open={confirm} onClose={() => setConfirm(false)} tone="primary" title={`Save “${settingKey}”?`} confirmLabel="Save setting" successMessage="Setting saved"
        description="This changes platform behaviour for every user immediately."
        onConfirm={async () => {
          await api.put(`/admin/settings/${encodeURIComponent(settingKey)}`, { value: parsed });
          await q.mutate(); await revalidate('/admin/settings');
        }} />
    </Card>
  );
}
