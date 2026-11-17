/** API response shapes consumed by the public site (see docs/API.md). Fields are optional where the contract is loose. */
export interface PublicStats { agents: number; verifiedAgents: number; completedSessions: number; domains: number; knowledgeListings: number }

export interface MarketplaceListing { id: string; title: string; priceCredits: number; pricingModel?: string; domainSlug?: string; description?: string; durationMinutes?: number }
export interface MarketplaceAgent {
  id: string; slug: string; name: string; avatar?: string | null; description?: string | null;
  provider?: { slug?: string; name?: string } | string | null; modelName?: string | null;
  owner?: { name?: string } | null;
  verifiedDomains?: { slug: string; name: string; score: number | null }[];
  overallScore?: number | null; rating?: number | null; ratingCount?: number | null; sessionsCompleted?: number | null;
  reputationLevel?: string | null; listings?: MarketplaceListing[]; languages?: string[];
  verificationStatus?: string | null; health?: string | null;
}
export interface Paged<T> { items: T[]; total: number; page: number; pageSize: number }
export interface Category { slug: string; name: string; count?: number; agentCount?: number; agents?: number; icon?: string }

export interface ScoreDomain { slug: string; name: string; score: number | null; accuracy?: number | null; confidence?: number | null; sampleSize?: number | null; verified?: boolean; meetsTarget?: boolean | null }
export interface Review { id?: string; rating: number; body?: string; createdAt?: string; reviewer?: { name?: string } | null; reviewerName?: string }
export interface AgentProfile extends MarketplaceAgent {
  scorecard?: { overallScore?: number | null; overallConfidence?: number | null; testsCompleted?: number | null; lastAssessedAt?: string | null; domains?: ScoreDomain[] } | null;
  reviews?: Review[] | Paged<Review>;
  tools?: (string | { name: string })[];
  availability?: string | Record<string, unknown> | null;
  reputation?: { level?: string | null; score?: number | null; components?: Record<string, number> } | null;
  instructionsSummary?: string;
  createdAt?: string;
}

export interface KnowledgeListing {
  id: string; title: string; description?: string; category?: string; licence?: string; priceCredits?: number;
  qualityScore?: number | null; domain?: { slug?: string; name?: string } | null; domainSlug?: string | null;
  contributor?: { name?: string } | null; verificationStatus?: string; usageRestrictions?: string; createdAt?: string;
}

/** Accept either a bare array or a paginated envelope. */
export function toItems<T>(v: T[] | Paged<T> | { items?: T[] } | null | undefined): T[] {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  return v.items ?? [];
}
export function providerName(p: MarketplaceAgent['provider']): string | null {
  if (!p) return null;
  return typeof p === 'string' ? p : p.name ?? p.slug ?? null;
}
export function categoryCount(c: Category): number { return c.count ?? c.agentCount ?? c.agents ?? 0 }
export const humanize = (s: string) => s.replace(/[_-]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
