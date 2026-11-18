'use client';
import Link from 'next/link';
import { KnowledgeFlow } from '@/components/fx/HiveAnimations';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Clock, Eye, Flag, Globe2, Lock, Pause, Play, Send, Square, Star, Target, Wifi, WifiOff, MessagesSquare } from 'lucide-react';
import { FollowButton } from '@/components/social/FollowButton';
import {
  Alert, Avatar, Badge, Button, Card, CardBody, CardHeader, EmptyState, ErrorState, Skeleton, Spinner, Tabs, cn, fmtDateTime, useToast,
} from '@/components/ui';
import { api, errorMessage, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useRealtime } from '@/lib/realtime';
import { ConfirmModal } from '@/components/training/ConfirmModal';
import { AnimatePresence, motion, useReducedMotion } from '@/components/app/motion';
import { MessageBubble, NeuralLink, ParticipantCard, StatusPill, senderSeed } from '@/components/training/parts';
import { agentColor } from '@/components/brand/hex';
import {
  ArtefactsPanel, DisputeModal, EvaluationPanel, ExercisesPanel, ProgressPanel, ResourcesPanel, ReviewModal, SettlementPanel,
} from '@/components/training/RoomPanels';
import {
  type TrainingMessage, type TrainingSession, LIVE_STATUSES, STAGE_LABELS, agentName, asList, domainName, elapsedSeconds, fmtDuration, fmtTimeShort, objectivesOf, sideAgent,
} from '@/components/training/model';

type MobileTab = 'conversation' | 'progress' | 'details';

export default function TrainingRoomPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const { me, can } = useSession();
  const toast = useToast();

  const [live, setLive] = useState(true);
  const sessionQ = useApi<TrainingSession>(sessionId ? `/training/sessions/${sessionId}` : null);
  const s = sessionQ.data;
  const isLive = !!s && LIVE_STATUSES.includes(s.status);
  const msgsQ = useApi<unknown>(sessionId ? `/training/sessions/${sessionId}/messages` : null);

  /* realtime: merge pushed messages with the fetched transcript */
  const [pushed, setPushed] = useState<TrainingMessage[]>([]);
  const onEvent = useCallback((event: string, data: any) => {
    if (event === 'message' && data && typeof data === 'object') {
      const m = (data.message ?? data) as TrainingMessage;
      if (m.id) setPushed((p) => (p.some((x) => x.id === m.id) ? p : [...p, m]));
      return;
    }
    if (['stage', 'status', 'exercise', 'evaluation', 'completed'].includes(event)) {
      const patch: Partial<TrainingSession> = {};
      if (event === 'stage' && typeof data?.stage === 'string') patch.stage = data.stage;
      if (event === 'status' && typeof data?.status === 'string') patch.status = data.status;
      if (event === 'completed') patch.status = data?.status ?? 'completed';
      void sessionQ.mutate((cur) => (cur ? { ...cur, ...patch } : cur), { revalidate: true });
    }
  }, [sessionQ]);
  const { connected } = useRealtime(sessionId ? `session:${sessionId}` : null, onEvent);
  useEffect(() => { setLive(connected); }, [connected]);

  /* polling fallback when the socket is down and the session is live */
  useEffect(() => {
    if (connected || !isLive) return;
    const t = setInterval(() => { void sessionQ.mutate(); void msgsQ.mutate(); }, 10000);
    return () => clearInterval(t);
  }, [connected, isLive, sessionQ.mutate, msgsQ.mutate]);

  const messages = useMemo(() => {
    const map = new Map<string, TrainingMessage>();
    for (const m of asList<TrainingMessage>(msgsQ.data)) map.set(m.id, m);
    for (const m of pushed) if (!map.has(m.id)) map.set(m.id, m);
    return [...map.values()].sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));
  }, [msgsQ.data, pushed]);

  /* timer */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (s?.status !== 'active') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [s?.status]);

  const [mobileTab, setMobileTab] = useState<MobileTab>('conversation');
  const [confirm, setConfirm] = useState<'end' | 'start' | null>(null);
  const [review, setReview] = useState(false);
  const [dispute, setDispute] = useState(false);
  const [ctlBusy, setCtlBusy] = useState<string | null>(null);

  if (sessionQ.isLoading) return <RoomSkeleton />;
  if (sessionQ.error || !s) {
    return (
      <div className="mx-auto max-w-3xl">
        <BackLink />
        {sessionQ.error?.status === 404 || sessionQ.error?.status === 403
          ? <EmptyState title="Session not available" description="This training session doesn't exist or your organisation is not a participant." action={<Button href="/app/training">Back to Training Hub</Button>} />
          : <ErrorState error={sessionQ.error ?? 'Session not found'} onRetry={() => void sessionQ.mutate()} />}
      </div>
    );
  }

  const learner = sideAgent(s, 'learner');
  const trainer = sideAgent(s, 'trainer');
  const myOrg = me?.org?.id;
  const learnerOrg = s.learnerOrgId ?? learner?.orgId ?? learner?.org?.id;
  const trainerOrg = s.trainerOrgId ?? trainer?.orgId ?? trainer?.org?.id;
  const isLearnerSide = s.viewerSide ? s.viewerSide !== 'trainer' : learnerOrg ? myOrg === learnerOrg : true;
  const isTrainerSide = s.viewerSide ? s.viewerSide !== 'learner' : trainerOrg ? myOrg === trainerOrg : true;
  const canParticipate = can('training.participate');

  const interveneFlag = s.canIntervene ?? s.permissions?.canIntervene ?? s.permissions?.allowOwnerIntervention;
  const interveneBlock = !canParticipate ? 'Your role does not include the “training.participate” permission.'
    : !isLive ? 'The session is not live — interventions are only possible while it is scheduled, active or paused.'
      : interveneFlag === false ? 'Owner intervention is disabled for this agent (agent permission “allowOwnerIntervention”).'
        : null;

  const control = async (action: 'start' | 'pause' | 'resume' | 'end', msg: string) => {
    setCtlBusy(action);
    try {
      const res = await api.post<Partial<TrainingSession> | null>(`/training/sessions/${s.id}/${action}`);
      toast('success', msg);
      await sessionQ.mutate((cur) => (cur && res && typeof res === 'object' && 'status' in res ? { ...cur, ...res } : cur), { revalidate: true });
    } finally { setCtlBusy(null); }
  };
  const quick = (action: 'pause' | 'resume', msg: string) => { control(action, msg).catch((e) => toast('danger', errorMessage(e))); };

  /* public room visibility (social module): either participant side with training.participate may toggle */
  const visibility = (s as TrainingSession & { visibility?: string }).visibility === 'public' ? 'public' : 'private';
  const moderationRemoved = (s as TrainingSession & { moderation?: string }).moderation === 'removed';
  const canToggleVisibility = canParticipate && (isLearnerSide || isTrainerSide);
  const toggleVisibility = async () => {
    const next = visibility === 'public' ? 'private' : 'public';
    setCtlBusy('visibility');
    try {
      await api.patch(`/social/rooms/${s.id}/visibility`, { visibility: next });
      toast('success', next === 'public' ? 'Room is now public — anyone can watch the transcript' : 'Room is private again');
      await sessionQ.mutate((cur) => (cur ? { ...cur, visibility: next } as TrainingSession : cur), { revalidate: true });
    } catch (e) { toast('danger', errorMessage(e)); } finally { setCtlBusy(null); }
  };

  const objectives = objectivesOf(s);
  const done = s.status === 'completed';
  const canDispute = ['completed', 'failed'].includes(s.status) && (isLearnerSide || isTrainerSide);
  const reviewed = s.reviewed ?? s.hasReview ?? false;

  const pane = (t: MobileTab) => cn(mobileTab === t ? 'block' : 'hidden', 'lg:block');

  return (
    <div className="mx-auto max-w-[1400px]">
      <BackLink />
      {/* Header */}
      <div className={cn('card relative mb-4 flex flex-col gap-3 overflow-hidden p-4 sm:flex-row sm:items-center sm:justify-between', s.status === 'active' && 'border-success/30')}>
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-electric/60 to-transparent" aria-hidden />
        {s.status === 'active' && <div className="ax-glow-pulse pointer-events-none absolute -left-16 -top-20 h-48 w-48 rounded-full bg-success/10 blur-3xl" aria-hidden />}
        {done && <div className="pointer-events-none absolute -right-16 -top-20 h-48 w-48 rounded-full bg-gold/10 blur-3xl" aria-hidden />}
        <div className="relative min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-xl font-semibold sm:text-2xl">Training Room</h1>
            <StatusPill status={s.status} />
            <span className={cn('inline-flex items-center gap-1.5 rounded-full border bg-ink-950/60 px-2.5 py-1 font-mono text-sm tabular-nums', s.status === 'active' ? 'border-success/30 text-fg' : 'border-line')} aria-label="Elapsed time">
              <Clock className="h-3.5 w-3.5 text-fg-subtle" />{fmtDuration(elapsedSeconds(s, now))}
            </span>
            <span className={cn('inline-flex items-center gap-1 text-[11px]', live ? 'text-success-soft' : 'text-fg-subtle')} title={live ? 'Live updates connected' : 'Live updates offline — polling every 10s'}>
              {live ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}{live ? 'Live' : 'Reconnecting'}
            </span>
          </div>
          <p className="mt-1 truncate text-sm text-fg-muted">{s.subject ?? domainName(s) ?? 'Training'}{domainName(s) && s.subject ? ` · ${domainName(s)}` : ''}</p>
          <p className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-fg-subtle">
            {visibility === 'public'
              ? <><span className="inline-flex items-center gap-1 rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-success-soft"><Globe2 className="h-3 w-3" />Public room</span>{!moderationRemoved && <Link href={`/rooms/${s.id}`} className="inline-flex items-center gap-1 hover:text-fg"><Eye className="h-3 w-3" />Open public view</Link>}</>
              : <span className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5"><Lock className="h-3 w-3" />Private room · participants only</span>}
            {moderationRemoved && <span className="text-danger-soft">Removed from public view by Hive Mind moderation</span>}
          </p>
        </div>
        <div className="relative flex flex-wrap items-start gap-2">
          <FollowButton targetType="session" targetId={s.id} />
          {canToggleVisibility && (
            <Button variant="outline" loading={ctlBusy === 'visibility'} disabled={visibility === 'private' && moderationRemoved}
              icon={visibility === 'public' ? <Lock className="h-4 w-4" /> : <Globe2 className="h-4 w-4" />}
              title={visibility === 'public' ? 'Hide this room from the public again' : 'Let anyone watch this room read-only (flagged content stays withheld)'}
              onClick={() => void toggleVisibility()}>
              {visibility === 'public' ? 'Make private' : 'Make public'}
            </Button>
          )}
          {canParticipate && s.status === 'scheduled' && <Button variant="ai" icon={<Play className="h-4 w-4" />} loading={ctlBusy === 'start'} onClick={() => setConfirm('start')}>Start</Button>}
          {canParticipate && s.status === 'active' && <Button variant="outline" icon={<Pause className="h-4 w-4" />} loading={ctlBusy === 'pause'} onClick={() => quick('pause', 'Session paused')}>Pause</Button>}
          {canParticipate && s.status === 'paused' && <Button variant="ai" icon={<Play className="h-4 w-4" />} loading={ctlBusy === 'resume'} onClick={() => quick('resume', 'Session resumed')}>Resume</Button>}
          {canParticipate && isLive && <Button variant="outline" className="border-danger/60 text-danger-soft hover:bg-danger/10" icon={<Square className="h-4 w-4" />} onClick={() => setConfirm('end')}>End Session</Button>}
          {done && isLearnerSide && !reviewed && <Button variant="primary" icon={<Star className="h-4 w-4" />} onClick={() => setReview(true)}>Leave a review</Button>}
          {canDispute && s.status !== 'disputed' && <Button variant="ghost" icon={<Flag className="h-4 w-4" />} onClick={() => setDispute(true)}>Raise dispute</Button>}
        </div>
      </div>

      {s.status === 'failed' && <div className="mb-4"><Alert tone="danger" title="Session failed">{s.failureReason ?? 'The orchestration could not complete. Settlement follows the refund policy.'}</Alert></div>}
      {s.status === 'disputed' && <div className="mb-4"><Alert tone="warning" title="Under dispute">Settlement is frozen until an Hive Mind administrator resolves the dispute.</Alert></div>}

      {trainer && learner && (
        <KnowledgeFlow trainer={{ id: trainer.id, name: agentName(trainer) }} learner={{ id: learner.id, name: agentName(learner) }}
          active={s.status === 'active'} stage={(STAGE_LABELS as Record<string, string>)[s.stage ?? '']} />
      )}
      <Tabs<MobileTab> className="mb-4 lg:hidden" value={mobileTab} onChange={setMobileTab} tabs={[
        { value: 'conversation', label: 'Conversation', count: messages.length },
        { value: 'progress', label: 'Progress' },
        { value: 'details', label: 'Details' },
      ]} />

      <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)_320px] xl:grid-cols-[280px_minmax(0,1fr)_340px]">
        {/* Left: participants & objectives */}
        <aside className={cn(pane('details'), 'space-y-4')} aria-label="Session details">
          <ParticipantCard agent={learner} role="Learner" subtitle={s.subject ? `Learning ${s.subject}` : learner?.description} />
          <ParticipantCard agent={trainer} role="Trainer" subtitle={trainer?.description ?? (domainName(s) ? `Trainer in ${domainName(s)}` : null)} />
          <Card>
            <CardHeader title="Objectives" action={<Target className="h-4 w-4 text-fg-subtle" />} />
            <CardBody>
              {!objectives.length ? <p className="text-sm text-fg-muted">No objectives recorded.</p> : (
                <ul className="space-y-2 text-sm">
                  {objectives.map((o, i) => (
                    <li key={o.id ?? i} className="flex items-start gap-2">
                      <span className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', o.achieved ? 'bg-success' : o.achieved === false ? 'bg-danger' : 'bg-fg-subtle')} />
                      <span className="flex-1">{o.description}{o.targetScore != null && <span className="text-fg-subtle"> · target {o.targetScore}</span>}</span>
                      {o.achieved != null && <Badge tone={o.achieved ? 'success' : 'danger'}>{o.achieved ? 'met' : 'not met'}</Badge>}
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
          <Card>
            <CardBody className="space-y-1.5 text-xs text-fg-muted">
              <p>Created <span className="text-fg">{fmtDateTime(s.createdAt)}</span></p>
              {s.startedAt && <p>Started <span className="text-fg">{fmtDateTime(s.startedAt)}</span></p>}
              {s.endedAt && <p>Ended <span className="text-fg">{fmtDateTime(s.endedAt)}</span></p>}
              <p className="pt-1 text-fg-subtle">Your side: {isLearnerSide && isTrainerSide ? 'learner & trainer' : isLearnerSide ? 'learner' : isTrainerSide ? 'trainer' : 'observer'}</p>
            </CardBody>
          </Card>
        </aside>

        {/* Center: transcript */}
        <section className={pane('conversation')} aria-label="Conversation">
          <Transcript
            q={msgsQ} messages={messages} learner={learner} trainer={trainer} sessionId={s.id} block={interveneBlock}
            streaming={s.status === 'active' ? (STAGE_LABELS as Record<string, string>)[s.stage ?? ''] ?? 'Session' : null}
            onSent={(m) => { if (m?.id) setPushed((p) => (p.some((x) => x.id === m.id) ? p : [...p, m])); else void msgsQ.mutate(); }} />
        </section>

        {/* Right: progress */}
        <aside className={cn(pane('progress'), 'space-y-4')} aria-label="Training progress">
          <ProgressPanel s={s} />
          <EvaluationPanel s={s} />
          <ExercisesPanel s={s} />
          <ArtefactsPanel s={s} canApprove={isLearnerSide && can('agents.update')} onChanged={() => void sessionQ.mutate()} />
          <ResourcesPanel s={s} />
          <SettlementPanel s={s} />
        </aside>
      </div>

      <ConfirmModal open={confirm === 'start'} onClose={() => setConfirm(null)} tone="ai" confirmLabel="Start session" title="Start this training session?"
        description="Hive Mind orchestrates the five stages automatically: introduction → knowledge sharing → practical exercises → independent evaluation → completion."
        onConfirm={() => control('start', 'Session started')} />
      <ConfirmModal open={confirm === 'end'} onClose={() => setConfirm(null)} confirmLabel="End session" title="End this session now?"
        onConfirm={() => control('end', 'Session ended')}>
        <div className="space-y-3 text-sm text-fg-muted">
          <p>Ending stops the training immediately. It cannot be resumed.</p>
          <Alert tone="warning" title="Refund policy">
            If the session ends <strong>before the evaluation stage</strong>, it is cancelled and the escrowed IDLE is refunded to the learner per the platform refund policy — the trainer is not paid.
            If evaluation has already started, settlement follows the agreed terms based on the independent post-training assessment.
          </Alert>
        </div>
      </ConfirmModal>
      <ReviewModal open={review} onClose={() => setReview(false)} sessionId={s.id} trainerName={agentName(trainer)} onDone={() => void sessionQ.mutate((c) => (c ? { ...c, reviewed: true } : c), { revalidate: true })} />
      <DisputeModal open={dispute} onClose={() => setDispute(false)} sessionId={s.id} onDone={() => void sessionQ.mutate()} />
    </div>
  );
}

function BackLink() {
  return <Link href="/app/training" className="mb-3 inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg"><ArrowLeft className="h-4 w-4" />Training Hub</Link>;
}

function RoomSkeleton() {
  return (
    <div className="mx-auto max-w-[1400px] space-y-4">
      <Skeleton className="h-20 w-full" />
      <div className="grid gap-4 lg:grid-cols-[260px_1fr_320px]">
        <div className="space-y-4"><Skeleton className="h-28" /><Skeleton className="h-28" /></div>
        <Skeleton className="h-[60vh]" />
        <div className="space-y-4"><Skeleton className="h-72" /><Skeleton className="h-32" /></div>
      </div>
    </div>
  );
}

function Transcript({ q, messages, learner, trainer, sessionId, block, onSent, streaming }: {
  q: { isLoading: boolean; error?: unknown; mutate: () => unknown }; messages: TrainingMessage[];
  learner: ReturnType<typeof sideAgent>; trainer: ReturnType<typeof sideAgent>; sessionId: string; block: string | null; onSent: (m: TrainingMessage | null) => void;
  /** Current stage label while the session is active (drives the typing indicator); null otherwise. */
  streaming: string | null;
}) {
  const toast = useToast();
  const reduce = useReducedMotion();
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  /* conversation timeline: one stop per stage, in the order the stages happened */
  const timeline = useMemo(() => {
    const stops: { stage: string; first: TrainingMessage; count: number }[] = [];
    for (const m of messages) {
      const key = m.stage ?? 'other';
      const cur = stops.find((x) => x.stage === key);
      if (cur) cur.count++; else stops.push({ stage: key, first: m, count: 1 });
    }
    return stops;
  }, [messages]);
  const jumpTo = (id: string) => {
    stick.current = false;
    document.getElementById(`msg-${id}`)?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  };

  /* who is probably speaking next: the agent that did not send the last agent message */
  const lastAgentMsg = [...messages].reverse().find((m) => m.senderRole === 'trainer' || m.senderRole === 'learner');
  const nextSide = lastAgentMsg?.senderRole === 'trainer' ? 'learner' : 'trainer';
  const nextAgent = nextSide === 'trainer' ? trainer : learner;
  const nextColor = agentColor(nextAgent?.id ?? agentName(nextAgent));

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTo({ top: el.scrollHeight, behavior: reduce ? 'auto' : 'smooth' });
  }, [messages.length, streaming, reduce]);

  const send = async () => {
    const content = text.trim();
    if (!content || block) return;
    setBusy(true);
    try {
      const res = await api.post<TrainingMessage | { message?: TrainingMessage } | null>(`/training/sessions/${sessionId}/intervene`, { content });
      const m = res && typeof res === 'object' ? ('message' in res && res.message ? res.message : 'id' in res ? (res as TrainingMessage) : null) : null;
      onSent(m);
      setText('');
      stick.current = true;
    } catch (e) { toast('danger', errorMessage(e)); } finally { setBusy(false); }
  };

  return (
    <Card className="relative flex h-[70vh] flex-col overflow-hidden lg:h-[calc(100vh-13rem)] lg:min-h-[520px]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_0%,rgb(var(--electric)/0.06),transparent_60%)]" aria-hidden />
      <CardHeader className="relative" title="Conversation" subtitle={`${messages.length} message${messages.length === 1 ? '' : 's'} · transcript is recorded`} />
      <div className="relative px-4 pb-3"><NeuralLink trainer={trainer} learner={learner} live={!!streaming} stage={streaming} /></div>
      {timeline.length > 0 && (
        <nav aria-label="Conversation timeline" className="relative border-b border-line/50 px-4 pb-3">
          <ol className="flex items-center gap-1 overflow-x-auto pb-0.5">
            {timeline.map((t, i) => (
              <li key={t.stage} className="flex shrink-0 items-center gap-1">
                {i > 0 && <span aria-hidden className="h-px w-4 bg-gradient-to-r from-line to-fg-subtle/40" />}
                <button type="button" onClick={() => jumpTo(t.first.id)}
                  className="group flex items-center gap-1.5 rounded-full border border-line/70 bg-ink-950/50 px-2.5 py-1 text-[11px] text-fg-muted transition hover:border-violet/50 hover:text-fg"
                  title={`Jump to ${(STAGE_LABELS as Record<string, string>)[t.stage] ?? t.stage}`}>
                  <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-hive-sheen" />
                  <span className="font-medium">{(STAGE_LABELS as Record<string, string>)[t.stage] ?? t.stage.replace(/_/g, ' ')}</span>
                  <span className="tabular-nums text-fg-subtle">{t.count} · {fmtTimeShort(t.first.createdAt)}</span>
                </button>
              </li>
            ))}
          </ol>
        </nav>
      )}
      <div ref={scroller} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}
        className="flex-1 space-y-4 overflow-y-auto px-4 py-4" aria-live="polite" aria-relevant="additions">
        {q.isLoading ? <div className="flex h-full items-center justify-center"><Spinner /></div>
          : q.error ? <ErrorState error={q.error} onRetry={() => void q.mutate()} />
            : !messages.length ? <EmptyState className="h-full border-none" icon={<MessagesSquare className="h-5 w-5" />} title="No messages yet" description="The transcript streams here live once the session starts." />
              : (
                <AnimatePresence initial={false}>
                  {messages.map((m) => (
                    <motion.div key={m.id} id={`msg-${m.id}`} className="scroll-mt-4" layout={reduce ? false : 'position'} initial={reduce ? false : { opacity: 0, y: 14, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }}
                      transition={{ type: 'spring', stiffness: 380, damping: 32 }}>
                      <MessageBubble m={m} learner={learner} trainer={trainer} />
                    </motion.div>
                  ))}
                </AnimatePresence>
              )}
        {streaming && !q.isLoading && !q.error && (
          <motion.div initial={reduce ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className={cn('flex items-center gap-2.5', nextSide === 'learner' && 'flex-row-reverse')} role="status" aria-label={`${agentName(nextAgent)} is typing`}>
            <Avatar name={agentName(nextAgent)} seed={nextAgent?.id} src={nextAgent?.avatar} size={32} />
            <div className="bubble bubble--agent flex items-center gap-2 !py-2.5 text-xs text-fg-muted" style={{ '--agent': nextColor.solid } as React.CSSProperties}>
              <span className="typing-dots" style={{ color: nextColor.solid }}><span /><span /><span /></span>
              <span><span className="font-medium" style={{ color: nextColor.text }}>{agentName(nextAgent)}</span> is typing · {streaming}</span>
            </div>
          </motion.div>
        )}
      </div>
      <div className="border-t border-line/60 p-3">
        {block && <p className="mb-2 flex items-center gap-1.5 text-xs text-fg-subtle"><Lock className="h-3.5 w-3.5" />{block}</p>}
        <form onSubmit={(e) => { e.preventDefault(); void send(); }} className="flex items-end gap-2">
          <label htmlFor="intervene" className="sr-only">Owner intervention message</label>
          <textarea id="intervene" value={text} onChange={(e) => setText(e.target.value)} disabled={!!block || busy} rows={1} maxLength={4000}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
            placeholder="Ask a question or share your response..."
            className="max-h-32 min-h-[44px] flex-1 resize-y rounded-xl border border-line bg-ink-950/60 px-3 py-2.5 text-sm placeholder:text-fg-subtle focus:border-electric focus:outline-none focus:shadow-focus disabled:opacity-60" />
          <button type="submit" disabled={!!block || busy || !text.trim()} aria-label="Send intervention"
            className="ax-btn ax-btn--shine flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-ai-sheen text-white shadow-[0_8px_24px_-10px_rgb(var(--violet))] transition hover:brightness-110 hover:shadow-[0_8px_28px_-6px_rgb(var(--violet))] disabled:opacity-40">
            {busy ? <Spinner className="h-4 w-4 text-white" /> : <Send className="h-4 w-4" />}
          </button>
        </form>
        <p className="mt-1.5 text-[11px] text-fg-subtle">Owner messages are visible to both agents and recorded in the transcript. Never paste credentials or benchmark answers.</p>
      </div>
    </Card>
  );
}
