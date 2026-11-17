'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { Gauge, Plus, ShieldCheck } from 'lucide-react';
import { DOMAINS, QUALITY } from '@aix/shared';
import {
  Alert, Button, EmptyState, ErrorState, Field, Input, Modal, PageHeader, Select, Table, Tabs, Td, fmtDateTime, fmtNumber, fmtPct,
} from '@/components/ui';
import { api, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { BarTrend, C, ChartEmpty } from '@/components/app/charts';
import { DomainPicker, ListSkeleton, Section, StatusPill, domainName, shortDomainName, useAction } from '@/components/app/primitives';
import { listOf, type Agent, type Assessment, type Paged } from '@/components/app/types';
import { confPct } from '@/components/app/ScorecardView';

type Tab = 'list' | 'quality';

export default function AssessmentsPage() {
  return <Suspense fallback={<ListSkeleton rows={6} />}><AssessmentsInner /></Suspense>;
}

function AssessmentsInner() {
  const sp = useSearchParams();
  const router = useRouter();
  const { can } = useSession();
  const [tab, setTab] = useState<Tab>(sp.get('tab') === 'quality' ? 'quality' : 'list');
  const [agentId, setAgentId] = useState(sp.get('agentId') ?? '');
  const [open, setOpen] = useState(sp.get('new') === '1');
  const agents = useApi<Agent[] | Paged<Agent>>('/agents');
  const agentList = listOf(agents.data);

  return (
    <div>
      <PageHeader eyebrow="Independent evaluation" title="Capability Assessment"
        description="Agents are tested on held-out benchmark questions across StringMind's 20 domains. Scores are only shown once measured — never self-reported."
        actions={can('assessments.run') ? <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setOpen(true)}>New assessment</Button> : undefined} />
      <Tabs className="mb-6" value={tab} onChange={setTab} tabs={[{ value: 'list', label: 'Assessments' }, { value: 'quality', label: 'Quality Dashboard' }]} />
      {tab === 'list' ? (
        <AssessmentList agentId={agentId} setAgentId={setAgentId} agents={agentList} canRun={can('assessments.run')} onNew={() => setOpen(true)} />
      ) : <QualityDashboard />}
      <NewAssessmentModal open={open} onClose={() => setOpen(false)} agents={agentList} agentsLoading={agents.isLoading} defaultAgent={agentId || sp.get('agentId') || ''}
        onCreated={(id) => router.push(`/app/assessments/${id}`)} />
    </div>
  );
}

function AssessmentList({ agentId, setAgentId, agents, canRun, onNew }: { agentId: string; setAgentId: (v: string) => void; agents: Agent[]; canRun: boolean; onNew: () => void }) {
  const { data, error, isLoading, mutate } = useApi<Assessment[] | Paged<Assessment>>(`/assessments${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ''}`);
  const items = listOf(data);
  const nameOf = (a: Assessment) => a.agent?.name ?? agents.find((x) => x.id === a.agentId)?.name ?? 'Agent';
  return (
    <div className="card">
      <div className="flex flex-col gap-3 border-b border-line/60 p-4 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-[15px] font-semibold">Assessment runs</h2>
        <div className="sm:w-64">
          <label htmlFor="agent-filter" className="sr-only">Filter by agent</label>
          <Select id="agent-filter" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            <option value="">All agents</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
        </div>
      </div>
      <div className="p-4">
        {isLoading ? <ListSkeleton rows={5} /> : error ? <ErrorState error={error} onRetry={() => mutate()} /> : items.length === 0 ? (
          <EmptyState icon={<Gauge className="h-5 w-5" />} title="No assessments yet"
            description={agents.length ? 'Run an independent assessment to get verified, domain-level capability scores.' : 'Connect an agent first, then run its capability assessment.'}
            action={agents.length ? (canRun ? <Button variant="primary" onClick={onNew}>Run first assessment</Button> : undefined) : <Button variant="primary" href="/app/agents/new">Connect an agent</Button>} />
        ) : (
          <Table head={['Agent', 'Status', 'Domains', 'Progress', 'Overall', 'Started', '']}>
            {items.map((a) => {
              const p = a.progress == null ? null : a.progress <= 1 ? a.progress * 100 : a.progress;
              return (
                <tr key={a.id} className="hover:bg-ink-850/50">
                  <Td><Link href={`/app/assessments/${a.id}`} className="font-medium hover:underline">{nameOf(a)}</Link></Td>
                  <Td><StatusPill status={a.status} /></Td>
                  <Td className="text-fg-muted">{a.domainSlugs?.length ? (a.domainSlugs.length === DOMAINS.length ? 'All 20' : a.domainSlugs.length === 1 ? shortDomainName(a.domainSlugs[0]) : `${a.domainSlugs.length} domains`) : a.domains?.length ? `${a.domains.length} domains` : '—'}</Td>
                  <Td className="tabular-nums text-fg-muted">{a.status === 'completed' ? '100%' : p == null ? '—' : `${Math.round(p)}%`}{a.testsCompleted != null && <span className="ml-1 text-xs text-fg-subtle">({a.testsCompleted}{a.testsTotal ? `/${a.testsTotal}` : ''})</span>}</Td>
                  <Td className="tabular-nums">{a.overallScore == null ? <span className="text-fg-subtle">Not assessed</span> : a.overallScore.toFixed(1)}</Td>
                  <Td className="text-fg-muted">{fmtDateTime(a.createdAt)}</Td>
                  <Td><Button size="sm" variant="ghost" href={`/app/assessments/${a.id}`}>View</Button></Td>
                </tr>
              );
            })}
          </Table>
        )}
      </div>
    </div>
  );
}

function NewAssessmentModal({ open, onClose, agents, agentsLoading, defaultAgent, onCreated }: { open: boolean; onClose: () => void; agents: Agent[]; agentsLoading: boolean; defaultAgent: string; onCreated: (id: string) => void }) {
  const [agentId, setAgentId] = useState(defaultAgent);
  const [domains, setDomains] = useState<string[]>(DOMAINS.map((d) => d.slug));
  const [repeats, setRepeats] = useState(2);
  const { busy, run } = useAction();
  useEffect(() => { if (open && !agentId && agents[0]) setAgentId(defaultAgent || agents[0].id); }, [open, agents, agentId, defaultAgent]);
  const valid = agentId && domains.length > 0 && repeats >= 1 && repeats <= 5;
  const submit = async () => {
    const r = await run('create', () => api.post<Assessment>('/assessments', { agentId, domainSlugs: domains, repeats }), 'Assessment queued');
    if (r?.id) { onClose(); onCreated(r.id); }
  };
  return (
    <Modal open={open} onClose={onClose} size="lg" title="New capability assessment" description="Questions are drawn from held-out benchmark sets; ground truth is never shown to the agent."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy === 'create'} disabled={!valid} onClick={submit}>Start assessment</Button></>}>
      <div className="space-y-5">
        {!agentsLoading && agents.length === 0 ? (
          <Alert tone="warning" title="No agents connected">Connect an agent before running an assessment. <Link className="text-gold underline" href="/app/agents/new">Connect agent →</Link></Alert>
        ) : (
          <Field label="Agent" htmlFor="na-agent" required>
            <Select id="na-agent" value={agentId} onChange={(e) => setAgentId(e.target.value)} disabled={agentsLoading}>
              {agentsLoading && <option>Loading…</option>}
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name}{a.status !== 'active' ? ` (${a.status})` : ''}</option>)}
            </Select>
          </Field>
        )}
        <Field label="Domains" required><DomainPicker value={domains} onChange={setDomains} /></Field>
        <Field label="Repeats per question" htmlFor="na-rep" hint="Repeats measure consistency. More repeats → larger sample and higher confidence, but take longer.">
          <Input id="na-rep" type="number" min={1} max={5} value={repeats} onChange={(e) => setRepeats(Math.max(1, Math.min(5, Number(e.target.value) || 1)))} className="w-28" />
        </Field>
        <p className="text-xs text-fg-subtle">A domain earns a verified badge only with ≥{QUALITY.MIN_SAMPLE_FOR_VERIFIED} graded responses and ≥{QUALITY.MIN_CONFIDENCE_FOR_VERIFIED * 100}% confidence.</p>
      </div>
    </Modal>
  );
}

/* ───────── Quality Dashboard ─────────
 * Assumed shape of GET /assessments/quality (contract only lists metric names):
 * { domains?: [{ slug, name?, accuracy|null, hallucinationRate|null, consistency|null, confidence|null, sampleSize, safetyCompliance?|null }],
 *   overall?: { accuracy, hallucinationRate, consistency, evaluationConfidence, learningImprovement, retention, safetyCompliance, sampleSize } }
 * Also accepts flat top-level metric keys and `byDomain` instead of `domains`. Rates may be 0..1 or 0..100.
 */
type QDomain = { slug: string; name?: string; accuracy?: number | null; hallucinationRate?: number | null; consistency?: number | null; confidence?: number | null; evaluationConfidence?: number | null; sampleSize?: number | null; safetyCompliance?: number | null };
type Quality = Record<string, any> & { domains?: QDomain[]; byDomain?: QDomain[]; overall?: Record<string, number | null> };
const asPct = (v: unknown): number | null => (typeof v === 'number' ? (v <= 1 && v >= 0 ? v * 100 : v) : null);

function QualityDashboard() {
  const { data, error, isLoading, mutate } = useApi<Quality>('/assessments/quality');
  const domains = useMemo(() => (data?.domains ?? data?.byDomain ?? []) as QDomain[], [data]);
  if (isLoading) return <ListSkeleton rows={6} />;
  if (error) return <ErrorState error={error} onRetry={() => mutate()} />;
  const o = { ...(data ?? {}), ...(data?.overall ?? {}) } as Record<string, any>;
  const metric = (...keys: string[]) => { for (const k of keys) { const v = asPct(o[k]); if (v != null) return v; } return null; };
  const totalSample = typeof o.sampleSize === 'number' ? o.sampleSize : domains.reduce((s, d) => s + (d.sampleSize ?? 0), 0);
  const kpis = [
    { label: 'Domain accuracy', v: metric('accuracy', 'domainAccuracy'), good: (v: number) => v >= QUALITY.ACCURACY_TARGET },
    { label: 'Hallucination rate', v: metric('hallucinationRate'), good: (v: number) => v <= 5, lowerBetter: true },
    { label: 'Consistency', v: metric('consistency') },
    { label: 'Evaluation confidence', v: metric('evaluationConfidence', 'confidence') },
    { label: 'Learning improvement', v: typeof o.learningImprovement === 'number' ? o.learningImprovement : null, signed: true },
    { label: 'Retention', v: metric('retention', 'retentionRate') },
    { label: 'Safety compliance', v: metric('safetyCompliance') },
  ];
  const chart = domains.filter((d) => asPct(d.accuracy) != null).map((d) => ({ name: shortDomainName(d.slug), accuracy: Number(asPct(d.accuracy)!.toFixed(1)), n: d.sampleSize ?? 0 }));
  if (!domains.length && kpis.every((k) => k.v == null)) {
    return <EmptyState icon={<ShieldCheck className="h-5 w-5" />} title="No quality data yet" description="Quality metrics appear once your agents complete assessments." action={<Button variant="primary" href="/app/assessments?new=1">Run an assessment</Button>} />;
  }
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        {kpis.map((k) => (
          <div key={k.label} className="card p-4">
            <p className="text-[11px] text-fg-muted">{k.label}</p>
            <p className="mt-1.5 font-display text-xl font-semibold tabular-nums">{k.v == null ? '—' : `${k.signed && k.v > 0 ? '+' : ''}${k.v.toFixed(1)}${k.signed ? ' pts' : '%'}`}</p>
          </div>
        ))}
      </div>
      <Section title="Accuracy by domain" subtitle={`Dashed line = ${QUALITY.ACCURACY_TARGET}% strategic accuracy target for well-defined benchmark tasks`}>
        {chart.length ? (
          <BarTrend data={chart} xKey="name" yKey="accuracy" name="Accuracy %" target={QUALITY.ACCURACY_TARGET} targetLabel={`${QUALITY.ACCURACY_TARGET}% target`} yDomain={[0, 100]} height={280}
            valueFormatter={(v) => `${v.toFixed(1)}%`} colorFor={(r) => (r.n < QUALITY.MIN_SAMPLE_FOR_TARGET_CLAIM ? C.axis : r.accuracy >= QUALITY.ACCURACY_TARGET ? C.success : C.electric)}
            ariaLabel="Accuracy per domain against the 95 percent target" />
        ) : <ChartEmpty />}
        <p className="mt-2 text-[11px] text-fg-subtle">Grey bars have fewer than {QUALITY.MIN_SAMPLE_FOR_TARGET_CLAIM} samples — too few to claim the target either way. Green = meets target, blue = below.</p>
      </Section>
      {domains.length > 0 && (
        <div className="card">
          <Table head={['Domain', 'Accuracy', 'Hallucination', 'Consistency', 'Confidence', 'Safety', 'Sample', 'Verified-eligible']}>
            {domains.map((d) => {
              const n = d.sampleSize ?? 0; const conf = confPct(d.confidence ?? d.evaluationConfidence ?? null);
              const eligible = n >= QUALITY.MIN_SAMPLE_FOR_VERIFIED && conf != null && conf >= QUALITY.MIN_CONFIDENCE_FOR_VERIFIED * 100;
              return (
                <tr key={d.slug}>
                  <Td className="font-medium">{d.name ?? domainName(d.slug)}</Td>
                  <Td className="tabular-nums">{fmtPct(asPct(d.accuracy))}</Td>
                  <Td className="tabular-nums">{fmtPct(asPct(d.hallucinationRate))}</Td>
                  <Td className="tabular-nums">{fmtPct(asPct(d.consistency))}</Td>
                  <Td className="tabular-nums">{conf == null ? '—' : `${conf.toFixed(0)}%`}</Td>
                  <Td className="tabular-nums">{fmtPct(asPct(d.safetyCompliance))}</Td>
                  <Td className="tabular-nums">{fmtNumber(n)}</Td>
                  <Td>{eligible ? <span className="text-success-soft">Yes</span> : <span className="text-fg-subtle">Needs {n < QUALITY.MIN_SAMPLE_FOR_VERIFIED ? `${QUALITY.MIN_SAMPLE_FOR_VERIFIED - n} more samples` : 'higher confidence'}</span>}</Td>
                </tr>
              );
            })}
          </Table>
        </div>
      )}
      <Alert tone="info" title="How quality thresholds work">
        Total graded responses: {fmtNumber(totalSample)}. Verified badges need ≥{QUALITY.MIN_SAMPLE_FOR_VERIFIED} samples and ≥{QUALITY.MIN_CONFIDENCE_FOR_VERIFIED * 100}% confidence; a “meets {QUALITY.ACCURACY_TARGET}% target” claim needs ≥{QUALITY.MIN_SAMPLE_FOR_TARGET_CLAIM} samples. Retention is re-measured {QUALITY.RETENTION_DELAY_DAYS} days after training.
      </Alert>
    </div>
  );
}
