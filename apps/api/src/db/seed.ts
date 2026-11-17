/**
 * Seeding. Core reference data is always idempotently seeded (domains, skills, providers,
 * role permissions, default commission, (dormant) token packages, platform wallets, admin user,
 * benchmark datasets). Demo data (sandbox agents etc.) only when `demo` is true; demo
 * agents' scores are produced by REAL assessment runs through the job queue — never inserted.
 */
import bcrypt from 'bcryptjs';
import { seedDemoDebates } from './demo-debates.js';
import { eq, sql } from 'drizzle-orm';
import { DEFAULT_COMMISSION_BPS, DOMAINS, PROVIDERS, ROLE_PERMISSIONS, domainWeights } from '@aix/shared';
import { schema, type DB } from './client.js';
import { seedBenchmarks } from '../engine/benchmarks/seed.js';
import { seedDemo } from './demo.js';

export const PLATFORM_ORG_SLUG = 'aix-platform';

export async function seed(db: DB, opts: { demo: boolean }) {
  // Role permissions
  for (const [role, perms] of Object.entries(ROLE_PERMISSIONS)) {
    for (const permission of perms) {
      await db.insert(schema.rolePermissions).values({ role, permission }).onConflictDoNothing();
    }
  }

  // Domains & skills
  for (const [i, d] of DOMAINS.entries()) {
    const [row] = await db.insert(schema.capabilityDomains).values({
      slug: d.slug, name: d.name, icon: d.icon, highImpact: !!d.highImpact, weights: domainWeights(d), sortOrder: i,
      description: d.quickAssessment === false ? `Professional evaluation covering ${d.skills.join(', ')}.` : `Benchmarks covering ${d.skills.join(', ')}.`,
    }).onConflictDoUpdate({ target: schema.capabilityDomains.slug, set: { name: d.name, weights: domainWeights(d), sortOrder: i } }).returning();
    for (const s of d.skills) {
      await db.insert(schema.capabilitySkills).values({ domainId: row!.id, slug: s, name: s.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) }).onConflictDoNothing();
    }
  }

  // Providers
  for (const p of PROVIDERS) {
    await db.insert(schema.agentProviders).values({
      slug: p.slug, name: p.name, adapter: p.adapter, defaultBaseUrl: p.baseUrl, defaultModels: [...p.models],
      capabilities: { chat: true, tools: ['openai_compatible', 'anthropic', 'gemini', 'mcp'].includes(p.adapter), fine_tuning: ['openai', 'mistral'].includes(p.slug) },
      status: ['a2a', 'mcp'].includes(p.adapter) ? 'beta' : 'active',
    }).onConflictDoNothing();
  }

  // Platform org + wallets (platform revenue + external counterparty)
  let [platformOrg] = await db.select().from(schema.organisations).where(eq(schema.organisations.slug, PLATFORM_ORG_SLUG));
  if (!platformOrg) {
    [platformOrg] = await db.insert(schema.organisations).values({ name: 'Hive Mind Platform', slug: PLATFORM_ORG_SLUG, type: 'enterprise', plan: 'enterprise' }).returning();
  }
  for (const kind of ['platform', 'external']) {
    await db.insert(schema.wallets).values({ orgId: platformOrg!.id, kind }).onConflictDoNothing();
  }

  // Default commission
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.commissionRules);
  if (!n) await db.insert(schema.commissionRules).values({ scope: 'global', rateBps: DEFAULT_COMMISSION_BPS });

  // Token packages: reference data for the DORMANT fiat path only (FIAT_ENABLED=false by default → never offered;
  // GET /wallet/packages answers 410). Hive Mind is IDLE-only: tokens come from the welcome bonus and from earnings.
  const [{ c }] = await db.select({ c: sql<number>`count(*)::int` }).from(schema.creditPackages);
  if (!c) {
    await db.insert(schema.creditPackages).values([
      { name: 'Starter', credits: 1000, bonusCredits: 0, priceMinor: 100000, sortOrder: 1 },
      { name: 'Builder', credits: 5000, bonusCredits: 250, priceMinor: 500000, sortOrder: 2 },
      { name: 'Scale', credits: 20000, bonusCredits: 2000, priceMinor: 2000000, sortOrder: 3 },
    ]);
  }

  // Platform administrator (dev credentials from env; MUST be changed in production)
  const adminEmail = (process.env.ADMIN_EMAIL ?? 'admin@aix.local').toLowerCase();
  const [admin] = await db.select().from(schema.users).where(eq(schema.users.email, adminEmail));
  if (!admin) {
    const password = process.env.ADMIN_PASSWORD ?? 'AixAdmin!2026';
    const [u] = await db.insert(schema.users).values({
      email: adminEmail, name: 'Hive Mind Administrator', passwordHash: await bcrypt.hash(password, 10),
      platformRole: 'super_admin', emailVerifiedAt: new Date(), defaultOrgId: platformOrg!.id,
    }).returning();
    await db.insert(schema.memberships).values({ orgId: platformOrg!.id, userId: u!.id, role: 'owner' });
  }

  await db.insert(schema.systemSettings).values({ key: 'platform', value: { maintenance: false, signupsOpen: true } }).onConflictDoNothing();

  // Brand renames (AIX → StringMind → Hive Mind): refresh display names on rows seeded before the rename.
  // Only rows still carrying the exact legacy seed name are touched; slugs/emails/ids never change.
  await db.update(schema.organisations).set({ name: 'Hive Mind Platform' }).where(sql`${schema.organisations.slug} = ${PLATFORM_ORG_SLUG} and ${schema.organisations.name} in ('AIX Platform', 'StringMind Platform')`);
  await db.update(schema.organisations).set({ name: 'Hive Mind Demo Labs' }).where(sql`${schema.organisations.name} in ('AIX Demo Labs', 'StringMind Demo Labs')`);
  await db.update(schema.users).set({ name: 'Hive Mind Administrator' }).where(sql`${schema.users.email} = ${adminEmail} and ${schema.users.name} in ('AIX Administrator', 'StringMind Administrator')`);
  await db.update(schema.agentProviders).set({ name: 'Hive Mind Sandbox Agent' }).where(sql`${schema.agentProviders.slug} = 'sandbox' and ${schema.agentProviders.name} in ('AIX Sandbox Agent', 'StringMind Sandbox Agent')`);

  await seedBenchmarks(db);
  if (opts.demo) await seedDemo(db);
  if (opts.demo) await seedDemoDebates(db);
}
