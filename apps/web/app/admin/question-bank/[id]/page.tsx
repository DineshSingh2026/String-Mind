'use client';
/** Admin · Question bank · one question: everything the judge sees (admins only), review actions, calibration verification. */
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { DOMAINS } from '@aix/shared';
import { Alert, Badge, Button, Card, CardBody, CardHeader, ErrorState, Input, Select, Skeleton, Textarea, fmtDateTime, useToast } from '@/components/ui';
import { StatusBadge } from '@/components/admin/kit';
import { api, errorMessage, useApi } from '@/lib/api';

type Row = Record<string, any>;
type Detail = { question: Row; calibrations: Row[]; reviewer: { id: string; name: string; email: string } | null };
const label = (s: string) => String(s ?? '').replace(/_/g, ' ');
const domainName = (slug: string | null) => DOMAINS.find((d) => d.slug === slug)?.name ?? slug ?? '(unmapped)';

function Section({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return <Card><CardHeader title={title} subtitle={subtitle} /><CardBody>{children}</CardBody></Card>;
}
const Pre = ({ children }: { children: ReactNode }) => <div className="whitespace-pre-wrap text-sm leading-relaxed text-fg">{children}</div>;
const Json = ({ v }: { v: unknown }) => <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-ink-900/70 p-3 font-mono text-[11px] text-fg-muted">{JSON.stringify(v, null, 2)}</pre>;

export default function QuestionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, mutate } = useApi<Detail>(`/pro-bank/questions/${id}`);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();

  if (error) return <ErrorState error={error} onRetry={() => void mutate()} />;
  if (!data) return <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-32" />)}</div>;
  const q = data.question;
  const meta = (q.meta ?? {}) as Row;
  const traps: Row[] = Array.isArray(meta.hiddenTraps) ? meta.hiddenTraps : [];
  const reviewNote = note ?? q.reviewNote ?? '';

  const act = async (key: string, body: Row, msg: string) => {
    setBusy(key);
    try { await api.patch(`/pro-bank/questions/${id}`, { ...body, ...(reviewNote !== (q.reviewNote ?? '') ? { reviewNote } : {}) }); toast('success', msg); await mutate(); }
    catch (e) { toast('danger', errorMessage(e)); } finally { setBusy(null); }
  };

  return (
    <div className="space-y-5">
      <Link href="/admin/question-bank" className="inline-flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg"><ArrowLeft className="h-3.5 w-3.5" />Question bank</Link>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <code className="font-mono text-xs text-fg-subtle">{q.source} · {q.externalId}</code>
          <h1 className="mt-1 text-xl font-semibold">{domainName(q.domainSlug)}{q.subtopic ? <span className="text-fg-muted"> · {q.subtopic}</span> : null}</h1>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <StatusBadge value={q.status} />
            <Badge>{q.difficulty}</Badge>
            <Badge>{label(q.taskType)}</Badge>
            <Badge tone={q.gradingMode === 'case_rubric' ? 'gold' : q.gradingMode === 'numeric' ? 'electric' : 'neutral'}>{label(q.gradingMode)}</Badge>
            <Badge tone={q.visibility === 'private' ? 'violet' : 'neutral'}>{label(q.visibility)}</Badge>
            {q.expertReviewRequired && <Badge tone="warning">expert review required</Badge>}
            {q.reviewedAt && <Badge tone="success">reviewed {fmtDateTime(q.reviewedAt)}{data.reviewer ? ` by ${data.reviewer.name}` : ''}</Badge>}
          </div>
          <p className="mt-2 text-xs text-fg-subtle">Source domain: {q.domainName} · licence: {q.license || '—'} · canary <code className="font-mono">{q.canary}</code> · served {q.timesServed}×{meta.difficultyNote ? ` · ${meta.difficultyNote}` : ''}</p>
        </div>
      </div>

      <Card>
        <CardHeader title="Review" subtitle="Approve records you as reviewer (item stays active). Send back = review (not selectable). Re-imports never override a reviewed item's status." />
        <CardBody className="space-y-3">
          <Textarea rows={2} placeholder="Review note (optional)" value={reviewNote} onChange={(e) => setNote(e.target.value)} />
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" loading={busy === 'approve'} onClick={() => act('approve', { approve: true, status: 'active' }, 'Approved')}>Approve</Button>
            <Button variant="outline" loading={busy === 'review'} onClick={() => act('review', { status: 'review' }, 'Sent back to review')}>Send back</Button>
            <Button variant="outline" loading={busy === 'retired'} onClick={() => act('retired', { status: 'retired' }, 'Retired')}>Retire</Button>
            <Button variant="danger" loading={busy === 'rejected'} onClick={() => act('rejected', { status: 'rejected' }, 'Rejected')}>Reject</Button>
            <Select aria-label="Visibility" className="!w-auto" value={q.visibility} onChange={(e) => act('vis', { visibility: e.target.value }, 'Visibility updated')}>
              <option value="private">private (certification-eligible)</option>
              <option value="public_example">public example (practice only)</option>
            </Select>
          </div>
        </CardBody>
      </Card>

      {q.validationIssues?.length > 0 && (
        <Alert tone="danger" title={`${q.validationIssues.length} validation issue(s)`}>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">{q.validationIssues.map((i: string, k: number) => <li key={k}>{i}</li>)}</ul>
        </Alert>
      )}

      {q.caseMaterial && <Section title="Case material" subtitle="Shown to the agent"><Pre>{q.caseMaterial}</Pre></Section>}
      <Section title="Task" subtitle="Shown to the agent"><Pre>{q.task}</Pre></Section>

      <Section title="Rubric" subtitle="Private — never sent to the agent. must_find items are highlighted.">
        {q.rubric?.length ? (
          <div className="space-y-2">
            {q.rubric.map((r: Row, i: number) => (
              <div key={r.id ?? i} className={r.type === 'must_find' ? 'rounded-xl border border-gold/40 bg-gold/5 p-3' : r.type === 'safety' ? 'rounded-xl border border-danger/30 bg-danger/5 p-3' : 'rounded-xl border border-line/60 p-3'}>
                <div className="flex flex-wrap items-center gap-2">
                  <code className="font-mono text-[11px] text-fg-subtle">{r.id}</code>
                  <Badge tone={r.type === 'must_find' ? 'gold' : r.type === 'safety' ? 'danger' : 'neutral'}>{label(r.type ?? 'quality')}</Badge>
                  <span className="ml-auto font-mono text-xs tabular-nums">{r.points} pts</span>
                </div>
                <p className="mt-1 text-sm">{r.criterion}</p>
                {r.evidence_of_success && <p className="mt-1 text-xs text-fg-muted"><b>Evidence of success:</b> {r.evidence_of_success}</p>}
                {r.partial_credit && <p className="mt-0.5 text-xs text-fg-muted"><b>Partial credit:</b> {r.partial_credit}</p>}
              </div>
            ))}
            <p className="text-right text-xs text-fg-subtle">Total {q.rubric.reduce((a: number, r: Row) => a + Number(r.points ?? 0), 0)} pts</p>
          </div>
        ) : <p className="text-sm text-fg-muted">No rubric.</p>}
      </Section>

      {traps.length > 0 && (
        <Section title="Hidden traps" subtitle="What an expert should notice">
          <ul className="space-y-1.5 text-sm">{traps.map((t, i) => <li key={t.id ?? i}><code className="mr-2 font-mono text-[11px] text-fg-subtle">{t.id}</code>{t.description}</li>)}</ul>
        </Section>
      )}

      <Section title="Reference solution" subtitle="Private">{q.referenceSolution ? <Pre>{q.referenceSolution}</Pre> : <p className="text-sm text-fg-muted">None (template item — graded against the rubric only).</p>}</Section>

      {q.redFlags?.length > 0 && <Section title="Red flags"><ul className="list-disc space-y-1 pl-5 text-sm">{q.redFlags.map((r: string, i: number) => <li key={i}>{r}</li>)}</ul></Section>}
      {q.deterministicChecks?.length > 0 && <Section title="Deterministic checks"><Json v={q.deterministicChecks} /></Section>}
      {q.variations?.length > 0 && <Section title="Variations"><div className="space-y-2">{q.variations.map((v: Row, i: number) => <div key={i} className="rounded-xl border border-line/60 p-3 text-sm"><p>{v.twist}</p>{v.rubric_changes && <p className="mt-1 text-xs text-fg-muted">Rubric changes: {typeof v.rubric_changes === 'string' ? v.rubric_changes : JSON.stringify(v.rubric_changes)}</p>}</div>)}</div></Section>}

      <Section title={`Calibration answers (${data.calibrations.length})`} subtitle="Synthetic answers are AI-written and unverified until an admin verifies them.">
        {data.calibrations.length ? <div className="space-y-3">{data.calibrations.map((c) => <Calibration key={c.id} c={c} rubric={q.rubric ?? []} onDone={() => mutate()} />)}</div>
          : <p className="text-sm text-fg-muted">No calibration answers for this question.</p>}
      </Section>

      <Section title="Metadata"><Json v={meta} /></Section>
    </div>
  );
}

function Calibration({ c, rubric, onDone }: { c: Row; rubric: Row[]; onDone: () => void }) {
  const [edit, setEdit] = useState(false);
  const [scores, setScores] = useState<Record<string, string>>(() => Object.fromEntries(rubric.map((r) => [String(r.id), String(c.scores?.[r.id] ?? 0)])));
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const sum = Object.values(scores).reduce((a, v) => a + (Number(v) || 0), 0);
  const verify = async (corrected: boolean) => {
    setBusy(true);
    try {
      await api.post(`/pro-bank/calibration/${c.id}/verify`, corrected ? { scores: Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, Number(v) || 0])) } : {});
      toast('success', corrected ? 'Corrected and verified' : 'Verified'); setEdit(false); onDone();
    } catch (e) { toast('danger', errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <div className="rounded-xl border border-line/60 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={c.level === 'expert' ? 'success' : c.level === 'generic' ? 'neutral' : c.level === 'unsafe' || c.level === 'confidently_wrong' ? 'danger' : 'warning'}>{label(c.level)}</Badge>
        <Badge tone={c.provenance === 'synthetic' ? 'neutral' : 'success'}>{label(c.provenance)}</Badge>
        <span className="ml-auto font-mono text-sm tabular-nums">{c.total} / 100</span>
      </div>
      <p className="mt-2 whitespace-pre-wrap text-sm">{c.answer}</p>
      <p className="mt-2 text-xs text-fg-muted">Scores: {Object.entries(c.scores ?? {}).map(([k, v]) => `${k} ${v}`).join(' · ') || '—'}{c.redFlagsFired?.length ? ` · red flags: ${c.redFlagsFired.join(', ')}` : ''}</p>
      {c.rationale && <p className="mt-1 whitespace-pre-wrap text-xs text-fg-subtle">{c.rationale}</p>}
      {edit && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {rubric.map((r) => (
            <label key={r.id} className="text-xs text-fg-muted">{r.id} (max {r.points})
              <Input type="number" min={0} max={r.points} step="0.5" value={scores[r.id] ?? ''} onChange={(e) => setScores((s) => ({ ...s, [r.id]: e.target.value }))} />
            </label>
          ))}
          <p className="self-end text-xs text-fg-muted">New total: <b className="text-fg">{+sum.toFixed(2)}</b></p>
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {c.provenance === 'synthetic' && !edit && <Button size="sm" variant="primary" loading={busy} onClick={() => verify(false)}>Verify as is</Button>}
        {!edit ? <Button size="sm" variant="outline" onClick={() => setEdit(true)}>Correct scores…</Button>
          : <><Button size="sm" variant="primary" loading={busy} onClick={() => verify(true)}>Save corrected & verify</Button><Button size="sm" variant="ghost" onClick={() => setEdit(false)}>Cancel</Button></>}
      </div>
    </div>
  );
}
