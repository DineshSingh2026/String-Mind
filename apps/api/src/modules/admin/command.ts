/**
 * Admin command centre: ONE read-only endpoint that powers the admin home dashboard.
 * Every number is a live aggregate of real rows (no estimates, no fabricated trend data).
 * The platform's own org is excluded from member/economy figures: admins control the platform, they are not participants.
 */
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { CREDIT_CURRENCY } from '@aix/shared';
import { db, schema } from '../../db/client.js';
import { PLATFORM_ORG_SLUG } from '../../db/seed.js';

const n = (v: unknown) => Number(v ?? 0);
const DAYS = 14;

/** Daily counts for the last DAYS days (zero-filled), oldest first. Table/column/where are static strings from this file only. */
async function daily(table: string, where = 'true'): Promise<{ date: string; value: number }[]> {
  const r = await db().execute(sql.raw(
    `select to_char(d::date, 'YYYY-MM-DD') as date, coalesce(c.n, 0)::int as value
       from generate_series(current_date - ${DAYS - 1}, current_date, interval '1 day') d
       left join (select created_at::date as day, count(*) as n from ${table} where ${where} and created_at >= current_date - ${DAYS - 1} group by 1) c on c.day = d::date
      order by d`));
  return (r.rows as { date: string; value: number }[]).map((x) => ({ date: x.date, value: n(x.value) }));
}

export default async function command(app: FastifyInstance) {
  app.get('/command-center', async () => {
    const d = db();
    const one = async <T,>(q: Promise<T[]>) => (await q)[0];
    const by = (rows: { k: string | null; n: number }[]) => Object.fromEntries(rows.map((r) => [r.k ?? 'unknown', n(r.n)]));

    const [platformOrg] = await d.select({ id: schema.organisations.id }).from(schema.organisations).where(eq(schema.organisations.slug, PLATFORM_ORG_SLUG)).limit(1);
    const notPlatformWallet = platformOrg ? sql`${schema.wallets.orgId} <> ${platformOrg.id}` : sql`true`;
    const notPlatformTx = platformOrg ? sql`${schema.transactions.orgId} <> ${platformOrg.id}` : sql`true`;

    const [users, orgs, agents, sessions, listings, debates, certs, comm, circ, locked, revenue, welcome, openDisputes, openFlags, highFlags, openReports, humanReview, failedJobs, queuedJobs, recon, payoutsPending, pendingVerify, suspendedAgents, mfa] = await Promise.all([
      one(d.select({
        total: sql<number>`count(*) filter (where platform_role = 'user')::int`, active: sql<number>`count(*) filter (where platform_role = 'user' and status = 'active')::int`,
        suspended: sql<number>`count(*) filter (where status = 'suspended')::int`, admins: sql<number>`count(*) filter (where platform_role <> 'user')::int`,
        new7: sql<number>`count(*) filter (where platform_role = 'user' and created_at >= now() - interval '7 days')::int`,
        prev7: sql<number>`count(*) filter (where platform_role = 'user' and created_at >= now() - interval '14 days' and created_at < now() - interval '7 days')::int`,
        online24: sql<number>`count(*) filter (where last_login_at >= now() - interval '24 hours')::int`,
      }).from(schema.users).where(isNull(schema.users.deletedAt))),
      one(d.select({ total: sql<number>`count(*)::int` }).from(schema.organisations).where(sql`slug <> ${PLATFORM_ORG_SLUG}`)),
      one(d.select({
        total: sql<number>`count(*)::int`, active: sql<number>`count(*) filter (where status = 'active')::int`, verified: sql<number>`count(*) filter (where verification_status = 'verified')::int`,
        isPublic: sql<number>`count(*) filter (where is_public)::int`, avg: sql<number>`coalesce(avg(overall_score),0)::float`,
        new7: sql<number>`count(*) filter (where created_at >= now() - interval '7 days')::int`, prev7: sql<number>`count(*) filter (where created_at >= now() - interval '14 days' and created_at < now() - interval '7 days')::int`,
      }).from(schema.agents).where(isNull(schema.agents.deletedAt))),
      one(d.select({
        total: sql<number>`count(*)::int`, live: sql<number>`count(*) filter (where status in ('active','paused'))::int`, completed: sql<number>`count(*) filter (where status = 'completed')::int`,
        failed: sql<number>`count(*) filter (where status = 'failed')::int`, disputed: sql<number>`count(*) filter (where status = 'disputed')::int`,
        new7: sql<number>`count(*) filter (where created_at >= now() - interval '7 days')::int`, prev7: sql<number>`count(*) filter (where created_at >= now() - interval '14 days' and created_at < now() - interval '7 days')::int`,
      }).from(schema.trainingSessions)),
      one(d.select({ active: sql<number>`count(*) filter (where status = 'active' and moderation = 'visible')::int`, underReview: sql<number>`count(*) filter (where moderation = 'under_review')::int`, total: sql<number>`count(*)::int` }).from(schema.marketplaceListings)),
      one(d.select({ total: sql<number>`count(*)::int`, live: sql<number>`count(*) filter (where status in ('live','voting'))::int` }).from(schema.debates)),
      one(d.select({ total: sql<number>`count(*) filter (where level <> 'none')::int` }).from(schema.agentCertifications)),
      one(d.select({ total: sql<number>`coalesce(sum(commission_credits),0)::bigint` }).from(schema.trainingSessions).where(eq(schema.trainingSessions.settlementStatus, 'settled'))),
      one(d.select({ total: sql<number>`coalesce(sum(available + locked + withdrawable),0)::bigint` }).from(schema.wallets).where(and(eq(schema.wallets.kind, 'org'), notPlatformWallet))),
      one(d.select({ total: sql<number>`coalesce(sum(locked),0)::bigint` }).from(schema.wallets).where(and(eq(schema.wallets.kind, 'org'), notPlatformWallet))),
      one(d.select({ total: sql<number>`coalesce(sum(available + withdrawable),0)::bigint` }).from(schema.wallets).where(eq(schema.wallets.kind, 'platform'))),
      one(d.select({ count: sql<number>`count(*)::int`, total: sql<number>`coalesce(sum(amount),0)::bigint` }).from(schema.transactions).where(and(eq(schema.transactions.type, 'welcome_bonus'), notPlatformTx))),
      one(d.select({ n: sql<number>`count(*)::int` }).from(schema.disputes).where(sql`status in ('open','under_review')`)),
      one(d.select({ n: sql<number>`count(*)::int` }).from(schema.fraudFlags).where(eq(schema.fraudFlags.status, 'open'))),
      one(d.select({ n: sql<number>`count(*)::int` }).from(schema.fraudFlags).where(and(eq(schema.fraudFlags.status, 'open'), eq(schema.fraudFlags.severity, 'high')))),
      one(d.select({ n: sql<number>`count(*)::int` }).from(schema.reports).where(eq(schema.reports.status, 'open'))),
      one(d.select({ n: sql<number>`count(*)::int` }).from(schema.assessmentResults).where(eq(schema.assessmentResults.needsHumanReview, true))),
      one(d.select({ n: sql<number>`count(*)::int` }).from(schema.jobs).where(eq(schema.jobs.status, 'failed'))),
      one(d.select({ n: sql<number>`count(*)::int` }).from(schema.jobs).where(eq(schema.jobs.status, 'queued'))),
      one(d.select({ n: sql<number>`count(*)::int` }).from(schema.walletReconciliationIssues).where(eq(schema.walletReconciliationIssues.status, 'open'))),
      one(d.select({ n: sql<number>`count(*)::int` }).from(schema.payouts).where(eq(schema.payouts.status, 'requested'))),
      one(d.select({ n: sql<number>`count(*)::int` }).from(schema.agents).where(and(isNull(schema.agents.deletedAt), eq(schema.agents.verificationStatus, 'pending')))),
      one(d.select({ n: sql<number>`count(*)::int` }).from(schema.agents).where(and(isNull(schema.agents.deletedAt), eq(schema.agents.status, 'suspended')))),
      one(d.select({ n: sql<number>`count(*) filter (where mfa_enabled)::int`, t: sql<number>`count(*)::int` }).from(schema.users).where(and(isNull(schema.users.deletedAt), sql`platform_role <> 'user'`))),
    ]);

    const [agentStatus, sessionStatus, health, providers, levels, jobStatus] = await Promise.all([
      d.select({ k: schema.agents.status, n: sql<number>`count(*)::int` }).from(schema.agents).where(isNull(schema.agents.deletedAt)).groupBy(schema.agents.status),
      d.select({ k: schema.trainingSessions.status, n: sql<number>`count(*)::int` }).from(schema.trainingSessions).groupBy(schema.trainingSessions.status),
      d.select({ k: schema.agents.health, n: sql<number>`count(*)::int` }).from(schema.agents).where(isNull(schema.agents.deletedAt)).groupBy(schema.agents.health),
      d.select({ k: schema.agentProviders.status, n: sql<number>`count(*)::int` }).from(schema.agentProviders).groupBy(schema.agentProviders.status),
      d.select({ k: schema.agentCertifications.level, n: sql<number>`count(*)::int` }).from(schema.agentCertifications).groupBy(schema.agentCertifications.level),
      d.select({ k: schema.jobs.status, n: sql<number>`count(*)::int` }).from(schema.jobs).groupBy(schema.jobs.status),
    ]);

    const [signups, sessionsDaily, agentsDaily, txDaily] = await Promise.all([
      daily('users', `platform_role = 'user' and deleted_at is null`), daily('training_sessions'), daily('agents', 'deleted_at is null'),
      daily('transactions', `type <> 'welcome_bonus' and status = 'posted'`),
    ]);

    const topAgents = await d.select({ id: schema.agents.id, name: schema.agents.name, score: schema.agents.overallScore, verification: schema.agents.verificationStatus, orgName: schema.organisations.name })
      .from(schema.agents).innerJoin(schema.organisations, eq(schema.organisations.id, schema.agents.orgId))
      .where(and(isNull(schema.agents.deletedAt), sql`${schema.agents.overallScore} is not null`)).orderBy(desc(schema.agents.overallScore)).limit(5);

    const recent = await d.select({ id: schema.auditLogs.id, action: schema.auditLogs.action, actorType: schema.auditLogs.actorType, targetType: schema.auditLogs.targetType, createdAt: schema.auditLogs.createdAt, email: schema.users.email })
      .from(schema.auditLogs).leftJoin(schema.users, eq(schema.users.id, schema.auditLogs.actorUserId)).orderBy(desc(schema.auditLogs.createdAt)).limit(14);

    return {
      generatedAt: new Date().toISOString(), currency: CREDIT_CURRENCY,
      members: { total: n(users?.total), active: n(users?.active), suspended: n(users?.suspended), admins: n(users?.admins), new7: n(users?.new7), prev7: n(users?.prev7), signedIn24h: n(users?.online24), orgs: n(orgs?.total) },
      agents: { total: n(agents?.total), active: n(agents?.active), verified: n(agents?.verified), public: n(agents?.isPublic), avgScore: Math.round(n(agents?.avg) * 10) / 10, new7: n(agents?.new7), prev7: n(agents?.prev7), byStatus: by(agentStatus), byHealth: by(health), suspended: n(suspendedAgents?.n) },
      training: { total: n(sessions?.total), live: n(sessions?.live), completed: n(sessions?.completed), failed: n(sessions?.failed), disputed: n(sessions?.disputed), new7: n(sessions?.new7), prev7: n(sessions?.prev7), byStatus: by(sessionStatus) },
      marketplace: { activeListings: n(listings?.active), listingsUnderReview: n(listings?.underReview), listingsTotal: n(listings?.total), debates: n(debates?.total), liveDebates: n(debates?.live), certifications: n(certs?.total), certificationLevels: by(levels) },
      economy: { currency: CREDIT_CURRENCY, inCirculation: n(circ?.total), lockedInEscrow: n(locked?.total), platformRevenue: n(revenue?.total), commissionEarned: n(comm?.total), welcomeBonuses: n(welcome?.count), welcomeIssued: n(welcome?.total) },
      attention: {
        disputes: n(openDisputes?.n), fraudFlags: n(openFlags?.n), highSeverityFraud: n(highFlags?.n), reports: n(openReports?.n), humanReview: n(humanReview?.n),
        failedJobs: n(failedJobs?.n), reconciliation: n(recon?.n), payouts: n(payoutsPending?.n), pendingVerification: n(pendingVerify?.n), listingsUnderReview: n(listings?.underReview),
      },
      ops: { jobs: by(jobStatus), queued: n(queuedJobs?.n), providers: by(providers), adminMfa: { enabled: n(mfa?.n), total: n(mfa?.t) } },
      series: { signups, sessions: sessionsDaily, agents: agentsDaily, transactions: txDaily },
      topAgents, recent,
    };
  });
}
