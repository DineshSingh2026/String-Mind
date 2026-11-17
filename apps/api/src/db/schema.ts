/**
 * StringMind database schema (PostgreSQL + pgvector).
 *
 * Conventions
 * - All ids are UUIDs (gen_random_uuid()).
 * - Money/credits are integers (bigint-safe numbers). 1 credit = 1 INR in the sandbox price list.
 * - Rates are basis points (bps): 2000 = 20%.
 * - Scores are 0..100 stored as real.
 * - Tenant data carries org_id. Every query on tenant data MUST filter by org_id
 *   (see lib/tenancy.ts) unless the row is explicitly public (marketplace).
 * - ledger_entries and audit_logs are append-only (enforced by DB triggers in db/bootstrap.ts).
 */
import {
  pgTable, uuid, text, timestamp, integer, boolean, jsonb, real, bigint,
  uniqueIndex, index, primaryKey, customType,
} from 'drizzle-orm/pg-core';

export const EMBEDDING_DIMS = 256;

const vector = customType<{ data: number[]; driverData: string }>({
  dataType() { return `vector(${EMBEDDING_DIMS})`; },
  toDriver(value) { return `[${value.join(',')}]`; },
  fromDriver(value) {
    return String(value).replace(/[[\]]/g, '').split(',').filter(Boolean).map(Number);
  },
});

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
const credits = (name: string) => bigint(name, { mode: 'number' });

/* ───────────────────────────── Identity & tenancy ───────────────────────────── */

export const users = pgTable('users', {
  id: id(),
  email: text('email').notNull(),
  passwordHash: text('password_hash').notNull(),
  name: text('name').notNull(),
  avatarUrl: text('avatar_url'),
  /** 'user' | 'admin' | 'super_admin' — platform-level role, separate from org roles */
  platformRole: text('platform_role').notNull().default('user'),
  /** 'active' | 'suspended' | 'deleted' */
  status: text('status').notNull().default('active'),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  mfaSecretEnc: text('mfa_secret_enc'),
  mfaEnabled: boolean('mfa_enabled').notNull().default(false),
  /** primary persona chosen at signup: individual | agent_owner | developer | trainer | enterprise */
  persona: text('persona').notNull().default('individual'),
  defaultOrgId: uuid('default_org_id'),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (t) => [uniqueIndex('users_email_uq').on(t.email)]);

export const organisations = pgTable('organisations', {
  id: id(),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  /** 'personal' | 'enterprise' */
  type: text('type').notNull().default('personal'),
  /** 'free' | 'pro' | 'enterprise' */
  plan: text('plan').notNull().default('free'),
  /** enterprise private network: agents only visible inside the org */
  privateNetwork: boolean('private_network').notNull().default(false),
  status: text('status').notNull().default('active'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('organisations_slug_uq').on(t.slug)]);

export const memberships = pgTable('memberships', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organisations.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** OrgRole from @aix/shared: owner | admin | developer | trainer | member | viewer */
  role: text('role').notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('memberships_org_user_uq').on(t.orgId, t.userId), index('memberships_user_idx').on(t.userId)]);

/** Seeded from @aix/shared ROLE_PERMISSIONS; kept in DB for admin visibility/audit. */
export const rolePermissions = pgTable('role_permissions', {
  role: text('role').notNull(),
  permission: text('permission').notNull(),
}, (t) => [primaryKey({ columns: [t.role, t.permission] })]);

export const sessions = pgTable('sessions', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  mfaPending: boolean('mfa_pending').notNull().default(false),
  ip: text('ip'),
  userAgent: text('user_agent'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('sessions_token_uq').on(t.tokenHash), index('sessions_user_idx').on(t.userId)]);

export const apiKeys = pgTable('api_keys', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organisations.id, { onDelete: 'cascade' }),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  name: text('name').notNull(),
  /** visible prefix e.g. aix_sk_test_ab12 */
  prefix: text('prefix').notNull(),
  keyHash: text('key_hash').notNull(),
  scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
  /** 'sandbox' | 'production' */
  environment: text('environment').notNull().default('sandbox'),
  rateLimitPerMin: integer('rate_limit_per_min').notNull().default(120),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  rotatedFromId: uuid('rotated_from_id'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('api_keys_hash_uq').on(t.keyHash), index('api_keys_org_idx').on(t.orgId)]);

/* ───────────────────────────── Agents ───────────────────────────── */

export const agentProviders = pgTable('agent_providers', {
  id: id(),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  /** adapter kind: openai_compatible | anthropic | gemini | sandbox | custom_rest | webhook | a2a | mcp | inbox */
  adapter: text('adapter').notNull(),
  defaultBaseUrl: text('default_base_url'),
  defaultModels: jsonb('default_models').$type<string[]>().notNull().default([]),
  /** what the provider can do: { tools, vision, json_mode, fine_tuning, streaming } */
  capabilities: jsonb('capabilities').$type<Record<string, boolean>>().notNull().default({}),
  docsUrl: text('docs_url'),
  /** 'active' | 'beta' | 'disabled' */
  status: text('status').notNull().default('active'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('agent_providers_slug_uq').on(t.slug)]);

export const agents = pgTable('agents', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organisations.id, { onDelete: 'cascade' }),
  ownerId: uuid('owner_id').notNull().references(() => users.id),
  providerId: uuid('provider_id').notNull().references(() => agentProviders.id),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  avatar: text('avatar'),
  modelName: text('model_name').notNull(),
  modelVersion: text('model_version'),
  instructions: text('instructions').notNull().default(''),
  role: text('role').notNull().default(''),
  tools: jsonb('tools').$type<{ name: string; description?: string }[]>().notNull().default([]),
  knowledgeSourceIds: jsonb('knowledge_source_ids').$type<string[]>().notNull().default([]),
  inputFormats: jsonb('input_formats').$type<string[]>().notNull().default(['text']),
  outputFormats: jsonb('output_formats').$type<string[]>().notNull().default(['text']),
  languages: jsonb('languages').$type<string[]>().notNull().default(['en']),
  /** self-declared domain slugs — displayed as "claimed", never used for ranking */
  claimedDomains: jsonb('claimed_domains').$type<string[]>().notNull().default([]),
  /** AgentPermissions from @aix/shared */
  permissions: jsonb('permissions').$type<Record<string, unknown>>().notNull().default({}),
  usageLimits: jsonb('usage_limits').$type<{ maxCallsPerDay?: number; maxCreditsPerDay?: number }>().notNull().default({}),
  /** 'draft' | 'active' | 'suspended' | 'disconnected' */
  status: text('status').notNull().default('draft'),
  /** 'unknown' | 'healthy' | 'degraded' | 'down' */
  health: text('health').notNull().default('unknown'),
  lastHealthCheckAt: timestamp('last_health_check_at', { withTimezone: true }),
  lastLatencyMs: integer('last_latency_ms'),
  isPublic: boolean('is_public').notNull().default(false),
  /** 'unverified' | 'pending' | 'verified' | 'rejected' */
  verificationStatus: text('verification_status').notNull().default('unverified'),
  overallScore: real('overall_score'),
  currentVersion: integer('current_version').notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('agents_slug_uq').on(t.slug),
  index('agents_org_idx').on(t.orgId),
  index('agents_public_idx').on(t.isPublic, t.status),
]);

export const agentVersions = pgTable('agent_versions', {
  id: id(),
  agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  instructions: text('instructions').notNull(),
  role: text('role').notNull().default(''),
  config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
  changeNote: text('change_note').notNull().default(''),
  /** 'manual' | 'training' | 'rollback' */
  source: text('source').notNull().default('manual'),
  sourceSessionId: uuid('source_session_id'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('agent_versions_uq').on(t.agentId, t.version)]);

export const agentConnections = pgTable('agent_connections', {
  id: id(),
  agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  /** api | custom_rest | webhook | sdk | a2a | mcp | sandbox | prompt */
  method: text('method').notNull(),
  endpointUrl: text('endpoint_url'),
  /** AES-256-GCM encrypted; never returned to clients */
  credentialEnc: text('credential_enc'),
  credentialLast4: text('credential_last4'),
  config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
  webhookSecretEnc: text('webhook_secret_enc'),
  /** 'pending' | 'connected' | 'error' | 'disconnected' */
  status: text('status').notNull().default('pending'),
  lastError: text('last_error'),
  lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('agent_connections_agent_uq').on(t.agentId)]);

/**
 * Pull-model task inbox for agents connected via prompt (adapter `inbox`). StringMind enqueues a task, the agent
 * long-polls GET /agent-api/tasks/next, answers with POST /agent-api/tasks/:id/result. `response` is untrusted text.
 */
export const agentTasks = pgTable('agent_tasks', {
  id: id(),
  agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull(),
  /** 'verify' | 'assessment' | 'training' | 'playground' | 'health' */
  kind: text('kind').notNull(),
  request: jsonb('request').$type<{ messages: { role: string; content: string }[]; system: string | null }>().notNull(),
  /** 'pending' | 'delivered' | 'answered' | 'expired' */
  status: text('status').notNull().default('pending'),
  response: text('response'),
  createdAt: createdAt(),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  answeredAt: timestamp('answered_at', { withTimezone: true }),
  deadline: timestamp('deadline', { withTimezone: true }).notNull(),
}, (t) => [index('agent_tasks_agent_status_idx').on(t.agentId, t.status, t.createdAt)]);

/* ───────────────────────────── Capability & benchmarks ───────────────────────────── */

export const capabilityDomains = pgTable('capability_domains', {
  id: id(),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  icon: text('icon'),
  /** scoring weights per dimension, sums to 1 */
  weights: jsonb('weights').$type<Record<string, number>>().notNull(),
  highImpact: boolean('high_impact').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('capability_domains_slug_uq').on(t.slug)]);

export const capabilitySkills = pgTable('capability_skills', {
  id: id(),
  domainId: uuid('domain_id').notNull().references(() => capabilityDomains.id, { onDelete: 'cascade' }),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
}, (t) => [uniqueIndex('capability_skills_uq').on(t.domainId, t.slug)]);

export const benchmarkDatasets = pgTable('benchmark_datasets', {
  id: id(),
  domainId: uuid('domain_id').notNull().references(() => capabilityDomains.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  version: text('version').notNull(),
  /** 'held_out' = only the evaluator sees it; 'practice' = may be used in training exercises */
  visibility: text('visibility').notNull().default('held_out'),
  /** 'active' | 'retired' | 'draft' */
  status: text('status').notNull().default('active'),
  questionCount: integer('question_count').notNull().default(0),
  humanReviewedCount: integer('human_reviewed_count').notNull().default(0),
  checksum: text('checksum'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('benchmark_datasets_uq').on(t.domainId, t.version, t.visibility)]);

export const benchmarkQuestions = pgTable('benchmark_questions', {
  id: id(),
  datasetId: uuid('dataset_id').notNull().references(() => benchmarkDatasets.id, { onDelete: 'cascade' }),
  skillId: uuid('skill_id').references(() => capabilitySkills.id),
  /** 'easy' | 'intermediate' | 'advanced' */
  difficulty: text('difficulty').notNull(),
  /** QuestionKind from @aix/shared */
  kind: text('kind').notNull(),
  prompt: text('prompt').notNull(),
  /** 'exact' | 'numeric' | 'choice' | 'keywords' | 'regex' | 'abstain' | 'refusal' */
  answerType: text('answer_type').notNull(),
  /** ground truth, NEVER sent to agents or trainers */
  groundTruth: jsonb('ground_truth').$type<Record<string, unknown>>().notNull(),
  choices: jsonb('choices').$type<string[] | null>(),
  rubric: jsonb('rubric').$type<Record<string, unknown>>().notNull().default({}),
  tags: jsonb('tags').$type<string[]>().notNull().default([]),
  humanReviewed: boolean('human_reviewed').notNull().default(false),
  createdAt: createdAt(),
}, (t) => [index('benchmark_questions_dataset_idx').on(t.datasetId)]);

/** A capability assessment run (also used as pre/post/retention evaluation for training). */
export const capabilityAssessments = pgTable('capability_assessments', {
  id: id(),
  agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organisations.id, { onDelete: 'cascade' }),
  requestedBy: uuid('requested_by').references(() => users.id),
  /** 'baseline' | 'manual' | 'pre_training' | 'post_training' | 'retention' | 'regression' */
  purpose: text('purpose').notNull().default('manual'),
  trainingSessionId: uuid('training_session_id'),
  domainSlugs: jsonb('domain_slugs').$type<string[]>().notNull(),
  /** 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' */
  status: text('status').notNull().default('queued'),
  progress: real('progress').notNull().default(0),
  repeats: integer('repeats').notNull().default(2),
  overallScore: real('overall_score'),
  confidence: real('confidence'),
  testsCompleted: integer('tests_completed').notNull().default(0),
  testsTotal: integer('tests_total').notNull().default(0),
  datasetVersions: jsonb('dataset_versions').$type<Record<string, string>>().notNull().default({}),
  /** evaluator identity + method, e.g. { id: 'aix-ground-truth-v1', method: 'deterministic' } */
  evaluator: jsonb('evaluator').$type<Record<string, unknown>>().notNull().default({}),
  summary: jsonb('summary').$type<Record<string, unknown>>().notNull().default({}),
  error: text('error'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [index('capability_assessments_agent_idx').on(t.agentId, t.createdAt)]);

export const assessmentResults = pgTable('assessment_results', {
  id: id(),
  assessmentId: uuid('assessment_id').notNull().references(() => capabilityAssessments.id, { onDelete: 'cascade' }),
  questionId: uuid('question_id').notNull().references(() => benchmarkQuestions.id),
  domainId: uuid('domain_id').notNull().references(() => capabilityDomains.id),
  attempt: integer('attempt').notNull().default(1),
  response: text('response').notNull().default(''),
  latencyMs: integer('latency_ms'),
  correct: boolean('correct').notNull(),
  score: real('score').notNull(),
  dimensionScores: jsonb('dimension_scores').$type<Record<string, number>>().notNull().default({}),
  /** e.g. 'incorrect_fact' | 'hallucination' | 'overconfident' | 'format' | 'unsafe' | 'timeout' | 'error' */
  failureCategory: text('failure_category'),
  evaluator: text('evaluator').notNull(),
  evaluationMethod: text('evaluation_method').notNull(),
  needsHumanReview: boolean('needs_human_review').notNull().default(false),
  createdAt: createdAt(),
}, (t) => [index('assessment_results_assessment_idx').on(t.assessmentId)]);

/** Human review of individual results (disputed / high-impact). */
export const evaluations = pgTable('evaluations', {
  id: id(),
  assessmentResultId: uuid('assessment_result_id').notNull().references(() => assessmentResults.id, { onDelete: 'cascade' }),
  reviewerId: uuid('reviewer_id').notNull().references(() => users.id),
  /** 'upheld' | 'overturned' */
  verdict: text('verdict').notNull(),
  score: real('score'),
  notes: text('notes').notNull().default(''),
  createdAt: createdAt(),
});

/** Latest verified capability per agent per domain (derived from completed assessments only). */
export const agentCapabilities = pgTable('agent_capabilities', {
  id: id(),
  agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  domainId: uuid('domain_id').notNull().references(() => capabilityDomains.id),
  score: real('score').notNull(),
  accuracy: real('accuracy').notNull(),
  hallucinationRate: real('hallucination_rate').notNull().default(0),
  consistency: real('consistency').notNull().default(0),
  confidence: real('confidence').notNull(),
  sampleSize: integer('sample_size').notNull(),
  dimensionScores: jsonb('dimension_scores').$type<Record<string, number>>().notNull().default({}),
  skillScores: jsonb('skill_scores').$type<Record<string, number>>().notNull().default({}),
  strengths: jsonb('strengths').$type<string[]>().notNull().default([]),
  weaknesses: jsonb('weaknesses').$type<string[]>().notNull().default([]),
  failureBreakdown: jsonb('failure_breakdown').$type<Record<string, number>>().notNull().default({}),
  /** true only when sampleSize >= MIN_SAMPLE_FOR_VERIFIED and confidence >= threshold */
  verified: boolean('verified').notNull().default(false),
  lastAssessmentId: uuid('last_assessment_id').notNull(),
  assessedAt: timestamp('assessed_at', { withTimezone: true }).notNull(),
}, (t) => [uniqueIndex('agent_capabilities_uq').on(t.agentId, t.domainId)]);

/* ───────────────────────────── Training ───────────────────────────── */

export const trainingRequests = pgTable('training_requests', {
  id: id(),
  learnerAgentId: uuid('learner_agent_id').notNull().references(() => agents.id),
  trainerAgentId: uuid('trainer_agent_id').notNull().references(() => agents.id),
  learnerOrgId: uuid('learner_org_id').notNull().references(() => organisations.id),
  trainerOrgId: uuid('trainer_org_id').notNull().references(() => organisations.id),
  requestedBy: uuid('requested_by').notNull().references(() => users.id),
  listingId: uuid('listing_id'),
  domainId: uuid('domain_id').notNull().references(() => capabilityDomains.id),
  objectives: jsonb('objectives').$type<string[]>().notNull().default([]),
  message: text('message').notNull().default(''),
  priceCredits: credits('price_credits').notNull(),
  /** 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired' */
  status: text('status').notNull().default('pending'),
  sessionId: uuid('session_id'),
  respondedBy: uuid('responded_by'),
  respondedAt: timestamp('responded_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [index('training_requests_trainer_idx').on(t.trainerOrgId, t.status), index('training_requests_learner_idx').on(t.learnerOrgId)]);

export const trainingSessions = pgTable('training_sessions', {
  id: id(),
  requestId: uuid('request_id').references(() => trainingRequests.id),
  learnerAgentId: uuid('learner_agent_id').notNull().references(() => agents.id),
  trainerAgentId: uuid('trainer_agent_id').notNull().references(() => agents.id),
  learnerOrgId: uuid('learner_org_id').notNull().references(() => organisations.id),
  trainerOrgId: uuid('trainer_org_id').notNull().references(() => organisations.id),
  domainId: uuid('domain_id').notNull().references(() => capabilityDomains.id),
  subject: text('subject').notNull(),
  /** 'introduction' | 'knowledge_sharing' | 'practical_exercises' | 'evaluation' | 'completion' */
  stage: text('stage').notNull().default('introduction'),
  /** 'scheduled' | 'active' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'disputed' */
  status: text('status').notNull().default('scheduled'),
  plan: jsonb('plan').$type<Record<string, unknown>>().notNull().default({}),
  preScore: real('pre_score'),
  postScore: real('post_score'),
  improvement: real('improvement'),
  retentionScore: real('retention_score'),
  preAssessmentId: uuid('pre_assessment_id'),
  postAssessmentId: uuid('post_assessment_id'),
  retentionAssessmentId: uuid('retention_assessment_id'),
  feeCredits: credits('fee_credits').notNull().default(0),
  commissionRateBps: integer('commission_rate_bps').notNull().default(2000),
  commissionCredits: credits('commission_credits'),
  trainerEarningsCredits: credits('trainer_earnings_credits'),
  /** settlement terms: 'on_completion' | 'on_improvement' (min improvement required) */
  settlementTerms: jsonb('settlement_terms').$type<{ mode: string; minImprovement?: number }>().notNull().default({ mode: 'on_completion' }),
  /** 'none' | 'escrowed' | 'settled' | 'refunded' | 'disputed' */
  settlementStatus: text('settlement_status').notNull().default('none'),
  escrowTxId: uuid('escrow_tx_id'),
  settlementTxId: uuid('settlement_tx_id'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  pausedAt: timestamp('paused_at', { withTimezone: true }),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  durationSeconds: integer('duration_seconds').notNull().default(0),
  failureReason: text('failure_reason'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('training_sessions_learner_idx').on(t.learnerOrgId), index('training_sessions_trainer_idx').on(t.trainerOrgId)]);

export const trainingParticipants = pgTable('training_participants', {
  id: id(),
  sessionId: uuid('session_id').notNull().references(() => trainingSessions.id, { onDelete: 'cascade' }),
  agentId: uuid('agent_id').references(() => agents.id),
  userId: uuid('user_id').references(() => users.id),
  /** 'learner' | 'trainer' | 'owner_observer' | 'evaluator' */
  role: text('role').notNull(),
  /** scoped permissions for the session, e.g. { shareKnowledge: true, readLearnerMemory: false } */
  permissions: jsonb('permissions').$type<Record<string, boolean>>().notNull().default({}),
  createdAt: createdAt(),
});

export const trainingObjectives = pgTable('training_objectives', {
  id: id(),
  sessionId: uuid('session_id').notNull().references(() => trainingSessions.id, { onDelete: 'cascade' }),
  skillId: uuid('skill_id').references(() => capabilitySkills.id),
  description: text('description').notNull(),
  targetScore: real('target_score'),
  achieved: boolean('achieved'),
  createdAt: createdAt(),
});

export const trainingMessages = pgTable('training_messages', {
  id: id(),
  sessionId: uuid('session_id').notNull().references(() => trainingSessions.id, { onDelete: 'cascade' }),
  senderAgentId: uuid('sender_agent_id').references(() => agents.id),
  senderUserId: uuid('sender_user_id').references(() => users.id),
  /** 'trainer' | 'learner' | 'system' | 'owner' | 'evaluator' */
  senderRole: text('sender_role').notNull(),
  stage: text('stage').notNull(),
  content: text('content').notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  /** set when the safety filter detected injection / benchmark leakage / unsafe content */
  flagged: boolean('flagged').notNull().default(false),
  flagReason: text('flag_reason'),
  createdAt: createdAt(),
}, (t) => [index('training_messages_session_idx').on(t.sessionId, t.createdAt)]);

export const exercises = pgTable('exercises', {
  id: id(),
  sessionId: uuid('session_id').notNull().references(() => trainingSessions.id, { onDelete: 'cascade' }),
  objectiveId: uuid('objective_id').references(() => trainingObjectives.id),
  prompt: text('prompt').notNull(),
  expected: jsonb('expected').$type<Record<string, unknown>>().notNull().default({}),
  learnerResponse: text('learner_response'),
  feedback: text('feedback'),
  score: real('score'),
  /** 'pending' | 'answered' | 'graded' */
  status: text('status').notNull().default('pending'),
  createdAt: createdAt(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

/* ───────────────────────────── Knowledge & learning ───────────────────────────── */

export const knowledgeSources = pgTable('knowledge_sources', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organisations.id, { onDelete: 'cascade' }),
  ownerId: uuid('owner_id').notNull().references(() => users.id),
  agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  /** 'upload' | 'text' | 'url' | 'trainer_shared' | 'licensed' | 'dataset' */
  type: text('type').notNull(),
  /** 'private' | 'org' | 'marketplace' | 'public' */
  visibility: text('visibility').notNull().default('private'),
  domainId: uuid('domain_id').references(() => capabilityDomains.id),
  licence: text('licence').notNull().default('proprietary'),
  ownershipAttested: boolean('ownership_attested').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('knowledge_sources_org_idx').on(t.orgId)]);

export const knowledgeDocuments = pgTable('knowledge_documents', {
  id: id(),
  sourceId: uuid('source_id').notNull().references(() => knowledgeSources.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organisations.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  mimeType: text('mime_type').notNull(),
  storagePath: text('storage_path'),
  sizeBytes: integer('size_bytes').notNull().default(0),
  /** sha256 of normalised text — used for duplicate/plagiarism detection */
  checksum: text('checksum').notNull(),
  /** 'processing' | 'ready' | 'failed' | 'rejected' */
  status: text('status').notNull().default('processing'),
  version: integer('version').notNull().default(1),
  chunkCount: integer('chunk_count').notNull().default(0),
  error: text('error'),
  createdAt: createdAt(),
}, (t) => [index('knowledge_documents_checksum_idx').on(t.checksum), index('knowledge_documents_source_idx').on(t.sourceId)]);

export const knowledgeChunks = pgTable('knowledge_chunks', {
  id: id(),
  documentId: uuid('document_id').notNull().references(() => knowledgeDocuments.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organisations.id, { onDelete: 'cascade' }),
  ordinal: integer('ordinal').notNull(),
  content: text('content').notNull(),
  tokenCount: integer('token_count').notNull(),
  /** simhash/minhash fingerprint for near-duplicate detection */
  fingerprint: text('fingerprint'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
}, (t) => [index('knowledge_chunks_doc_idx').on(t.documentId), index('knowledge_chunks_org_idx').on(t.orgId)]);

export const embeddings = pgTable('embeddings', {
  id: id(),
  chunkId: uuid('chunk_id').notNull().references(() => knowledgeChunks.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull(),
  model: text('model').notNull(),
  embedding: vector('embedding').notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('embeddings_chunk_model_uq').on(t.chunkId, t.model)]);

export const learningArtefacts = pgTable('learning_artefacts', {
  id: id(),
  sessionId: uuid('session_id').references(() => trainingSessions.id, { onDelete: 'set null' }),
  learnerAgentId: uuid('learner_agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  trainerAgentId: uuid('trainer_agent_id').references(() => agents.id),
  orgId: uuid('org_id').notNull().references(() => organisations.id, { onDelete: 'cascade' }),
  /** LearningType: 'temporary_context' | 'persistent_memory' | 'knowledge_retrieval' | 'instruction_update' | 'fine_tuning' */
  learningType: text('learning_type').notNull(),
  title: text('title').notNull(),
  content: text('content').notNull(),
  domainId: uuid('domain_id').references(() => capabilityDomains.id),
  /** 'pending' | 'approved' | 'rejected' | 'applied' */
  status: text('status').notNull().default('pending'),
  approvedBy: uuid('approved_by').references(() => users.id),
  permissions: jsonb('permissions').$type<Record<string, boolean>>().notNull().default({}),
  provenance: jsonb('provenance').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
}, (t) => [index('learning_artefacts_learner_idx').on(t.learnerAgentId)]);

export const agentMemories = pgTable('agent_memories', {
  id: id(),
  agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organisations.id, { onDelete: 'cascade' }),
  /** 'persistent_memory' | 'temporary_context' */
  kind: text('kind').notNull(),
  content: text('content').notNull(),
  domainId: uuid('domain_id').references(() => capabilityDomains.id),
  sourceArtefactId: uuid('source_artefact_id').references(() => learningArtefacts.id, { onDelete: 'set null' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [index('agent_memories_agent_idx').on(t.agentId)]);

export const learningRecords = pgTable('learning_records', {
  id: id(),
  agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organisations.id, { onDelete: 'cascade' }),
  sessionId: uuid('session_id').references(() => trainingSessions.id, { onDelete: 'set null' }),
  domainId: uuid('domain_id').notNull().references(() => capabilityDomains.id),
  learningTypes: jsonb('learning_types').$type<string[]>().notNull().default([]),
  preScore: real('pre_score'),
  postScore: real('post_score'),
  improvement: real('improvement'),
  metrics: jsonb('metrics').$type<Record<string, number>>().notNull().default({}),
  retentionScore: real('retention_score'),
  retentionCheckedAt: timestamp('retention_checked_at', { withTimezone: true }),
  verified: boolean('verified').notNull().default(false),
  createdAt: createdAt(),
}, (t) => [index('learning_records_agent_idx').on(t.agentId)]);

/* ───────────────────────────── Marketplace ───────────────────────────── */

export const marketplaceListings = pgTable('marketplace_listings', {
  id: id(),
  agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organisations.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  domainId: uuid('domain_id').notNull().references(() => capabilityDomains.id),
  skills: jsonb('skills').$type<string[]>().notNull().default([]),
  priceCredits: credits('price_credits').notNull().default(0),
  /** 'per_session' | 'free' */
  pricingModel: text('pricing_model').notNull().default('per_session'),
  settlementMode: text('settlement_mode').notNull().default('on_completion'),
  minImprovement: real('min_improvement'),
  durationMinutes: integer('duration_minutes').notNull().default(30),
  /** 'draft' | 'active' | 'paused' | 'removed' */
  status: text('status').notNull().default('active'),
  /** 'visible' | 'hidden' | 'under_review' (admin moderation) */
  moderation: text('moderation').notNull().default('visible'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('marketplace_listings_domain_idx').on(t.domainId, t.status)]);

export const knowledgeListings = pgTable('knowledge_listings', {
  id: id(),
  sourceId: uuid('source_id').notNull().references(() => knowledgeSources.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organisations.id, { onDelete: 'cascade' }),
  contributorId: uuid('contributor_id').notNull().references(() => users.id),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  category: text('category').notNull(),
  domainId: uuid('domain_id').references(() => capabilityDomains.id),
  licence: text('licence').notNull(),
  ownershipAttested: boolean('ownership_attested').notNull(),
  priceCredits: credits('price_credits').notNull().default(0),
  qualityScore: real('quality_score'),
  /** 'pending' | 'verified' | 'rejected' */
  verificationStatus: text('verification_status').notNull().default('pending'),
  provenance: jsonb('provenance').$type<Record<string, unknown>>().notNull().default({}),
  usageRestrictions: text('usage_restrictions').notNull().default(''),
  version: integer('version').notNull().default(1),
  /** 'draft' | 'active' | 'removed' */
  status: text('status').notNull().default('active'),
  moderation: text('moderation').notNull().default('under_review'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const knowledgeLicences = pgTable('knowledge_licences', {
  id: id(),
  listingId: uuid('listing_id').notNull().references(() => knowledgeListings.id),
  buyerOrgId: uuid('buyer_org_id').notNull().references(() => organisations.id),
  buyerUserId: uuid('buyer_user_id').notNull().references(() => users.id),
  agentId: uuid('agent_id').references(() => agents.id),
  transactionId: uuid('transaction_id'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('knowledge_licences_uq').on(t.listingId, t.buyerOrgId)]);

export const reviews = pgTable('reviews', {
  id: id(),
  sessionId: uuid('session_id').notNull().references(() => trainingSessions.id),
  reviewerId: uuid('reviewer_id').notNull().references(() => users.id),
  agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  rating: integer('rating').notNull(),
  body: text('body').notNull().default(''),
  /** 'published' | 'hidden' */
  status: text('status').notNull().default('published'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('reviews_session_reviewer_uq').on(t.sessionId, t.reviewerId)]);

export const favourites = pgTable('favourites', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  /** 'favourite' | 'shortlist' */
  list: text('list').notNull().default('favourite'),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.userId, t.agentId, t.list] })]);

export const reports = pgTable('reports', {
  id: id(),
  reporterId: uuid('reporter_id').notNull().references(() => users.id),
  /** 'agent' | 'listing' | 'knowledge' | 'review' | 'user' */
  targetType: text('target_type').notNull(),
  targetId: uuid('target_id').notNull(),
  reason: text('reason').notNull(),
  details: text('details').notNull().default(''),
  /** 'open' | 'actioned' | 'dismissed' */
  status: text('status').notNull().default('open'),
  resolvedBy: uuid('resolved_by'),
  createdAt: createdAt(),
});

export const agentReputation = pgTable('agent_reputation', {
  agentId: uuid('agent_id').primaryKey().references(() => agents.id, { onDelete: 'cascade' }),
  score: real('score').notNull().default(0),
  /** ReputationLevel from @aix/shared */
  level: text('level').notNull().default('new_contributor'),
  sessionsCompleted: integer('sessions_completed').notNull().default(0),
  sessionsFailed: integer('sessions_failed').notNull().default(0),
  trainingSuccessRate: real('training_success_rate').notNull().default(0),
  avgLearnerImprovement: real('avg_learner_improvement').notNull().default(0),
  avgRating: real('avg_rating'),
  ratingCount: integer('rating_count').notNull().default(0),
  disputesLost: integer('disputes_lost').notNull().default(0),
  safetyIncidents: integer('safety_incidents').notNull().default(0),
  components: jsonb('components').$type<Record<string, number>>().notNull().default({}),
  updatedAt: updatedAt(),
});

/* ───────────────────────────── Finance (double-entry ledger) ───────────────────────────── */

export const wallets = pgTable('wallets', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organisations.id, { onDelete: 'cascade' }),
  /** 'org' (customer wallet) | 'platform' (single row: StringMind revenue) | 'external' (single row: world) */
  kind: text('kind').notNull().default('org'),
  currency: text('currency').notNull().default('CREDIT'),
  /** cached balances — ALWAYS recomputable from ledger_entries; only changed by ledger service */
  available: credits('available').notNull().default(0),
  locked: credits('locked').notNull().default(0),
  withdrawable: credits('withdrawable').notNull().default(0),
  purchasedTotal: credits('purchased_total').notNull().default(0),
  earnedTotal: credits('earned_total').notNull().default(0),
  spentTotal: credits('spent_total').notNull().default(0),
  refundedTotal: credits('refunded_total').notNull().default(0),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('wallets_org_uq').on(t.orgId, t.kind)]);

export const transactions = pgTable('transactions', {
  id: id(),
  /** purchase | training_escrow | training_settlement | training_refund | knowledge_purchase | payout_request | payout_paid | payout_rejected | adjustment | dispute_refund */
  type: text('type').notNull(),
  /** 'posted' | 'reversed' */
  status: text('status').notNull().default('posted'),
  orgId: uuid('org_id').references(() => organisations.id),
  referenceType: text('reference_type'),
  referenceId: uuid('reference_id'),
  idempotencyKey: text('idempotency_key').notNull(),
  description: text('description').notNull().default(''),
  amount: credits('amount').notNull(),
  createdBy: uuid('created_by'),
  reversalOf: uuid('reversal_of'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('transactions_idem_uq').on(t.idempotencyKey), index('transactions_org_idx').on(t.orgId, t.createdAt)]);

/** Append-only. Sum(amount) per transaction must be 0. bucket = available | locked | withdrawable | revenue | external */
export const ledgerEntries = pgTable('ledger_entries', {
  id: id(),
  transactionId: uuid('transaction_id').notNull().references(() => transactions.id),
  walletId: uuid('wallet_id').notNull().references(() => wallets.id),
  bucket: text('bucket').notNull(),
  amount: credits('amount').notNull(),
  createdAt: createdAt(),
}, (t) => [index('ledger_entries_wallet_idx').on(t.walletId), index('ledger_entries_tx_idx').on(t.transactionId)]);

export const creditPackages = pgTable('credit_packages', {
  id: id(),
  name: text('name').notNull(),
  credits: credits('credits').notNull(),
  bonusCredits: credits('bonus_credits').notNull().default(0),
  priceMinor: integer('price_minor').notNull(),
  currency: text('currency').notNull().default('INR'),
  active: boolean('active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
});

export const payments = pgTable('payments', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organisations.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  /** 'sandbox' | 'razorpay' | 'stripe' */
  provider: text('provider').notNull(),
  providerRef: text('provider_ref'),
  packageId: uuid('package_id').references(() => creditPackages.id),
  amountMinor: integer('amount_minor').notNull(),
  currency: text('currency').notNull(),
  credits: credits('credits').notNull(),
  /** 'created' | 'succeeded' | 'failed' | 'refunded' */
  status: text('status').notNull().default('created'),
  transactionId: uuid('transaction_id'),
  invoiceNumber: text('invoice_number'),
  taxMinor: integer('tax_minor').notNull().default(0),
  failureReason: text('failure_reason'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const payouts = pgTable('payouts', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organisations.id),
  requestedBy: uuid('requested_by').notNull().references(() => users.id),
  amountCredits: credits('amount_credits').notNull(),
  /** 'requested' | 'approved' | 'paid' | 'rejected' */
  status: text('status').notNull().default('requested'),
  method: jsonb('method').$type<Record<string, string>>().notNull().default({}),
  reviewedBy: uuid('reviewed_by'),
  reviewNote: text('review_note'),
  requestTxId: uuid('request_tx_id'),
  settleTxId: uuid('settle_tx_id'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Commission configuration. Most specific active rule wins: org > domain > global. */
export const commissionRules = pgTable('commission_rules', {
  id: id(),
  /** 'global' | 'domain' | 'org' */
  scope: text('scope').notNull(),
  scopeId: uuid('scope_id'),
  rateBps: integer('rate_bps').notNull(),
  active: boolean('active').notNull().default(true),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
});

export const subscriptions = pgTable('subscriptions', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organisations.id, { onDelete: 'cascade' }),
  plan: text('plan').notNull(),
  /** 'active' | 'cancelled' | 'past_due' */
  status: text('status').notNull().default('active'),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const disputes = pgTable('disputes', {
  id: id(),
  sessionId: uuid('session_id').notNull().references(() => trainingSessions.id),
  raisedBy: uuid('raised_by').notNull().references(() => users.id),
  raisedByOrgId: uuid('raised_by_org_id').notNull().references(() => organisations.id),
  reason: text('reason').notNull(),
  details: text('details').notNull().default(''),
  /** 'open' | 'under_review' | 'resolved_refund' | 'resolved_release' | 'resolved_partial' | 'rejected' */
  status: text('status').notNull().default('open'),
  resolution: text('resolution'),
  refundCredits: credits('refund_credits'),
  resolvedBy: uuid('resolved_by'),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const fraudFlags = pgTable('fraud_flags', {
  id: id(),
  targetType: text('target_type').notNull(),
  targetId: uuid('target_id').notNull(),
  rule: text('rule').notNull(),
  /** 'low' | 'medium' | 'high' */
  severity: text('severity').notNull(),
  details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
  /** 'open' | 'confirmed' | 'dismissed' */
  status: text('status').notNull().default('open'),
  reviewedBy: uuid('reviewed_by'),
  createdAt: createdAt(),
});

/* ───────────────────────────── Platform ───────────────────────────── */

export const notifications = pgTable('notifications', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** NotificationType from @aix/shared */
  type: text('type').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull().default(''),
  link: text('link'),
  readAt: timestamp('read_at', { withTimezone: true }),
  emailedAt: timestamp('emailed_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [index('notifications_user_idx').on(t.userId, t.createdAt)]);

export const notificationPreferences = pgTable('notification_preferences', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  inApp: boolean('in_app').notNull().default(true),
  email: boolean('email').notNull().default(true),
}, (t) => [primaryKey({ columns: [t.userId, t.type] })]);

/** Outbound email (dev: written here and to storage/outbox instead of sent). */
export const emailOutbox = pgTable('email_outbox', {
  id: id(),
  to: text('to').notNull(),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  status: text('status').notNull().default('queued'),
  createdAt: createdAt(),
});

/** Append-only. */
export const auditLogs = pgTable('audit_logs', {
  id: id(),
  actorUserId: uuid('actor_user_id'),
  /** 'user' | 'admin' | 'system' | 'api_key' | 'agent' */
  actorType: text('actor_type').notNull(),
  orgId: uuid('org_id'),
  action: text('action').notNull(),
  targetType: text('target_type'),
  targetId: text('target_id'),
  ip: text('ip'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
}, (t) => [index('audit_logs_org_idx').on(t.orgId, t.createdAt), index('audit_logs_action_idx').on(t.action)]);

export const webhooks = pgTable('webhooks', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => organisations.id, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  events: jsonb('events').$type<string[]>().notNull(),
  secretEnc: text('secret_enc').notNull(),
  active: boolean('active').notNull().default(true),
  createdBy: uuid('created_by').notNull(),
  createdAt: createdAt(),
});

export const webhookDeliveries = pgTable('webhook_deliveries', {
  id: id(),
  webhookId: uuid('webhook_id').notNull().references(() => webhooks.id, { onDelete: 'cascade' }),
  event: text('event').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  /** 'pending' | 'delivered' | 'failed' */
  status: text('status').notNull().default('pending'),
  responseCode: integer('response_code'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const apiRequestLogs = pgTable('api_request_logs', {
  id: id(),
  orgId: uuid('org_id'),
  apiKeyId: uuid('api_key_id'),
  userId: uuid('user_id'),
  method: text('method').notNull(),
  path: text('path').notNull(),
  statusCode: integer('status_code').notNull(),
  latencyMs: integer('latency_ms').notNull(),
  createdAt: createdAt(),
}, (t) => [index('api_request_logs_org_idx').on(t.orgId, t.createdAt)]);

/** Durable background jobs (Redis-free queue; swap to BullMQ via jobs/queue.ts interface in prod). */
export const jobs = pgTable('jobs', {
  id: id(),
  type: text('type').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  /** 'queued' | 'running' | 'completed' | 'failed' */
  status: text('status').notNull().default('queued'),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(3),
  runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
  lockedAt: timestamp('locked_at', { withTimezone: true }),
  lastError: text('last_error'),
  createdAt: createdAt(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (t) => [index('jobs_status_run_idx').on(t.status, t.runAt)]);

export const systemSettings = pgTable('system_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedBy: uuid('updated_by'),
  updatedAt: updatedAt(),
});

export const contactMessages = pgTable('contact_messages', {
  id: id(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  company: text('company'),
  topic: text('topic').notNull(),
  message: text('message').notNull(),
  status: text('status').notNull().default('new'),
  createdAt: createdAt(),
});
