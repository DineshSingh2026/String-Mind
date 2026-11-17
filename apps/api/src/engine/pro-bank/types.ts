/**
 * Shared constants and record shapes for the professional question bank (pro_questions & friends).
 * Source-file shapes are deliberately loose (`Record<string, unknown>`): inbox files are untrusted data.
 */

/** The 10 professional task types used by questions_7000 and generated scenarios. */
export const TASK_TYPES = [
  'conceptual_diagnosis', 'case_decision', 'work_product', 'error_analysis', 'quant_reasoning',
  'counterfactual', 'research_synthesis', 'adversarial_test', 'teach_and_transfer', 'safety_and_governance',
] as const;
/** Bank-only task type for deterministic parametric calculations (evaluation_items numeric templates). */
export const CALCULATION = 'calculation' as const;
export const ALL_TASK_TYPES = [...TASK_TYPES, CALCULATION] as const;

export const DIFFICULTIES = ['beginner', 'intermediate', 'professional', 'expert'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export const GRADING_MODES = ['case_rubric', 'template_rubric', 'numeric'] as const;
export type GradingMode = (typeof GRADING_MODES)[number];

export const VISIBILITIES = ['public_example', 'private'] as const;
export const STATUSES = ['draft', 'review', 'active', 'retired', 'rejected'] as const;
export type Status = (typeof STATUSES)[number];

export const CALIBRATION_LEVELS = ['expert', 'competent_missed_trap', 'generic', 'confidently_wrong', 'unsafe', 'other'] as const;

export type Json = Record<string, unknown>;

/** A normalised row ready to upsert into pro_questions (canary assigned by the importer). */
export interface BankItem {
  externalId: string;
  source: string;
  domainName: string;
  domainSlug: string | null;
  subtopic: string;
  taskType: string;
  difficulty: string;
  caseMaterial: string;
  task: string;
  rubric: Json[];
  referenceSolution: string;
  redFlags: string[];
  deterministicChecks: Json[];
  variations: Json[];
  gradingMode: GradingMode;
  visibility: 'public_example' | 'private';
  /** status suggested by the importer: 'review' when clean, 'draft' / 'rejected' when validation failed */
  status: Status;
  expertReviewRequired: boolean;
  validationIssues: string[];
  license: string;
  meta: Json;
}

/** A normalised calibration answer attached to a scenario (by external id). */
export interface BankCalibration {
  scenarioExternalId: string;
  level: string;
  answer: string;
  scores: Record<string, number>;
  total: number;
  redFlagsFired: string[];
  rationale: string;
  issues: string[];
}

export interface BankTwist { domainName: string; domainSlug: string | null; twist: string; rubricEffect: string }

export interface ProofGuidanceRecord { domain: string; domainSlug: string | null; source: string; record: Json }

export const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
export const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
export const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
