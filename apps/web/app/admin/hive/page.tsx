'use client';
import { useEffect, useState } from 'react';
import {
  Alert, Badge, Button, Card, CardBody, CardHeader, ErrorState, Field, Input, Progress, Skeleton, Table, Td, Toggle, fmtNumber, useToast,
} from '@/components/ui';
import { api, errorMessage, useApi } from '@/lib/api';
import { AdminHeader, StatusBadge, mono, when } from '@/components/admin/kit';

interface Settings { enabled: boolean; dailyCapCents: number; inputPricePerMTokCents: number; outputPricePerMTokCents: number }
interface SettingsRes { settings: Settings; model: { provider: string; model: string } | null }
interface Run {
  id: string; sourceType: 'session' | 'debate'; sourceId: string; sourceTitle: string | null; status: string; lessonsCreated: number;
  inputTokens: number; outputTokens: number; costCents: number; error: string | null; createdAt: string;
}
interface RunsRes {
  today: { spendCents: number; capCents: number; runs: number; lessons: number; inputTokens: number; outputTokens: number; dayStartUtc: string };
  lessonTotal: number; items: Run[]; total: number;
}

const usd = (cents: number) => `$${(cents / 100).toFixed(cents < 100 ? 4 : 2)}`;
const STATUS_LABEL: Record<string, string> = {
  done: 'done', running: 'running', skipped_cap: 'skipped: daily cap', skipped_no_model: 'skipped: no model', skipped_disabled: 'skipped: turned off', failed: 'failed',
};

export default function AdminHivePage() {
  const toast = useToast();
  const s = useApi<SettingsRes>('/hive/settings');
  const runs = useApi<RunsRes>('/hive/runs?pageSize=50', { refreshInterval: 30_000 });
  const [form, setForm] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (s.data && !form) setForm(s.data.settings); }, [s.data, form]);

  const save = async () => {
    if (!form) return;
    setSaving(true);
    try {
      const r = await api.put<{ settings: Settings }>('/hive/settings', form);
      setForm(r.settings);
      await Promise.all([s.mutate(), runs.mutate()]);
      toast('success', 'Hive learning settings saved');
    } catch (e) { toast('danger', errorMessage(e)); } finally { setSaving(false); }
  };
  const retry = async (r: Run) => {
    try { await api.post('/hive/runs/learn', { sourceType: r.sourceType, sourceId: r.sourceId }); toast('success', 'Queued: Hive Mind will learn from it now'); setTimeout(() => void runs.mutate(), 1500); }
    catch (e) { toast('danger', errorMessage(e)); }
  };
  const num = (k: keyof Settings) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => (f ? { ...f, [k]: Math.max(0, Number(e.target.value) || 0) } : f));

  const today = runs.data?.today;
  const pct = today && today.capCents > 0 ? Math.min(100, (today.spendCents / today.capCents) * 100) : today ? 100 : 0;

  return (
    <div className="space-y-4">
      <AdminHeader title="Hive learning" description="Hive Mind reads finished public rooms and closed debates and keeps up to 3 lessons from each, using the platform evaluator model. Costs are estimates: real token counts × the prices below. The cap resets at 00:00 UTC." />

      {s.data && !s.data.model && (
        <Alert tone="warning" title="Automatic learning is off: no Hive model is configured">
          Set <code className="font-mono">EVALUATOR_PROVIDER</code>, <code className="font-mono">EVALUATOR_API_KEY</code> and optionally <code className="font-mono">EVALUATOR_MODEL</code> in the API environment, then restart the API. Until then every run is recorded as &ldquo;skipped: no model&rdquo; and nothing is invented.
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader title="Settings" subtitle={s.data?.model ? `Model: ${s.data.model.provider} · ${s.data.model.model}` : 'Model: not configured'} />
          <CardBody>
            {s.isLoading || !form ? (s.error ? <ErrorState error={s.error} onRetry={() => void s.mutate()} /> : <Skeleton className="h-48" />) : (
              <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
                <Toggle checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} label="Automatic learning enabled" />
                <Field label="Daily cap (US cents)" hint={`= ${usd(form.dailyCapCents)} per UTC day`} htmlFor="cap">
                  <Input id="cap" type="number" min={0} step={1} value={form.dailyCapCents} onChange={num('dailyCapCents')} />
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Input price (cents / million tokens)" htmlFor="pin">
                    <Input id="pin" type="number" min={0} step="any" value={form.inputPricePerMTokCents} onChange={num('inputPricePerMTokCents')} />
                  </Field>
                  <Field label="Output price (cents / million tokens)" htmlFor="pout">
                    <Input id="pout" type="number" min={0} step="any" value={form.outputPricePerMTokCents} onChange={num('outputPricePerMTokCents')} />
                  </Field>
                </div>
                <Button type="submit" variant="primary" loading={saving}>Save settings</Button>
              </form>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Today (UTC)" subtitle={today ? `since ${new Date(today.dayStartUtc).toUTCString().slice(0, 22)} UTC` : undefined} />
          <CardBody>
            {runs.isLoading ? <Skeleton className="h-40" /> : runs.error ? <ErrorState error={runs.error} onRetry={() => void runs.mutate()} /> : today && (
              <div className="space-y-4">
                <div>
                  <div className="flex items-baseline justify-between">
                    <p className="font-display text-2xl font-semibold tabular-nums">{usd(today.spendCents)}</p>
                    <p className="text-sm text-fg-muted">of {usd(today.capCents)} cap</p>
                  </div>
                  <Progress className="mt-2" value={pct} tone={pct >= 100 ? 'danger' : pct >= 80 ? 'gold' : 'success'} label="Today's spend against the daily cap" />
                  {pct >= 100 && <p className="mt-2 text-xs text-danger-soft">Cap reached: new runs are skipped until 00:00 UTC (they are retried automatically the next day).</p>}
                </div>
                <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                  <div><dt className="text-[11px] text-fg-subtle">Runs</dt><dd className="font-semibold tabular-nums">{today.runs}</dd></div>
                  <div><dt className="text-[11px] text-fg-subtle">Lessons</dt><dd className="font-semibold tabular-nums">{today.lessons}</dd></div>
                  <div><dt className="text-[11px] text-fg-subtle">Input tokens</dt><dd className="font-semibold tabular-nums">{fmtNumber(today.inputTokens)}</dd></div>
                  <div><dt className="text-[11px] text-fg-subtle">Output tokens</dt><dd className="font-semibold tabular-nums">{fmtNumber(today.outputTokens)}</dd></div>
                </dl>
                <p className="text-xs text-fg-muted">Hive lessons kept so far: <span className="font-semibold text-fg">{runs.data?.lessonTotal ?? 0}</span></p>
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="Recent runs" subtitle={runs.data ? `${runs.data.total} in total` : undefined} />
        {runs.isLoading ? <CardBody><Skeleton className="h-32" /></CardBody> : !runs.data?.items.length ? (
          <CardBody><p className="text-sm text-fg-muted">No runs yet. A run is recorded when a public room completes or a debate closes.</p></CardBody>
        ) : (
          <Table head={['Source', 'Status', 'Lessons', 'Tokens in / out', 'Est. cost', 'When', '']}>
            {runs.data.items.map((r) => (
              <tr key={r.id} className="border-t border-line/40">
                <Td>
                  <div className="flex items-center gap-2"><Badge tone={r.sourceType === 'debate' ? 'violet' : 'electric'}>{r.sourceType === 'debate' ? 'debate' : 'room'}</Badge><span className="max-w-[16rem] truncate text-sm">{r.sourceTitle ?? '—'}</span></div>
                  <div className="mt-0.5">{mono(r.sourceId)}</div>
                  {r.error && <p className="mt-1 max-w-xs truncate text-[11px] text-fg-subtle" title={r.error}>{r.error}</p>}
                </Td>
                <Td><StatusBadge value={STATUS_LABEL[r.status] ?? r.status} /></Td>
                <Td className="tabular-nums">{r.lessonsCreated}</Td>
                <Td className="tabular-nums text-xs">{fmtNumber(r.inputTokens)} / {fmtNumber(r.outputTokens)}</Td>
                <Td className="tabular-nums text-xs">{usd(r.costCents)}</Td>
                <Td>{when(r.createdAt)}</Td>
                <Td>{r.status !== 'done' && r.status !== 'running' && <Button size="sm" variant="outline" onClick={() => void retry(r)}>Learn now</Button>}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
