'use client';
/**
 * Admin · Question bank — professional evaluation items (pro_questions): real counts, filters, bulk review actions and
 * "Run import". Clean imports are live ('active') immediately; admins review after activation.
 */
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { BookOpenCheck, CheckCircle2, Database, FlaskConical, ShieldAlert, Sparkles, UploadCloud } from 'lucide-react';
import { DOMAINS } from '@aix/shared';
import { Alert, Badge, Button, Card, CardHeader, Checkbox, EmptyState, ErrorState, Input, Modal, Select, Skeleton, Stat, Table, Td, fmtNumber, useToast } from '@/components/ui';
import { AdminHeader, StatusBadge } from '@/components/admin/kit';
import { api, errorMessage, useApi } from '@/lib/api';

type Row = Record<string, any>;
type Stats = {
  total: number; withIssues: number; needsExpertReview: number; reviewed: number;
  byStatus: Record<string, number>; byVisibility: Record<string, number>; byDifficulty: Record<string, number>; byMode: Record<string, number>;
  bySource: Record<string, number>; byTaskType: Record<string, number>;
  byDomain: { slug: string; total: number; active: number; review: number; private: number; caseRubric: number; templateRubric: number; numeric: number; beginner: number; intermediate: number; professional: number; expert: number }[];
  issueKinds: { kind: string; n: number }[];
  calibration: { total: number; byProvenance: Record<string, number>; byLevel: Record<string, number> };
  twists: number; proofGuidanceDomains: number; inboxDir: string;
};
type ImportSummary = {
  dir: string; dryRun: boolean; durationMs: number; unmappedDomains: string[];
  sources: { source: string; read: number; imported: number; updated: number; unchanged: number; failedVerification: number; flagged: number; duplicates: number; parseErrors: number; calibrations: { imported: number }; twists: { imported: number }; proofGuidance: number }[];
};

const DIFFICULTIES = ['beginner', 'intermediate', 'professional', 'expert'];
const MODES = ['case_rubric', 'template_rubric', 'numeric'];
const STATUSES = ['active', 'review', 'draft', 'retired', 'rejected'];
const TASK_TYPES = ['conceptual_diagnosis', 'case_decision', 'work_product', 'error_analysis', 'quant_reasoning', 'counterfactual', 'research_synthesis', 'adversarial_test', 'teach_and_transfer', 'safety_and_governance', 'calculation'];
const domainName = (slug: string | null) => DOMAINS.find((d) => d.slug === slug)?.name ?? slug ?? '(unmapped)';
const label = (s: string) => s.replace(/_/g, ' ');

type Filters = { domain: string; subtopic: string; difficulty: string; taskType: string; gradingMode: string; visibility: string; status: string; source: string; hasIssues: string; needsExpertReview: boolean; q: string };
const EMPTY: Filters = { domain: '', subtopic: '', difficulty: '', taskType: '', gradingMode: '', visibility: '', status: '', source: '', hasIssues: '', needsExpertReview: false, q: '' };

function toQuery(f: Filters) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== '' && v !== false) p.set(k, String(v));
  return p;
}
function toFilterBody(f: Filters) {
  const b: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f)) if (v !== '' && v !== false) b[k] = k === 'hasIssues' ? v === 'true' : v;
  return b;
}

export default function QuestionBankPage() {
  const stats = useApi<Stats>('/pro-bank/stats');
  const [f, setF] = useState<Filters>(EMPTY);
  const [page, setPage] = useState(1);
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => { setF((x) => ({ ...x, [k]: v })); setPage(1); };
  const qs = useMemo(() => { const p = toQuery(f); p.set('page', String(page)); p.set('pageSize', '25'); return p.toString(); }, [f, page]);
  const list = useApi<{ items: Row[]; total: number; page: number; pageSize: number }>(`/pro-bank/questions?${qs}`, { keepPreviousData: true });
  const [importing, setImporting] = useState(false);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [bulk, setBulk] = useState<null | { action: 'approve' | 'active' | 'retired' | 'review' | 'rejected' }>(null);
  const toast = useToast();
  const s = stats.data;

  const runImport = async () => {
    setImporting(true);
    try {
      const r = await api.post<ImportSummary>('/pro-bank/import', {});
      setSummary(r);
      await Promise.all([stats.mutate(), list.mutate()]);
    } catch (e) { toast('danger', errorMessage(e)); } finally { setImporting(false); }
  };

  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;
  const sources = Object.keys(s?.bySource ?? {}).sort();

  return (
    <div className="space-y-5">
      <AdminHeader
        title="Question bank"
        description="Professional evaluation items imported from the knowledge library and generated scenarios. Clean items go live on import; admins review after activation. Difficulty labels are author- or generator-assigned, not calibrated."
        actions={<Button variant="primary" icon={<UploadCloud className="h-4 w-4" />} loading={importing} onClick={runImport}>Run import</Button>}
      />

      {stats.error ? <ErrorState error={stats.error} onRetry={() => void stats.mutate()} /> : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Stat label="Questions" value={s?.total ?? 0} loading={!s} icon={<Database className="h-4 w-4" />} tone="gold" hint={s ? `${fmtNumber(s.byVisibility.private ?? 0)} private · ${fmtNumber(s.byVisibility.public_example ?? 0)} public examples` : undefined} />
          <Stat label="Active" value={s?.byStatus.active ?? 0} loading={!s} icon={<CheckCircle2 className="h-4 w-4" />} tone="success" hint={s ? `${fmtNumber(s.byStatus.retired ?? 0)} retired · ${fmtNumber(s.byStatus.rejected ?? 0)} rejected` : undefined} />
          <Stat label="In review" value={s?.byStatus.review ?? 0} loading={!s} icon={<ShieldAlert className="h-4 w-4" />} tone="violet" hint={s ? `${fmtNumber(s.withIssues)} with validation issues` : undefined} />
          <Stat label="Needs expert review" value={s?.needsExpertReview ?? 0} loading={!s} icon={<BookOpenCheck className="h-4 w-4" />} tone="electric" hint="active, flagged, not yet reviewed" />
          <Stat label="Calibration answers" value={s?.calibration.total ?? 0} loading={!s} icon={<FlaskConical className="h-4 w-4" />} hint={s ? `${fmtNumber(s.calibration.byProvenance.human_verified ?? 0)} human-verified · ${fmtNumber(s.calibration.byProvenance.synthetic ?? 0)} synthetic` : undefined} />
          <Stat label="Twists" value={s?.twists ?? 0} loading={!s} icon={<Sparkles className="h-4 w-4" />} hint={s ? `proof guidance: ${s.proofGuidanceDomains} domain record(s)` : undefined} />
        </div>
      )}

      {s && <Breakdown s={s} onDomain={(slug) => set('domain', slug)} />}

      <Card>
        <CardHeader title="Filters" subtitle="Bulk actions apply to every item matching the filters (items with validation issues are skipped unless you filter for them)." action={<Button size="sm" variant="ghost" onClick={() => { setF(EMPTY); setPage(1); }}>Reset</Button>} />
        <div className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-4">
          <Select aria-label="Domain" value={f.domain} onChange={(e) => set('domain', e.target.value)}>
            <option value="">All domains</option>
            {DOMAINS.map((d) => <option key={d.slug} value={d.slug}>{d.name}</option>)}
            <option value="(unmapped)">(unmapped)</option>
          </Select>
          <Input aria-label="Subtopic" placeholder="Subtopic contains…" value={f.subtopic} onChange={(e) => set('subtopic', e.target.value)} />
          <Select aria-label="Difficulty" value={f.difficulty} onChange={(e) => set('difficulty', e.target.value)}><option value="">Any difficulty</option>{DIFFICULTIES.map((d) => <option key={d} value={d}>{d}</option>)}</Select>
          <Select aria-label="Task type" value={f.taskType} onChange={(e) => set('taskType', e.target.value)}><option value="">Any task type</option>{TASK_TYPES.map((d) => <option key={d} value={d}>{label(d)}</option>)}</Select>
          <Select aria-label="Grading mode" value={f.gradingMode} onChange={(e) => set('gradingMode', e.target.value)}><option value="">Any grading mode</option>{MODES.map((d) => <option key={d} value={d}>{label(d)}</option>)}</Select>
          <Select aria-label="Visibility" value={f.visibility} onChange={(e) => set('visibility', e.target.value)}><option value="">Any visibility</option><option value="private">private</option><option value="public_example">public example</option></Select>
          <Select aria-label="Status" value={f.status} onChange={(e) => set('status', e.target.value)}><option value="">Any status</option>{STATUSES.map((d) => <option key={d} value={d}>{d}</option>)}</Select>
          <Select aria-label="Source" value={f.source} onChange={(e) => set('source', e.target.value)}><option value="">Any source</option>{sources.map((d) => <option key={d} value={d}>{d}</option>)}</Select>
          <Select aria-label="Validation issues" value={f.hasIssues} onChange={(e) => set('hasIssues', e.target.value)}><option value="">Issues: any</option><option value="true">Has issues</option><option value="false">No issues</option></Select>
          <Input aria-label="Search" placeholder="Search id, task or case…" value={f.q} onChange={(e) => set('q', e.target.value)} />
          <div className="flex items-center"><Checkbox label="Needs expert review" checked={f.needsExpertReview} onChange={(v) => set('needsExpertReview', v)} /></div>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-line/60 px-5 py-3 text-xs text-fg-muted">
          <span className="mr-auto">{list.data ? `${fmtNumber(list.data.total)} matching` : '…'}</span>
          <Button size="sm" variant="primary" disabled={!list.data?.total} onClick={() => setBulk({ action: 'approve' })}>Approve filtered</Button>
          <Button size="sm" variant="outline" disabled={!list.data?.total} onClick={() => setBulk({ action: 'active' })}>Activate</Button>
          <Button size="sm" variant="outline" disabled={!list.data?.total} onClick={() => setBulk({ action: 'review' })}>Send back to review</Button>
          <Button size="sm" variant="outline" disabled={!list.data?.total} onClick={() => setBulk({ action: 'retired' })}>Retire</Button>
          <Button size="sm" variant="danger" disabled={!list.data?.total} onClick={() => setBulk({ action: 'rejected' })}>Reject</Button>
        </div>
      </Card>

      <Card>
        {list.error ? <div className="p-5"><ErrorState error={list.error} onRetry={() => void list.mutate()} /></div>
          : !list.data ? <div className="space-y-2 p-5">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-10" />)}</div>
            : !list.data.items.length ? <div className="p-5"><EmptyState title={s?.total ? 'No questions match these filters' : 'The bank is empty'} description={s?.total ? undefined : 'Run the import to load the knowledge-library inbox.'} /></div>
              : (
                <>
                  <Table head={['Question', 'Domain', 'Difficulty · type', 'Mode', 'Visibility', 'Status', 'Issues']}>
                    {list.data.items.map((r) => (
                      <tr key={r.id} className="transition-colors hover:bg-ink-850/60">
                        <Td className="max-w-md">
                          <Link href={`/admin/question-bank/${r.id}`} className="block hover:text-gold-soft">
                            <code className="font-mono text-[11px] text-fg-subtle">{r.source} · {r.externalId}</code>
                            <p className="mt-0.5 line-clamp-2 text-xs">{r.caseMaterial ? `${r.caseMaterial.slice(0, 120)}… ` : ''}{r.task}</p>
                          </Link>
                        </Td>
                        <Td><p className="text-xs">{domainName(r.domainSlug)}</p>{r.subtopic && <p className="text-[11px] text-fg-subtle">{r.subtopic}</p>}</Td>
                        <Td><div className="flex flex-col gap-1"><Badge>{r.difficulty}</Badge><span className="text-[11px] text-fg-muted">{label(r.taskType)}</span></div></Td>
                        <Td><Badge tone={r.gradingMode === 'case_rubric' ? 'gold' : r.gradingMode === 'numeric' ? 'electric' : 'neutral'}>{label(r.gradingMode)}</Badge></Td>
                        <Td><Badge tone={r.visibility === 'private' ? 'violet' : 'neutral'}>{label(r.visibility)}</Badge></Td>
                        <Td><div className="flex flex-col gap-1"><StatusBadge value={r.status} />{r.expertReviewRequired && !r.reviewedAt && <Badge tone="warning">expert review</Badge>}{r.reviewedAt && <Badge tone="success">reviewed</Badge>}</div></Td>
                        <Td>{r.validationIssues?.length ? <Badge tone="danger">{r.validationIssues.length}</Badge> : <span className="text-fg-subtle">—</span>}</Td>
                      </tr>
                    ))}
                  </Table>
                  <div className="flex items-center justify-between border-t border-line/60 px-5 py-3 text-xs text-fg-muted">
                    <span>Page {page} of {pages} · {fmtNumber(list.data.total)} total</span>
                    <div className="flex gap-2"><Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button><Button size="sm" variant="outline" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button></div>
                  </div>
                </>
              )}
      </Card>

      <BulkModal open={!!bulk} action={bulk?.action ?? 'approve'} filters={f} matching={list.data?.total ?? 0} onClose={() => setBulk(null)}
        onDone={async () => { setBulk(null); await Promise.all([stats.mutate(), list.mutate()]); }} />
      <ImportModal summary={summary} onClose={() => setSummary(null)} />
    </div>
  );
}

function Breakdown({ s, onDomain }: { s: Stats; onDomain: (slug: string) => void }) {
  const [open, setOpen] = useState(false);
  const rows = open ? s.byDomain : s.byDomain.slice(0, 8);
  return (
    <Card>
      <CardHeader title="By domain" subtitle={`${s.byDomain.length} domains with items · difficulty is author-assigned, not calibrated`} action={<Button size="sm" variant="ghost" onClick={() => setOpen(!open)}>{open ? 'Show fewer' : `Show all ${s.byDomain.length}`}</Button>} />
      <Table head={['Domain', 'Total', 'Active', 'Review', 'Active private', 'Beginner', 'Intermediate', 'Professional', 'Expert', 'Case', 'Template', 'Numeric']}>
        {rows.map((d) => (
          <tr key={d.slug} className="text-xs">
            <Td><button className="text-left hover:text-gold-soft" onClick={() => onDomain(d.slug)}>{domainName(d.slug)}</button></Td>
            {[d.total, d.active, d.review, d.private, d.beginner, d.intermediate, d.professional, d.expert, d.caseRubric, d.templateRubric, d.numeric].map((n, i) => <Td key={i} className="tabular-nums">{fmtNumber(n)}</Td>)}
          </tr>
        ))}
      </Table>
      {s.issueKinds.length > 0 && (
        <div className="border-t border-line/60 p-5">
          <p className="mb-2 text-xs font-medium text-fg-muted">Validation issue kinds</p>
          <ul className="space-y-1 text-xs">{s.issueKinds.map((k) => <li key={k.kind} className="flex gap-3"><span className="w-12 shrink-0 text-right tabular-nums text-danger-soft">{k.n}</span><span className="text-fg-muted">{k.kind}</span></li>)}</ul>
        </div>
      )}
    </Card>
  );
}

const ACTION_TEXT = {
  approve: 'Mark every matching item as expert-reviewed (status unchanged).',
  active: 'Set every matching item to active (selectable for exams).',
  review: 'Send every matching item back to review (not selectable).',
  retired: 'Retire every matching item (no longer selectable).',
  rejected: 'Reject every matching item.',
} as const;

function BulkModal({ open, action, filters, matching, onClose, onDone }: { open: boolean; action: keyof typeof ACTION_TEXT; filters: Filters; matching: number; onClose: () => void; onDone: () => Promise<void> }) {
  const [note, setNote] = useState('');
  const [includeIssues, setIncludeIssues] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const submit = async () => {
    setBusy(true);
    try {
      const body = { filter: toFilterBody(filters), includeIssues, ...(note ? { reviewNote: note } : {}), ...(action === 'approve' ? { approve: true } : { status: action }) };
      const r = await api.post<{ updated: number }>('/pro-bank/questions/bulk-status', body);
      toast('success', `${fmtNumber(r.updated)} question(s) updated`);
      setNote(''); setIncludeIssues(false);
      await onDone();
    } catch (e) { toast('danger', errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title={`Bulk: ${action === 'approve' ? 'approve' : label(action)}`} description={ACTION_TEXT[action]}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant={action === 'rejected' ? 'danger' : 'primary'} loading={busy} onClick={submit}>Apply</Button></>}>
      <div className="space-y-3 text-sm">
        <Alert tone="warning">Up to {fmtNumber(matching)} item(s) match the current filters. This is recorded in the audit log.</Alert>
        <Checkbox label="Include items that have validation issues" checked={includeIssues} onChange={setIncludeIssues} />
        <Input placeholder="Review note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
    </Modal>
  );
}

function ImportModal({ summary, onClose }: { summary: ImportSummary | null; onClose: () => void }) {
  return (
    <Modal open={!!summary} onClose={onClose} size="xl" title="Import finished" description={summary ? `${summary.dir} · ${(summary.durationMs / 1000).toFixed(1)}s` : undefined}
      footer={<Button onClick={onClose}>Close</Button>}>
      {summary && (
        <div className="space-y-3">
          <Table head={['Source', 'Read', 'New', 'Updated', 'Unchanged', 'Failed verification', 'Flagged', 'Duplicates', 'Parse errors', 'Calibrations +', 'Twists +']}>
            {summary.sources.map((x) => (
              <tr key={x.source} className="text-xs">
                <Td><code className="font-mono">{x.source}</code></Td>
                {[x.read, x.imported, x.updated, x.unchanged, x.failedVerification, x.flagged, x.duplicates, x.parseErrors, x.calibrations.imported, x.twists.imported].map((n, i) => <Td key={i} className="tabular-nums">{fmtNumber(n)}</Td>)}
              </tr>
            ))}
          </Table>
          <p className="text-xs text-fg-muted">Flagged items are imported as <b>review</b>; everything else is active. Unmapped domains: {summary.unmappedDomains.length ? summary.unmappedDomains.join(', ') : 'none'}.</p>
        </div>
      )}
    </Modal>
  );
}
