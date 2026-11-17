/**
 * @aix/shared — constants and types shared by the API and the web app.
 * Single source of truth for roles, permissions, domains, scoring, thresholds.
 */

/* ───────────── Roles & permissions (RBAC) ───────────── */

export const PLATFORM_ROLES = ['user', 'admin', 'super_admin'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const ORG_ROLES = ['owner', 'admin', 'developer', 'trainer', 'member', 'viewer'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const PERSONAS = ['individual', 'agent_owner', 'developer', 'trainer', 'enterprise'] as const;
export type Persona = (typeof PERSONAS)[number];

export const PERMISSIONS = [
  'org.read', 'org.manage', 'org.members.manage',
  'agents.read', 'agents.create', 'agents.update', 'agents.delete', 'agents.connect',
  'assessments.run', 'assessments.read',
  'training.request', 'training.respond', 'training.participate', 'training.read',
  'knowledge.read', 'knowledge.write', 'knowledge.publish',
  'marketplace.publish',
  'wallet.read', 'wallet.purchase', 'wallet.payout',
  'developer.keys.manage', 'developer.webhooks.manage', 'developer.logs.read',
  'analytics.read', 'audit.read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL = [...PERMISSIONS];
const READ: Permission[] = ['org.read', 'agents.read', 'assessments.read', 'training.read', 'knowledge.read', 'wallet.read', 'analytics.read'];

export const ROLE_PERMISSIONS: Record<OrgRole, Permission[]> = {
  owner: ALL,
  admin: ALL.filter((p) => p !== 'wallet.payout'),
  developer: [...READ, 'agents.create', 'agents.update', 'agents.connect', 'assessments.run', 'training.request', 'training.participate',
    'knowledge.write', 'developer.keys.manage', 'developer.webhooks.manage', 'developer.logs.read'],
  trainer: [...READ, 'agents.create', 'agents.update', 'agents.connect', 'assessments.run', 'training.respond', 'training.participate',
    'training.request', 'knowledge.write', 'knowledge.publish', 'marketplace.publish'],
  member: [...READ, 'training.request', 'training.participate', 'assessments.run', 'knowledge.write'],
  viewer: READ,
};

export function roleHas(role: OrgRole, perm: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(perm) ?? false;
}

/* ───────────── Capability domains ───────────── */

export const SCORING_DIMENSIONS = ['correctness', 'reasoning', 'practical', 'reliability', 'uncertainty'] as const;
export type ScoringDimension = (typeof SCORING_DIMENSIONS)[number];

export const DEFAULT_WEIGHTS: Record<ScoringDimension, number> = {
  correctness: 0.35, reasoning: 0.2, practical: 0.2, reliability: 0.15, uncertainty: 0.1,
};

export interface DomainDef {
  slug: string; name: string; icon: string; highImpact?: boolean;
  weights?: Partial<Record<ScoringDimension, number>>; skills: string[];
}

export const DOMAINS: DomainDef[] = [
  { slug: 'programming', name: 'Programming & Software Development', icon: 'code', skills: ['algorithms', 'debugging', 'code-review', 'apis'], weights: { practical: 0.3, reasoning: 0.15, correctness: 0.3 } },
  { slug: 'ai-ml', name: 'Artificial Intelligence & Machine Learning', icon: 'brain', skills: ['ml-fundamentals', 'deep-learning', 'evaluation', 'llms'] },
  { slug: 'mathematics', name: 'Mathematics & Logical Reasoning', icon: 'sigma', skills: ['arithmetic', 'algebra', 'probability', 'logic'], weights: { correctness: 0.45, reasoning: 0.25, practical: 0.1 } },
  { slug: 'data-science', name: 'Data Science & Analytics', icon: 'chart', skills: ['statistics', 'sql', 'visualisation', 'experimentation'] },
  { slug: 'finance', name: 'Financial Analysis', icon: 'landmark', highImpact: true, skills: ['accounting', 'valuation', 'tax', 'ratios'] },
  { slug: 'trading', name: 'Trading & Market Research', icon: 'candlestick', highImpact: true, skills: ['market-structure', 'risk', 'instruments'] },
  { slug: 'business-strategy', name: 'Business Strategy', icon: 'compass', skills: ['frameworks', 'unit-economics', 'competition'] },
  { slug: 'marketing', name: 'Marketing & Advertising', icon: 'megaphone', skills: ['funnels', 'metrics', 'positioning'] },
  { slug: 'sales-support', name: 'Sales & Customer Support', icon: 'headset', skills: ['objection-handling', 'support-ops', 'crm'] },
  { slug: 'content', name: 'Content Creation & Copywriting', icon: 'pen', skills: ['grammar', 'style', 'structure'] },
  { slug: 'research', name: 'Research & Information Retrieval', icon: 'search', skills: ['source-evaluation', 'citation', 'synthesis'], weights: { uncertainty: 0.2, correctness: 0.3, practical: 0.15 } },
  { slug: 'education', name: 'Education & Tutoring', icon: 'graduation', skills: ['pedagogy', 'assessment-design', 'explanation'] },
  { slug: 'science-engineering', name: 'Science & Engineering', icon: 'atom', skills: ['physics', 'chemistry', 'units'] },
  { slug: 'healthcare', name: 'Healthcare Knowledge & Research', icon: 'heart-pulse', highImpact: true, skills: ['physiology', 'research-methods', 'safety'], weights: { correctness: 0.35, uncertainty: 0.2, practical: 0.1 } },
  { slug: 'legal-compliance', name: 'Legal Information & Compliance', icon: 'scale', highImpact: true, skills: ['contracts', 'data-protection', 'compliance'], weights: { uncertainty: 0.2, practical: 0.1 } },
  { slug: 'cybersecurity', name: 'Cybersecurity & Technology', icon: 'shield', skills: ['web-security', 'crypto', 'network'] },
  { slug: 'design', name: 'Design & Creative Work', icon: 'palette', skills: ['ux', 'visual', 'accessibility'] },
  { slug: 'automation', name: 'Automation & Workflow Management', icon: 'workflow', skills: ['orchestration', 'scheduling', 'integration'] },
  { slug: 'robotics-iot', name: 'Robotics & IoT', icon: 'cpu', skills: ['sensors', 'protocols', 'control'] },
  { slug: 'general', name: 'General Knowledge & Communication', icon: 'globe', skills: ['geography', 'history', 'communication'] },
];

export function domainWeights(d: DomainDef): Record<ScoringDimension, number> {
  const w = { ...DEFAULT_WEIGHTS, ...(d.weights ?? {}) };
  const sum = Object.values(w).reduce((a, b) => a + b, 0);
  return Object.fromEntries(Object.entries(w).map(([k, v]) => [k, Math.round((v / sum) * 1000) / 1000])) as Record<ScoringDimension, number>;
}

export const QUESTION_KINDS = ['factual', 'reasoning', 'practical', 'consistency', 'instruction', 'tool', 'uncertainty', 'hallucination', 'safety'] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

export const DIFFICULTIES = ['easy', 'intermediate', 'advanced'] as const;

/* ───────────── Quality thresholds ───────────── */

export const QUALITY = {
  /** strategic accuracy target for well-defined benchmark tasks */
  ACCURACY_TARGET: 95,
  /** min graded responses in a domain before a "verified" badge is shown */
  MIN_SAMPLE_FOR_VERIFIED: 20,
  /** min statistical confidence (0..1) for verified badge */
  MIN_CONFIDENCE_FOR_VERIFIED: 0.8,
  /** min sample before "meets 95% target" claim may be displayed */
  MIN_SAMPLE_FOR_TARGET_CLAIM: 40,
  /** days until retention reassessment after training */
  RETENTION_DELAY_DAYS: 7,
} as const;

/* ───────────── Learning types (must be stored separately) ───────────── */

export const LEARNING_TYPES = ['temporary_context', 'persistent_memory', 'knowledge_retrieval', 'instruction_update', 'fine_tuning'] as const;
export type LearningType = (typeof LEARNING_TYPES)[number];
export const LEARNING_TYPE_LABELS: Record<LearningType, string> = {
  temporary_context: 'Temporary context',
  persistent_memory: 'Persistent memory',
  knowledge_retrieval: 'Knowledge retrieval (RAG)',
  instruction_update: 'Updated instructions',
  fine_tuning: 'Model fine-tuning',
};

export const TRAINING_STAGES = ['introduction', 'knowledge_sharing', 'practical_exercises', 'evaluation', 'completion'] as const;
export type TrainingStage = (typeof TRAINING_STAGES)[number];

/* ───────────── Reputation ───────────── */

export const REPUTATION_LEVELS = [
  { slug: 'new_contributor', name: 'New Contributor', min: 0 },
  { slug: 'verified_agent', name: 'Verified Agent', min: 20 },
  { slug: 'skilled_trainer', name: 'Skilled Trainer', min: 40 },
  { slug: 'expert_trainer', name: 'Expert Trainer', min: 60 },
  { slug: 'elite_contributor', name: 'Elite Contributor', min: 75 },
  { slug: 'top_performer', name: 'StringMind Top Performer', min: 90 },
] as const;

/* ───────────── Finance ───────────── */

/*
 * StringMind is a pure token economy (docs/IDLE_TOKENS.md): rewards are IDLE Tokens, never money.
 * IDLE cannot be bought or withdrawn; every account receives WELCOME_BONUS_IDLE once on first login.
 */
export const TOKEN_SYMBOL = 'IDLE';
export const TOKEN_NAME = 'IDLE Tokens';
export const WELCOME_BONUS_IDLE = 1000;
/** Platform commission on training / knowledge sales, in basis points of the IDLE price. */
export const DEFAULT_COMMISSION_BPS = 2000;
export const CREDIT_CURRENCY = 'IDLE';
/** @deprecated Fiat payouts are disabled (IDLE cannot be withdrawn). Kept only for the dormant FIAT_ENABLED code path. */
export const MIN_PAYOUT_CREDITS = 500;

/* ───────────── Notifications ───────────── */

export const NOTIFICATION_TYPES = [
  'training_request', 'training_accepted', 'training_declined', 'session_reminder', 'training_completed',
  'evaluation_result', 'payment_update', 'payout_update', 'new_review', 'security_alert', 'agent_connection_failure',
  'dispute_update', 'system',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/* ───────────── Providers ───────────── */

export const PROVIDERS = [
  { slug: 'sandbox', name: 'StringMind Sandbox Agent', adapter: 'sandbox', baseUrl: null, models: ['aix-sandbox-1'] },
  { slug: 'xai', name: 'xAI Grok', adapter: 'openai_compatible', baseUrl: 'https://api.x.ai/v1', models: ['grok-4', 'grok-3', 'grok-3-mini'] },
  { slug: 'openai', name: 'OpenAI', adapter: 'openai_compatible', baseUrl: 'https://api.openai.com/v1', models: ['gpt-5', 'gpt-4.1', 'gpt-4o-mini'] },
  { slug: 'anthropic', name: 'Anthropic Claude', adapter: 'anthropic', baseUrl: 'https://api.anthropic.com', models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] },
  { slug: 'gemini', name: 'Google Gemini', adapter: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', models: ['gemini-2.5-pro', 'gemini-2.5-flash'] },
  { slug: 'mistral', name: 'Mistral', adapter: 'openai_compatible', baseUrl: 'https://api.mistral.ai/v1', models: ['mistral-large-latest', 'mistral-small-latest'] },
  { slug: 'deepseek', name: 'DeepSeek', adapter: 'openai_compatible', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { slug: 'meta-llama', name: 'Meta Llama (OpenAI-compatible host)', adapter: 'openai_compatible', baseUrl: 'http://localhost:11434/v1', models: ['llama3.3', 'llama4'] },
  { slug: 'custom-rest', name: 'Custom REST Agent', adapter: 'custom_rest', baseUrl: null, models: ['custom'] },
  { slug: 'webhook', name: 'Webhook Agent', adapter: 'webhook', baseUrl: null, models: ['custom'] },
  { slug: 'a2a', name: 'A2A-compatible Agent', adapter: 'a2a', baseUrl: null, models: ['custom'] },
  { slug: 'mcp', name: 'MCP Tool Server', adapter: 'mcp', baseUrl: null, models: ['custom'] },
] as const;

/* ───────────── API envelope types ───────────── */

export interface ApiError { error: { code: string; message: string; details?: unknown } }
export interface Paginated<T> { items: T[]; total: number; page: number; pageSize: number }
