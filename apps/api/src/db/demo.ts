/**
 * Demo data (idempotent: skipped when the demo org exists).
 * Sandbox agents get knowledge sources holding Hive Mind benchmark knowledge packs; their scores are
 * produced ONLY by real baseline assessments enqueued here and run by the job worker — no score
 * or capability row is ever inserted directly.
 */
import bcrypt from 'bcryptjs';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema, type DB } from './client.js';
import { chunkText, embed, LOCAL_EMBEDDING_MODEL, tokenize } from '../engine/embeddings.js';
import { getKnowledgePack } from '../engine/benchmarks/index.js';
import { createAssessment } from '../engine/assessment.js';

export const DEMO_ORG_SLUG = 'aix-demo-labs';
export const LEARNER_ORG_SLUG = 'northwind-finance';
export const DEMO_PASSWORD = 'DemoUser!2026';

/**
 * Create a knowledge source for an agent and ingest `facts` inline (document → chunks → embeddings).
 * One chunk per fact keeps retrieval precise. Returns the source id.
 */
export async function ingestKnowledgePack(db: DB, input: {
  orgId: string; ownerId: string; agentId: string; domainId: string | null; name: string; facts: string[]; description?: string;
}): Promise<string> {
  const [src] = await db.insert(schema.knowledgeSources).values({
    orgId: input.orgId, ownerId: input.ownerId, agentId: input.agentId, name: input.name, description: input.description ?? '',
    type: 'dataset', visibility: 'private', domainId: input.domainId, licence: 'CC-BY-4.0 (Hive Mind benchmark authors)', ownershipAttested: true,
  }).returning();
  const text = input.facts.join('\n\n');
  const [doc] = await db.insert(schema.knowledgeDocuments).values({
    sourceId: src!.id, orgId: input.orgId, title: input.name, mimeType: 'text/plain', sizeBytes: Buffer.byteLength(text),
    checksum: createHash('sha256').update(`${input.agentId}:${text.toLowerCase().replace(/\s+/g, ' ').trim()}`).digest('hex'),
    status: 'ready', chunkCount: 0,
  }).returning();
  let ordinal = 0;
  for (const fact of input.facts) {
    for (const content of chunkText(fact)) {
      const [chunk] = await db.insert(schema.knowledgeChunks).values({
        documentId: doc!.id, orgId: input.orgId, ordinal: ordinal++, content, tokenCount: tokenize(content).length, metadata: { origin: 'knowledge_pack' },
      }).returning();
      await db.insert(schema.embeddings).values({ chunkId: chunk!.id, orgId: input.orgId, model: LOCAL_EMBEDDING_MODEL, embedding: embed(content) });
    }
  }
  await db.update(schema.knowledgeDocuments).set({ chunkCount: ordinal }).where(eq(schema.knowledgeDocuments.id, doc!.id));
  return src!.id;
}

const TRAINER_PERMS = { publicProfile: true, allowTraining: true, allowLearning: true, shareKnowledge: true, allowOwnerIntervention: true, dataSharing: 'artefacts_only', allowedDomains: [] as string[] };
export const LEARNER_PERMS = { publicProfile: false, allowTraining: false, allowLearning: true, shareKnowledge: false, allowOwnerIntervention: true, dataSharing: 'artefacts_only', allowedDomains: [] as string[] };

const TRAINERS = [
  { name: 'TaxExpert', slug: 'taxexpert', domain: 'finance', price: 600, title: 'Indian tax & financial accounting fundamentals', desc: 'Sandbox trainer covering accounting, ratios, valuation basics and Indian GST/TDS fundamentals.' },
  { name: 'CodeMaster Pro', slug: 'codemaster-pro', domain: 'programming', price: 700, title: 'Programming fundamentals: algorithms, debugging & APIs', desc: 'Sandbox trainer for complexity, data structures, HTTP/REST and debugging basics.' },
  { name: 'ResearchMind', slug: 'researchmind', domain: 'research', price: 500, title: 'Research methods & source evaluation', desc: 'Sandbox trainer for source evaluation, citation practice and evidence synthesis.' },
  { name: 'CyberSentinel', slug: 'cybersentinel', domain: 'cybersecurity', price: 800, title: 'Security essentials: web, crypto & networks', desc: 'Sandbox trainer for OWASP-style web security, cryptography and network fundamentals.' },
  { name: 'MathPro', slug: 'mathpro', domain: 'mathematics', price: 500, title: 'Mathematics & logical reasoning', desc: 'Sandbox trainer for arithmetic, algebra, probability and logic.' },
  { name: 'HealthGuru AI', slug: 'healthguru-ai', domain: 'healthcare', price: 750, title: 'Healthcare knowledge & research methods (informational only)', desc: 'Sandbox trainer for physiology basics, research methods and safety. Not medical advice.' },
] as const;

export async function seedDemo(db: DB) {
  const [exists] = await db.select().from(schema.organisations).where(eq(schema.organisations.slug, DEMO_ORG_SLUG)).limit(1);
  if (exists) return;

  const [provider] = await db.select().from(schema.agentProviders).where(eq(schema.agentProviders.slug, 'sandbox')).limit(1);
  if (!provider) throw new Error('Sandbox provider missing — run core seed first');
  const domains = await db.select().from(schema.capabilityDomains);
  const domainId = (slug: string) => domains.find((d) => d.slug === slug)?.id ?? null;
  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);

  async function orgWithUser(orgName: string, slug: string, email: string, name: string, persona: string) {
    const [org] = await db.insert(schema.organisations).values({ name: orgName, slug, type: 'enterprise', plan: 'pro' }).returning();
    let [user] = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
    if (!user) [user] = await db.insert(schema.users).values({ email, name, passwordHash: hash, persona, defaultOrgId: org!.id, emailVerifiedAt: new Date() }).returning();
    await db.insert(schema.memberships).values({ orgId: org!.id, userId: user!.id, role: 'owner' }).onConflictDoNothing();
    await db.insert(schema.wallets).values({ orgId: org!.id, kind: 'org' }).onConflictDoNothing(); // zero balance; IDLE only via ledger (welcome bonus on first login)
    return { org: org!, user: user! };
  }

  async function sandboxAgent(o: { orgId: string; ownerId: string }, a: { name: string; slug: string; domain: string; desc: string; trainer: boolean }) {
    const [agent] = await db.insert(schema.agents).values({
      orgId: o.orgId, ownerId: o.ownerId, providerId: provider!.id, slug: `${a.slug}-demo`, name: a.name, description: a.desc,
      modelName: 'aix-sandbox-1', instructions: 'Answer only from verified knowledge available to you. Say you do not know when you are not sure.',
      role: a.trainer ? `Trainer agent for ${a.domain}` : `Learner agent for ${a.domain}`, claimedDomains: [a.domain],
      permissions: a.trainer ? TRAINER_PERMS : LEARNER_PERMS, status: 'active', health: 'healthy', isPublic: a.trainer,
      lastHealthCheckAt: new Date(), lastLatencyMs: 2,
    }).returning();
    await db.insert(schema.agentConnections).values({ agentId: agent!.id, method: 'sandbox', status: 'connected', config: { persona: 'concise' }, lastTestedAt: new Date() });
    await db.insert(schema.agentVersions).values({ agentId: agent!.id, version: 1, instructions: agent!.instructions, role: agent!.role, changeNote: 'Initial version (demo seed)', source: 'manual' });
    await db.insert(schema.agentReputation).values({ agentId: agent!.id }).onConflictDoNothing();
    return agent!;
  }

  const labs = await orgWithUser('Hive Mind Demo Labs', DEMO_ORG_SLUG, 'demo@aix.local', 'Demo Trainer', 'trainer');
  const northwind = await orgWithUser('Northwind Finance', LEARNER_ORG_SLUG, 'learner@aix.local', 'Northwind Learner', 'agent_owner');

  const toAssess: { agentId: string; orgId: string; requestedBy: string; domains: string[] }[] = [];
  for (const t of TRAINERS) {
    const agent = await sandboxAgent({ orgId: labs.org.id, ownerId: labs.user.id }, { ...t, trainer: true });
    await ingestKnowledgePack(db, {
      orgId: labs.org.id, ownerId: labs.user.id, agentId: agent.id, domainId: domainId(t.domain),
      name: `${t.name} knowledge pack (${t.domain})`, facts: getKnowledgePack(t.domain),
      description: 'Hive Mind benchmark knowledge pack: reference statements for the domain (not benchmark questions).',
    });
    // Privileged seed insert: the API requires a verified score ≥ 70 to create a listing. Listings are
    // only DISPLAYED with verified scores coming from the real baseline assessment below.
    await db.insert(schema.marketplaceListings).values({
      agentId: agent.id, orgId: labs.org.id, title: t.title, description: t.desc, domainId: domainId(t.domain)!,
      skills: [], priceCredits: t.price, pricingModel: 'per_session', settlementMode: 'on_completion', durationMinutes: 30,
    });
    toAssess.push({ agentId: agent.id, orgId: labs.org.id, requestedBy: labs.user.id, domains: t.domain === 'research' ? ['research', 'general'] : [t.domain] });
  }

  const learner = await sandboxAgent({ orgId: northwind.org.id, ownerId: northwind.user.id }, {
    name: 'FinanceBot', slug: 'financebot', domain: 'finance', trainer: false, desc: 'Northwind’s internal finance assistant (sandbox). Partially trained.',
  });
  const pack = getKnowledgePack('finance');
  await ingestKnowledgePack(db, {
    orgId: northwind.org.id, ownerId: northwind.user.id, agentId: learner.id, domainId: domainId('finance'),
    name: 'Northwind finance notes (partial)', facts: pack.filter((_, i) => i % 3 === 0), // ~30% of the pack
  });
  toAssess.push({ agentId: learner.id, orgId: northwind.org.id, requestedBy: northwind.user.id, domains: ['finance'] });

  // REAL baseline assessments, executed by the job worker (delay lets job handlers register first).
  for (const a of toAssess) {
    await createAssessment({ agentId: a.agentId, orgId: a.orgId, requestedBy: a.requestedBy, purpose: 'baseline', domainSlugs: a.domains }, { delayMs: 3000 });
  }
}
