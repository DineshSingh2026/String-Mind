/**
 * Renders the exact prompt an agent receives for a professional exam item:
 *   case material + task + (optional) twist + a fixed instruction block.
 * NEVER includes the rubric, red flags/traps, reference solution, deterministic check specs or the canary
 * (the canary is metadata only). Template placeholders for self-reported profile data ({experience_years},
 * {specialization}, {agent_evidence}) are replaced with neutral text: the exam adapts to performance only.
 */
export const INSTRUCTION_BLOCK = [
  '--- Hive Mind Professional Exam: instructions ---',
  'Answer as a senior practitioner would in real work. Show your reasoning briefly, state the assumptions you make,',
  'say plainly what you are unsure of or what information is missing, and flag any safety, legal or ethical risk.',
  'If the task asks for a number, end with a line "Final answer: <value>". Do not ask clarifying questions: make',
  'reasonable, stated assumptions instead. Your answer is graded by an independent examiner.',
].join('\n');

const NEUTRAL: Record<string, string> = {
  experience_years: 'an unstated number of',
  specialization: 'an unstated specialization',
  agent_evidence: 'no verified evidence',
};

export function neutraliseTemplate(text: string): string {
  return text.replace(/\{(experience_years|specialization|agent_evidence)\}/g, (_, k: string) => NEUTRAL[k] ?? '');
}

export function renderPrompt(q: { caseMaterial: string; task: string }, twist: string | null): string {
  const parts = [
    q.caseMaterial.trim() ? `Case material:\n${neutraliseTemplate(q.caseMaterial.trim())}` : '',
    `Task:\n${neutraliseTemplate(q.task.trim())}`,
    twist?.trim() ? `Additional complication (take it into account):\n${twist.trim()}` : '',
    INSTRUCTION_BLOCK,
  ];
  return parts.filter(Boolean).join('\n\n');
}

/** Text of a question-level variation entry ({ twist, rubric_changes } or a plain string). */
export function variationText(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (v && typeof v === 'object') {
    const t = (v as Record<string, unknown>).twist;
    return typeof t === 'string' && t.trim() ? t.trim() : null;
  }
  return null;
}

/** Rubric guidance for a twist (only ever shown to the judge, never the agent). */
export function variationRubricNote(v: unknown): string | null {
  if (v && typeof v === 'object') {
    const r = (v as Record<string, unknown>).rubric_changes ?? (v as Record<string, unknown>).rubricEffect;
    if (typeof r === 'string' && r.trim()) return r.trim();
    if (Array.isArray(r)) return r.map(String).join('; ') || null;
  }
  return null;
}
