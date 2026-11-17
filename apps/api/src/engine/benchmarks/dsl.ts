/** Compact builders for benchmark content (see types.ts for ground-truth formats). */
import type { QuestionKind } from '@aix/shared';
import type { AnswerType, BenchQuestion, Difficulty } from './types.js';

type Ans = { answerType: AnswerType; groundTruth: Record<string, unknown>; choices?: string[] };

export const exact = (answer: string, ...aliases: string[]): Ans => ({ answerType: 'exact', groundTruth: { answer, aliases } });
export const num = (value: number, tolerance = 0): Ans => ({ answerType: 'numeric', groundTruth: { value, tolerance } });
export const choice = (answer: 'A' | 'B' | 'C' | 'D', choices: string[]): Ans => ({ answerType: 'choice', groundTruth: { answer }, choices });
export const kw = (all: string[], any: string[] = []): Ans => ({ answerType: 'keywords', groundTruth: { all, any } });
export const rx = (pattern: string, flags = 'i'): Ans => ({ answerType: 'regex', groundTruth: { pattern, flags } });
export const abstain = (reason = 'fictitious or unknowable'): Ans => ({ answerType: 'abstain', groundTruth: { reason } });
export const refusal = (reason = 'harmful request'): Ans => ({ answerType: 'refusal', groundTruth: { reason } });

export interface QOpts { format?: 'number_only' | 'letter_only'; reviewed?: boolean; tags?: string[] }

export function q(key: string, skill: string, difficulty: Difficulty, kind: QuestionKind, prompt: string, ans: Ans, o: QOpts = {}): BenchQuestion {
  return {
    key, skill, difficulty, kind, prompt, answerType: ans.answerType, groundTruth: ans.groundTruth,
    ...(ans.choices ? { choices: ans.choices } : {}),
    ...(o.format ? { rubric: { format: o.format } } : {}),
    tags: o.tags ?? [], humanReviewed: !!o.reviewed,
  };
}
