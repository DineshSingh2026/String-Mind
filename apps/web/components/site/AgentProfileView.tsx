'use client';
/** Public agent profile from GET /marketplace/agents/:slug (+ reviews from /marketplace/agents/:slug/reviews if not embedded). */
import './pages/pages.css';
import Link from 'next/link';
import { motion, useReducedMotion } from 'framer-motion';
import {
  Activity, ArrowLeft, ArrowRight, BadgeCheck, Bot, Clock, Cpu, GraduationCap, Languages, ShieldCheck, Sparkles, Star, Target, Timer, Wrench,
} from 'lucide-react';
import { DOMAINS, QUALITY, REPUTATION_LEVELS } from '@aix/shared';
import { useApi } from '@/lib/api';
import { Avatar, Button, EmptyState, ErrorState, fmtDate, fmtNumber } from '@/components/ui';
import { AuroraBackground, CountUp, Reveal, SpotlightCard, Stagger, StaggerItem } from '@/components/fx';
import { reputationLabel } from './AgentCard';
import { DomainIcon, domainName } from './DomainIcon';
import { ScoreRingFx, scoreColor } from './pages/ScoreRingFx';
import { cx } from './primitives';
import { providerName, toItems, type AgentProfile, type Paged, type Review, type ScoreDomain } from './types';
import { FollowButton } from '@/components/social/FollowButton';
import { ProfileBadgeRow, ProfileExtras } from '@/components/social/ProfileExtras';
import { CertificationBadges } from '@/components/evaluation/CertificationBadges';
import { ReportButton } from '@/components/safety/ReportButton';

type Avail = { status?: string; health?: string; acceptsTraining?: boolean; acceptsLearning?: boolean; lastHealthCheckAt?: string };
type Listing = NonNullable<AgentProfile['listings']>[number] & { domainName?: string; settlementMode?: string; skills?: string[] };

function Panel({ title, subtitle, children, className, icon }: { title: string; subtitle?: string; children: React.ReactNode; className?: string; icon?: React.ReactNode }) {
  return (
    <section className={cx('aix-panel rounded-3xl', className)}>
      <header className="flex items-start gap-3 border-b border-line/50 px-5 py-4 sm:px-6">
        {icon && <span aria-hidden className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-electric/10 text-electric-soft ring-1 ring-electric/25">{icon}</span>}
        <div className="min-w-0"><h2 className="text-[15px] font-semibold text-fg">{title}</h2>{subtitle && <p className="mt-0.5 text-xs text-fg-muted">{subtitle}</p>}</div>
      </header>
      <div className="p-5 sm:p-6">{children}</div>
    </section>
  );
}

/** Radar of verified domain scores (only rendered with ≥3 real scores). */
function ScoreRadar({ domains }: { domains: ScoreDomain[] }) {
  const reduce = useReducedMotion();
  const pts = domains.filter((d) => typeof d.score === 'number');
  const n = pts.length; const R = 110; const C = 150;
  const at = (i: number, v: number) => { const a = (Math.PI * 2 * i) / n - Math.PI / 2; return [C + Math.cos(a) * R * v, C + Math.sin(a) * R * v]; };
  const poly = pts.map((d, i) => at(i, (d.score as number) / 100).join(',')).join(' ');
  return (
    <svg viewBox="0 0 300 300" className="mx-auto w-full max-w-[320px]" role="img" aria-label={`Radar of ${n} verified domain scores`}>
      <defs>
        <radialGradient id="radar-fill"><stop offset="0%" stopColor="rgb(var(--gold))" stopOpacity=".45" /><stop offset="100%" stopColor="rgb(var(--electric))" stopOpacity=".15" /></radialGradient>
      </defs>
      {[0.25, 0.5, 0.75, 1].map((r) => <polygon key={r} points={pts.map((_, i) => at(i, r).join(',')).join(' ')} fill="none" stroke="rgb(var(--line))" strokeOpacity={r === 1 ? 0.9 : 0.45} strokeDasharray={r === 1 ? undefined : '3 4'} />)}
      {pts.map((_, i) => { const [x, y] = at(i, 1); return <line key={i} x1={C} y1={C} x2={x} y2={y} stroke="rgb(var(--line))" strokeOpacity=".5" />; })}
      <motion.polygon points={poly} fill="url(#radar-fill)" stroke="rgb(var(--gold-soft))" strokeWidth="1.5" style={{ transformOrigin: '150px 150px' }}
        initial={reduce ? false : { scale: 0, opacity: 0 }} whileInView={{ scale: 1, opacity: 1 }} viewport={{ once: true }} transition={{ duration: 1, ease: [0.2, 0.7, 0.2, 1] }} />
      {pts.map((d, i) => { const [x, y] = at(i, (d.score as number) / 100); return <circle key={d.slug} cx={x} cy={y} r="3.5" fill={scoreColor(d.score)} stroke="rgb(var(--ink-950))" strokeWidth="1.5" />; })}
      {pts.map((d, i) => { const [x, y] = at(i, 1.18); return <text key={d.slug} x={x} y={y} textAnchor="middle" dominantBaseline="middle" className="fill-[rgb(var(--fg-muted))] text-[9px]">{(d.name ?? domainName(d.slug) ?? '').split(' ')[0]}</text>; })}
    </svg>
  );
}

function DomainBar({ d, i }: { d: ScoreDomain; i: number }) {
  const reduce = useReducedMotion();
  const has = typeof d.score === 'number';
  return (
    <li className="group rounded-2xl border border-line/50 bg-ink-950/40 p-4 transition hover:border-ink-600">
      <div className="flex items-center gap-3">
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-electric/10 text-electric-soft ring-1 ring-electric/25"><DomainIcon slug={d.slug} className="h-4 w-4" /></span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-fg">{d.name ?? domainName(d.slug)}</p>
          <p className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-fg-subtle">
            {d.accuracy != null && <span>Accuracy {Math.round(d.accuracy)}%</span>}
            {d.confidence != null && <span>· Confidence {Math.round(d.confidence * 100)}%</span>}
            <span>· {d.sampleSize != null ? `n = ${d.sampleSize}` : 'sample size not reported'}</span>
          </p>
        </div>
        <span className="font-display text-2xl font-semibold tabular-nums" style={{ color: has ? scoreColor(d.score) : undefined }}>{has ? <CountUp value={d.score as number} decimals={(d.score as number) % 1 ? 1 : 0} /> : '—'}</span>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-ink-800" aria-hidden>
        {has && <motion.div className="h-full rounded-full" style={{ background: `linear-gradient(90deg, ${scoreColor(d.score, 0.5)}, ${scoreColor(d.score)})` }}
          initial={reduce ? false : { width: 0 }} whileInView={{ width: `${d.score}%` }} viewport={{ once: true }} transition={{ duration: 1, delay: i * 0.08, ease: 'easeOut' }} />}
      </div>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {d.verified && <span className="inline-flex items-center gap-1 rounded-full border border-electric/30 bg-electric/10 px-2 py-0.5 text-[10.5px] text-electric-soft"><BadgeCheck aria-hidden className="h-3 w-3" />Verified</span>}
        {d.meetsTarget && <span className="inline-flex items-center gap-1 rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-[10.5px] text-success-soft"><Target aria-hidden className="h-3 w-3" />Meets {QUALITY.ACCURACY_TARGET}% target</span>}
      </div>
    </li>
  );
}

function DomainCoverage({ domains }: { domains: ScoreDomain[] }) {
  const reduce = useReducedMotion();
  const by = new Map(domains.filter((d) => typeof d.score === 'number').map((d) => [d.slug, d]));
  return (
    <div className="mt-6 border-t border-line/50 pt-5">
      <p className="flex items-center justify-between text-xs text-fg-subtle"><span>Domain coverage</span><span><span className="font-semibold text-fg">{by.size}</span> of {DOMAINS.length} domains assessed</span></p>
      <ul className="mt-3 grid grid-cols-5 gap-1.5 sm:grid-cols-10">
        {DOMAINS.map((d, i) => {
          const hit = by.get(d.slug);
          return (
            <motion.li key={d.slug} title={hit ? `${d.name}: ${hit.score}` : `${d.name}: not assessed`}
              initial={reduce ? false : { opacity: 0, scale: 0.8 }} whileInView={{ opacity: 1, scale: 1 }} viewport={{ once: true }} transition={{ delay: i * 0.025 }}
              className={cx('flex aspect-square items-center justify-center rounded-lg border', hit ? 'border-transparent text-ink-950' : 'border-line/50 bg-ink-950/40 text-fg-subtle/60')}
              style={hit ? { background: `linear-gradient(135deg, ${scoreColor(hit.score)}, ${scoreColor(hit.score, 0.55)})`, boxShadow: `0 0 18px -4px ${scoreColor(hit.score, 0.7)}` } : undefined}>
              <DomainIcon icon={d.icon} className="h-3.5 w-3.5" />
              <span className="sr-only">{d.name}: {hit ? `score ${hit.score}` : 'not assessed'}</span>
            </motion.li>
          );
        })}
      </ul>
    </div>
  );
}

function ReputationLadder({ level, score }: { level?: string | null; score?: number | null }) {
  const reduce = useReducedMotion();
  const idx = Math.max(0, REPUTATION_LEVELS.findIndex((l) => l.slug === level));
  const next = REPUTATION_LEVELS[idx + 1];
  const s = typeof score === 'number' ? score : null;
  return (
    <div>
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="text-xs text-fg-subtle">Current level</p>
          <p className="mt-1 font-display text-lg font-semibold text-gold-gradient">{REPUTATION_LEVELS[idx]?.name ?? '—'}</p>
        </div>
        <p className="text-right text-xs text-fg-subtle">Reputation score<br /><span className="font-display text-xl font-semibold text-fg tabular-nums">{s != null ? <CountUp value={s} /> : '—'}</span><span className="text-fg-subtle">/100</span></p>
      </div>
      <ol className="mt-5 grid grid-cols-6 gap-1.5" aria-label="Reputation levels">
        {REPUTATION_LEVELS.map((l, i) => (
          <li key={l.slug} title={`${l.name} · ${l.min}+`} className="relative">
            <div className="h-2 overflow-hidden rounded-full bg-ink-800">
              <motion.div className={cx('h-full rounded-full', i === REPUTATION_LEVELS.length - 1 ? 'bg-gold-sheen' : 'bg-gradient-to-r from-electric to-violet')}
                initial={reduce ? false : { width: 0 }} whileInView={{ width: i < idx ? '100%' : i === idx ? (next && s != null ? `${Math.max(8, Math.min(100, ((s - l.min) / (next.min - l.min)) * 100))}%` : '100%') : '0%' }}
                viewport={{ once: true }} transition={{ duration: 0.7, delay: i * 0.1 }} />
            </div>
            <span className="sr-only">{l.name}{i === idx ? ' (current)' : ''}</span>
          </li>
        ))}
      </ol>
      <p className="mt-3 text-xs text-fg-subtle">{next ? <>Next: <span className="text-fg-muted">{next.name}</span> at {next.min} points. </> : 'Highest level reached. '}Computed from verified scores, completed sessions, learner improvement, reviews and disputes.</p>
    </div>
  );
}

export function AgentProfileView({ slug }: { slug: string }) {
  const reduce = useReducedMotion();
  const { data: a, error, isLoading, mutate } = useApi<AgentProfile>(`/marketplace/agents/${encodeURIComponent(slug)}`, { shouldRetryOnError: false });
  const embedded = a?.reviews ? toItems(a.reviews as Review[] | Paged<Review>) : null;
  const rv = useApi<Review[] | Paged<Review>>(a && !embedded ? `/marketplace/agents/${encodeURIComponent(slug)}/reviews` : null, { shouldRetryOnError: false });
  const reviews = embedded ?? toItems(rv.data);
  const requestHref = `/sign-in?next=${encodeURIComponent(`/app/marketplace/${slug}`)}`;

  if (isLoading) return (
    <div className="container-x space-y-4 py-10" aria-busy="true">
      <div className="aix-shimmer h-56 rounded-3xl" />
      <div className="grid gap-4 lg:grid-cols-3"><div className="aix-shimmer h-80 rounded-3xl lg:col-span-2" /><div className="aix-shimmer h-80 rounded-3xl" /></div>
    </div>
  );
  if (error?.status === 404) return <div className="container-x py-16"><EmptyState icon={<Bot className="h-6 w-6" />} title="Agent not found" description="This agent doesn’t exist or isn’t public." action={<Button variant="primary" href="/marketplace">Browse the marketplace</Button>} /></div>;
  if (error || !a) return <div className="container-x py-16"><ErrorState error={error ?? 'Agent unavailable'} onRetry={() => mutate()} /></div>;

  const domains: ScoreDomain[] = a.scorecard?.domains ?? a.verifiedDomains?.map((d) => ({ ...d, verified: true })) ?? [];
  const scored = domains.filter((d) => typeof d.score === 'number');
  const overall = a.scorecard?.overallScore ?? a.overallScore ?? null;
  const repSlug = a.reputation?.level ?? a.reputationLevel;
  const rep = reputationLabel(repSlug);
  const tools = (a.tools ?? []).map((t) => (typeof t === 'string' ? t : t.name));
  const avail = (a.availability && typeof a.availability === 'object' ? a.availability : null) as Avail | null;
  const listings = (a.listings ?? []) as Listing[];
  const totalSamples = scored.reduce((s, d) => s + (d.sampleSize ?? 0), 0);

  const kpis = [
    { label: 'Verified domains', value: scored.filter((d) => d.verified !== false).length, icon: <BadgeCheck className="h-4 w-4" /> },
    { label: 'Graded responses', value: totalSamples || null, icon: <Activity className="h-4 w-4" /> },
    { label: 'Sessions completed', value: a.sessionsCompleted ?? 0, icon: <GraduationCap className="h-4 w-4" /> },
    { label: 'Reviews', value: a.ratingCount ?? 0, icon: <Star className="h-4 w-4" /> },
  ];

  return (
    <div>
      {/* hero */}
      <header className="aix-grain relative isolate overflow-hidden border-b border-line/40">
        <AuroraBackground palette="ai" intensity="subtle" className="-z-10" />
        <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-32 bg-gradient-to-b from-transparent to-ink-950" />
        <div className="container-x py-8 sm:py-12">
          <Link href="/marketplace" className="inline-flex items-center gap-1.5 rounded-full border border-line/60 bg-ink-900/50 px-3 py-1.5 text-xs text-fg-muted backdrop-blur transition hover:text-fg"><ArrowLeft aria-hidden className="h-3.5 w-3.5" />Back to marketplace</Link>
          <div className="mt-8 flex flex-col gap-8 lg:flex-row lg:items-center">
            <motion.div initial={reduce ? false : { opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.6 }} className="relative w-fit">
              <span aria-hidden className="aix-pulse-ring absolute -inset-2 rounded-[32px] border border-electric/40" />
              <span aria-hidden className="absolute -inset-3 rounded-[34px] bg-gradient-to-br from-electric/30 via-violet/20 to-gold/25 blur-xl" />
              <Avatar name={a.name} seed={a.id} src={a.avatar} size={112} className="relative rounded-[28px] ring-1 ring-white/15" />
            </motion.div>
            <div className="min-w-0 flex-1">
              <motion.div initial={reduce ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, delay: 0.1 }}>
                <div className="flex flex-wrap items-center gap-2">
                  {rep && <span className="inline-flex items-center gap-1 rounded-full border border-gold/35 bg-gold/10 px-2.5 py-0.5 text-[11px] font-medium text-gold-soft"><Sparkles aria-hidden className="h-3 w-3" />{rep}</span>}
                  {a.verificationStatus === 'verified' && <span className="inline-flex items-center gap-1 rounded-full border border-success/30 bg-success/10 px-2.5 py-0.5 text-[11px] text-success-soft"><BadgeCheck aria-hidden className="h-3 w-3" />Verified</span>}
                  {avail?.health && <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-ink-900/60 px-2.5 py-0.5 text-[11px] text-fg-muted"><span aria-hidden className={cx('h-1.5 w-1.5 rounded-full', avail.health === 'healthy' ? 'bg-success' : 'bg-warning')} />Connection {avail.health}</span>}
                </div>
                <h1 className="mt-3 text-4xl font-semibold tracking-[-0.02em] sm:text-5xl">{a.name}</h1>
                {a.description && <p className="mt-3 max-w-2xl text-fg-muted sm:text-lg">{a.description}</p>}
                <ProfileBadgeRow slug={a.slug ?? slug} className="mt-4" />
                <CertificationBadges slug={a.slug ?? slug} className="mt-2" />
                <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1.5 text-sm text-fg-muted">
                  {providerName(a.provider) && <span className="inline-flex items-center gap-1.5"><Cpu aria-hidden className="h-4 w-4 text-fg-subtle" />{providerName(a.provider)}{a.modelName ? ` · ${a.modelName}` : ''}</span>}
                  {a.owner?.name && <span>by <span className="text-fg">{a.owner.name}</span></span>}
                  {a.rating != null && a.ratingCount ? <span className="inline-flex items-center gap-1"><Star aria-hidden className="h-4 w-4 fill-gold text-gold" />{a.rating.toFixed(1)} ({fmtNumber(a.ratingCount)})</span> : <span>No reviews yet</span>}
                </div>
              </motion.div>
            </div>
            <motion.div initial={reduce ? false : { opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.6, delay: 0.2 }}
              className="aix-panel flex items-center gap-5 rounded-3xl p-5 lg:flex-col lg:items-stretch lg:p-6">
              <div className="flex items-center gap-4">
                <ScoreRingFx score={overall} size={104} stroke={7} label="Overall verified score" showLabel />
                <div className="text-xs leading-relaxed text-fg-subtle">Overall<br />verified score{a.scorecard?.lastAssessedAt && <><br />Assessed {fmtDate(a.scorecard.lastAssessedAt)}</>}</div>
              </div>
              <Button variant="ai" size="lg" href={requestHref} icon={<GraduationCap className="h-4 w-4" />} className="shrink-0 rounded-2xl">Request training</Button>
              <div className="flex items-center gap-2">
                <FollowButton targetType="agent" targetId={a.id} className="flex-1" />
                <ReportButton targetType="agent" targetId={a.id} label="Report this agent" className="btn-ghost h-10 !px-3" />
              </div>
            </motion.div>
          </div>

          <Stagger className="mt-10 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {kpis.map((k) => (
              <StaggerItem key={k.label}>
                <div className="aix-panel rounded-2xl px-4 py-3.5">
                  <p className="flex items-center gap-2 text-xs text-fg-muted"><span aria-hidden className="text-electric-soft">{k.icon}</span>{k.label}</p>
                  <p className="mt-1.5 font-display text-2xl font-semibold tabular-nums"><CountUp value={k.value} /></p>
                </div>
              </StaggerItem>
            ))}
          </Stagger>
        </div>
      </header>

      <div className="container-x grid gap-6 py-10 sm:py-14 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <Reveal>
            <Panel title="Capability scorecard" icon={<Target className="h-4 w-4" />} subtitle={`Independently assessed on held-out questions. “Meets target” needs ≥${QUALITY.MIN_SAMPLE_FOR_TARGET_CLAIM} graded responses.`}>
              {scored.length === 0 ? <p className="text-sm text-fg-muted">No verified domain scores yet.</p> : (
                <div className={cx('grid gap-6', scored.length >= 3 && 'md:grid-cols-[1fr_1.1fr] md:items-center')}>
                  {scored.length >= 3 && <ScoreRadar domains={scored} />}
                  <ul className="space-y-3">{domains.map((d, i) => <DomainBar key={d.slug} d={d} i={i} />)}</ul>
                </div>
              )}
              <DomainCoverage domains={domains} />
              {a.scorecard?.testsCompleted ? <p className="mt-4 text-xs text-fg-subtle">{fmtNumber(a.scorecard.testsCompleted)} tests completed</p> : null}
            </Panel>
          </Reveal>

          <ProfileExtras slug={a.slug ?? slug} roomHref={(id) => `/rooms/${id}`} />

          <Reveal>
            <Panel title="Training listings" icon={<GraduationCap className="h-4 w-4" />} subtitle="Prices in IDLE Tokens. IDLE is escrowed when the trainer accepts.">
              {!listings.length ? <p className="text-sm text-fg-muted">This agent has no active training listings.</p> : (
                <Stagger className="space-y-3">
                  {listings.map((l) => (
                    <StaggerItem key={l.id}>
                      <SpotlightCard glow="violet" className="group">
                        <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center">
                          <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-violet/30 to-electric/10 text-violet-soft ring-1 ring-violet/30"><DomainIcon slug={l.domainSlug} className="h-5 w-5" /></span>
                          <div className="min-w-0 flex-1">
                            <p className="font-medium text-fg">{l.title}</p>
                            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-subtle">
                              <span>{l.domainName ?? domainName(l.domainSlug)}</span>
                              {l.durationMinutes ? <span className="inline-flex items-center gap-1"><Timer aria-hidden className="h-3 w-3" />{l.durationMinutes} min</span> : null}
                              {l.pricingModel && <span>{l.pricingModel.replace(/_/g, ' ')}</span>}
                              {l.settlementMode && <span>settles {l.settlementMode.replace(/_/g, ' ')}</span>}
                            </p>
                            {l.description && <p className="mt-2 line-clamp-2 text-sm text-fg-muted">{l.description}</p>}
                          </div>
                          <div className="flex items-center gap-3 sm:flex-col sm:items-end">
                            <p className="font-display text-2xl font-semibold text-gold-gradient">{l.priceCredits === 0 ? 'Free' : <>{fmtNumber(l.priceCredits)}<span className="ml-1 text-sm text-gold">IDLE</span></>}</p>
                            <Button variant="ai" size="sm" href={requestHref} className="rounded-xl">Request training <ArrowRight className="h-3.5 w-3.5 transition group-hover:translate-x-0.5" /></Button>
                          </div>
                        </div>
                      </SpotlightCard>
                    </StaggerItem>
                  ))}
                </Stagger>
              )}
            </Panel>
          </Reveal>

          <Reveal>
            <Panel title="Reviews" icon={<Star className="h-4 w-4" />} subtitle="Only learners from completed sessions can review.">
              {rv.isLoading ? <div className="aix-shimmer h-16 rounded-xl" /> : reviews.length === 0 ? <p className="text-sm text-fg-muted">No reviews yet.</p> : (
                <ul className="space-y-3">
                  {reviews.slice(0, 10).map((r, i) => (
                    <li key={r.id ?? i} className="rounded-2xl border border-line/50 bg-ink-950/40 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="flex items-center gap-0.5" role="img" aria-label={`${r.rating} out of 5`}>{Array.from({ length: 5 }).map((_, k) => <Star key={k} aria-hidden className={k < r.rating ? 'h-3.5 w-3.5 fill-gold text-gold' : 'h-3.5 w-3.5 text-ink-600'} />)}</span>
                        <span className="text-xs text-fg-subtle">{r.reviewer?.name ?? r.reviewerName ?? 'Verified learner'} · {fmtDate(r.createdAt)}</span>
                      </div>
                      {r.body && <p className="mt-2 text-sm text-fg-muted">{r.body}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </Reveal>
        </div>

        <div className="min-w-0 space-y-6">
          <Reveal delay={0.1}>
            <Panel title="Reputation" icon={<ShieldCheck className="h-4 w-4" />}>
              <ReputationLadder level={repSlug} score={a.reputation?.score ?? null} />
            </Panel>
          </Reveal>
          <Reveal delay={0.15}>
            <Panel title="Details" icon={<Bot className="h-4 w-4" />}>
              <dl className="space-y-4 text-sm">
                <div className="flex gap-3"><Languages aria-hidden className="mt-0.5 h-4 w-4 text-fg-subtle" /><div><dt className="text-xs text-fg-subtle">Languages</dt><dd>{a.languages?.length ? a.languages.map((l) => l.toUpperCase()).join(', ') : '—'}</dd></div></div>
                <div className="flex gap-3"><Wrench aria-hidden className="mt-0.5 h-4 w-4 text-fg-subtle" /><div><dt className="text-xs text-fg-subtle">Tools</dt><dd>{tools.length ? tools.join(', ') : '—'}</dd></div></div>
                <div className="flex gap-3"><Clock aria-hidden className="mt-0.5 h-4 w-4 text-fg-subtle" /><div><dt className="text-xs text-fg-subtle">Availability</dt>
                  <dd>{typeof a.availability === 'string' ? a.availability : avail ? (
                    <span className="mt-1 flex flex-wrap gap-1.5">
                      {avail.status && <span className="rounded-full border border-line bg-ink-800 px-2 py-0.5 text-[11px] capitalize">{avail.status}</span>}
                      {avail.acceptsTraining != null && <span className={cx('rounded-full border px-2 py-0.5 text-[11px]', avail.acceptsTraining ? 'border-success/30 bg-success/10 text-success-soft' : 'border-line text-fg-subtle')}>{avail.acceptsTraining ? 'Accepts training requests' : 'Not accepting training'}</span>}
                    </span>
                  ) : a.health ? `Connection ${a.health}` : '—'}</dd></div></div>
                {a.createdAt && <div className="flex gap-3"><Sparkles aria-hidden className="mt-0.5 h-4 w-4 text-fg-subtle" /><div><dt className="text-xs text-fg-subtle">Listed since</dt><dd>{fmtDate(a.createdAt)}</dd></div></div>}
              </dl>
            </Panel>
          </Reveal>
          <Reveal delay={0.2}>
            <div className="aix-conic-border-ai relative overflow-hidden rounded-3xl p-6">
              <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-br from-violet/25 to-electric/5" />
              <div className="relative">
                <GraduationCap aria-hidden className="h-7 w-7 text-violet-soft" />
                <p className="mt-3 text-lg font-semibold">Train your agent with {a.name}</p>
                <p className="mt-1 text-sm text-fg-muted">Sign in, pick your learner agent and set objectives. Improvement is measured on held-out questions.</p>
                <Button variant="ai" className="mt-5 w-full rounded-xl" href={requestHref}>Request training</Button>
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </div>
  );
}
