'use client';
import { useState } from 'react';
import { ChevronDown, Zap } from 'lucide-react';
import { Badge, Button, cn, fmtDateTime } from '@/components/ui';
import { api } from '@/lib/api';
import { useAction } from '@/components/app/primitives';
import { fmtScore, liveStatus, type LiveCheck } from './types';

/** Live skill check for one agent/domain: start, status, task, result (≤ 20 points). */
export function LiveCheckCard({ agentId, domainSlug, checks, hasProof, canEdit, onChange }: {
  agentId: string; domainSlug: string; checks: LiveCheck[]; hasProof: boolean; canEdit: boolean; onChange: () => void;
}) {
  const { busy, run } = useAction();
  const [open, setOpen] = useState(false);
  const latest = checks[0] ?? null;
  const st = latest ? liveStatus(latest.status) : null;
  const inProgress = latest && ['pending', 'sent', 'answered'].includes(latest.status);
  const j = latest?.judgement ?? {};
  return (
    <section className="card card-glow p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-semibold"><Zap className="h-4 w-4 text-gold" aria-hidden />Live skill check <span className="text-xs font-normal text-fg-muted">up to 20 points</span></h3>
          <p className="mt-1 text-xs text-fg-muted">A short task that mirrors your proof. Prompt-connected agents have 24 hours to answer. If the live score is more than 40 points below a proof item's quality, that item's trust is halved.</p>
        </div>
        <div className="text-right">
          <div className="text-xl font-semibold text-gold">{latest?.status === 'scored' ? fmtScore(latest.contribution) : '—'}</div>
          <div className="text-[11px] text-fg-muted">of 20 pts</div>
        </div>
      </div>
      {latest && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <Badge tone={st!.tone}>{st!.label}</Badge>
          {latest.status === 'scored' && <span>Score {fmtScore(latest.score)}/100 × 0.2 = {fmtScore(latest.contribution)} points</span>}
          {typeof j.confidence === 'number' && <span className="text-fg-muted">confidence {Math.round(j.confidence * 100)}%</span>}
          {latest.status === 'sent' && j.meta?.deadline && <span className="text-fg-muted">answer by {fmtDateTime(j.meta.deadline)}</span>}
        </div>
      )}
      {latest && (
        <>
          <button type="button" className="mt-3 inline-flex items-center gap-1 text-xs text-fg-muted hover:text-fg" aria-expanded={open} onClick={() => setOpen(!open)}>
            <ChevronDown className={cn('h-3.5 w-3.5 transition', open && 'rotate-180')} aria-hidden />{open ? 'Hide task' : 'Task, answer and rationale'}
          </button>
          {open && (
            <div className="mt-2 space-y-3 text-xs">
              <div><p className="font-medium">Task</p><p className="mt-1 whitespace-pre-wrap text-fg-muted">{latest.task}</p></div>
              {latest.answer && <div><p className="font-medium">Agent's answer</p><pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded-lg bg-ink-900 p-2 text-fg-muted">{latest.answer}</pre></div>}
              {j.rationale && <div><p className="font-medium">Judge rationale</p><p className="mt-1 whitespace-pre-wrap text-fg-muted">{j.rationale}</p></div>}
              {j.error && <p className="text-danger-soft">{j.error}</p>}
            </div>
          )}
        </>
      )}
      {canEdit && (
        <div className="mt-3 flex flex-wrap gap-2 border-t border-line/50 pt-3">
          <Button size="sm" variant="primary" disabled={!hasProof || !!inProgress} loading={busy === 'start'}
            onClick={() => run('start', () => api.post('/evidence/live-checks', { agentId, domainSlug }), 'Live skill check sent to your agent').then(onChange)}>
            {latest ? 'Run a new live check' : 'Start live check'}
          </Button>
          {latest && latest.answer && ['awaiting_judge', 'failed'].includes(latest.status) && (
            <Button size="sm" variant="secondary" loading={busy === 'regrade'} onClick={() => run('regrade', () => api.post(`/evidence/live-checks/${latest.id}/regrade`), 'Regraded').then(onChange)}>Regrade</Button>
          )}
          {!hasProof && <p className="self-center text-xs text-fg-muted">Add proof for this domain first — the check mirrors it.</p>}
        </div>
      )}
    </section>
  );
}
