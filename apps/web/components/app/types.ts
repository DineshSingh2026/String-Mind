/**
 * Response shapes for the signed-in app, derived from docs/API.md.
 * Fields the contract leaves unspecified are optional so UI code must handle their absence.
 */
import type { LearningType } from '@aix/shared';

export interface Paged<T> { items: T[]; total: number; page: number; pageSize: number }
/** Accepts either a bare array or a `{ items }` envelope (contract is inconsistent for some lists). */
export function listOf<T>(d: T[] | Paged<T> | { items?: T[] } | null | undefined): T[] {
  if (!d) return [];
  if (Array.isArray(d)) return d;
  return d.items ?? [];
}

export type AgentStatus = 'draft' | 'active' | 'inactive' | 'suspended' | 'disconnected' | 'error' | string;
export type ConnectionMethod = 'api_key' | 'custom_rest' | 'webhook' | 'a2a' | 'mcp' | 'sandbox' | 'prompt';

export interface Provider {
  id: string; slug: string; name: string; adapter: string; defaultBaseUrl: string | null;
  defaultModels: string[]; capabilities?: string[] | Record<string, unknown>; status: string;
}

export interface AgentPermissions {
  publicProfile: boolean; allowTraining: boolean; allowLearning: boolean; shareKnowledge: boolean;
  allowOwnerIntervention: boolean; dataSharing: 'none' | 'artefacts_only' | 'full_session'; allowedDomains: string[];
}

export interface Agent {
  id: string; slug?: string; name: string; description?: string | null; avatarUrl?: string | null;
  status: AgentStatus; health?: 'healthy' | 'degraded' | 'down' | 'unknown' | string | null;
  isPublic?: boolean; modelName?: string; modelVersion?: string | null; role?: string | null;
  instructions?: string | null; languages?: string[]; claimedDomains?: ClaimedDomain[]; tools?: string[];
  provider?: { slug: string; name: string };
  connection?: { method: ConnectionMethod | string; status: string; credentialLast4?: string | null; lastTestedAt?: string | null; lastError?: string | null; endpointUrl?: string | null } | null;
  overallScore?: number | null;
  reputation?: { score?: number | null; level?: string | null } | number | null;
  createdAt?: string; updatedAt?: string;
  // detail-only
  permissions?: AgentPermissions;
  usageLimits?: { maxCallsPerDay?: number | null; maxCreditsPerDay?: number | null } | null;
  versionsCount?: number; currentVersion?: number;
  capabilities?: { domainSlug?: string; slug?: string; name?: string; score: number | null; verified?: boolean }[];
  learningSummary?: Record<string, number> | null;
}

export interface ScorecardDomain {
  slug: string; name: string; score: number | null; accuracy: number | null; confidence: number | null;
  sampleSize: number; verified: boolean; dimensionScores?: Record<string, number | null> | null;
  skillScores?: Record<string, number | null> | { slug: string; name?: string; score: number | null }[] | null;
  strengths?: string[]; weaknesses?: string[]; failureBreakdown?: Record<string, number> | null; meetsTarget: boolean | null;
}
export interface Scorecard {
  overallScore: number | null; overallConfidence: number | null; testsCompleted: number; lastAssessedAt: string | null;
  domains: ScorecardDomain[]; claimedOnly: string[];
  recommendations: { domainSlug: string; reason: string; suggestedTrainers: { agentId: string; name: string; score: number | null; priceCredits: number | null; slug?: string }[] }[];
}

export interface MarketAgent {
  id: string; slug: string; name: string; avatar?: string | null; description?: string | null;
  provider?: { slug: string; name: string } | string | null; modelName?: string;
  owner?: { name: string } | null; verifiedDomains: { slug: string; name: string; score: number | null }[];
  overallScore: number | null; rating: number | null; ratingCount: number; sessionsCompleted: number;
  reputationLevel?: string | null; listings: Listing[]; languages?: string[]; verificationStatus?: string | null; health?: string | null;
}
export interface Listing {
  id: string; title: string; description?: string | null; priceCredits: number; pricingModel?: string;
  domainSlug: string; durationMinutes?: number | null; skills?: string[]; settlementMode?: string; minImprovement?: number | null;
}
export interface Review { id: string; rating: number; body: string; createdAt: string; author?: { name: string } | null; reviewerName?: string; learnerAgent?: { name: string } | null }

export interface Wallet {
  /** All amounts are IDLE Tokens (currency: 'IDLE'). */
  available: number; locked: number; earnedTotal: number;
  spentTotal: number; refundedTotal: number; bonusTotal?: number | null; currency: string;
}
export interface Transaction {
  id: string; type: string; amount: number; description: string | null; referenceType?: string | null;
  referenceId?: string | null; createdAt: string; status?: string;
}

export interface Assessment {
  id: string; agentId: string; agent?: { id: string; name: string } | null; status: 'queued' | 'running' | 'completed' | 'failed' | string;
  progress?: number | null; testsCompleted?: number | null; testsTotal?: number | null; domainSlugs?: string[];
  repeats?: number; overallScore?: number | null; createdAt: string; completedAt?: string | null; error?: string | null;
  /** async (prompt-agent) runs: { mode: 'async', deadline } — tasks wait for the agent to check in */
  summary?: { mode?: string; deadline?: string; [k: string]: unknown } | null;
  domains?: { slug: string; name?: string; score: number | null; accuracy?: number | null; confidence?: number | null; sampleSize?: number; verified?: boolean; meetsTarget?: boolean | null }[];
}

export interface LearningRecord {
  id: string; agentId?: string; type: LearningType | string; learningType?: LearningType | string; domainSlug?: string | null;
  summary?: string | null; description?: string | null; title?: string | null; sessionId?: string | null;
  preScore?: number | null; postScore?: number | null; improvement?: number | null; retentionScore?: number | null; createdAt: string;
}

export interface NotificationItem { id: string; type: string; title: string; body?: string | null; link?: string | null; readAt?: string | null; read?: boolean; createdAt: string }

/** Agent reputation may be an object or number depending on endpoint. */
export function reputationLevel(r: Agent['reputation']): string | null {
  if (!r || typeof r === 'number') return null;
  return r.level ?? null;
}

/**
 * Claimed (self-reported) domains arrive as slugs from some endpoints and as `{ slug, name, claimed }`
 * objects from the marketplace. Normalise to slugs so rendering can never receive an object.
 */
export type ClaimedDomain = string | { slug: string; name?: string; claimed?: boolean };
export function claimedSlugs(list: readonly ClaimedDomain[] | null | undefined): string[] {
  return (list ?? []).map((c) => (typeof c === 'string' ? c : c?.slug)).filter((s): s is string => typeof s === 'string' && s.length > 0);
}
