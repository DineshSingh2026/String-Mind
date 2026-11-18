/**
 * Grading a replay answer against what actually worked in the past.
 *
 * Deterministic "decision match" (always available, free, reproducible):
 *   recall  — share of the reference's distinctive terms (terms of what worked / the lesson that are NOT already in
 *             the situation text, so restating the question earns nothing) that the answer contains
 *   cosine  — semantic overlap of answer and reference (local hash embedding)
 *   match   = 0.6 × recall + 0.4 × rescaled cosine
 *   repeated mistake — for a failed case, an answer closer to the recorded (failed) decision than to the lesson
 *             is halved
 *   grounded — +0.1 when the answer cites one of the agent's own past cases that was given to it as context
 *
 * Optional LLM judge (only when an evaluator model is configured — EVALUATOR_PROVIDER / EVALUATOR_API_KEY): the
 * judge scores the same rubric; the final score is the mean of the judge and the deterministic match, and the
 * method says so. Without a judge nothing is guessed: the deterministic score is the score.
 */
import { cosine, embed, tokenize } from '../embeddings.js';
import { isContent } from '../hive-judge/text.js';
import { judgeConfig, legacyLlmJudge } from '../pro-judge.js';

export const REPLAY_EVALUATOR = 'hive-replay-v1';

export interface ReplayGradeInput {
  situation: string;
  answer: string;
  /** what worked (success) or the lesson (failure) */
  expected: string;
  /** recorded decision of a failed case */
  avoid?: string;
  /** context indices [n] that were the subject's own past cases */
  experienceRefs?: number[];
  domain?: string;
}

export interface ReplayGrade {
  score: number; method: string; recall: number; cosine: number; repeatedMistake: boolean; grounded: boolean;
  judgeScore?: number | null; abstained?: boolean; matchedTerms: string[]; missedTerms: string[];
}

const ABSTAIN = /\b(i don'?t know|not sure what|cannot (?:decide|answer)|no (?:relevant )?experience)\b/i;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

function distinctiveTerms(expected: string, situation: string): string[] {
  const sit = new Set(tokenize(situation));
  const out: string[] = [];
  for (const t of tokenize(expected)) if (isContent(t) && !sit.has(t) && !out.includes(t)) out.push(t);
  return out.slice(0, 30);
}

export function gradeReplayDeterministic(input: ReplayGradeInput): ReplayGrade {
  const answer = input.answer ?? '';
  const ansTokens = new Set(tokenize(answer));
  if (!answer.trim()) return { score: 0, method: 'deterministic', recall: 0, cosine: 0, repeatedMistake: false, grounded: false, abstained: true, matchedTerms: [], missedTerms: [] };
  let terms = distinctiveTerms(input.expected, input.situation);
  if (terms.length < 3) terms = [...new Set(tokenize(input.expected).filter(isContent))].slice(0, 30);
  const matched = terms.filter((t) => ansTokens.has(t));
  const recall = terms.length ? matched.length / terms.length : 0;
  const ae = embed(answer);
  const cos = Math.max(0, cosine(ae, embed(input.expected)));
  const cosScaled = Math.max(0, Math.min(1, (cos - 0.05) / 0.45));
  let score = 0.6 * recall + 0.4 * cosScaled;

  let repeatedMistake = false;
  if (input.avoid?.trim()) {
    const toAvoid = Math.max(0, cosine(ae, embed(input.avoid)));
    if (toAvoid > cos + 0.08) { repeatedMistake = true; score *= 0.5; }
  }
  const refs = new Set(input.experienceRefs ?? []);
  const cited = [...answer.matchAll(/\[(\d{1,2})\]/g)].map((m) => Number(m[1]));
  const grounded = cited.some((n) => refs.has(n));
  if (grounded) score += 0.1;
  const abstained = ABSTAIN.test(answer) && answer.length < 300;
  if (abstained) score = Math.min(score, 0.1);
  return {
    score: r3(Math.max(0, Math.min(1, score))), method: 'deterministic', recall: r3(recall), cosine: r3(cos), repeatedMistake, grounded, abstained,
    matchedTerms: matched.slice(0, 15), missedTerms: terms.filter((t) => !ansTokens.has(t)).slice(0, 15),
  };
}

/** An external LLM judge is configured (not the local Hive Judge, which is trained for exam rubrics). */
export function replayJudgeConfigured(): boolean {
  return judgeConfig() !== null;
}

export async function gradeReplay(input: ReplayGradeInput): Promise<ReplayGrade> {
  const det = gradeReplayDeterministic(input);
  if (!replayJudgeConfigured() || det.abstained) return det;
  try {
    const j = await legacyLlmJudge({
      domain: input.domain ?? 'general',
      task: `A real past situation was replayed to an agent. Situation:\n${input.situation}\n\nThe agent was asked what it would decide and why.`,
      rubric: [
        { id: 'decision', criterion: 'Reaches essentially the same decision as the reference (what actually worked, or the lesson learned).', points: 60 },
        { id: 'reasoning', criterion: 'Its reasoning is consistent with the reference and the real outcome.', points: 25 },
        { id: 'mistake', criterion: input.avoid ? `Does not repeat the recorded mistake: ${input.avoid}` : 'The decision is concrete and actionable, not generic advice.', points: 15 },
      ],
      referenceSolution: input.expected,
      answer: input.answer,
    });
    if (j.status !== 'done') return det;
    const judgeScore = Math.max(0, Math.min(1, j.total / 100));
    return { ...det, judgeScore: r3(judgeScore), score: r3((judgeScore + det.score) / 2), method: `deterministic+llm_judge:${j.model ?? 'judge'}` };
  } catch {
    return det;
  }
}
