'use client';
import { useEffect, useState } from 'react';
import { CheckCircle2, Circle, Loader2, TrendingDown, TrendingUp, BookOpen, FileText, ExternalLink, Coins, ClipboardList, Lightbulb, Star } from 'lucide-react';
import { LEARNING_TYPE_LABELS, TRAINING_STAGES, type LearningType } from '@aix/shared';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Field, Modal, Select, Textarea, cn, fmtCredits, fmtPct, useToast } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { ProgressRing } from './parts';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { AnimatedNumber, Celebrate } from '@/components/app/motion';
import { type Artefact, type TrainingSession, STAGE_LABELS, scoresOf, settlementOf, stageIndex, stageProgress } from './model';
import { IdleToken } from '@/components/brand/IdleToken';

export function ProgressPanel({ s }: { s: TrainingSession }) {
  const reduce = useReducedMotion();
  const idx = stageIndex(s.stage);
  const done = s.status === 'completed';
  const halted = ['failed', 'cancelled'].includes(s.status);
  return (
    <Card>
      <CardHeader title="Training Progress" subtitle={halted ? `Session ${s.status}${s.failureReason ? ` — ${s.failureReason}` : ''}` : 'Stage-based, updates live'} />
      <CardBody>
        <div className="flex justify-center"><ProgressRing value={stageProgress(s)} /></div>
        <ol className="relative mt-5 space-y-1" aria-label="Training stages">
          <span className="absolute bottom-3 left-[17px] top-3 w-px bg-line/70" aria-hidden />
          <motion.span className="absolute left-[17px] top-3 w-px origin-top bg-gradient-to-b from-success to-success/40" aria-hidden
            initial={reduce ? false : { height: 0 }} animate={{ height: `calc(${(Math.min(done ? TRAINING_STAGES.length - 1 : idx, TRAINING_STAGES.length - 1) / (TRAINING_STAGES.length - 1)) * 100}% - 24px)` }} transition={{ duration: 0.9, ease: [0.2, 0.7, 0.2, 1] }} />
          {TRAINING_STAGES.map((st, i) => {
            const complete = done || i < idx;
            const current = !done && i === idx && s.status !== 'scheduled';
            return (
              <motion.li key={st} initial={reduce ? false : { opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.1 + i * 0.07 }}
                className={cn('relative flex items-center gap-2.5 rounded-xl px-2 py-1.5 text-sm transition-colors', current && 'bg-electric/[0.07] ring-1 ring-electric/25')}>
                <span className="relative z-[1] flex h-[22px] w-[22px] items-center justify-center rounded-full bg-ink-900">
                  <AnimatePresence mode="wait" initial={false}>
                    {complete ? (
                      <motion.span key="done" initial={reduce ? false : { scale: 0, rotate: -45 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: 'spring', stiffness: 500, damping: 18 }}>
                        <CheckCircle2 className="h-[18px] w-[18px] shrink-0 text-success drop-shadow-[0_0_6px_rgb(var(--success)/0.6)]" aria-label="Done" />
                      </motion.span>
                    ) : current && s.status === 'active' ? (
                      <motion.span key="run" initial={{ scale: 0 }} animate={{ scale: 1 }}><Loader2 className="h-[18px] w-[18px] shrink-0 animate-spin text-electric" aria-label="In progress" /></motion.span>
                    ) : (
                      <motion.span key="wait" initial={{ scale: 0 }} animate={{ scale: 1 }}><Circle className={cn('h-[18px] w-[18px] shrink-0', current ? 'text-warning' : 'text-fg-subtle')} aria-label={current ? 'Current' : 'Pending'} /></motion.span>
                    )}
                  </AnimatePresence>
                </span>
                <span className={cn(complete ? 'text-fg' : current ? 'font-medium text-fg' : 'text-fg-muted')}>{STAGE_LABELS[st]}</span>
                {current && <span className="ml-auto text-[11px] text-fg-subtle">{s.status === 'paused' ? 'Paused' : st === 'evaluation' ? 'Evaluation pending' : 'Current'}</span>}
              </motion.li>
            );
          })}
        </ol>
      </CardBody>
    </Card>
  );
}

export function EvaluationPanel({ s }: { s: TrainingSession }) {
  const sc = scoresOf(s);
  if (sc.pre == null && sc.post == null) {
    return (
      <Card>
        <CardHeader title="Independent Evaluation" />
        <CardBody><p className="text-sm text-fg-muted">Scores appear after the independent pre- and post-training assessments run on held-out benchmark questions. Nothing is shown until they are measured.</p></CardBody>
      </Card>
    );
  }
  const up = (sc.improvement ?? 0) >= 0;
  const celebrate = s.status === 'completed' && sc.improvement != null && sc.improvement > 0;
  const [burst, setBurst] = useState(false);
  useEffect(() => {
    if (!celebrate) return;
    // one confetti burst per session per browser (a real, verified positive outcome)
    const k = `aix.celebrated.${s.id}`;
    try { if (localStorage.getItem(k)) return; localStorage.setItem(k, '1'); } catch { /* storage unavailable: still celebrate once per mount */ }
    setBurst(true);
  }, [celebrate, s.id]);
  return (
    <Card className={cn('relative overflow-hidden', celebrate && 'border-success/40 shadow-[0_0_40px_-18px_rgb(var(--success))]')}>
      <Celebrate fire={burst} />
      <CardHeader title="Independent Evaluation" subtitle="Held-out questions · different sets pre and post" />
      <CardBody className="grid grid-cols-3 gap-3 text-center">
        <div><p className="text-xs text-fg-muted">Pre score</p><p className="mt-1 font-display text-xl font-semibold tabular-nums">{sc.pre != null ? <AnimatedNumber value={sc.pre} format={(n) => n.toFixed(1)} /> : '—'}</p></div>
        <div><p className="text-xs text-fg-muted">Post score</p><p className="mt-1 font-display text-xl font-semibold tabular-nums">{sc.post != null ? <AnimatedNumber value={sc.post} format={(n) => n.toFixed(1)} /> : 'Pending'}</p></div>
        <div><p className="text-xs text-fg-muted">Improvement</p>
          {sc.improvement != null
            ? <motion.p initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 400, damping: 16, delay: 0.6 }}
                className={cn('mt-1 inline-flex items-center gap-1 font-display text-xl font-semibold tabular-nums', up ? 'text-success drop-shadow-[0_0_10px_rgb(var(--success)/0.5)]' : 'text-danger-soft')}>{up ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}{up ? '+' : ''}{sc.improvement.toFixed(1)}</motion.p>
            : <p className="mt-1 text-sm text-fg-muted">—</p>}
        </div>
        {sc.pre != null && sc.post != null && (
          <div className="col-span-3 mt-1 space-y-1.5 text-left" aria-hidden>
            {([['Pre', sc.pre, 'bg-ink-600'], ['Post', sc.post, up ? 'bg-gradient-to-r from-success/60 to-success' : 'bg-danger/70']] as const).map(([k, v, cls], i) => (
              <div key={k} className="flex items-center gap-2 text-[11px] text-fg-subtle"><span className="w-7">{k}</span>
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink-800"><motion.span className={cn('block h-full rounded-full', cls)} initial={{ width: 0 }} animate={{ width: `${Math.max(0, Math.min(100, v))}%` }} transition={{ duration: 1, delay: 0.2 + i * 0.25, ease: [0.2, 0.7, 0.2, 1] }} /></span>
              </div>
            ))}
          </div>
        )}
        {celebrate && <p className="col-span-3 text-xs font-medium text-success-soft">Verified improvement on held-out questions.</p>}
        {sc.retention != null && <p className="col-span-3 text-xs text-fg-muted">Retention re-assessment: <span className="font-medium text-fg">{sc.retention.toFixed(1)}</span></p>}
      </CardBody>
    </Card>
  );
}

export function ExercisesPanel({ s }: { s: TrainingSession }) {
  const ex = s.exercises ?? [];
  return (
    <Card>
      <CardHeader title="Practice Exercises" subtitle={ex.length ? `${ex.filter((e) => e.status === 'graded').length}/${ex.length} graded` : undefined} action={<ClipboardList className="h-4 w-4 text-fg-subtle" />} />
      <CardBody className="space-y-3">
        {!ex.length && <p className="text-sm text-fg-muted">Exercises are generated during the practical stage (practice-visibility datasets only — never held-out benchmark questions).</p>}
        {ex.map((e, i) => (
          <details key={e.id} className="group rounded-xl border border-line bg-ink-950/40 p-3">
            <summary className="flex cursor-pointer list-none items-start justify-between gap-2 text-sm">
              <span className="min-w-0"><span className="text-fg-subtle">#{i + 1}</span> <span className="line-clamp-2">{e.prompt}</span></span>
              {typeof e.score === 'number' ? <Badge tone={e.score >= 70 ? 'success' : e.score >= 40 ? 'warning' : 'danger'}>{Math.round(e.score)}</Badge> : <Badge>{e.status ?? 'pending'}</Badge>}
            </summary>
            <div className="mt-3 space-y-2 text-xs">
              <div><p className="text-fg-subtle">Prompt</p><p className="whitespace-pre-wrap text-fg">{e.prompt}</p></div>
              <div><p className="text-fg-subtle">Learner answer</p><p className="whitespace-pre-wrap text-fg-muted">{e.learnerResponse || 'Awaiting answer'}</p></div>
              {e.feedback && <div><p className="text-fg-subtle">Feedback</p><p className="whitespace-pre-wrap text-fg-muted">{e.feedback}</p></div>}
            </div>
          </details>
        ))}
      </CardBody>
    </Card>
  );
}

export function ArtefactsPanel({ s, canApprove, onChanged }: { s: TrainingSession; canApprove: boolean; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const items = s.artefacts ?? [];
  // pending items always visible; otherwise show the first few until expanded
  const LIMIT = 4;
  const visible = showAll ? items : items.filter((a, i) => a.status === 'pending' || i < LIMIT);
  const act = async (a: Artefact, decision: 'approve' | 'reject') => {
    setBusy(a.id + decision);
    try {
      await api.post(`/training/sessions/${s.id}/artefacts/${a.id}/${decision}`);
      toast('success', decision === 'approve' ? `“${a.title}” approved` : `“${a.title}” rejected`);
      onChanged();
    } catch (e) { toast('danger', errorMessage(e)); } finally { setBusy(null); }
  };
  return (
    <Card>
      <CardHeader title="Knowledge Sharing" subtitle="Learning artefacts proposed by the trainer" action={<Lightbulb className="h-4 w-4 text-gold" />} />
      <CardBody className="space-y-3">
        <Alert tone="info">Unapproved artefacts are <strong>not applied</strong> to the learner agent. Each artefact is stored separately by learning type. The session pauses before evaluation while artefacts are pending — review them, then press <strong>Resume</strong>.</Alert>
        {(() => {
          const bulk = items.filter((a) => a.status === 'pending' && a.learningType === 'persistent_memory');
          if (!canApprove || bulk.length < 2) return null;
          return (
            <Button size="sm" variant="primary" className="w-full" loading={busy === 'bulk'} disabled={!!busy}
              onClick={async () => {
                setBusy('bulk');
                let ok = 0;
                try {
                  for (const a of bulk) { await api.post(`/training/sessions/${s.id}/artefacts/${a.id}/approve`); ok++; }
                  toast('success', `${ok} knowledge artefacts approved`);
                } catch (e) { toast('danger', `${ok} approved, then: ${errorMessage(e)}`); } finally { setBusy(null); onChanged(); }
              }}>
              Approve all knowledge ({bulk.length})
            </Button>
          );
        })()}
        {!items.length && <p className="text-sm text-fg-muted">No artefacts yet.</p>}
        {visible.map((a, i) => (
          <motion.div key={a.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 8) * 0.04 }}
            className={cn('rounded-xl border bg-ink-950/40 p-3 transition-colors', a.status === 'pending' ? 'border-gold/40 shadow-[0_0_20px_-10px_rgb(var(--gold))]' : 'border-line hover:border-ink-600')}>
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone="violet">{LEARNING_TYPE_LABELS[a.learningType as LearningType] ?? a.learningType}</Badge>
              <Badge tone={a.status === 'approved' || a.status === 'applied' ? 'success' : a.status === 'rejected' ? 'danger' : 'gold'}>{a.status}</Badge>
            </div>
            <p className="mt-2 text-sm font-medium">{a.title}</p>
            <p className="mt-1 line-clamp-4 whitespace-pre-wrap text-xs text-fg-muted">{a.content}</p>
            {a.status === 'pending' && (canApprove ? (
              <div className="mt-3 flex gap-2">
                <Button size="sm" variant="primary" loading={busy === a.id + 'approve'} disabled={!!busy} onClick={() => act(a, 'approve')}>Approve</Button>
                <Button size="sm" variant="outline" loading={busy === a.id + 'reject'} disabled={!!busy} onClick={() => act(a, 'reject')}>Reject</Button>
              </div>
            ) : <p className="mt-2 text-[11px] text-fg-subtle">Awaiting approval by the learner agent&apos;s owner.</p>)}
          </motion.div>
        ))}
        {items.length > visible.length && <Button size="sm" variant="ghost" className="w-full" onClick={() => setShowAll(true)}>Show all {items.length} artefacts</Button>}
        {showAll && items.length > LIMIT && <Button size="sm" variant="ghost" className="w-full" onClick={() => setShowAll(false)}>Show fewer</Button>}
      </CardBody>
    </Card>
  );
}

export function ResourcesPanel({ s }: { s: TrainingSession }) {
  const res = s.resources ?? s.sharedResources ?? [];
  return (
    <Card>
      <CardHeader title="Shared Resources" action={<BookOpen className="h-4 w-4 text-fg-subtle" />} />
      <CardBody>
        {!res.length ? <p className="text-sm text-fg-muted">No resources shared in this session.</p> : (
          <ul className="space-y-2">
            {res.map((r, i) => (
              <li key={r.id ?? i} className="flex items-center gap-2 text-sm">
                <FileText className="h-4 w-4 shrink-0 text-electric" />
                {r.url ? <a href={r.url} target="_blank" rel="noreferrer noopener" className="truncate text-electric-soft hover:underline">{r.title ?? r.name ?? r.url}<ExternalLink className="ml-1 inline h-3 w-3" /></a>
                  : <span className="truncate">{r.title ?? r.name ?? 'Resource'}</span>}
                {(r.kind ?? r.type) && <Badge className="ml-auto">{r.kind ?? r.type}</Badge>}
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

export function SettlementPanel({ s }: { s: TrainingSession }) {
  const st = settlementOf(s);
  const tone = st.status === 'settled' ? 'success' : st.status === 'refunded' ? 'electric' : st.status === 'disputed' ? 'danger' : st.status === 'escrowed' ? 'gold' : 'neutral';
  return (
    <Card>
      <CardHeader title="Settlement" action={<Coins className="h-4 w-4 text-gold" />} />
      <CardBody className="space-y-2 text-sm">
        <Row k="Session fee" v={<span className="inline-flex items-center gap-1.5 text-gold-soft"><IdleToken size={14} />{st.fee ? fmtCredits(st.fee) : st.fee === 0 ? 'Free' : '—'}</span>} />
        <Row k={`Platform commission${st.bps != null ? ` (${fmtPct(st.bps / 100, 1)})` : ''}`} v={fmtCredits(st.commission)} />
        <Row k="Trainer earnings (IDLE)" v={<span className="font-semibold">{fmtCredits(st.earnings)}</span>} />
        {st.terms?.mode && <Row k="Terms" v={st.terms.mode === 'on_improvement' ? `On improvement ≥ ${st.terms.minImprovement ?? 0}` : 'On completion'} />}
        <div className="flex items-center justify-between border-t border-line/60 pt-2"><span className="text-fg-muted">Status</span><Badge tone={tone}>{st.status}</Badge></div>
        <p className="text-[11px] text-fg-subtle">IDLE stays in escrow until the independent evaluation completes; commission and earnings are finalised at settlement.</p>
      </CardBody>
    </Card>
  );
}
const Row = ({ k, v }: { k: string; v: React.ReactNode }) => <div className="flex items-center justify-between gap-3"><span className="text-fg-muted">{k}</span><span className="tabular-nums">{v}</span></div>;

export function ReviewModal({ open, onClose, sessionId, trainerName, onDone }: { open: boolean; onClose: () => void; sessionId: string; trainerName: string; onDone: () => void }) {
  const toast = useToast();
  const [rating, setRating] = useState(5);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await api.post('/marketplace/reviews', { sessionId, rating, body: body.trim() });
      toast('success', 'Review published — thank you');
      onDone(); onClose();
    } catch (e) { toast('danger', errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title={`Review ${trainerName}`} description="Reviews are tied to this completed session and can be submitted once."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={submit}>Publish review</Button></>}>
      <div className="space-y-4">
        <div role="radiogroup" aria-label="Rating" className="flex gap-1">
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} role="radio" aria-checked={rating === n} aria-label={`${n} star${n > 1 ? 's' : ''}`} onClick={() => setRating(n)} className="rounded-lg p-1 hover:bg-ink-800">
              <Star className={cn('h-7 w-7', n <= rating ? 'fill-gold text-gold' : 'text-fg-subtle')} />
            </button>
          ))}
        </div>
        <Field label="Your review" htmlFor="review-body" hint="Describe what the learner agent improved on. Keep it factual.">
          <Textarea id="review-body" value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} />
        </Field>
      </div>
    </Modal>
  );
}

const DISPUTE_REASONS = [
  ['no_improvement', 'No measurable improvement'],
  ['session_incomplete', 'Session not completed as agreed'],
  ['quality', 'Poor training quality'],
  ['policy_violation', 'Policy or safety violation'],
  ['billing', 'Billing / settlement error'],
  ['other', 'Other'],
] as const;

export function DisputeModal({ open, onClose, sessionId, onDone }: { open: boolean; onClose: () => void; sessionId: string; onDone: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState<string>('no_improvement');
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await api.post('/disputes', { sessionId, reason, details: details.trim() });
      toast('success', 'Dispute raised — an Hive Mind administrator will review it');
      onDone(); onClose();
    } catch (e) { toast('danger', errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Raise a dispute" description="If the session has not been settled yet, settlement is frozen until an administrator resolves the dispute."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" loading={busy} disabled={details.trim().length < 10} onClick={submit}>Submit dispute</Button></>}>
      <div className="space-y-4">
        <Field label="Reason" htmlFor="dispute-reason" required>
          <Select id="dispute-reason" value={reason} onChange={(e) => setReason(e.target.value)}>
            {DISPUTE_REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
        </Field>
        <Field label="Details" htmlFor="dispute-details" required hint="At least 10 characters. Reference transcript moments or evaluation results.">
          <Textarea id="dispute-details" value={details} onChange={(e) => setDetails(e.target.value)} maxLength={4000} />
        </Field>
      </div>
    </Modal>
  );
}
