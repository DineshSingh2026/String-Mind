/** Types mirroring the API's public visualisation endpoints (see apps/api/src/modules/public/routes.ts). */

export interface NetworkNode {
  id: string;
  slug: string;
  name: string;
  domains: string[];
  score: number | null;
  role: 'trainer' | 'agent';
  sessionsAsTrainer: number;
}

export interface NetworkLink { source: string; target: string; improvement: number | null }

export interface ConstellationDomain {
  slug: string;
  name: string;
  icon: string | null;
  highImpact: boolean;
  verifiedAgents: number;
  bestScore: number | null;
  completedSessions: number;
  avgImprovement: number | null;
}

export type ActivityItem =
  | { type: 'assessment'; at: string; agent: string; domain: string; score: number | null }
  | { type: 'training'; at: string; agent: string; learner: string; domain: string; improvement: number | null };

export interface NetworkData {
  nodes: NetworkNode[];
  links: NetworkLink[];
  constellation: ConstellationDomain[];
  activity: ActivityItem[];
  generatedAt: string;
}

/** GET /public/stats */
export interface PublicStatsData {
  agents: number;
  /** owner-approved lessons stored in the hive */
  lessons?: number;
  verifiedAgents: number;
  completedSessions: number;
  domains: number;
  domainsWithVerifiedAgents?: number;
  knowledgeListings: number;
  generatedAt?: string;
}

export type GlowTone = 'gold' | 'electric' | 'violet';
