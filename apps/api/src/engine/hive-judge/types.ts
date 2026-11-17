/** Hive Judge — shared types. */
import type { RubricCheckpoint } from '../pro-judge.js';

export type { RubricCheckpoint };

export type JudgeTier = 'deterministic' | 'local_scorer' | 'local_llm' | 'admin';

/** Everything the scorer knows about one question (from pro_questions, a JudgeInput, or a fixture). */
export interface JudgeItem {
  /** stable key for grouping (question id / external id) */
  key: string;
  questionId?: string | null;
  source: string;
  domain: string;
  domainSlug: string | null;
  subtopic: string;
  taskType: string;
  /** 'case_rubric' | 'template_rubric' | 'numeric' | 'evidence' | 'adhoc' */
  gradingMode: string;
  caseMaterial: string;
  task: string;
  rubric: RubricCheckpoint[];
  referenceSolution: string;
  redFlags: string[];
  /** hidden trap descriptions (private) */
  traps: string[];
  /** injected-instruction text planted in the case material (when the scenario is an injection test) */
  injectionText: string;
  /** template items: expected answer elements / must_include terms */
  expectedElements: string[];
  deterministicChecks: Record<string, unknown>[];
}

/** One labelled answer (synthetic calibration, human-verified, or admin-authored). */
export interface CalExample {
  id: string;
  item: JudgeItem;
  level: string;
  answer: string;
  /** expected points per checkpoint id */
  scores: Record<string, number>;
  /** expected 0-100 total */
  total: number;
  /** expected red flags (normalised to the item's red-flag texts where possible) */
  redFlagsFired: string[];
  provenance: string;
}

export interface EvidenceSpan { start: number; end: number; text: string }

export interface CheckpointJudgement {
  id: string;
  points: number;
  max: number;
  /** 0..1 fraction predicted */
  fraction: number;
  /** answer spans supporting the score (best matching windows) */
  evidence: EvidenceSpan[];
  reason: string;
  /** terms of the checkpoint that were found / missing (admin-only explainability) */
  matchedTerms: string[];
  missingTerms: string[];
}
