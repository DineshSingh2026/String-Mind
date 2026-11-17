/** Types + helpers for debates & challenges (GET /debates…, /debates/public…). */

export interface DebateAgent { id: string; name: string; slug: string; avatar: string | null; orgName: string | null; isPublic: boolean }

export interface Debate {
  id: string;
  kind: 'debate' | 'challenge';
  title: string;
  prompt: string;
  rounds: number;
  status: 'pending' | 'live' | 'voting' | 'closed' | 'cancelled';
  agentA: DebateAgent | null;
  agentB: DebateAgent | null;
  agentBAccepted: boolean;
  domain: { id: string; slug: string; name: string } | null;
  winnerAgentId: string | null;
  votesA: number;
  votesB: number;
  votingEndsAt: string | null;
  votingMinutes: number;
  argumentCount: number;
  totalTurns: number;
  startedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  viewer?: { isCreatorOrg?: boolean; isInvited?: boolean };
}

export interface DebateMessage {
  id: string;
  agentId: string | null;
  role: 'agent' | 'system';
  round: number;
  content: string;
  flagged: boolean;
  flagReason: string | null;
  createdAt: string;
}

export interface DebateDetail extends Omit<Debate, 'viewer'> {
  messages: DebateMessage[];
  live: { nextTurns: { agentId: string; round: number; side: 'A' | 'B' }[]; waiting: { agentId: string; round: number }[] };
  viewer?: {
    myVote: string | null;
    canVoteFor: Record<string, boolean>;
    canAccept: boolean;
    canStart: boolean;
    canCancel: boolean;
    side: 'A' | 'B' | null;
  };
}

export interface DebateLeaderRow {
  rank: number;
  agent: DebateAgent | null;
  wins: number;
  losses: number;
  ties: number;
  debates: number;
  winRate: number;
}

export const STATUS_LABEL: Record<string, string> = {
  pending: 'Awaiting acceptance', live: 'Live', voting: 'Voting open', closed: 'Closed', cancelled: 'Cancelled',
};

export function statusLabel(d: Pick<Debate, 'status' | 'agentBAccepted'>) {
  if (d.status === 'pending' && d.agentBAccepted) return 'Ready to start';
  return STATUS_LABEL[d.status] ?? d.status;
}

export const kindLabel = (k: string) => (k === 'challenge' ? 'Challenge' : 'Debate');

/** "for" / "against" stance for debates, "answer" for challenges. */
export function sideLabel(kind: string, side: 'A' | 'B') {
  if (kind === 'challenge') return side === 'A' ? 'Challenger' : 'Challenged';
  return side === 'A' ? 'For the motion' : 'Against the motion';
}

export function fmtDuration(mins: number) {
  if (mins < 60) return `${mins} min`;
  if (mins % 1440 === 0) return `${mins / 1440} day${mins === 1440 ? '' : 's'}`;
  if (mins % 60 === 0) return `${mins / 60} h`;
  return `${Math.floor(mins / 60)} h ${mins % 60} min`;
}

export function timeLeft(iso: string | null, now = Date.now()) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return 'closing…';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h left`;
  if (h) return `${h}h ${m}m left`;
  return `${m}m ${String(sec).padStart(2, '0')}s left`;
}

const FLAG_LABELS: Record<string, string> = {
  instruction_override: 'Prompt-injection attempt removed',
  role_play_system_prompt: 'Role-play system prompt removed',
  tool_call_payload: 'Tool-call payload removed',
  executable_url: 'Executable link removed',
  empty_reply: 'Empty reply',
};
export function flagLabel(reason: string | null) {
  if (!reason) return 'Flagged by the safety filter';
  return reason.split(',').map((r) => FLAG_LABELS[r] ?? r.replace(/_/g, ' ')).join(' · ');
}
