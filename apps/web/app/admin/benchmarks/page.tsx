'use client';
import { useState } from 'react';
import { Badge, Button, Field, Input, Modal, Select, Tabs, Textarea, useToast } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { AdminHeader, DataCard, StatusBadge, nameOf, useMutate, useRevalidate, when, type Row } from '@/components/admin/kit';

type Tab = 'datasets' | 'review';

export default function AdminBenchmarksPage() {
  const [tab, setTab] = useState<Tab>('datasets');
  const [ds, setDs] = useState<Row | null>(null);
  const [judge, setJudge] = useState<Row | null>(null);
  const { busy, run } = useMutate('/admin/benchmarks');
  return (
    <div className="space-y-5">
      <AdminHeader title="Benchmarks" description="Held-out datasets (never shown to agents or trainers), question ground truth, human-review flags and the evaluation review queue." />
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[{ value: 'datasets', label: 'Datasets & questions' }, { value: 'review', label: 'Human-review queue' }]} />
      {tab === 'datasets' && <>
        <DataCard title="Datasets" columns={[
          { header: 'Dataset', cell: (d) => <div><p className="font-medium">{d.name}</p><p className="text-xs text-fg-muted">{nameOf(d, 'domain', 'domainSlug')}</p></div> },
          { header: 'Version', cell: (d) => <code className="font-mono text-xs">{d.version}</code> },
          { header: 'Visibility', cell: (d) => <Badge tone={d.visibility === 'held_out' ? 'violet' : 'electric'}>{d.visibility}</Badge> },
          { header: 'Status', cell: (d) => <StatusBadge value={d.status} /> },
          { header: 'Questions', cell: (d) => d.questionCount ?? '—' },
          { header: 'Human-reviewed', cell: (d) => `${d.humanReviewedCount ?? 0}/${d.questionCount ?? 0}` },
          { header: '', cell: (d) => <Button size="sm" variant={ds?.id === d.id ? 'primary' : 'outline'} onClick={() => setDs(d)}>Questions</Button> },
        ]} path="/admin/benchmarks" />
        {ds && (
          <DataCard title={`Questions · ${ds.name} ${ds.version}`} subtitle="Ground truth is visible to admins only." action={<Button size="sm" variant="ghost" onClick={() => setDs(null)}>Close</Button>}
            path={`/admin/benchmarks/${ds.id}/questions`} columns={[
              { header: 'Prompt', cell: (q) => <p className="max-w-md whitespace-pre-wrap text-xs">{q.prompt}</p> },
              { header: 'Kind', cell: (q) => <div className="space-y-1"><Badge>{q.kind}</Badge><Badge tone="neutral">{q.difficulty}</Badge></div> },
              { header: 'Ground truth', cell: (q) => <code className="block max-w-xs whitespace-pre-wrap break-all font-mono text-[11px] text-gold-soft">{JSON.stringify(q.groundTruth)}</code> },
              { header: 'Reviewed', cell: (q) => <StatusBadge value={q.humanReviewed ? 'approved' : 'pending'} /> },
              {
                header: '', cell: (q) => <Button size="sm" variant="outline" loading={busy === q.id}
                  onClick={() => run(q.id, () => api.post(`/admin/benchmarks/questions/${q.id}/review`, { humanReviewed: !q.humanReviewed }), q.humanReviewed ? 'Marked unreviewed' : 'Marked reviewed')}>
                  {q.humanReviewed ? 'Unmark' : 'Mark reviewed'}</Button>,
              },
            ]} />
        )}
      </>}
      {tab === 'review' && (
        <DataCard title="Results needing human review" subtitle="High-impact or low-confidence automatic evaluations" path="/admin/human-review" empty="Queue is empty"
          columns={[
            { header: 'Agent', cell: (r) => nameOf(r, 'agent', 'agentName') },
            { header: 'Question', cell: (r) => <p className="max-w-sm text-xs">{r.question?.prompt ?? r.prompt ?? '—'}</p> },
            { header: 'Response', cell: (r) => <p className="max-w-sm whitespace-pre-wrap text-xs text-fg-muted">{String(r.response ?? '').slice(0, 300)}</p> },
            { header: 'Auto score', cell: (r) => <div className="space-y-1"><span className="tabular-nums">{r.score != null ? Number(r.score).toFixed(0) : '—'}</span>{r.failureCategory && <Badge tone="warning">{r.failureCategory}</Badge>}</div> },
            { header: 'Created', cell: (r) => when(r.createdAt) },
            { header: '', cell: (r) => <Button size="sm" variant="primary" onClick={() => setJudge(r)}>Review</Button> },
          ]} />
      )}
      <JudgeModal row={judge} onClose={() => setJudge(null)} />
    </div>
  );
}

function JudgeModal({ row, onClose }: { row: Row | null; onClose: () => void }) {
  const toast = useToast();
  const revalidate = useRevalidate();
  const [verdict, setVerdict] = useState('upheld');
  const [score, setScore] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const scoreNum = score === '' ? null : Number(score);
  const valid = scoreNum === null || (scoreNum >= 0 && scoreNum <= 100);
  const submit = async () => {
    setBusy(true);
    try {
      await api.post(`/admin/human-review/${row!.id}`, { verdict, ...(scoreNum !== null ? { score: scoreNum } : {}), notes: notes.trim() });
      toast('success', 'Review recorded'); await revalidate('/admin/human-review'); setNotes(''); setScore(''); onClose();
    } catch (e) { toast('danger', errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open={!!row} onClose={onClose} size="lg" title="Human review" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!valid} onClick={submit}>Submit verdict</Button></>}>
      {row && (
        <div className="space-y-4 text-sm">
          <div><p className="text-xs text-fg-subtle">Question</p><p className="whitespace-pre-wrap">{row.question?.prompt ?? row.prompt}</p></div>
          {row.question?.groundTruth && <div><p className="text-xs text-fg-subtle">Ground truth</p><code className="block whitespace-pre-wrap break-all font-mono text-xs text-gold-soft">{JSON.stringify(row.question.groundTruth)}</code></div>}
          <div><p className="text-xs text-fg-subtle">Agent response</p><p className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-xl border border-line bg-ink-950/50 p-3 text-fg-muted">{row.response}</p></div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Verdict" htmlFor="verdict"><Select id="verdict" value={verdict} onChange={(e) => setVerdict(e.target.value)}><option value="upheld">Upheld (automatic score correct)</option><option value="overturned">Overturned</option></Select></Field>
            <Field label="Corrected score (0–100)" htmlFor="hr-score" error={valid ? undefined : 'Must be 0–100'}><Input id="hr-score" type="number" min={0} max={100} value={score} onChange={(e) => setScore(e.target.value)} placeholder="optional" /></Field>
          </div>
          <Field label="Notes" htmlFor="hr-notes"><Textarea id="hr-notes" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        </div>
      )}
    </Modal>
  );
}
