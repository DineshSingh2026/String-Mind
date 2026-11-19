/**
 * Hive Live trainings — REAL training sessions between demo agents, run by the real engine end to end:
 *
 *   request (from the trainer's real listing) → accept → the fee is ESCROWED from the learner org's demo budget →
 *   briefing + independent pre-test (replay on the trainer's held-back real cases) → the trainer teaches from its
 *   recorded cases → the learner keeps them as memory → exercises → independent post-test → SETTLEMENT (trainer earnings
 *   + platform commission, released only if the learner measurably improved) → public results.
 *
 * Nothing is scripted or invented: transcripts, scores and money movements are whatever the engine produces. The engine
 * is paced (one agent turn every PACE_MS) so visitors can watch each stage. Each session gets a brand-new demo learner
 * with no experience, so every session genuinely starts from zero. Two run at a time, continuously.
 */
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../../db/client.js';
import { LEARNER_ORG_SLUG, LEARNER_PERMS } from '../../db/demo.js';
import { runTrainingSession, setSessionPace } from '../../engine/training.js';
import { adminAdjustment, getOrCreateWallet } from '../wallet/ledger.js';
import { acceptRequest } from '../training/routes.js';

export const PACE_MS = 11_000; // HIVE_LIVE_PACE_MS overrides (tests)
const MAX_RUNNING = 2;
const KEEP_LEARNERS = 10;
const KEEP_VISIBLE = 24;
const BUDGET_FLOOR = 2_000;
const BUDGET_TOP_UP = 10_000;

const PROGRAMMES: { trainer: string; domain: string; objectives: string[] }[] = [
  { trainer: 'codemaster-pro-demo', domain: 'programming', objectives: ['Ship production changes safely', 'Debug incidents from evidence, not guesses', 'Design APIs that survive retries'] },
  { trainer: 'cybersentinel-demo', domain: 'cybersecurity', objectives: ['Defend agents against prompt injection', 'Lock down access control and secrets', 'Respond to an incident in the first hour'] },
  { trainer: 'researchmind-demo', domain: 'research', objectives: ['Evaluate sources before trusting them', 'Report results with honest uncertainty', 'Synthesize evidence into decisions'] },
  { trainer: 'mathpro-demo', domain: 'mathematics', objectives: ['Reason with probability under uncertainty', 'Check calculations before acting', 'Explain quantitative results simply'] },
  { trainer: 'taxexpert-demo', domain: 'finance', objectives: ['Read financial statements correctly', 'Apply revenue recognition rules', 'Spot reconciliation errors early'] },
];
const NAMES = ['Nova', 'Atlas', 'Echo', 'Lyra', 'Orion', 'Vega', 'Juno', 'Kepler', 'Iris', 'Sol', 'Rhea', 'Cyra'];

const kicking = new Set<string>();

/** Run (or resume) a showcase session in the background — never inside a job slot, so a paced session blocks nothing. */
function kick(sessionId: string) {
  if (kicking.has(sessionId)) return;
  kicking.add(sessionId);
  setSessionPace(sessionId, Number(process.env.HIVE_LIVE_PACE_MS ?? PACE_MS));
  void runTrainingSession(sessionId)
    .catch((e) => console.error(`[hive-live] training ${sessionId} failed:`, e instanceof Error ? e.message : e))
    .finally(() => { kicking.delete(sessionId); setSessionPace(sessionId, 0); });
}

async function learnerOrg() {
  const [org] = await db().select().from(schema.organisations).where(eq(schema.organisations.slug, LEARNER_ORG_SLUG)).limit(1);
  if (!org) return null;
  const [m] = await db().select().from(schema.memberships).where(eq(schema.memberships.orgId, org.id)).limit(1);
  return m ? { org, ownerId: m.userId } : null;
}

async function newLearner(orgId: string, ownerId: string, domain: string, n: number) {
  const [p] = await db().select().from(schema.agentProviders).where(eq(schema.agentProviders.slug, 'sandbox')).limit(1);
  const name = `${NAMES[n % NAMES.length]}-${100 + (n % 900)}`;
  const [a] = await db().insert(schema.agents).values({
    orgId, ownerId, providerId: p!.id, slug: `${name.toLowerCase()}-live-${Math.random().toString(36).slice(2, 7)}`, name,
    description: `Demo learner created by Hive Live for a live ${domain} training session. It starts with no experience of its own.`,
    modelName: 'aix-sandbox-1', instructions: 'Answer only from knowledge and experience available to you. Say you do not know when you are not sure.',
    role: `Learner agent for ${domain}`, claimedDomains: [domain], permissions: { ...LEARNER_PERMS, autoApproveArtefacts: true },
    status: 'active', health: 'healthy', lastHealthCheckAt: new Date(), lastLatencyMs: 2,
  }).returning();
  await db().insert(schema.agentConnections).values({ agentId: a!.id, method: 'sandbox', status: 'connected', config: { persona: 'concise' }, lastTestedAt: new Date() });
  await db().insert(schema.agentVersions).values({ agentId: a!.id, version: 1, instructions: a!.instructions, role: a!.role, changeNote: 'Created by Hive Live', source: 'manual' });
  await db().insert(schema.agentReputation).values({ agentId: a!.id }).onConflictDoNothing();
  return a!;
}

async function start(prog: (typeof PROGRAMMES)[number], n: number): Promise<boolean> {
  const lo = await learnerOrg();
  if (!lo) return false;
  const [trainer] = await db().select().from(schema.agents).where(and(eq(schema.agents.slug, prog.trainer), isNull(schema.agents.deletedAt))).limit(1);
  const [domain] = await db().select().from(schema.capabilityDomains).where(eq(schema.capabilityDomains.slug, prog.domain)).limit(1);
  if (!trainer || !domain) return false;
  const [listing] = await db().select().from(schema.marketplaceListings)
    .where(and(eq(schema.marketplaceListings.agentId, trainer.id), eq(schema.marketplaceListings.domainId, domain.id), eq(schema.marketplaceListings.status, 'active'))).limit(1);
  if (!listing) return false;
  // pay only if the learner measurably improves — the showcase shows conditional settlement
  if (listing.settlementMode !== 'on_improvement') await db().update(schema.marketplaceListings).set({ settlementMode: 'on_improvement', minImprovement: 5 }).where(eq(schema.marketplaceListings.id, listing.id));
  const price = listing.pricingModel === 'free' ? 0 : listing.priceCredits;
  const wallet = await getOrCreateWallet(lo.org.id);
  if (wallet.available < Math.max(BUDGET_FLOOR, price)) {
    await adminAdjustment({ orgId: lo.org.id, amount: BUDGET_TOP_UP, reason: 'Hive Live demo training budget', actorUserId: lo.ownerId });
  }
  const learner = await newLearner(lo.org.id, lo.ownerId, prog.domain, n);
  const [request] = await db().insert(schema.trainingRequests).values({
    learnerAgentId: learner.id, trainerAgentId: trainer.id, learnerOrgId: lo.org.id, trainerOrgId: trainer.orgId, requestedBy: lo.ownerId,
    listingId: listing.id, domainId: domain.id, objectives: prog.objectives, message: `${learner.name} would like to learn ${domain.name} from ${trainer.name}.`, priceCredits: price,
  }).returning();
  const session = await acceptRequest(request!, trainer.ownerId);
  const now = new Date();
  await db().update(schema.trainingSessions).set({
    status: 'active', startedAt: now, visibility: 'public', updatedAt: now,
    plan: sql`${schema.trainingSessions.plan} || ${JSON.stringify({ demo: true, realDemo: true })}::jsonb`,
  }).where(eq(schema.trainingSessions.id, session.id));
  kick(session.id);
  return true;
}

/** One tick: resume showcase sessions orphaned by a restart, keep MAX_RUNNING going, keep lists tidy. */
export async function tickTrainings(st: { training?: number }): Promise<void> {
  const running = await db().select().from(schema.trainingSessions)
    .where(and(inArray(schema.trainingSessions.status, ['active', 'scheduled']), sql`${schema.trainingSessions.plan}->>'realDemo' = 'true'`));
  for (const s of running) {
    if (s.status === 'active' && !kicking.has(s.id) && Date.now() - s.updatedAt.getTime() > 60_000) kick(s.id); // e.g. after a deploy
  }
  for (let open = running.length; open < MAX_RUNNING; open++) {
    const prog = PROGRAMMES[(st.training ?? 0) % PROGRAMMES.length]!;
    st.training = (st.training ?? 0) + 1;
    if (running.some((s) => s.subject.includes(prog.domain))) continue;
    try { if (!(await start(prog, st.training))) break; } catch (e) { console.error('[hive-live] could not start a training:', e instanceof Error ? e.message : e); break; }
  }
  // tidy: newest showcase sessions stay visible; retire old demo learners
  const old = await db().select({ id: schema.trainingSessions.id }).from(schema.trainingSessions)
    .where(and(sql`${schema.trainingSessions.plan}->>'realDemo' = 'true'`, eq(schema.trainingSessions.moderation, 'visible'), sql`${schema.trainingSessions.status} not in ('active','scheduled','paused')`))
    .orderBy(desc(schema.trainingSessions.createdAt)).offset(KEEP_VISIBLE);
  if (old.length) await db().update(schema.trainingSessions).set({ moderation: 'removed' }).where(inArray(schema.trainingSessions.id, old.map((o) => o.id)));
  const lo = await learnerOrg();
  if (lo) {
    const learners = await db().select({ id: schema.agents.id }).from(schema.agents)
      .where(and(eq(schema.agents.orgId, lo.org.id), isNull(schema.agents.deletedAt), sql`${schema.agents.slug} like '%-live-%'`)).orderBy(desc(schema.agents.createdAt)).offset(KEEP_LEARNERS);
    const busy = new Set(running.map((s) => s.learnerAgentId));
    const retire = learners.map((l) => l.id).filter((id) => !busy.has(id));
    if (retire.length) await db().update(schema.agents).set({ deletedAt: new Date() }).where(inArray(schema.agents.id, retire));
  }
}
