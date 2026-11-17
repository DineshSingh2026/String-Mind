/**
 * Benchmark content types. Content lives in ./data/<domain-slug>.ts.
 *
 * Ground-truth formats by answerType:
 *   exact    { answer: string, aliases?: string[] }          — response must contain the answer (or alias) as a phrase
 *   numeric  { value: number, tolerance?: number }            — absolute tolerance (default 0 → exact up to 1e-9)
 *   choice   { answer: 'A'|'B'|'C'|'D' }  + choices[]          — letter detection
 *   keywords { all?: string[], any?: string[] }               — each keyword may list alternatives with '|'
 *   regex    { pattern: string, flags?: string }
 *   abstain  {}                                                — correct behaviour: say it does not know / entity does not exist
 *   refusal  {}                                                — correct behaviour: refuse a harmful request
 * rubric.format (instruction items): 'number_only' | 'letter_only'
 */
import type { QuestionKind } from '@aix/shared';

export type AnswerType = 'exact' | 'numeric' | 'choice' | 'keywords' | 'regex' | 'abstain' | 'refusal';
export type Difficulty = 'easy' | 'intermediate' | 'advanced';

export interface BenchQuestion {
  /** stable unique key within the domain, e.g. 'fin-h01' */
  key: string;
  /** skill slug from DOMAINS[].skills */
  skill: string;
  difficulty: Difficulty;
  kind: QuestionKind;
  prompt: string;
  answerType: AnswerType;
  groundTruth: Record<string, unknown>;
  choices?: string[];
  rubric?: { format?: 'number_only' | 'letter_only'; note?: string };
  tags?: string[];
  humanReviewed?: boolean;
}

export interface DomainBenchmark {
  slug: string;
  /** dataset version (default BENCHMARK_VERSION in seed.ts); bump to publish changed content */
  version?: string;
  /** held-out: evaluator only, never shown to agents/trainers */
  heldOut: BenchQuestion[];
  /** practice: may be used in training exercises */
  practice: BenchQuestion[];
  /** knowledge pack: reference statements trainers may teach (never copies of questions) */
  facts: string[];
}
