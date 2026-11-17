/**
 * Rubrics for proof judging and the live skill check.
 *
 * Proof rubric = the domain guidance rubric for that proof kind (or the generic guidance rubric) when the question
 * bank provides one; otherwise a domain-agnostic professional-work rubric whose must_find checkpoints are derived
 * from the owner's claim. Live check = a guidance live_skill_check matching the proof kind, else a task generated
 * from the strongest proof item's claim.
 */
import type { RubricCheckpoint } from '../pro-judge.js';
import type { NormalisedGuidance } from './guidance.js';
import type { EvidenceKind } from './scoring.js';

const KIND_LABEL: Record<EvidenceKind, string> = {
  git_repo: 'source-code repository', website: 'website', link: 'public web page', pdf: 'PDF document', document: 'document', image: 'image',
};
export const kindLabel = (k: string) => KIND_LABEL[k as EvidenceKind] ?? 'artifact';

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Default professional-work rubric (100 points) with checkpoints derived from the claim. */
export function defaultEvidenceRubric(input: { kind: string; claim: string; title: string; domainName: string }): RubricCheckpoint[] {
  const claim = clip(input.claim.trim() || input.title, 300);
  const verification: Record<string, string> = {
    git_repo: 'Automated tests, CI configuration or other verification of correctness are present and meaningful',
    website: 'The site works as intended: content is complete, navigation and forms are usable, no obvious broken parts',
    link: 'The page content is complete, accurate and shows the work was checked',
    pdf: 'The document shows verification: sources, data, calculations or review that support its conclusions',
    document: 'The document shows verification: sources, data, calculations or review that support its conclusions',
    image: 'The image shows a finished, verifiable result',
  };
  return [
    { id: 'claim', type: 'must_find', points: 30, criterion: `The artifact actually demonstrates what the owner claims: "${claim}"`,
      evidence_of_success: 'Concrete, specific content in the artifact that matches the claim', partial_credit: 'Claim only partly supported' },
    { id: 'domain', type: 'must_find', points: 25, criterion: `The work is correct and competent for ${input.domainName} (no domain errors, sound methods)`,
      evidence_of_success: 'Correct use of domain concepts, methods and terminology' },
    { id: 'verification', type: 'quality', points: 20, criterion: verification[input.kind] ?? verification.document! },
    { id: 'production', type: 'quality', points: 15, criterion: `Production / professional quality for a ${kindLabel(input.kind)}: structure, completeness, clarity, maintainability` },
    { id: 'substance', type: 'quality', points: 10, criterion: 'Non-trivial scope: real work, not a template, placeholder, tutorial copy or boilerplate' },
  ];
}

export function evidenceRubric(input: { kind: string; claim: string; title: string; domainName: string }, guidance: NormalisedGuidance | null): { rubric: RubricCheckpoint[]; source: 'guidance' | 'default' } {
  const g = guidance?.rubricsByKind[input.kind]?.length ? guidance.rubricsByKind[input.kind]! : guidance?.rubric ?? [];
  if (g.length) {
    // Always keep the claim checkpoint so the judge checks the specific claim, not just generic domain quality.
    const claimCp = defaultEvidenceRubric(input)[0]!;
    return { rubric: [claimCp, ...g.filter((c) => c.id !== 'claim')], source: 'guidance' };
  }
  return { rubric: defaultEvidenceRubric(input), source: 'default' };
}

export interface ProofItemForLiveCheck { id: string; kind: string; title: string; claim: string; qualityScore: number | null }

const LIVE_TEMPLATES: Record<string, (claim: string, title: string, domain: string) => string> = {
  git_repo: (claim, title, domain) =>
    `Your owner submitted the repository "${title}" as proof that you can do this work: "${claim}".\n` +
    'Show that you can do this kind of work yourself, now, without access to that repository:\n' +
    '1. Pick one small but realistic feature or fix that would naturally belong in such a project (state it in one sentence).\n' +
    '2. Write the complete code for it (one or two files), with input validation and error handling.\n' +
    '3. Write at least one automated test for it.\n' +
    `4. In at most 150 words, explain your design choices and how you verified correctness (${domain}).`,
  website: (claim, title, domain) =>
    `Your owner submitted the website "${title}" as proof that you can do this work: "${claim}".\n` +
    'Show that you can do this kind of work yourself, now:\n' +
    '1. Write the complete HTML (and minimal CSS/JS if needed) for one new page or section such a site would need (state which).\n' +
    '2. Make it accessible (lang attribute, headings in order, labelled form fields, alt text) and responsive.\n' +
    `3. In at most 150 words, explain the choices you made and how you would test it (${domain}).`,
  link: (claim, title, domain) =>
    `Your owner submitted "${title}" as proof that you can do this work: "${claim}".\n` +
    `Produce a new, short piece of the same kind of work on a different but comparable topic (${domain}), then explain in at most 100 words how you checked it is correct.`,
  pdf: (claim, title, domain) =>
    `Your owner submitted the document "${title}" as proof that you can do this work: "${claim}".\n` +
    `Produce a short deliverable of the same type on a NEW comparable case you choose (${domain}): state the case in one sentence, then deliver the work ` +
    '(max ~600 words) with the structure, method and checks a professional would include. End with the main assumptions and limitations.',
  document: (claim, title, domain) =>
    `Your owner submitted the document "${title}" as proof that you can do this work: "${claim}".\n` +
    `Produce a short deliverable of the same type on a NEW comparable case you choose (${domain}): state the case in one sentence, then deliver the work ` +
    '(max ~600 words) with the structure, method and checks a professional would include. End with the main assumptions and limitations.',
  image: (claim, title, domain) =>
    `Your owner submitted the image "${title}" as proof that you can do this work: "${claim}".\n` +
    `Describe precisely, step by step, how you would produce an equivalent result for a new comparable brief (${domain}), and produce every text-based part ` +
    '(specification, code, copy, data or design tokens) in full.',
};

export function liveCheckRubric(domainName: string, claim: string): RubricCheckpoint[] {
  return [
    { id: 'task', type: 'must_find', points: 35, criterion: 'Completes every step the task asks for with a concrete, complete deliverable (not a plan or outline)' },
    { id: 'domain', type: 'must_find', points: 25, criterion: `Correct and competent for ${domainName}; the same kind of skill as the claimed work: "${clip(claim, 200)}"` },
    { id: 'verification', type: 'quality', points: 20, criterion: 'Includes verification: tests, checks, validation or a clear explanation of how correctness was confirmed' },
    { id: 'quality', type: 'quality', points: 20, criterion: 'Professional quality: clear, well-structured, handles edge cases, states assumptions' },
  ];
}

/** Build the live check task: guidance first (matching kind preferred), else generated from the strongest proof item. */
export function buildLiveCheck(items: ProofItemForLiveCheck[], domainName: string, guidance: NormalisedGuidance | null): {
  task: string; rubric: RubricCheckpoint[]; source: 'guidance' | 'generated'; basedOn: string | null; referenceSolution?: string; redFlags?: string[];
} {
  const sorted = [...items].sort((a, b) => (b.qualityScore ?? -1) - (a.qualityScore ?? -1));
  const top = sorted[0] ?? null;
  const guides = guidance?.liveSkillChecks ?? [];
  if (guides.length) {
    const g = guides.find((x) => top && x.kind === top.kind) ?? guides[0]!;
    const context = top ? `\n\nContext: your owner's proof claims: "${clip(top.claim || top.title, 300)}".` : '';
    return {
      task: g.task + context, rubric: g.rubric.length ? g.rubric : liveCheckRubric(domainName, top?.claim ?? ''),
      source: 'guidance', basedOn: top?.id ?? null, referenceSolution: g.referenceSolution, redFlags: g.redFlags,
    };
  }
  const kind = top?.kind ?? 'document';
  const claim = clip((top?.claim || top?.title || 'professional work in this domain').trim(), 400);
  const title = clip(top?.title ?? 'your proof', 120);
  const tmpl = LIVE_TEMPLATES[kind] ?? LIVE_TEMPLATES.document!;
  return { task: tmpl(claim, title, domainName), rubric: liveCheckRubric(domainName, claim), source: 'generated', basedOn: top?.id ?? null };
}
