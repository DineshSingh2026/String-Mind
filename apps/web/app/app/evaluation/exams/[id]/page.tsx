'use client';
/**
 * Professional exam / screening page: live progress (tier ladder, items answered, ability with SE band, per-item
 * cards as they are graded) and the final report (score, axes, confidence). Live over realtime channel
 * `pro-exam:<id>`, with polling as a fallback. Honest states: a score only appears when every answer is graded.
 */
import Link from 'next/link';
import { EvaluationLaunch } from '@/components/fx/HiveAnimations';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ArrowLeft, Hourglass, Radio, RefreshCw, Sparkles, XCircle } from 'lucide-react';
import { DOMAINS } from '@aix/shared';
import { Alert, Badge, Button, Card, CardBody, CardHeader, ErrorState, Progress, ScoreRing, Skeleton, fmtDateTime, useToast } from '@/components/ui';
import { api, errorMessage, useApi } from '@/lib/api';
import { useRealtime } from '@/lib/realtime';
import { AbilityBar, AxesBars, ItemCard, StrengthsList, TierLadder, type ExamItemView, type ScreeningRow } from '@/components/evaluation/exam/ExamParts';

interface ExamView {
  id: string; agent: { id: string; name: string }; domainSlug: string; domainName: string; mode: 'certification' | 'practice' | 'screening'; status: string;
  targetItems: number; ability: number | null; abilitySe: number | null; score: number | null; axes: Record<string, number>; confidence: number | null;
  failureReason: string | null; startedAt: string | null; completedAt: string | null; createdAt: string;
  progress: { finished: number; target: number; currentTier: string; waitingForAgent: boolean; delivery: string };
  screening: ScreeningRow[] | null;
  report: { stopReason?: string; note?: string | null; scoring?: { abilityScore?: number; rawMean?: number; formula?: string }; followUp?: { domains?: string[]; startedExamId?: string | null; error?: string | null };
    judge?: { reliability?: number | null; judgedItems?: number } };
  items: ExamItemView[]; judgeAvailable: boolean;
}

const LIVE = ['queued', 'running', 'grading'];
const domainLabel = (slug: string | null) => (slug ? DOMAINS.find((d) => d.slug === slug)?.name ?? slug : undefined);
const STOP: Record<string, string> = {
  target_reached: 'all planned questions answered', precision_reached: 'the ability estimate became precise enough', pool_exhausted: 'no unseen questions were left',
  screening_complete: 'all screening questions answered', regraded: 'pending answers were graded',
};

export default function ExamPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const { data: e, error, isLoading, mutate } = useApi<ExamView>(`/pro-exams/${id}`);
  const live = !e || LIVE.includes(e.status);
  const { connected } = useRealtime(live || e?.status === 'awaiting_judge' ? `pro-exam:${id}` : null, () => { void mutate(); });
  useApi<ExamView>(live ? `/pro-exams/${id}` : null, { refreshInterval: connected ? 20000 : 3000, onSuccess: (d) => void mutate(d, { revalidate: false }) });

  const act = async (what: 'cancel' | 'regrade') => {
    setBusy(what);
    try {
      await api.post(`/pro-exams/${id}/${what}`);
      toast('success', what === 'cancel' ? 'Exam cancelled' : 'Pending answers graded');
      await mutate();
    } catch (err) { toast('danger', errorMessage(err)); } finally { setBusy(null); }
  };

  if (error) return <ErrorState error={error} onRetry={() => mutate()} />;
  if (isLoading || !e) return <div className="space-y-4"><Skeleton className="h-24" /><Skeleton className="h-64" /></div>;

  const screening = e.mode === 'screening';
  const pct = e.progress.target ? Math.round((e.progress.finished / e.progress.target) * 100) : 0;
  const followUp = e.report.followUp;

  return (
    <div className="space-y-6">
      <Link href="/app/evaluation" className="inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg"><ArrowLeft className="h-4 w-4" />Evaluation</Link>
      {live && <EvaluationLaunch agentId={e.agent.id} agentName={e.agent.name} domain={screening ? 'Screening' : e.domainName} active={live} />}

      <header className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-xs uppercase tracking-[0.18em] text-gold">{screening ? 'Hive Mind screening' : `Hive Mind professional exam · ${e.mode}`}</p>
          <h1 className="mt-1 font-display text-2xl font-semibold">{e.agent.name} · {e.domainName}</h1>
          <p className="mt-1 text-sm text-fg-muted">Started {fmtDateTime(e.startedAt ?? e.createdAt)}{e.completedAt ? ` · finished ${fmtDateTime(e.completedAt)}` : ''}</p>
        </div>
        <div className="flex items-center gap-2">
          {live && <Badge tone={connected ? 'success' : 'neutral'} icon={<Radio className="h-3 w-3" />}>{connected ? 'Live' : 'Polling'}</Badge>}
          <StatusBadge status={e.status} />
          {(live || e.status === 'awaiting_judge') && <Button size="sm" variant="ghost" loading={busy === 'cancel'} onClick={() => act('cancel')} icon={<XCircle className="h-4 w-4" />}>Cancel</Button>}
        </div>
      </header>

      {e.status === 'failed' && <Alert tone="danger" title="Exam stopped">{e.failureReason}</Alert>}
      {e.status === 'cancelled' && <Alert tone="info">This exam was cancelled.</Alert>}
      {e.status === 'awaiting_judge' && (
        <Alert tone="warning" title="Waiting for the judge">
          {e.report.note ?? 'Some answers could not be graded yet.'} No score is shown until every answer is graded.
          <div className="mt-2"><Button size="sm" variant="secondary" loading={busy === 'regrade'} onClick={() => act('regrade')} icon={<RefreshCw className="h-4 w-4" />}>Grade pending answers</Button></div>
        </Alert>
      )}
      {live && e.progress.waitingForAgent && e.progress.delivery === 'async' && (
        <Alert tone="info" title="Waiting for your agent">The questions are in your agent&apos;s Hive Mind inbox. Tell it: “Check Hive Mind for tasks and answer them all.” Answers are graded the moment they arrive.</Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title={e.status === 'completed' ? 'Result' : 'Progress'} subtitle={`${e.progress.finished} of ${e.progress.target} questions finished`} />
          <CardBody className="space-y-5">
            <Progress value={pct} label={`${pct}% complete`} />
            {e.status === 'completed' && e.score != null ? (
              <div className="flex flex-wrap items-center gap-6">
                <ScoreRing score={e.score} size={96} label="Score" />
                <div className="space-y-1 text-sm">
                  <p>Confidence <span className="font-mono text-fg">{e.confidence != null ? `${Math.round(e.confidence * 100)}%` : '—'}</span></p>
                  {e.report.scoring?.abilityScore != null && <p className="text-fg-muted">Ability score {e.report.scoring.abilityScore} · mean item score {e.report.scoring.rawMean}</p>}
                  {e.report.judge?.reliability != null && <p className="text-fg-muted">Judge reliability {Math.round(e.report.judge.reliability * 100)}% over {e.report.judge.judgedItems} judged answers</p>}
                  {e.report.stopReason && <p className="text-xs text-fg-subtle">Stopped because {STOP[e.report.stopReason] ?? e.report.stopReason}.</p>}
                  {e.report.scoring?.formula && <p className="text-xs text-fg-subtle">{e.report.scoring.formula}</p>}
                </div>
              </div>
            ) : e.status === 'awaiting_judge' ? (
              <p className="flex items-center gap-2 text-sm text-warning"><Hourglass className="h-4 w-4" />Score pending: {e.items.filter((i) => i.status === 'awaiting_judge').length} answer(s) awaiting the judge.</p>
            ) : null}
            {!screening && <AbilityBar ability={e.ability} se={e.abilitySe} />}
            {Object.keys(e.axes ?? {}).length > 0 && <div><h3 className="mb-2 text-sm font-semibold">Skill axes</h3><AxesBars axes={e.axes} /></div>}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title={screening ? 'Strengths map' : 'Difficulty ladder'} subtitle={screening ? 'Mean score per domain (2 questions each)' : 'Moves up after ≥ 70, down after < 40'} />
          <CardBody>
            {screening ? <StrengthsList rows={e.screening ?? []} /> : <TierLadder current={e.progress.currentTier} items={e.items} />}
            {screening && followUp && (
              <div className="mt-4 rounded-xl border border-line/60 p-3 text-sm">
                <p className="flex items-center gap-1.5 font-medium"><Sparkles className="h-4 w-4 text-gold" />Next: full exam</p>
                {followUp.startedExamId
                  ? <Link className="mt-1 block text-gold-soft hover:underline" href={`/app/evaluation/exams/${followUp.startedExamId}`}>Open the {followUp.domains?.map((d) => domainLabel(d)).join(' → ')} exam</Link>
                  : <p className="mt-1 text-xs text-fg-muted">{followUp.error ?? 'No follow-up exam started.'}</p>}
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Questions</h2>
        {e.items.length === 0 && <p className="text-sm text-fg-muted">Selecting the first questions…</p>}
        {e.items.map((it) => <ItemCard key={it.id} item={it} domainLabel={screening ? domainLabel(it.domainSlug) : undefined} />)}
      </section>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone = status === 'completed' ? 'success' : status === 'failed' ? 'danger' : status === 'awaiting_judge' ? 'warning' : status === 'cancelled' ? 'neutral' : 'electric';
  return <Badge tone={tone}>{status.replace('_', ' ')}</Badge>;
}
