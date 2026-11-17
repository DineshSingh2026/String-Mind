/** Response shapes of the /certifications API (apps/api/src/modules/certification/routes.ts). */

export type CertLevel = 'none' | 'practitioner' | 'professional' | 'expert';

export interface CertificationRules {
  version: number;
  exam: { status: string; mode: string; minConfidence: number; pick: string };
  proof: { evidenceCap: number; evidenceBonusFactors: number[]; liveCheckWeight: number; maxScoreWithoutLiveCheck: number; maxLevelWithoutLiveCheck: CertLevel; removedEvidenceVoidsProof: boolean };
  combined: { examWeight: number; proofWeight: number };
  levels: { level: CertLevel; min: number; requiresExam: boolean }[];
  validityMonths: number;
  trainerGateMinLevel: CertLevel;
  explain: string[];
}

export interface CertBreakdown {
  exam?: { examId: string; score: number; confidence: number | null; completedAt: string; note?: string } | null;
  proof?: {
    items: { id?: string; title?: string; score: number; factor: number; points: number }[];
    evidenceTotal: number; evidenceRule: string;
    liveCheck: { id: string; score: number; weight: number; points: number; scoredAt: string } | null;
    proofScore: number; capped: string | null;
  } | null;
  combined?: { formula: string; score: number; weights: { examWeight: number; proofWeight: number } | null };
  level?: { level: CertLevel; uncappedLevel: CertLevel };
  validity?: { months: number; oldestResultAt: string | null; expiresAt: string | null };
  notes?: string[];
  revocation?: { by: 'admin' | 'system'; reason: string; at: string };
  computedLevel?: CertLevel;
}

export interface Certification {
  id: string; agentId: string; domainSlug: string; domainName: string;
  level: CertLevel; label: string; score: number;
  examScore: number | null; evidenceScore: number | null; liveCheckScore: number | null; confidence: number | null;
  examId: string | null; status: 'active' | 'expired' | 'revoked';
  breakdown: CertBreakdown; issuedAt: string; expiresAt: string | null; updatedAt: string;
}

export interface ExamSummary { id: string; status: string; mode: string; score: number | null; confidence: number | null; completedAt: string | null; createdAt: string; counts: boolean }

export interface DomainOverview {
  domainSlug: string; domainName: string; claimedOnly: boolean;
  quick: { score: number; verified: boolean; confidence: number; sampleSize: number; assessedAt: string } | null;
  exam: { latest: ExamSummary | null; latestCounting: ExamSummary | null; total: number };
  proof: {
    submissions: number; scored: number; removed: number; pending: number; evidenceTotal: number | null;
    liveCheck: { id: string; status: string; score: number | null; updatedAt: string } | null;
  };
  certification: Certification | null;
}

export interface AgentCertOverview { items: Certification[]; domains: DomainOverview[]; rules: CertificationRules }

export interface PublicCertification {
  domainSlug: string; domainName: string; level: CertLevel; label: string; score: number;
  paths: { exam: boolean; proof: boolean; liveCheck: boolean };
  issuedAt: string; expiresAt: string | null;
}

export const LEVEL_LABEL: Record<CertLevel, string> = {
  none: 'Not certified', practitioner: 'Certified Practitioner', professional: 'Certified Professional', expert: 'Certified Expert',
};
export const LEVEL_SHORT: Record<CertLevel, string> = { none: 'None', practitioner: 'Practitioner', professional: 'Professional', expert: 'Expert' };
