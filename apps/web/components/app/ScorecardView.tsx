'use client';
import Link from 'next/link';
import { AlertTriangle, ArrowRight, CheckCircle2, Info, MinusCircle, Target } from 'lucide-react';
import { QUALITY, SCORING_DIMENSIONS } from '@aix/shared';
import { Badge, Button, EmptyState, ScoreRing, cn, fmtCredits, fmtDateTime, fmtNumber } from '@/components/ui';
import { VerifiedBadge, domainName, titleCase } from './primitives';
import { claimedSlugs, type ClaimedDomain, type Scorecard, type ScorecardDomain } from './types';

const pct = (v: number | null | undefined, d = 0) => (v == null ? '—' : `${v.toFixed(d)}%`);
/** Confidence may arrive as 0..1 or 0..100. */
export const confPct = (c: number | null | undefined) => (c == null ? null : c <= 1 ? c * 100 : c);

/** Per-domain verified score bars; optional claimed domains listed separately and labelled. */
export function DomainScoreBars({ domains, claimed, compact }: { domains: { slug: string; name?: string; score: number | null; verified?: boolean; sampleSize?: number }[]; claimed?: ClaimedDomain[]; compact?: boolean }) {
  const claimedOnly = claimedSlugs(claimed).filter((c) => !domains.some((d) => d.slug === c && d.score != null));
  return (
    <div className="space-y-4">
      {domains.length > 0 && (
        <ul className="space-y-3" aria-label="Verified domain scores">
          {domains.map((d) => {
            const has = d.score != null;
            const color = !has ? '' : d.score! >= 85 ? 'bg-success' : d.score! >= 65 ? 'bg-gold' : d.score! >= 40 ? 'bg-warning' : 'bg-danger';
            return (
              <li key={d.slug}>
                <div className="mb-1 flex items-center justify-between gap-2 text-sm">
                  <span className="flex min-w-0 items-center gap-1.5"><span className="truncate">{d.name || domainName(d.slug)}</span>{d.verified && <VerifiedBadge />}</span>
                  <span className="shrink-0 tabular-nums text-fg-muted">{has ? `${d.score!.toFixed(1)}` : 'Not assessed'}{!compact && d.sampleSize != null && <span className="ml-2 text-[11px] text-fg-subtle">n={d.sampleSize}</span>}</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-ink-800" role="progressbar" aria-label={`${d.name || domainName(d.slug)} score`} aria-valuenow={d.score ?? undefined} aria-valuemin={0} aria-valuemax={100}>
                  {has && <div className={cn('h-full rounded-full', color)} style={{ width: `${Math.max(0, Math.min(100, d.score!))}%` }} />}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {claimedOnly.length > 0 && (
        <div>
          <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-fg-muted"><Info className="h-3.5 w-3.5" aria-hidden />Claimed by owner — not yet demonstrated in assessment</p>
          <div className="flex flex-wrap gap-1.5">{claimedOnly.map((c) => <Badge key={c} className="border-dashed">{domainName(c)} · claimed</Badge>)}</div>
        </div>
      )}
    </div>
  );
}

function DomainDetail({ d }: { d: ScorecardDomain }) {
  const conf = confPct(d.confidence);
  const skills = Array.isArray(d.skillScores) ? d.skillScores.map((s) => [s.name ?? s.slug, s.score] as const) : Object.entries(d.skillScores ?? {});
  const dims = d.dimensionScores ? SCORING_DIMENSIONS.map((k) => [k, d.dimensionScores?.[k] ?? null] as const) : [];
  const failures = Object.entries(d.failureBreakdown ?? {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const enoughForVerified = d.sampleSize >= QUALITY.MIN_SAMPLE_FOR_VERIFIED;
  return (
    <details className="group rounded-xl border border-line/70 bg-ink-950/40 open:bg-ink-950/60">
      <summary className="flex cursor-pointer list-none items-center gap-3 p-3 [&::-webkit-details-marker]:hidden">
        <ScoreRing score={d.score} size={44} label={d.name} verified={d.verified} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{d.name || domainName(d.slug)}</p>
          <p className="text-[11px] text-fg-subtle">Accuracy {pct(d.accuracy, 1)} · Confidence {conf == null ? '—' : `${conf.toFixed(0)}%`} · n={d.sampleSize}</p>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          {d.verified ? <VerifiedBadge /> : <span title={`Requires ≥${QUALITY.MIN_SAMPLE_FOR_VERIFIED} graded responses and ≥${QUALITY.MIN_CONFIDENCE_FOR_VERIFIED * 100}% confidence`}><Badge>Unverified</Badge></span>}
          {d.meetsTarget === true && <Badge tone="gold" icon={<Target className="h-3 w-3" />}>Meets {QUALITY.ACCURACY_TARGET}% target</Badge>}
          {d.meetsTarget === false && <Badge tone="warning">Below {QUALITY.ACCURACY_TARGET}% target</Badge>}
        </div>
      </summary>
      <div className="grid gap-4 border-t border-line/60 p-3 text-sm sm:grid-cols-2">
        {dims.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-medium text-fg-muted">Scoring dimensions</p>
            <ul className="space-y-1.5">{dims.map(([k, v]) => <li key={k} className="flex justify-between gap-2"><span className="text-fg-muted">{titleCase(k)}</span><span className="tabular-nums">{v == null ? '—' : v.toFixed(1)}</span></li>)}</ul>
          </div>
        )}
        {skills.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-medium text-fg-muted">Skills</p>
            <ul className="space-y-1.5">{skills.map(([k, v]) => <li key={k} className="flex justify-between gap-2"><span className="text-fg-muted">{titleCase(k)}</span><span className="tabular-nums">{v == null ? 'Not assessed' : Number(v).toFixed(1)}</span></li>)}</ul>
          </div>
        )}
        {(d.strengths?.length ?? 0) > 0 && (
          <div><p className="mb-2 text-xs font-medium text-fg-muted">Strengths</p><ul className="space-y-1">{d.strengths!.map((s) => <li key={s} className="flex gap-1.5"><CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" aria-hidden />{s}</li>)}</ul></div>
        )}
        {(d.weaknesses?.length ?? 0) > 0 && (
          <div><p className="mb-2 text-xs font-medium text-fg-muted">Weaknesses</p><ul className="space-y-1">{d.weaknesses!.map((s) => <li key={s} className="flex gap-1.5"><MinusCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />{s}</li>)}</ul></div>
        )}
        {failures.length > 0 && (
          <div className="sm:col-span-2"><p className="mb-2 text-xs font-medium text-fg-muted">Failure breakdown</p><div className="flex flex-wrap gap-1.5">{failures.map(([k, n]) => <Badge key={k} tone="danger">{titleCase(k)} · {n}</Badge>)}</div></div>
        )}
        {!enoughForVerified && (
          <p className="flex gap-1.5 text-xs text-fg-subtle sm:col-span-2"><AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />Sample size {d.sampleSize} is below the {QUALITY.MIN_SAMPLE_FOR_VERIFIED} needed for a verified badge — run more repeats to tighten confidence.</p>
        )}
      </div>
    </details>
  );
}

/** Full capability scorecard (GET /assessments/scorecard/:agentId). */
export function ScorecardView({ card, agentId, canAssess, onRunAssessment }: { card: Scorecard; agentId: string; canAssess?: boolean; onRunAssessment?: () => void }) {
  if (card.overallScore == null && card.domains.every((d) => d.score == null)) {
    return (
      <EmptyState icon={<Target className="h-5 w-5" />} title="Not assessed yet"
        description="This agent has no verified capability scores. Run an independent assessment to measure it across StringMind's 20 domains."
        action={canAssess && onRunAssessment ? <Button variant="primary" onClick={onRunAssessment}>Run capability assessment</Button> : undefined} />
    );
  }
  const conf = confPct(card.overallConfidence);
  const assessed = card.domains.filter((d) => d.score != null);
  return (
    <div className="space-y-6">
      <div className="card flex flex-col gap-5 p-5 sm:flex-row sm:items-center">
        <ScoreRing score={card.overallScore} size={104} label="Overall capability score" />
        <div className="grid flex-1 grid-cols-2 gap-4 sm:grid-cols-4">
          <Mini k="Overall confidence" v={conf == null ? '—' : `${conf.toFixed(0)}%`} />
          <Mini k="Tests completed" v={fmtNumber(card.testsCompleted)} />
          <Mini k="Domains verified" v={`${card.domains.filter((d) => d.verified).length} / ${assessed.length}`} />
          <Mini k="Last assessed" v={fmtDateTime(card.lastAssessedAt)} />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="card p-5 lg:col-span-2">
          <h3 className="mb-4 text-[15px] font-semibold">Verified vs claimed</h3>
          <DomainScoreBars domains={assessed} claimed={card.claimedOnly} compact />
          {assessed.length === 0 && <p className="text-sm text-fg-subtle">No domains assessed yet.</p>}
        </div>
        <div className="space-y-2 lg:col-span-3">
          <h3 className="text-[15px] font-semibold">Domain detail</h3>
          {card.domains.map((d) => <DomainDetail key={d.slug} d={d} />)}
          <p className="pt-1 text-[11px] text-fg-subtle">Verified requires ≥{QUALITY.MIN_SAMPLE_FOR_VERIFIED} graded responses and ≥{QUALITY.MIN_CONFIDENCE_FOR_VERIFIED * 100}% confidence. “Meets {QUALITY.ACCURACY_TARGET}% target” is only claimed with ≥{QUALITY.MIN_SAMPLE_FOR_TARGET_CLAIM} samples.</p>
        </div>
      </div>

      {card.recommendations.length > 0 && (
        <div className="card p-5">
          <h3 className="mb-1 text-[15px] font-semibold">Recommended training</h3>
          <p className="mb-4 text-xs text-fg-muted">Based on verified gaps. Trainers are ranked by their own verified scores.</p>
          <div className="grid gap-4 md:grid-cols-2">
            {card.recommendations.map((r) => (
              <div key={r.domainSlug} className="rounded-xl border border-line/70 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div><p className="font-medium">{domainName(r.domainSlug)}</p><p className="mt-0.5 text-xs text-fg-muted">{r.reason}</p></div>
                  <Button size="sm" variant="ai" href={`/app/marketplace?domain=${encodeURIComponent(r.domainSlug)}&learner=${encodeURIComponent(agentId)}`}>Find trainers</Button>
                </div>
                {r.suggestedTrainers.length > 0 && (
                  <ul className="mt-3 divide-y divide-line/50 text-sm">
                    {r.suggestedTrainers.map((t) => (
                      <li key={t.agentId} className="flex items-center justify-between gap-2 py-2">
                        {t.slug ? <Link className="truncate hover:underline" href={`/app/marketplace/${t.slug}`}>{t.name}</Link> : <span className="truncate">{t.name}</span>}
                        <span className="flex shrink-0 items-center gap-3 text-xs"><span className="text-fg-muted">Score {t.score == null ? '—' : t.score.toFixed(0)}</span><span className="font-medium text-gold">{t.priceCredits == null ? '—' : fmtCredits(t.priceCredits)}</span></span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
          <div className="mt-4"><Button size="sm" variant="ghost" href={`/app/marketplace?learner=${encodeURIComponent(agentId)}`}>Browse marketplace <ArrowRight className="h-3.5 w-3.5" /></Button></div>
        </div>
      )}
      {canAssess && onRunAssessment && <div><Button variant="outline" onClick={onRunAssessment}>Run a new assessment</Button></div>}
    </div>
  );
}

function Mini({ k, v }: { k: string; v: React.ReactNode }) {
  return <div><p className="text-[11px] text-fg-subtle">{k}</p><p className="mt-0.5 font-display text-base font-semibold tabular-nums">{v}</p></div>;
}
