'use client';
/** Agent "mind": Experience Ledger, Experience Score per domain, history import and self replay. */
import { useState } from 'react';
import { DOMAINS } from '@aix/shared';
import { Alert, Badge, Button, EmptyState, ErrorState, Field, Select, Skeleton, Table, Td, Textarea } from '@/components/ui';
import { api, useApi } from '@/lib/api';

interface ScoreRow { domain: string; score: number; resolvedCount: number; witnessedCount: number; spanDays: number; successRate: number | null; replayScore: number | null; qualifiedToTrain: boolean; missing: string[] }
interface Replay { id: string; domain: string; purpose: string; status: string; mode: string; score: number | null; itemsTotal: number; itemsGraded: number; error: string | null; createdAt: string }
interface Profile { totals: { records: number; pending: number }; scores: ScoreRow[]; replays: Replay[]; rules: { explanation: string[] } }
interface Record_ { id: string; domain: string | null; situation: string; action: string; result: string; verification: string; occurredAt: string }

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function ExperienceTab({ id, canWrite }: { id: string; canWrite: boolean }) {
  const prof = useApi<Profile>(`/experience/agents/${id}`);
  const recs = useApi<{ items: Record_[]; total: number }>(`/experience/agents/${id}/records?pageSize=25`);
  const [content, setContent] = useState('');
  const [domain, setDomain] = useState('all');
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => { void prof.mutate(); void recs.mutate(); };

  async function run(fn: () => Promise<string>) {
    setBusy(true); setMsg(null);
    try { setMsg({ tone: 'success', text: await fn() }); refresh(); } catch (e) { setMsg({ tone: 'danger', text: errText(e) }); } finally { setBusy(false); }
  }

  if (prof.isLoading) return <Skeleton className="h-40" />;
  if (prof.error) return <ErrorState error={prof.error} onRetry={() => prof.mutate()} />;
  const p = prof.data!;

  return (
    <div className="space-y-6">
      <div className="card p-5 space-y-2">
        <h3 className="font-semibold">Experience — this agent&apos;s real track record</h3>
        <ul className="list-disc pl-5 text-sm text-muted">{p.rules.explanation.map((t) => <li key={t}>{t}</li>)}</ul>
        <p className="text-sm">{p.totals.records} recorded cases · {p.totals.pending} waiting for an outcome</p>
      </div>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      {canWrite && <MemoryConnectCard id={id} />}

      {p.scores.length > 0 && (
        <div className="card"><Table head={['Domain', 'Experience', 'Cases (witnessed)', 'Span', 'Success', 'Replay', 'Can train']}>
          {p.scores.map((s) => (
            <tr key={s.domain}>
              <Td>{s.domain}</Td><Td><b>{s.score}</b>/100</Td><Td>{s.resolvedCount} ({s.witnessedCount})</Td>
              <Td>{Math.round(s.spanDays / 30)} mo</Td><Td>{s.successRate == null ? '—' : `${Math.round(s.successRate * 100)}%`}</Td>
              <Td>{s.replayScore ?? '—'}</Td>
              <Td>{s.qualifiedToTrain ? <Badge tone="success">Qualified</Badge> : <span className="text-xs text-muted">{s.domain === 'all' ? '—' : s.missing.join(' ')}</span>}</Td>
            </tr>
          ))}
        </Table></div>
      )}

      {canWrite && (
        <div className="card p-5 space-y-3">
          <h3 className="font-semibold">Import past history</h3>
          <p className="text-sm text-muted">JSON array, JSONL or CSV with columns: domain, situation, action, reasoning, outcome, lesson, result (success/failure/mixed/pending), occurredAt, tags. Imported history counts as self-reported; decisions your agent logs live (then resolves) count as witnessed.</p>
          <Field label="History file content"><Textarea rows={6} value={content} onChange={(e) => setContent(e.target.value)} placeholder='[{"domain":"programming","situation":"…","action":"…","result":"success","outcome":"…","lesson":"…","occurredAt":"2024-05-01"}]' /></Field>
          <div className="flex flex-wrap gap-2 items-center">
            <input type="file" accept=".json,.jsonl,.csv,.txt" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setContent(await f.text()); }} />
            <Button disabled={busy || !content.trim()} onClick={() => run(async () => {
              const r = await api.post<{ created: number; duplicates: number; rejectedCount: number; rejected: { index: number; reason: string }[] }>(`/experience/agents/${id}/import`, { content });
              setContent('');
              return `Imported ${r.created} case(s); ${r.duplicates} duplicate(s); ${r.rejectedCount} rejected${r.rejected[0] ? ` (e.g. row ${r.rejected[0].index + 1}: ${r.rejected[0].reason})` : ''}.`;
            })}>Import</Button>
          </div>
        </div>
      )}

      {canWrite && (
        <div className="card p-5 space-y-3">
          <h3 className="font-semibold">Experience replay</h3>
          <p className="text-sm text-muted">Real past cases are replayed with the outcome hidden; the agent must decide again from the rest of its experience. Needs at least 5 cases with a known outcome (failures need a lesson).</p>
          <div className="flex gap-2 items-end">
            <Field label="Domain"><Select value={domain} onChange={(e) => setDomain(e.target.value)}>
              <option value="all">All domains</option>
              {DOMAINS.map((d) => <option key={d.slug} value={d.slug}>{d.name}</option>)}
            </Select></Field>
            <Button variant="ai" disabled={busy} onClick={() => run(async () => { await api.post(`/experience/agents/${id}/replays`, { domain }); return 'Replay started. Prompt-connected agents answer from their task inbox — tell your agent: "Check Hive Mind for tasks and answer them all."'; })}>Run replay</Button>
          </div>
          {p.replays.length > 0 && (
            <Table head={['Date', 'Purpose', 'Domain', 'Status', 'Score', 'Cases']}>
              {p.replays.map((r) => (
                <tr key={r.id}><Td>{new Date(r.createdAt).toLocaleString()}</Td><Td>{r.purpose.replace('_', ' ')}</Td><Td>{r.domain}</Td>
                  <Td>{r.status}{r.error ? ` — ${r.error}` : ''}</Td><Td>{r.score ?? '—'}</Td><Td>{r.itemsGraded}/{r.itemsTotal}</Td></tr>
              ))}
            </Table>
          )}
        </div>
      )}

      <div className="card">
        {recs.data?.items.length ? (
          <Table head={['When', 'Domain', 'Situation', 'Decision', 'Result', 'Verification']}>
            {recs.data.items.map((e) => (
              <tr key={e.id}><Td>{e.occurredAt.slice(0, 10)}</Td><Td>{e.domain ?? 'general'}</Td><Td className="max-w-xs truncate">{e.situation}</Td>
                <Td className="max-w-xs truncate">{e.action}</Td><Td>{e.result}</Td><Td>{e.verification === 'witnessed' ? <Badge tone="success">witnessed</Badge> : 'self-reported'}</Td></tr>
            ))}
          </Table>
        ) : <EmptyState title="No experience recorded yet" description="A new agent has no experience, so its Experience Score is 0 whatever its model. Import its past work above, or let the connected agent record decisions via the agent API (see connect.md)." />}
      </div>
    </div>
  );
}

interface MemoryPrompts { promptConnected: boolean; syncPrompt: string; exportPrompt: string; templateCsv: string }

/** "Connect your agent's memory": prompts the owner pastes into the agent (sync via API, or export a file to import). */
export function MemoryConnectCard({ id }: { id: string }) {
  const { data } = useApi<MemoryPrompts>(`/experience/agents/${id}/memory-prompt`);
  const [copied, setCopied] = useState<string | null>(null);
  if (!data) return null;
  const copy = async (key: string, text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(key); setTimeout(() => setCopied(null), 2000); } catch { setCopied(null); }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([data.templateCsv], { type: 'text/csv' }));
    const a = document.createElement('a'); a.href = url; a.download = 'hive-mind-experience-template.csv'; a.click(); URL.revokeObjectURL(url);
  };
  return (
    <div className="card p-5 space-y-3">
      <h3 className="font-semibold">Connect your agent&apos;s memory</h3>
      <p className="text-sm text-muted">
        Paste a prompt into your agent. It reads its own memory and history and sends every real case to this agent&apos;s
        Experience Ledger. The prompt forbids inventing cases: imported history counts as self-reported, and replays test it.
      </p>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ai" onClick={() => copy('sync', data.syncPrompt)}>{copied === 'sync' ? 'Copied ✓' : 'Copy memory-sync prompt'}</Button>
          <span className="text-xs text-muted">{data.promptConnected
            ? 'Recommended: your agent is connected, so it sends its history directly and keeps recording live (witnessed).'
            : 'Works once the agent is connected via prompt (it needs its agent token). Not connected? Use the export prompt.'}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => copy('export', data.exportPrompt)}>{copied === 'export' ? 'Copied ✓' : 'Copy export prompt'}</Button>
          <span className="text-xs text-muted">Any agent: it writes its history as JSON. Save it as a .json file and import it below.</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={download}>Download CSV template</Button>
          <span className="text-xs text-muted">Fill it in yourself or export from your own logs.</span>
        </div>
      </div>
      <details className="text-sm"><summary className="cursor-pointer text-muted">Preview the memory-sync prompt</summary>
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-black/5 p-3 text-xs">{data.syncPrompt}</pre>
      </details>
    </div>
  );
}
