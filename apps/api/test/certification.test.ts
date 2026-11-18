import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { app, createUserDirect, database, loginAdmin, setup, teardown } from './helpers.js';
import { schema } from '../src/db/client.js';
import {
  CERTIFICATION_RULES, evidenceTotal, levelFor, recomputeCertification, recomputeCertificationRow, sweepCertifications,
} from '../src/modules/certification/service.js';
import { qualifyTrainer } from './fixtures/experience.js';

type User = Awaited<ReturnType<typeof createUserDirect>>;
let owner: User;
const D = 'cybersecurity';
const MONTH = 30 * 24 * 3600_000;
const ago = (ms: number) => new Date(Date.now() - ms);

async function makeAgent(name = 'Cert', extra: Partial<typeof schema.agents.$inferInsert> = {}) {
  const [p] = await database.select().from(schema.agentProviders).where(eq(schema.agentProviders.slug, 'sandbox'));
  const [a] = await database.insert(schema.agents).values({
    orgId: owner.orgId, ownerId: owner.userId, providerId: p!.id, slug: `${name.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}`, name,
    modelName: 'aix-sandbox-1', status: 'active', permissions: { allowTraining: true, allowLearning: true }, ...extra,
  }).returning();
  return a!;
}

async function exam(agentId: string, score: number, o: { mode?: string; status?: string; confidence?: number; at?: Date; domain?: string } = {}) {
  const at = o.at ?? new Date();
  const [e] = await database.insert(schema.proExams).values({
    agentId, orgId: owner.orgId, domainSlug: o.domain ?? D, status: o.status ?? 'completed', mode: o.mode ?? 'certification',
    seedHash: 'x', score, confidence: o.confidence ?? 0.8, completedAt: at, createdAt: at, updatedAt: at,
  }).returning();
  return e!;
}

async function evidence(agentId: string, evidenceScore: number, o: { at?: Date; moderation?: string; status?: string } = {}) {
  const at = o.at ?? new Date();
  const [e] = await database.insert(schema.evidenceSubmissions).values({
    agentId, orgId: owner.orgId, submittedBy: owner.userId, domainSlug: D, kind: 'link', title: `Proof ${evidenceScore}`,
    status: o.status ?? 'scored', evidenceScore, qualityScore: evidenceScore / 0.8, trustWeight: 0.8, moderation: o.moderation ?? 'visible', createdAt: at, updatedAt: at,
  }).returning();
  return e!;
}

async function liveCheck(agentId: string, score: number, at = new Date()) {
  await database.insert(schema.evidenceLiveChecks).values({ agentId, orgId: owner.orgId, domainSlug: D, task: 't', status: 'scored', score, createdAt: at, updatedAt: at });
}

async function cert(agentId: string, domain = D) {
  const [c] = await database.select().from(schema.agentCertifications)
    .where(and(eq(schema.agentCertifications.agentId, agentId), eq(schema.agentCertifications.domainSlug, domain)));
  return c ?? null;
}

beforeAll(async () => {
  await setup();
  owner = await createUserDirect();
});
afterAll(async () => { await teardown(); });

describe('rules (pure)', () => {
  it('levels and thresholds; expert requires exam; proof without live check capped at practitioner', () => {
    const e = { examPath: true, proofOnlyNoLive: false };
    expect(levelFor(59.9, e)).toBe('none');
    expect(levelFor(60, e)).toBe('practitioner');
    expect(levelFor(74.9, e)).toBe('practitioner');
    expect(levelFor(75, e)).toBe('professional');
    expect(levelFor(87.9, e)).toBe('professional');
    expect(levelFor(88, e)).toBe('expert');
    expect(levelFor(95, { examPath: false, proofOnlyNoLive: false })).toBe('professional');
    expect(levelFor(80, { examPath: false, proofOnlyNoLive: true })).toBe('practitioner');
  });
  it('evidence total: best + diminishing bonus, capped at 80', () => {
    expect(evidenceTotal([50]).total).toBe(50);
    expect(evidenceTotal([40, 60]).total).toBe(70); // 60 + 0.25×40
    expect(evidenceTotal([50, 20, 20]).total).toBe(57.5); // 50 + 5 + 2.5
    expect(evidenceTotal([80, 80, 80]).total).toBe(80);
    expect(CERTIFICATION_RULES.combined).toEqual({ examWeight: 0.6, proofWeight: 0.4 });
  });
});

describe('recomputeCertification', () => {
  it('exam only → exam score and level', async () => {
    const a = await makeAgent();
    const e = await exam(a.id, 80, { confidence: 0.75 });
    await recomputeCertification(a.id, D);
    const c = (await cert(a.id))!;
    expect(c).toMatchObject({ level: 'professional', score: 80, examScore: 80, evidenceScore: null, status: 'active', examId: e.id, confidence: 0.75 });
    expect((c.breakdown as { combined: { formula: string } }).combined.formula).toContain('exam only');
    expect(c.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 11 * MONTH);
  });

  it('practice exams never certify; confidence < 0.6 ignored', async () => {
    const a = await makeAgent();
    await exam(a.id, 99, { mode: 'practice' });
    await exam(a.id, 95, { confidence: 0.59 });
    await exam(a.id, 97, { status: 'running' });
    expect(await recomputeCertificationRow(a.id, D)).toBeNull();
    expect(await cert(a.id)).toBeNull();
    await exam(a.id, 65, { confidence: 0.6, at: ago(MONTH) });
    await recomputeCertification(a.id, D);
    expect(await cert(a.id)).toMatchObject({ level: 'practitioner', score: 65 });
  });

  it('proof only without live check is capped at 80 and practitioner', async () => {
    const a = await makeAgent();
    await evidence(a.id, 70);
    await evidence(a.id, 60); // 70 + 15 = 85 → cap 80
    await recomputeCertification(a.id, D);
    const c = (await cert(a.id))!;
    expect(c).toMatchObject({ level: 'practitioner', score: 80, evidenceScore: 80, liveCheckScore: null, examScore: null });
    expect((c.breakdown as { level: { uncappedLevel: string } }).level.uncappedLevel).toBe('professional');
  });

  it('proof with live check: evidence + 0.2 × live; expert requires the exam path', async () => {
    const a = await makeAgent();
    await evidence(a.id, 75);
    await liveCheck(a.id, 90); // 75 + 18 = 93
    await recomputeCertification(a.id, D);
    expect(await cert(a.id)).toMatchObject({ score: 93, liveCheckScore: 90, level: 'professional' });
  });

  it('combined: 0.6 × exam + 0.4 × proof, reaching expert', async () => {
    const a = await makeAgent();
    await exam(a.id, 95);
    await evidence(a.id, 60);
    await liveCheck(a.id, 100); // proof 80
    await recomputeCertification(a.id, D);
    expect(await cert(a.id)).toMatchObject({ score: 89, examScore: 95, evidenceScore: 60, liveCheckScore: 100, level: 'expert' }); // 57 + 32
  });

  it('a newer lower exam replaces an older better one', async () => {
    const a = await makeAgent();
    await exam(a.id, 92, { at: ago(2 * MONTH) });
    await recomputeCertification(a.id, D);
    expect((await cert(a.id))!.level).toBe('expert');
    await exam(a.id, 70);
    await recomputeCertification(a.id, D);
    expect(await cert(a.id)).toMatchObject({ level: 'practitioner', score: 70 });
    const notes = await database.select().from(schema.notifications).where(eq(schema.notifications.userId, owner.userId));
    expect(notes.filter((n) => n.type === 'evaluation_result' && n.link?.includes(a.id)).length).toBe(2);
  });

  it('results older than 12 months do not count; the sweep expires certifications', async () => {
    const a = await makeAgent();
    await exam(a.id, 90, { at: ago(13 * MONTH) });
    expect(await recomputeCertificationRow(a.id, D)).toBeNull();

    const b = await makeAgent();
    await exam(b.id, 80, { at: ago(11 * MONTH) });
    await recomputeCertification(b.id, D);
    expect((await cert(b.id))!.status).toBe('active');
    await sweepCertifications(new Date(Date.now() + 2 * MONTH));
    expect(await cert(b.id)).toMatchObject({ status: 'expired', level: 'none' });
  });

  it('removed evidence voids the proof path (revoked when nothing else remains)', async () => {
    const a = await makeAgent();
    await evidence(a.id, 70);
    await recomputeCertification(a.id, D);
    expect((await cert(a.id))!.level).toBe('practitioner');
    await evidence(a.id, 50, { moderation: 'removed' });
    await recomputeCertification(a.id, D);
    expect(await cert(a.id)).toMatchObject({ status: 'revoked', level: 'none' });
  });

  it('suspended agents are revoked and restored when active again', async () => {
    const a = await makeAgent();
    await exam(a.id, 80);
    await recomputeCertification(a.id, D);
    await database.update(schema.agents).set({ status: 'suspended' }).where(eq(schema.agents.id, a.id));
    await sweepCertifications();
    expect(await cert(a.id)).toMatchObject({ status: 'revoked', level: 'none' });
    await database.update(schema.agents).set({ status: 'active' }).where(eq(schema.agents.id, a.id));
    await sweepCertifications();
    expect(await cert(a.id)).toMatchObject({ status: 'active', level: 'professional' });
  });
});

describe('API', () => {
  it('admin revoke is audited, notifies, sticks until a newer result', async () => {
    const a = await makeAgent();
    await exam(a.id, 80, { at: ago(MONTH) });
    await recomputeCertification(a.id, D);
    const c = (await cert(a.id))!;
    const admin = await loginAdmin();
    expect((await owner.request('POST', `/certifications/${c.id}/revoke`, { reason: 'Exam leak' })).status).toBe(403);
    const r = await admin.request('POST', `/certifications/${c.id}/revoke`, { reason: 'Exam leak' });
    expect(r.status).toBe(200);
    expect(r.body.certification).toMatchObject({ status: 'revoked', level: 'none' });
    const logs = await database.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, 'certification.revoke'));
    expect(logs.some((l) => l.targetId === c.id)).toBe(true);
    const notes = await database.select().from(schema.notifications).where(eq(schema.notifications.userId, owner.userId));
    expect(notes.some((n) => n.type === 'evaluation_result' && n.title.includes('revoked'))).toBe(true);
    // recompute without new results keeps the revocation
    const again = await owner.request('POST', `/certifications/${a.id}/${D}/recompute`);
    expect(again.status).toBe(200);
    expect(again.body.certification.status).toBe('revoked');
    // a newer result lifts it
    await exam(a.id, 78);
    await recomputeCertification(a.id, D);
    expect(await cert(a.id)).toMatchObject({ status: 'active', level: 'professional', score: 78 });
  });

  it('rules + public + org endpoints', async () => {
    const rules = await app.inject({ method: 'GET', url: '/certifications/rules' });
    expect(rules.statusCode).toBe(200);
    expect(JSON.parse(rules.body).rules.levels.map((l: { min: number }) => l.min)).toEqual([60, 75, 88]);
    const pub = await makeAgent('Public', { isPublic: true });
    const priv = await makeAgent('Private');
    await exam(pub.id, 82); await recomputeCertification(pub.id, D);
    await exam(priv.id, 82); await recomputeCertification(priv.id, D);
    const p = await app.inject({ method: 'GET', url: `/certifications/agents/${pub.slug}` });
    expect(p.statusCode).toBe(200);
    expect(JSON.parse(p.body).items[0]).toMatchObject({ domainSlug: D, level: 'professional', label: 'Certified Professional' });
    expect((await app.inject({ method: 'GET', url: `/certifications/agents/${priv.slug}` })).statusCode).toBe(404);
    const mine = await owner.request('GET', `/certifications?agentId=${priv.id}`);
    expect(mine.status).toBe(200);
    expect(mine.body.domains.find((d: { domainSlug: string }) => d.domainSlug === D).certification.level).toBe('professional');
    const other = await createUserDirect();
    expect((await other.request('GET', `/certifications?agentId=${priv.id}`)).status).toBe(404);
    expect((await other.request('POST', `/certifications/${priv.id}/${D}/recompute`)).status).toBe(404);
    // marketplace card exposes the certification
    const card = await owner.request('GET', `/marketplace/agents/${pub.slug}`);
    expect(card.body.certifications?.[0]).toMatchObject({ domainSlug: D, level: 'professional' });
  });
});

describe('trainer gate', () => {
  const base = { title: 'Learn web security', domainSlug: D, priceCredits: 100, durationMinutes: 30 };

  it('training is sold on experience: certification or a capability score alone does not qualify; real proven experience does', async () => {
    const certified = await makeAgent('Certified');
    await exam(certified.id, 80);
    await recomputeCertification(certified.id, D);
    const cert = await owner.request('POST', '/marketplace/listings', { ...base, agentId: certified.id });
    expect(cert.status).toBe(422);
    expect(cert.body.error.details.reason).toBe('experience_required');

    const classic = await makeAgent('Classic');
    const [dom] = await database.select().from(schema.capabilityDomains).where(eq(schema.capabilityDomains.slug, D));
    await database.insert(schema.agentCapabilities).values({
      agentId: classic.id, domainId: dom!.id, score: 75, accuracy: 75, confidence: 0.9, sampleSize: 40, verified: true, lastAssessmentId: crypto.randomUUID(), assessedAt: new Date(),
    });
    expect((await owner.request('POST', '/marketplace/listings', { ...base, agentId: classic.id })).status).toBe(422);

    // the certified agent records its real work history and proves it in a replay → qualifies
    await qualifyTrainer(certified, D);
    expect((await owner.request('POST', '/marketplace/listings', { ...base, agentId: certified.id })).status).toBe(201);
  });
});
