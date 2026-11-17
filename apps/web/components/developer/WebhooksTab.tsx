'use client';
import { useState } from 'react';
import { Plus, Send, Trash2, Webhook, History } from 'lucide-react';
import {
  Badge, Button, Card, CardHeader, Checkbox, EmptyState, ErrorState, Field, Input, Modal, Skeleton, Table, Td, Toggle, fmtDateTime, useToast,
} from '@/components/ui';
import { api, errorMessage, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ConfirmModal } from '@/components/training/ConfirmModal';
import { asList } from '@/components/training/model';
import { NoPermission, SecretOnceModal, extractSecret } from './common';

interface Hook { id: string; url: string; events: string[]; active: boolean; createdAt?: string }
interface Delivery { id: string; event: string; status: string; responseCode?: number | null; attempts?: number; lastError?: string | null; createdAt?: string; nextAttemptAt?: string | null }

/** `GET /developer/events` may return string[] or [{name}] / {events: [...]}. */
function eventNames(data: unknown): string[] {
  const raw = Array.isArray(data) ? data : data && typeof data === 'object' ? ((data as { events?: unknown[]; items?: unknown[] }).events ?? (data as { items?: unknown[] }).items ?? []) : [];
  return raw.map((e) => (typeof e === 'string' ? e : (e as { name?: string; event?: string })?.name ?? (e as { event?: string })?.event ?? '')).filter(Boolean);
}

export function WebhooksTab() {
  const { can } = useSession();
  const toast = useToast();
  const allowed = can('developer.webhooks.manage');
  const q = useApi<unknown>('/developer/webhooks?pageSize=100');
  const events = useApi<unknown>('/developer/events?pageSize=100');
  const hooks = asList<Hook>(q.data);
  const [create, setCreate] = useState(false);
  const [secret, setSecret] = useState<string | null | undefined>(undefined);
  const [del, setDel] = useState<Hook | null>(null);
  const [logs, setLogs] = useState<Hook | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const test = async (h: Hook) => {
    setBusy('test' + h.id);
    try {
      const r = await api.post<{ ok?: boolean; status?: string; responseCode?: number; statusCode?: number } | null>(`/developer/webhooks/${h.id}/test`);
      const code = r?.responseCode ?? r?.statusCode;
      if (r && r.ok === false) toast('danger', `Test delivery failed${code ? ` (HTTP ${code})` : ''}`);
      else toast('success', `Test event sent${code ? ` — HTTP ${code}` : ''}. Check the delivery log.`);
    } catch (e) { toast('danger', errorMessage(e)); } finally { setBusy(null); }
  };
  const toggle = async (h: Hook, active: boolean) => {
    setBusy('tog' + h.id);
    try { await api.patch(`/developer/webhooks/${h.id}`, { active }); toast('success', active ? 'Webhook enabled' : 'Webhook paused'); void q.mutate(); }
    catch (e) { toast('danger', errorMessage(e)); } finally { setBusy(null); }
  };

  return (
    <Card>
      <CardHeader title="Webhooks" subtitle="Signed HTTPS callbacks for platform events (header x-aix-signature)"
        action={allowed && <Button variant="primary" size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setCreate(true)}>Add endpoint</Button>} />
      {!allowed && <div className="px-5 pt-4"><NoPermission perm="developer.webhooks.manage" /></div>}
      {q.isLoading ? <div className="space-y-2 p-5">{[0, 1].map((i) => <Skeleton key={i} className="h-12" />)}</div>
        : q.error ? <div className="p-5"><ErrorState error={q.error} onRetry={() => void q.mutate()} /></div>
          : !hooks.length ? <div className="p-5"><EmptyState icon={<Webhook className="h-5 w-5" />} title="No webhook endpoints" description="Receive training.completed, payment.succeeded and other events at your own HTTPS endpoint." action={allowed && <Button variant="primary" onClick={() => setCreate(true)}>Add endpoint</Button>} /></div>
            : (
              <Table head={['Endpoint', 'Events', 'Active', 'Created', '']}>
                {hooks.map((h) => (
                  <tr key={h.id}>
                    <Td><code className="break-all font-mono text-xs">{h.url}</code></Td>
                    <Td><div className="flex max-w-xs flex-wrap gap-1">{h.events.slice(0, 3).map((e) => <Badge key={e} tone="electric">{e}</Badge>)}{h.events.length > 3 && <Badge>+{h.events.length - 3}</Badge>}</div></Td>
                    <Td><Toggle label={`Webhook ${h.url} active`} checked={h.active} disabled={!allowed || busy === 'tog' + h.id} onChange={(v) => void toggle(h, v)} /></Td>
                    <Td className="text-xs text-fg-muted">{fmtDateTime(h.createdAt)}</Td>
                    <Td>
                      <div className="flex justify-end gap-1.5">
                        <Button size="sm" variant="ghost" icon={<History className="h-3.5 w-3.5" />} onClick={() => setLogs(h)}>Deliveries</Button>
                        {allowed && <Button size="sm" variant="ghost" icon={<Send className="h-3.5 w-3.5" />} loading={busy === 'test' + h.id} onClick={() => void test(h)}>Test</Button>}
                        {allowed && <Button size="sm" variant="ghost" className="text-danger-soft" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setDel(h)}>Delete</Button>}
                      </div>
                    </Td>
                  </tr>
                ))}
              </Table>
            )}

      <CreateHookModal open={create} onClose={() => setCreate(false)} eventsQ={events} onCreated={(res) => { setSecret(extractSecret(res, ['secret', 'signingSecret', 'webhookSecret'])); void q.mutate(); }} />
      <SecretOnceModal open={secret !== undefined} onClose={() => setSecret(undefined)} title="Webhook signing secret" secret={secret ?? null} description="Use it to verify the x-aix-signature header (see SDK & Quickstart)." />
      <ConfirmModal open={!!del} onClose={() => setDel(null)} confirmLabel="Delete endpoint" successMessage="Webhook deleted" title="Delete this webhook?"
        description={del?.url} onConfirm={async () => { await api.del(`/developer/webhooks/${del!.id}`); void q.mutate(); }} />
      <DeliveriesModal hook={logs} onClose={() => setLogs(null)} />
    </Card>
  );
}

function CreateHookModal({ open, onClose, eventsQ, onCreated }: { open: boolean; onClose: () => void; eventsQ: { data?: unknown; isLoading: boolean; error?: unknown; mutate: () => unknown }; onCreated: (res: unknown) => void }) {
  const toast = useToast();
  const [url, setUrl] = useState('');
  const [sel, setSel] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const names = eventNames(eventsQ.data);
  const validUrl = /^https?:\/\/\S+$/i.test(url.trim());
  const submit = async () => {
    setBusy(true);
    try {
      const res = await api.post('/developer/webhooks', { url: url.trim(), events: sel });
      toast('success', 'Webhook endpoint added');
      setUrl(''); setSel([]); onClose(); onCreated(res);
    } catch (e) { toast('danger', errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Add webhook endpoint" size="lg"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!validUrl || !sel.length} onClick={submit}>Add endpoint</Button></>}>
      <div className="space-y-4">
        <Field label="Endpoint URL" htmlFor="hook-url" required hint="HTTPS recommended. Hive Mind retries failed deliveries with backoff." error={url && !validUrl ? 'Enter a valid http(s) URL' : undefined}>
          <Input id="hook-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/stringmind/webhooks" />
        </Field>
        <fieldset>
          <legend className="mb-2 flex w-full items-center justify-between text-xs font-medium text-fg-muted">
            <span>Events ({sel.length} selected)</span>
            {names.length > 0 && <button type="button" className="text-electric-soft hover:underline" onClick={() => setSel(sel.length === names.length ? [] : names)}>{sel.length === names.length ? 'Clear' : 'Select all'}</button>}
          </legend>
          {eventsQ.isLoading ? <Skeleton className="h-24" /> : eventsQ.error ? <ErrorState error={eventsQ.error} onRetry={() => void eventsQ.mutate()} /> : !names.length ? <p className="text-sm text-fg-muted">No events available.</p> : (
            <div className="grid gap-2 rounded-xl border border-line bg-ink-950/40 p-3 sm:grid-cols-2">
              {names.map((n) => <Checkbox key={n} label={<code className="font-mono text-xs">{n}</code>} checked={sel.includes(n)} onChange={() => setSel((s) => (s.includes(n) ? s.filter((x) => x !== n) : [...s, n]))} />)}
            </div>
          )}
        </fieldset>
      </div>
    </Modal>
  );
}

function DeliveriesModal({ hook, onClose }: { hook: Hook | null; onClose: () => void }) {
  const q = useApi<unknown>(hook ? `/developer/webhooks/${hook.id}/deliveries` : null, { refreshInterval: hook ? 10000 : 0 });
  const items = asList<Delivery>(q.data);
  return (
    <Modal open={!!hook} onClose={onClose} size="xl" title="Delivery log" description={hook?.url}>
      {q.isLoading ? <Skeleton className="h-40" /> : q.error ? <ErrorState error={q.error} onRetry={() => void q.mutate()} />
        : !items.length ? <EmptyState title="No deliveries yet" description="Send a test event to see it here." />
          : (
            <Table head={['Event', 'Status', 'HTTP', 'Attempts', 'Time', 'Error']}>
              {items.map((d) => (
                <tr key={d.id}>
                  <Td><code className="font-mono text-xs">{d.event}</code></Td>
                  <Td><Badge tone={d.status === 'delivered' ? 'success' : d.status === 'failed' ? 'danger' : 'warning'}>{d.status}</Badge></Td>
                  <Td className="tabular-nums">{d.responseCode ?? '—'}</Td>
                  <Td className="tabular-nums">{d.attempts ?? 0}</Td>
                  <Td className="text-xs text-fg-muted">{fmtDateTime(d.createdAt)}</Td>
                  <Td className="max-w-[220px] truncate text-xs text-danger-soft" >{d.lastError ?? ''}</Td>
                </tr>
              ))}
            </Table>
          )}
    </Modal>
  );
}
