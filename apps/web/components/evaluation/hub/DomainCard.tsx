'use client';
/** One domain in the Professional Evaluation hub: the three paths side by side + the resulting certification. */
import { useState } from 'react';
import { ChevronDown, FileCheck2, Gauge, GraduationCap, RefreshCw } from 'lucide-react';
import { Badge, Button, cn, fmtDate } from '@/components/ui';
import { DOMAINS } from '@aix/shared';
import { StatusPill } from '@/components/app/primitives';
import { Breakdown } from './Breakdown';
import { CertHex } from './CertHex';
import { Proof, StartExam } from './ExternalPaths';
import { LEVEL_LABEL, type DomainOverview } from './types';

function PathCol({ icon, title, children, footer }: { icon: React.ReactNode; title: string; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col rounded-xl border border-line/60 bg-ink-950/30 p-3">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">{icon}{title}</div>
      <div className="flex-1 text-sm">{children}</div>
      {footer && <div className="mt-3 flex flex-wrap gap-2">{footer}</div>}
    </div>
  );
}

const Big = ({ v, sub }: { v: React.ReactNode; sub?: React.ReactNode }) => (
  <div><p className="text-2xl font-semibold tabular-nums">{v}</p>{sub && <p className="text-xs text-fg-muted">{sub}</p>}</div>
);

export function DomainCard({ agentId, d, canRun, canUpdate, onRecompute, busy }: {
  agentId: string; d: DomainOverview; canRun: boolean; canUpdate: boolean; onRecompute: () => void; busy: boolean;
}) {
  const [examOpen, setExamOpen] = useState(false);
  const [showHow, setShowHow] = useState(false);
  const [showProof, setShowProof] = useState(false);
  const c = d.certification;
  const latest = d.exam.latest;
  const counting = d.exam.latestCounting;
  const active = c?.status === 'active' && c.level !== 'none';
  // 50 of the 70 domains have no benchmark bank: the quick assessment is not offered there (exam + proof work everywhere)
  const quickAvailable = (DOMAINS.find((x) => x.slug === d.domainSlug) as { quickAssessment?: boolean } | undefined)?.quickAssessment !== false;

  return (
    <article className={cn('rounded-2xl border border-line/70 bg-ink-900 p-4 sm:p-5', active && 'card-glow border-transparent')}>
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold">{d.domainName}</h3>
          {d.claimedOnly && <p className="text-xs text-fg-subtle">Claimed by the owner · not evaluated yet</p>}
        </div>
        {canUpdate && (d.exam.total > 0 || d.proof.submissions > 0 || c) && (
          <Button size="sm" variant="ghost" loading={busy} icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={onRecompute}>Recompute</Button>
        )}
      </header>

      <div className="grid gap-3 lg:grid-cols-3">
        <PathCol icon={<Gauge className="h-4 w-4 text-electric" aria-hidden />} title="Quick assessment"
          footer={quickAvailable ? <Button size="sm" variant="secondary" href={`/app/assessments?agentId=${agentId}&new=1`}>{d.quick ? 'Re-assess' : 'Run assessment'}</Button> : undefined}>
          {!quickAvailable && !d.quick ? (
            <p className="text-fg-muted">Quick assessment: not available for this domain. Use the professional exam or proof of work.</p>
          ) : d.quick ? (
            <Big v={d.quick.score.toFixed(1)} sub={<>{d.quick.verified ? <Badge tone="success">Verified</Badge> : <Badge tone="warning">Not verified</Badge>} <span className="ml-1">{fmtDate(d.quick.assessedAt)}</span></>} />
          ) : <p className="text-fg-muted">Not assessed in this domain yet.</p>}
          <p className="mt-2 text-xs text-fg-subtle">Does not certify on its own.</p>
        </PathCol>

        <PathCol icon={<GraduationCap className="h-4 w-4 text-gold" aria-hidden />} title="Professional exam"
          footer={<>
            {canRun && <Button size="sm" variant="primary" onClick={() => setExamOpen(true)}>Start exam</Button>}
            {latest && <Button size="sm" variant="secondary" href={`/app/evaluation/exams/${latest.id}`}>View latest</Button>}
          </>}>
          {counting ? (
            <Big v={counting.score?.toFixed(1)} sub={`Counts · confidence ${Math.round((counting.confidence ?? 0) * 100)}% · ${fmtDate(counting.completedAt)}`} />
          ) : <p className="text-fg-muted">No qualifying exam yet.</p>}
          {latest && latest.id !== counting?.id && (
            <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
              Latest: <StatusPill status={latest.status} /> {latest.mode === 'practice' && <Badge>Practice · never certifies</Badge>}
              {latest.status === 'completed' && latest.mode === 'certification' && (latest.confidence ?? 0) < 0.6 && <span>confidence below 60% — ignored</span>}
            </p>
          )}
        </PathCol>

        <PathCol icon={<FileCheck2 className="h-4 w-4 text-success" aria-hidden />} title="Proof of work"
          footer={<>
            <Button size="sm" variant="secondary" onClick={() => setShowProof((v) => !v)}>{showProof ? 'Hide' : 'Manage proof'}</Button>
            <Button size="sm" variant="ghost" href={`/app/evaluation/proof?agentId=${agentId}&domain=${d.domainSlug}`}>Open</Button>
          </>}>
          {d.proof.scored ? (
            <Big v={d.proof.evidenceTotal?.toFixed(1)} sub={`Evidence (max 80) · ${d.proof.scored} scored item${d.proof.scored === 1 ? '' : 's'}`} />
          ) : <p className="text-fg-muted">{d.proof.submissions ? `${d.proof.submissions} submitted, none scored yet.` : 'No proof submitted yet.'}</p>}
          <p className="mt-2 text-xs text-fg-muted">
            Live check: {d.proof.liveCheck ? (d.proof.liveCheck.score != null && d.proof.liveCheck.status === 'scored' ? `${d.proof.liveCheck.score.toFixed(0)} (+${(d.proof.liveCheck.score * 0.2).toFixed(1)})` : d.proof.liveCheck.status) : 'none — proof capped at 80 / Practitioner'}
          </p>
          {d.proof.removed > 0 && <p className="mt-1 text-xs text-danger">{d.proof.removed} item(s) removed by moderation — proof path voided.</p>}
        </PathCol>
      </div>

      {showProof && <div className="mt-3"><Proof agentId={agentId} domainSlug={d.domainSlug} /></div>}

      <footer className="mt-4 rounded-xl border border-line/60 p-3">
        {c ? (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <CertHex level={c.status === 'active' ? c.level : 'none'} size={44} />
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{c.status === 'active' ? LEVEL_LABEL[c.level] : c.status === 'revoked' ? 'Certification revoked' : 'Certification expired'}</p>
                <p className="text-xs text-fg-muted">
                  Combined score <span className="tabular-nums font-medium text-fg">{c.score.toFixed(1)}</span>
                  {c.status === 'active' && c.expiresAt && <> · valid until {fmtDate(c.expiresAt)}</>}
                  {c.status === 'active' && c.level === 'none' && <> · below 60, no level yet</>}
                </p>
              </div>
              <button type="button" onClick={() => setShowHow((v) => !v)} className="inline-flex items-center gap-1 text-xs font-medium text-gold hover:text-gold-soft" aria-expanded={showHow}>
                How this was calculated <ChevronDown className={cn('h-3.5 w-3.5 transition', showHow && 'rotate-180')} aria-hidden />
              </button>
            </div>
            {showHow && <div className="mt-3 border-t border-line/50 pt-3"><Breakdown cert={c} /></div>}
          </>
        ) : (
          <div className="flex items-center gap-3">
            <CertHex level="none" size={36} />
            <p className="text-sm text-fg-muted">No certification yet. Pass a professional exam or submit scored proof of work in this domain to earn one.</p>
          </div>
        )}
      </footer>

      {examOpen && <StartExam open={examOpen} onClose={() => setExamOpen(false)} agentId={agentId} domainSlug={d.domainSlug} />}
    </article>
  );
}
