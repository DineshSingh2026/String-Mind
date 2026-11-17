import { DOMAINS } from '@aix/shared';

export type EvidenceKind = 'git_repo' | 'website' | 'pdf' | 'document' | 'image' | 'link';
export const URL_KINDS: EvidenceKind[] = ['git_repo', 'website', 'link'];

export interface OwnershipMethod { key: string; label: string; value: string; detail?: string }
export interface Evidence {
  id: string; agentId: string; domainSlug: string; kind: EvidenceKind; title: string; claim: string; url: string | null;
  mimeType: string | null; sizeBytes: number | null; ownershipToken: string | null; ownershipStatus: string; status: string;
  checks: Record<string, any>; judgement: Record<string, any>; trustWeight: number | null; qualityScore: number | null; evidenceScore: number | null;
  moderation: string; createdAt: string; updatedAt: string;
  ownership: { status: string; instructions: { methods: OwnershipMethod[] } | null };
  flags: string[];
}
export interface LiveCheck {
  id: string; agentId: string; domainSlug: string; task: string; status: string; answer: string | null; score: number | null; contribution: number | null;
  rubric: { id: string; criterion: string; points: number }[]; judgement: Record<string, any>; createdAt: string; updatedAt: string;
}
export interface DomainSummary {
  agentId: string; domainSlug: string; domainName: string; items: number; scoredItems: number; awaitingJudge: number; flags: string[];
  evidenceTotal: number; evidenceMax: number; liveCheck: { id: string; score: number | null; contribution: number } | null;
  liveContribution: number; liveMax: number; total: number;
}
export interface Rules {
  scoring: {
    baseTrust: Record<EvidenceKind, { verified: number; unverified: number }>; possibleCopyCap: number;
    notReproduced: { gap: number; factor: number }; formulas: Record<string, string>;
  };
  limits: { fileBytes: Record<string, number>; claimMaxChars: number; maxItemsPerDomain: number; documentTypes: string[]; imageTypes: string[] };
  kinds: Record<EvidenceKind, string>;
  guidance: { proofTypes: { kind?: string; label: string; description?: string }[]; authenticityChecks: string[] } | null;
}

export const KIND_LABEL: Record<EvidenceKind, string> = {
  git_repo: 'Git repository', website: 'Website', link: 'Web link', pdf: 'PDF', document: 'Document', image: 'Image / screenshot',
};

export const domainLabel = (slug: string) => DOMAINS.find((d) => d.slug === slug)?.name ?? slug;

/** Human status for a proof item. "Under admin review" only when the judge actually returned awaiting. */
export function evidenceStatus(e: Pick<Evidence, 'status' | 'judgement'>): { label: string; tone: 'neutral' | 'electric' | 'success' | 'warning' | 'danger' } {
  if (e.judgement?.status === 'not_assessable') return { label: 'Recorded · no points', tone: 'neutral' };
  switch (e.status) {
    case 'submitted': return { label: 'Queued', tone: 'electric' };
    case 'checking': return { label: 'Checking', tone: 'electric' };
    case 'awaiting_judge': return { label: 'Under admin review', tone: 'warning' };
    case 'scored': return { label: 'Scored', tone: 'success' };
    case 'failed': return { label: 'Needs recheck', tone: 'danger' };
    case 'rejected': return { label: 'Rejected', tone: 'danger' };
    default: return { label: e.status, tone: 'neutral' };
  }
}

export function liveStatus(s: string): { label: string; tone: 'neutral' | 'electric' | 'success' | 'warning' | 'danger' } {
  switch (s) {
    case 'pending': return { label: 'Delivering', tone: 'electric' };
    case 'sent': return { label: 'Waiting for the agent', tone: 'electric' };
    case 'answered': return { label: 'Grading', tone: 'electric' };
    case 'awaiting_judge': return { label: 'Under admin review', tone: 'warning' };
    case 'scored': return { label: 'Scored', tone: 'success' };
    case 'timeout': return { label: 'Timed out', tone: 'danger' };
    case 'failed': return { label: 'Failed', tone: 'danger' };
    default: return { label: s, tone: 'neutral' };
  }
}

export const FLAG_TEXT: Record<string, string> = {
  possible_copy: 'Possible copy — the same file or URL was submitted by another organisation; trust capped at 0.2.',
  proof_not_reproduced: 'Proof not reproduced — the live skill check scored more than 40 points below this item; trust halved.',
};

export const isBusyStatus = (s: string) => s === 'submitted' || s === 'checking' || s === 'pending' || s === 'answered';
export const fmtScore = (n: number | null | undefined, d = 1) => (n == null ? '—' : (Math.round(n * 10 ** d) / 10 ** d).toString());
