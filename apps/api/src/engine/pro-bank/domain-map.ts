/**
 * Maps a source domain name to its platform domain slug. Since the owner's decision, all 70 knowledge-library
 * domains are native platform domains (DOMAINS in @aix/shared, slug = kebab-case of the name; the original 20 keep
 * their slugs). mapDomainToSlug() therefore returns the domain's OWN slug (exact name match, plus a small alias table
 * for spelling variants) and null only for names not in DOMAINS.
 * OWNED BY the Question bank feature — keep the signature.
 *
 * NEAREST_QUICK keeps, for information, the nearest of the original 20 quick-assessment domains for each of the 70,
 * with an honest fit label (exact | close | broad). It is NOT used for routing questions.
 */
import { DOMAINS } from '@aix/shared';

export type DomainFit = 'exact' | 'close' | 'broad';
export interface DomainMapping { name: string; slug: string | null; nearestQuickSlug: string | null; nearestQuickFit: DomainFit | null }

const NEAREST_QUICK: readonly [string, string, DomainFit][] = [
  ['Accessibility & Assistive Technology', 'design', 'close'],
  ['Accounting & Audit', 'finance', 'close'],
  ['Aerospace & Aviation', 'science-engineering', 'close'],
  ['Agriculture & Agronomy', 'science-engineering', 'broad'],
  ['Architecture & Building Science', 'science-engineering', 'close'],
  ['Art History & Music Theory', 'design', 'broad'],
  ['Artificial Intelligence & Machine Learning', 'ai-ml', 'exact'],
  ['Automation & Workflow Management', 'automation', 'exact'],
  ['Biotechnology & Genomics', 'science-engineering', 'close'],
  ['Business Strategy', 'business-strategy', 'exact'],
  ['Climate & Environmental Science', 'science-engineering', 'close'],
  ['Content Creation & Copywriting', 'content', 'exact'],
  ['Cybersecurity & Technology', 'cybersecurity', 'exact'],
  ['Data Science & Analytics', 'data-science', 'exact'],
  ['Design & Creative Work', 'design', 'exact'],
  ['Digital Forensics & Incident Response', 'cybersecurity', 'close'],
  ['Distributed Systems & Blockchain', 'programming', 'close'],
  ['E-commerce & Retail', 'business-strategy', 'broad'],
  ['Econometrics & Forecasting', 'data-science', 'close'],
  ['Economics & Public Policy', 'business-strategy', 'broad'],
  ['Education & Tutoring', 'education', 'exact'],
  ['Energy & Power Systems', 'science-engineering', 'close'],
  ['Financial Analysis', 'finance', 'exact'],
  ['Food Science & Nutrition', 'healthcare', 'broad'],
  ['Game Development & Simulation', 'programming', 'close'],
  ['General Knowledge & Communication', 'general', 'exact'],
  ['Geography & GIS', 'science-engineering', 'broad'],
  ['Geology & Earth Science', 'science-engineering', 'close'],
  ['Geospatial Remote Sensing', 'science-engineering', 'close'],
  ['Healthcare Knowledge & Research', 'healthcare', 'exact'],
  ['History & Archaeology', 'general', 'broad'],
  ['Hospitality & Tourism', 'business-strategy', 'broad'],
  ['Human Resources & Talent', 'business-strategy', 'broad'],
  ['Insurance & Actuarial Science', 'finance', 'close'],
  ['Journalism & Media Literacy', 'content', 'close'],
  ['Languages & Literature', 'content', 'broad'],
  ['Legal Information & Compliance', 'legal-compliance', 'exact'],
  ['Library & Archival Science', 'research', 'close'],
  ['Linguistics & Translation', 'content', 'broad'],
  ['Manufacturing & Industrial Engineering', 'science-engineering', 'close'],
  ['Maritime & Navigation', 'science-engineering', 'broad'],
  ['Marketing & Advertising', 'marketing', 'exact'],
  ['Materials Science', 'science-engineering', 'close'],
  ['Mathematics & Logical Reasoning', 'mathematics', 'exact'],
  ['Negotiation & Conflict Resolution', 'general', 'broad'],
  ['Nonprofit & Social Impact', 'business-strategy', 'broad'],
  ['Operations Research & Optimization', 'mathematics', 'close'],
  ['Philosophy & Ethics', 'general', 'broad'],
  ['Politics & Governance', 'general', 'broad'],
  ['Privacy Engineering & AI Governance', 'legal-compliance', 'close'],
  ['Product Management & Entrepreneurship', 'business-strategy', 'close'],
  ['Programming & Software Development', 'programming', 'exact'],
  ['Project & Program Management', 'business-strategy', 'broad'],
  ['Psychology & Behavioral Science', 'healthcare', 'broad'],
  ['Public Health & Epidemiology', 'healthcare', 'close'],
  ['Real Estate & Urban Planning', 'business-strategy', 'broad'],
  ['Research & Information Retrieval', 'research', 'exact'],
  ['Robotics & IoT', 'robotics-iot', 'exact'],
  ['Sales & Customer Support', 'sales-support', 'exact'],
  ['Science & Engineering', 'science-engineering', 'exact'],
  ['Sociology & Anthropology', 'general', 'broad'],
  ['Space Science & Astronomy', 'science-engineering', 'close'],
  ['Sports Science & Coaching', 'healthcare', 'broad'],
  ['Statistics & Causal Inference', 'data-science', 'close'],
  ['Supply Chain & Logistics', 'business-strategy', 'broad'],
  ['Taxation & Payroll', 'finance', 'close'],
  ['Telecommunications & Networks', 'cybersecurity', 'broad'],
  ['Trading & Market Research', 'trading', 'exact'],
  ['Transportation & Mobility', 'science-engineering', 'broad'],
  ['Veterinary Science & Animal Care', 'healthcare', 'broad'],
];

const norm = (s: string) => s.toLowerCase().replace(/\band\b/g, '&').replace(/[^a-z0-9&]+/g, ' ').trim();

/** Spelling variants seen (or likely) in source files → canonical DOMAINS name. */
export const DOMAIN_ALIASES: Record<string, string> = {
  'AI & Machine Learning': 'Artificial Intelligence & Machine Learning',
  'Artificial Intelligence and ML': 'Artificial Intelligence & Machine Learning',
  'Ecommerce & Retail': 'E-commerce & Retail',
  'E-Commerce & Retail': 'E-commerce & Retail',
  'Cybersecurity': 'Cybersecurity & Technology',
  'Healthcare': 'Healthcare Knowledge & Research',
  'Legal & Compliance': 'Legal Information & Compliance',
  'Finance': 'Financial Analysis',
  'Programming': 'Programming & Software Development',
  'Software Development': 'Programming & Software Development',
  'Geography & Geographic Information Systems': 'Geography & GIS',
  'Remote Sensing': 'Geospatial Remote Sensing',
  'Internet of Things & Robotics': 'Robotics & IoT',
  'Statistics & Causal Analysis': 'Statistics & Causal Inference',
  'Privacy & AI Governance': 'Privacy Engineering & AI Governance',
};

const nearest = new Map(NEAREST_QUICK.map(([n, slug, fit]) => [norm(n), { slug, fit }]));
const INDEX = new Map<string, DomainMapping>();
for (const d of DOMAINS) {
  const near = nearest.get(norm(d.name));
  const m: DomainMapping = { name: d.name, slug: d.slug, nearestQuickSlug: near?.slug ?? (d.quickAssessment === false ? null : d.slug), nearestQuickFit: near?.fit ?? (d.quickAssessment === false ? null : 'exact') };
  INDEX.set(norm(d.name), m);
  INDEX.set(norm(d.slug), m);
}
for (const [alias, canonical] of Object.entries(DOMAIN_ALIASES)) {
  const m = INDEX.get(norm(canonical));
  if (m && !INDEX.has(norm(alias))) INDEX.set(norm(alias), m);
}

/** Every platform domain with its nearest quick-assessment domain (for information / reporting). */
export const DOMAIN_TABLE: readonly DomainMapping[] = DOMAINS.map((d) => INDEX.get(norm(d.name))!);

/** Full mapping entry (null when the name is not a platform domain or known alias). */
export function lookupDomain(domainName: string): DomainMapping | null {
  return INDEX.get(norm(domainName ?? '')) ?? null;
}

export function mapDomainToSlug(domainName: string): string | null {
  return lookupDomain(domainName)?.slug ?? null;
}
