'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { CheckCircle2, Info, Wifi, WifiOff, XCircle } from 'lucide-react';
import { QUALITY } from '@aix/shared';
import { Alert, Badge, Button, EmptyState, ErrorState, ScoreRing, Select, Skeleton, Table, Td, fmtDateTime, fmtNumber } from '@/components/ui';
import { useApi } from '@/lib/api';
import { useRealtime } from '@/lib/realtime';
import { BackLink, ListSkeleton, Section, StatusPill, VerifiedBadge, domainName, titleCase } from '@/components/app/primitives';
import { confPct } from '@/components/app/ScorecardView';
import { listOf, type Assessment, type Paged } from '@/components/app/types';
import { PulseDot, StaggerLi, StaggerList, motion } from '@/components/app/motion';
import { CheckInHint } from '@/components/app/PromptConnect';
import { api, errorMessage } from '@/lib/api';

interface Result { id: string; domainSlug?: string; domain?: string; questionId?: string; prompt: string; response: string | null; correct: boolean | null; score: number | null; failureCategory?: string | null; evaluator?: string | null; kind?: string; repeat?: number; needsHumanReview?: boolean }

export default function AssessmentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [live, setLive] = useState<{ progress?: number; testsCompleted?: number } | null>(null);
  const { data: a, error, isLoading, mutate } = useApi<Assessment>(`/assessments/${id}`);
  const running = !a || a.status === 'queued' || a.status === 'running';
  const { connected } = useRealtime(running ? `assessment:${id}` : null, (event, data) => {
    if (event === 'progress') setLive({ progress: data?.progress, testsCompleted: data?.testsCompleted });
    if (event === 'completed' || event === 'failed') { setLive(null); void mutate(); }
  });
  // Polling fallback when the socket is down (and a slow safety poll otherwise).
  useApi<Assessment>(running ? `/assessments/${id}` : null, { refreshInterval: connected ? 30000 : 4000 });

  if (isLoading) return <div className="space-y-4"><Skeleton className="h-36 rounded-2xl" /><Skeleton className="h-64 rounded-2xl" /></div>;
  if (error || !a) return <><BackLink href="/app/assessments">Assessments</BackLink><ErrorState error={error ?? 'Not found'} onRetry={() => mutate()} /></>;

  const rawP = live?.progress ?? a.progress ?? null;
  const progress = rawP == null ? null : rawP <= 1 ? rawP * 100 : rawP;
  const tests = live?.testsCompleted ?? a.testsCompleted ?? null;
  const domains = a.domains ?? [];
  const waiting = running && a.summary?.mode === 'async' && (progress ?? 0) < 100;
  const agentName = a.agent?.name ?? 'your agent';
  const cancel = async () => {
    if (!window.confirm('Cancel this assessment? Unanswered tasks are withdrawn from your agent.')) return;
    try { await api.post(`/assessments/${id}/cancel`, {}); } catch (e) { window.alert(errorMessage(e)); }
    void mutate();
  };

  return (
    <div className="space-y-6">
      <BackLink href="/app/assessments">Assessments</BackLink>
      <section className={`card relative overflow-hidden p-5 ${running ? 'border-electric/30' : ''}`}>
        {running && <div className="ax-glow-pulse pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-electric/15 blur-3xl" aria-hidden />}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <ScoreRing score={a.status === 'completed' ? a.overallScore ?? null : null} size={84} label="Overall score" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2"><h1 className="text-xl font-semibold">Capability assessment</h1><StatusPill status={a.status} /></div>
            <p className="mt-1 text-sm text-fg-muted">
              Agent: {a.agent ? <Link href={`/app/agents/${a.agentId}`} className="text-fg hover:underline">{a.agent.name}</Link> : a.agentId} · Started {fmtDateTime(a.createdAt)}{a.completedAt ? ` · Completed ${fmtDateTime(a.completedAt)}` : ''}{a.repeats ? ` · ${a.repeats} repeats` : ''}
            </p>
          </div>
          {running && (
            <span className={`flex items-center gap-1.5 text-xs ${connected ? 'text-success' : 'text-fg-subtle'}`} aria-live="polite">
              {connected ? <Wifi className="h-3.5 w-3.5" aria-hidden /> : <WifiOff className="h-3.5 w-3.5" aria-hidden />}{connected ? 'Live updates' : 'Polling for updates'}
            </span>
          )}
        </div>
        {waiting && (
          <div className="mt-5 rounded-xl border border-gold/30 bg-gold/5 p-4" aria-live="polite">
            <p className="text-sm font-semibold text-fg">Waiting for {agentName} — {fmtNumber(tests ?? 0)} of {fmtNumber(a.testsTotal ?? 0)} answered.</p>
            <p className="mt-1 text-sm text-fg-muted">Tasks wait until {a.summary?.deadline ? fmtDateTime(a.summary.deadline) : '24 hours after the start'}. The score appears as soon as every question is answered.</p>
            <CheckInHint className="mt-3" />
            <div className="mt-3"><Button size="sm" variant="ghost" onClick={cancel}>Cancel assessment</Button></div>
          </div>
        )}
        {running && (
          <div className="mt-5">
            <div className="mb-1.5 flex justify-between text-xs text-fg-muted"><span className="flex items-center gap-2"><PulseDot tone={a.status === 'queued' ? 'warning' : 'electric'} />{a.status === 'queued' ? 'Queued — waiting for a worker' : waiting ? 'Waiting for your agent to check in…' : 'Running benchmark questions…'}</span><span className="tabular-nums">{progress == null ? '' : `${Math.round(progress)}%`}{tests != null ? ` · ${fmtNumber(tests)}${a.testsTotal ? ` / ${fmtNumber(a.testsTotal)}` : ''} tests` : ''}</span></div>
            <div className="ax-shimmer relative h-2.5 overflow-hidden rounded-full bg-ink-800" role="progressbar" aria-label="Assessment progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress ?? 0)}>
              <motion.div className="h-full rounded-full bg-ai-sheen shadow-[0_0_14px_rgb(var(--electric)/0.7)]" initial={{ width: 0 }} animate={{ width: `${Math.max(2, progress ?? 0)}%` }} transition={{ type: 'spring', stiffness: 60, damping: 18 }} />
            </div>
          </div>
        )}
        {a.status === 'failed' && <div className="mt-4"><Alert tone="danger" title="Assessment failed"><span className="whitespace-pre-wrap break-words">{a.error ?? 'The assessment could not complete. Check the agent connection and try again.'}</span></Alert></div>}
        {a.status === 'completed' && <div className="mt-4"><Button size="sm" variant="outline" href={`/app/agents/${a.agentId}`}>View full scorecard</Button></div>}
      </section>

      {domains.length > 0 && (
        <Section title="Results by domain">
          <StaggerList as="div" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {domains.map((d, i) => {
              const c = confPct(d.confidence);
              return (
                <StaggerLi as="div" key={d.slug} className="ax-spot ax-lift relative flex items-center gap-3 overflow-hidden rounded-xl border border-line/70 bg-ink-950/30 p-3">
                  {d.score != null && <motion.span aria-hidden className={`absolute bottom-0 left-0 h-0.5 ${d.score >= 85 ? 'bg-success' : d.score >= 65 ? 'bg-gold' : d.score >= 40 ? 'bg-warning' : 'bg-danger'}`}
                    initial={{ width: 0 }} animate={{ width: `${Math.max(0, Math.min(100, d.score))}%` }} transition={{ duration: 1, delay: 0.2 + Math.min(i, 10) * 0.06, ease: [0.2, 0.7, 0.2, 1] }} />}
                  <ScoreRing score={d.score} size={48} label={d.name ?? domainName(d.slug)} verified={d.verified} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{d.name ?? domainName(d.slug)}</p>
                    <p className="text-[11px] text-fg-subtle">Acc {d.accuracy == null ? '—' : `${d.accuracy.toFixed(1)}%`} · Conf {c == null ? '—' : `${c.toFixed(0)}%`} · n={d.sampleSize ?? '—'}</p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {d.verified && <VerifiedBadge />}
                      {d.meetsTarget === true && <Badge tone="gold">Meets {QUALITY.ACCURACY_TARGET}%</Badge>}
                      {d.meetsTarget === false && <Badge tone="warning">Below {QUALITY.ACCURACY_TARGET}%</Badge>}
                    </div>
                  </div>
                </StaggerLi>
              );
            })}
          </StaggerList>
        </Section>
      )}

      {a.status !== 'queued' && <ResultsTable id={id} domains={domains.map((d) => d.slug).length ? domains.map((d) => d.slug) : a.domainSlugs ?? []} />}

      <Section title="Quality notes">
        <ul className="space-y-2 text-sm text-fg-muted">
          <li className="flex gap-2"><Info className="mt-0.5 h-4 w-4 shrink-0 text-electric" aria-hidden />A domain is <b className="text-fg">verified</b> only with ≥{QUALITY.MIN_SAMPLE_FOR_VERIFIED} graded responses and ≥{QUALITY.MIN_CONFIDENCE_FOR_VERIFIED * 100}% statistical confidence.</li>
          <li className="flex gap-2"><Info className="mt-0.5 h-4 w-4 shrink-0 text-electric" aria-hidden />“Meets {QUALITY.ACCURACY_TARGET}% target” is only claimed with ≥{QUALITY.MIN_SAMPLE_FOR_TARGET_CLAIM} samples; otherwise it is left blank.</li>
          <li className="flex gap-2"><Info className="mt-0.5 h-4 w-4 shrink-0 text-electric" aria-hidden />Ground-truth answers are hidden to keep benchmarks independent. Repeats measure consistency — a Quick run (1×) does not measure it, so it neither helps nor hurts the score.</li>
        </ul>
      </Section>
    </div>
  );
}

function ResultsTable({ id, domains }: { id: string; domains: string[] }) {
  const [domain, setDomain] = useState('');
  const { data, error, isLoading, mutate } = useApi<Result[] | Paged<Result>>(`/assessments/${id}/results${domain ? `?domain=${encodeURIComponent(domain)}` : ''}`);
  const items = listOf(data);
  return (
    <Section title="Per-question results" action={domains.length > 1 && (
      <Select aria-label="Filter by domain" value={domain} onChange={(e) => setDomain(e.target.value)} className="h-9 w-48 text-xs"><option value="">All domains</option>{domains.map((d) => <option key={d} value={d}>{domainName(d)}</option>)}</Select>
    )} bodyClassName="p-0 pt-2">
      {isLoading ? <div className="p-5"><ListSkeleton /></div> : error ? <div className="p-5"><ErrorState error={error} onRetry={() => mutate()} /></div> : !items.length ? (
        <div className="p-5"><EmptyState title="No graded responses yet" description="Results appear as each question is graded." /></div>
      ) : (
        <Table head={['Domain', 'Prompt', 'Response', 'Correct', 'Score', 'Failure category', 'Evaluator']}>
          {items.map((r) => (
            <tr key={r.id}>
              <Td className="whitespace-nowrap text-xs text-fg-muted">{domainName(r.domainSlug ?? r.domain)}{r.kind && <span className="block text-fg-subtle">{titleCase(r.kind)}</span>}</Td>
              <Td className="min-w-[220px] max-w-sm"><details><summary className="line-clamp-2 cursor-pointer text-xs">{r.prompt}</summary><p className="mt-1 whitespace-pre-wrap text-xs text-fg-muted">{r.prompt}</p></details></Td>
              <Td className="min-w-[220px] max-w-sm"><details><summary className="line-clamp-2 cursor-pointer text-xs text-fg-muted">{r.response ?? '—'}</summary><p className="mt-1 whitespace-pre-wrap text-xs text-fg-muted">{r.response}</p></details></Td>
              <Td>{r.correct == null ? <span className="text-xs text-fg-subtle">{r.needsHumanReview ? 'Human review' : '—'}</span> : r.correct ? <CheckCircle2 className="h-4 w-4 text-success" aria-label="Correct" /> : <XCircle className="h-4 w-4 text-danger" aria-label="Incorrect" />}</Td>
              <Td className="tabular-nums">{r.score == null ? '—' : r.score.toFixed(0)}</Td>
              <Td>{r.failureCategory ? <Badge tone="danger">{titleCase(r.failureCategory)}</Badge> : '—'}</Td>
              <Td className="text-xs text-fg-muted">{titleCase(r.evaluator)}</Td>
            </tr>
          ))}
        </Table>
      )}
    </Section>
  );
}
