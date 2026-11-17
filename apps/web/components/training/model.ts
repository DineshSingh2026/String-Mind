/**
 * Training data model + tolerant normalisers.
 * The backend contract (docs/API.md → training) does not pin every nested field name, so these helpers
 * accept the obvious variants (e.g. `learner` | `learnerAgent`, `{items}` | array) and never invent values.
 */
import { TRAINING_STAGES, type TrainingStage } from '@aix/shared';

export interface AgentRef {
  id?: string;
  name: string;
  slug?: string | null;
  avatar?: string | null;
  role?: string | null;
  description?: string | null;
  modelName?: string | null;
  provider?: { slug?: string; name?: string } | string | null;
  org?: { id?: string; name?: string } | null;
  orgName?: string | null;
  orgId?: string | null;
}

export interface TrainingRequest {
  id: string;
  status: 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired' | string;
  learner?: AgentRef; learnerAgent?: AgentRef; learnerAgentId?: string;
  trainer?: AgentRef; trainerAgent?: AgentRef; trainerAgentId?: string;
  learnerOrgId?: string; trainerOrgId?: string;
  domain?: { slug?: string; name?: string } | null; domainSlug?: string;
  objectives?: string[];
  message?: string;
  priceCredits?: number | null;
  sessionId?: string | null;
  listing?: { id: string; title?: string } | null;
  createdAt?: string;
  respondedAt?: string | null;
}

export interface TrainingMessage {
  id: string;
  senderRole: 'trainer' | 'learner' | 'system' | 'owner' | 'evaluator' | string;
  senderAgentId?: string | null;
  senderUserId?: string | null;
  senderName?: string | null;
  sender?: { name?: string } | null;
  stage?: string;
  content: string;
  metadata?: Record<string, unknown>;
  flagged?: boolean;
  flagReason?: string | null;
  createdAt: string;
}

export interface Exercise {
  id: string; prompt: string; learnerResponse?: string | null; feedback?: string | null;
  score?: number | null; status?: string; completedAt?: string | null;
}

export interface Artefact {
  id: string; learningType: string; title: string; content: string;
  status: 'pending' | 'approved' | 'rejected' | 'applied' | string; createdAt?: string;
}

export interface Objective { id?: string; description: string; targetScore?: number | null; achieved?: boolean | null }

export interface TrainingSession {
  id: string;
  subject?: string;
  status: 'scheduled' | 'active' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'disputed' | string;
  stage?: TrainingStage | string;
  learner?: AgentRef; learnerAgent?: AgentRef; learnerAgentId?: string; learnerOrgId?: string;
  trainer?: AgentRef; trainerAgent?: AgentRef; trainerAgentId?: string; trainerOrgId?: string;
  participants?: { id?: string; role: string; agentId?: string | null; userId?: string | null; agent?: AgentRef | null; user?: { id?: string; name?: string } | null; permissions?: Record<string, boolean> }[];
  domain?: { slug?: string; name?: string } | null; domainSlug?: string;
  objectives?: (Objective | string)[];
  exercises?: Exercise[];
  artefacts?: Artefact[];
  resources?: { id?: string; title?: string; name?: string; url?: string | null; kind?: string; type?: string }[];
  sharedResources?: TrainingSession['resources'];
  preScore?: number | null; postScore?: number | null; improvement?: number | null; retentionScore?: number | null;
  scores?: { pre?: number | null; post?: number | null; improvement?: number | null; retention?: number | null } | null;
  feeCredits?: number | null; commissionRateBps?: number | null; commissionCredits?: number | null; trainerEarningsCredits?: number | null;
  settlementStatus?: string; settlementTerms?: { mode?: string; minImprovement?: number } | null;
  settlement?: { feeCredits?: number | null; commissionRateBps?: number | null; commissionCredits?: number | null; trainerEarningsCredits?: number | null; status?: string; terms?: { mode?: string; minImprovement?: number } | null } | null;
  startedAt?: string | null; pausedAt?: string | null; endedAt?: string | null;
  durationSeconds?: number | null; pausedSeconds?: number | null; totalPausedSeconds?: number | null;
  failureReason?: string | null;
  canIntervene?: boolean; permissions?: { canIntervene?: boolean; allowOwnerIntervention?: boolean } | null;
  viewerSide?: 'learner' | 'trainer' | 'both' | null;
  lastMessage?: TrainingMessage | null;
  reviewed?: boolean; hasReview?: boolean;
  createdAt?: string; updatedAt?: string;
}

/** Accept `T[]` or a paginated `{ items }` envelope. */
export function asList<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === 'object' && Array.isArray((data as { items?: unknown }).items)) return (data as { items: T[] }).items;
  return [];
}

type WithSides = { learner?: AgentRef; learnerAgent?: AgentRef; trainer?: AgentRef; trainerAgent?: AgentRef; participants?: TrainingSession['participants'] };
export function sideAgent(x: WithSides | undefined | null, side: 'learner' | 'trainer'): AgentRef | null {
  if (!x) return null;
  const direct = side === 'learner' ? x.learner ?? x.learnerAgent : x.trainer ?? x.trainerAgent;
  if (direct) return direct;
  const p = x.participants?.find((pp) => pp.role === side && pp.agent);
  return p?.agent ?? null;
}

export const agentName = (a: AgentRef | null | undefined) => a?.name ?? 'Unknown agent';
export const providerName = (a: AgentRef | null | undefined) =>
  !a?.provider ? null : typeof a.provider === 'string' ? a.provider : a.provider.name ?? a.provider.slug ?? null;
export const orgName = (a: AgentRef | null | undefined) => a?.org?.name ?? a?.orgName ?? null;
export const domainName = (x: { domain?: { slug?: string; name?: string } | null; domainSlug?: string } | null | undefined) =>
  x?.domain?.name ?? x?.domain?.slug ?? x?.domainSlug ?? null;

export function scoresOf(s: TrainingSession) {
  const pre = s.scores?.pre ?? s.preScore ?? null;
  const post = s.scores?.post ?? s.postScore ?? null;
  const improvement = s.scores?.improvement ?? s.improvement ?? (pre != null && post != null ? post - pre : null);
  const retention = s.scores?.retention ?? s.retentionScore ?? null;
  return { pre, post, improvement, retention };
}

export function settlementOf(s: TrainingSession) {
  const st = s.settlement ?? {};
  const fee = st.feeCredits ?? s.feeCredits ?? null;
  const bps = st.commissionRateBps ?? s.commissionRateBps ?? null;
  const commission = st.commissionCredits ?? s.commissionCredits ?? null;
  const earnings = st.trainerEarningsCredits ?? s.trainerEarningsCredits ?? null;
  return { fee, bps, commission, earnings, status: st.status ?? s.settlementStatus ?? 'none', terms: st.terms ?? s.settlementTerms ?? null };
}

export function objectivesOf(s: { objectives?: (Objective | string)[] }): Objective[] {
  return (s.objectives ?? []).map((o) => (typeof o === 'string' ? { description: o } : o));
}

export function stageIndex(stage: string | undefined) {
  const i = TRAINING_STAGES.indexOf((stage ?? 'introduction') as TrainingStage);
  return i < 0 ? 0 : i;
}

/** Stage-based progress: completed stages / 5. A completed session is 100%. */
export function stageProgress(s: Pick<TrainingSession, 'status' | 'stage'>) {
  if (s.status === 'completed') return 100;
  if (s.status === 'scheduled') return 0;
  return Math.round((stageIndex(s.stage) / TRAINING_STAGES.length) * 100);
}

export const STAGE_LABELS: Record<TrainingStage, string> = {
  introduction: 'Introduction',
  knowledge_sharing: 'Knowledge Sharing',
  practical_exercises: 'Practice Exercises',
  evaluation: 'Independent Evaluation',
  completion: 'Completion & Settlement',
};

export const STATUS_META: Record<string, { label: string; dot: string; tone: 'success' | 'warning' | 'danger' | 'neutral' | 'electric' | 'gold' | 'violet' }> = {
  scheduled: { label: 'Scheduled', dot: 'bg-electric', tone: 'electric' },
  active: { label: 'In Progress', dot: 'bg-success animate-pulse-dot', tone: 'success' },
  paused: { label: 'Paused', dot: 'bg-warning', tone: 'warning' },
  completed: { label: 'Completed', dot: 'bg-gold', tone: 'gold' },
  failed: { label: 'Failed', dot: 'bg-danger', tone: 'danger' },
  cancelled: { label: 'Cancelled', dot: 'bg-fg-subtle', tone: 'neutral' },
  disputed: { label: 'Disputed', dot: 'bg-violet', tone: 'violet' },
};
export const statusMeta = (s: string) => STATUS_META[s] ?? { label: s, dot: 'bg-fg-subtle', tone: 'neutral' as const };

export const LIVE_STATUSES = ['scheduled', 'active', 'paused'];
export const DONE_STATUSES = ['completed', 'failed', 'cancelled', 'disputed'];

/** Elapsed active seconds. Assumes `pausedSeconds`/`totalPausedSeconds` (if sent) is accumulated pause time; when ended, `durationSeconds` is authoritative. */
export function elapsedSeconds(s: TrainingSession, now: number) {
  if (!s.startedAt) return 0;
  const start = new Date(s.startedAt).getTime();
  const paused = s.pausedSeconds ?? s.totalPausedSeconds ?? 0;
  if (DONE_STATUSES.includes(s.status)) {
    if (s.durationSeconds) return s.durationSeconds;
    const end = s.endedAt ? new Date(s.endedAt).getTime() : start;
    return Math.max(0, Math.floor((end - start) / 1000) - paused);
  }
  const ref = s.status === 'paused' && s.pausedAt ? new Date(s.pausedAt).getTime() : now;
  return Math.max(0, Math.floor((ref - start) / 1000) - paused);
}

/** "14:05" — short local time for timeline stops. */
export function fmtTimeShort(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(+d) ? '' : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function fmtDuration(sec: number) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

export function senderLabel(m: TrainingMessage, learner: AgentRef | null, trainer: AgentRef | null) {
  if (m.senderName) return m.senderName;
  if (m.sender?.name) return m.sender.name;
  switch (m.senderRole) {
    case 'trainer': return trainer?.name ?? 'Trainer';
    case 'learner': return learner?.name ?? 'Learner';
    case 'owner': return 'Owner';
    case 'evaluator': return 'Hive Mind Evaluator';
    default: return 'Hive Mind System';
  }
}

/** Flagged messages are hidden unless the backend explicitly marks them as not blocked. */
export const isBlocked = (m: TrainingMessage) => !!m.flagged && (m.metadata?.blocked as boolean | undefined) !== false;

export function flagReasonLabel(r: string | null | undefined) {
  if (!r) return 'Flagged by safety filter';
  const k = r.toLowerCase();
  if (k.includes('leak') || k.includes('benchmark')) return 'Benchmark leakage blocked';
  if (k.includes('inject')) return 'Prompt injection blocked';
  if (k.includes('unsafe')) return 'Unsafe content blocked';
  return r.replace(/_/g, ' ');
}
