'use client';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Bookmark, Clock, Flag, Globe2, GraduationCap, Heart, Plus, Star, Trash2, Wrench, X } from 'lucide-react';
import { REPUTATION_LEVELS } from '@aix/shared';
import {
  Alert, Avatar, Badge, Button, EmptyState, ErrorState, Field, Input, Modal, ScoreRing, Select, Skeleton, Textarea, cn, fmtCredits, fmtDate,
} from '@/components/ui';
import { ApiError, api, errorMessage, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { tierFor } from '@/components/app/AgentCard';
import { DomainScoreBars } from '@/components/app/ScorecardView';
import { useFavourites } from '@/components/app/marketplace-favourites';
import { BackLink, ListSkeleton, Rating, Section, VerifiedBadge, domainName, reputationName, titleCase, useAction } from '@/components/app/primitives';
import { claimedSlugs, listOf, type ClaimedDomain, type Agent, type Listing, type MarketAgent, type Paged, type Review, type Wallet } from '@/components/app/types';
import { IdleToken } from '@/components/brand/IdleToken';
import { FollowButton } from '@/components/social/FollowButton';
import { ProfileBadgeRow, ProfileExtras } from '@/components/social/ProfileExtras';
import { CertificationBadges } from '@/components/evaluation/CertificationBadges';

/* Assumed profile shape: MarketAgent + optional extras from GET /marketplace/agents/:slug. */
interface Profile extends MarketAgent {
  claimedDomains?: ClaimedDomain[];
  tools?: (string | { name?: string; description?: string })[];
  availability?: string | { status?: string; health?: string; acceptsTraining?: boolean; acceptsLearning?: boolean; lastHealthCheckAt?: string | null } | null;
  createdAt?: string;
  reputation?: { score?: number | null; level?: string | null; components?: Record<string, number | null> } | null;
  scorecard?: { overallScore?: number | null; domains?: { slug: string; name?: string; score: number | null; verified?: boolean; sampleSize?: number }[]; claimedOnly?: string[] } | null;
  reviews?: Review[];
}
const LEARNER_KEY = 'aix.marketplace.learner';

export default function Page() {
  return <Suspense fallback={<Skeleton className="h-64 w-full rounded-2xl" />}><AgentProfile /></Suspense>;
}

function AgentProfile() {
  const { slug } = useParams<{ slug: string }>();
  const sp = useSearchParams();
  const { can } = useSession();
  const { data: p, error, isLoading, mutate } = useApi<Profile>(`/marketplace/agents/${encodeURIComponent(slug)}`);
  const fav = useFavourites();
  const [requestFor, setRequestFor] = useState<Listing | null>(null);
  const [reportOpen, setReportOpen] = useState(false);

  if (isLoading) return <div className="space-y-4"><Skeleton className="h-40 w-full rounded-2xl" /><div className="grid gap-4 lg:grid-cols-3"><Skeleton className="h-72 rounded-2xl lg:col-span-2" /><Skeleton className="h-72 rounded-2xl" /></div></div>;
  if (error) return <><BackLink href="/app/marketplace">Marketplace</BackLink><ErrorState error={error} onRetry={() => mutate()} /></>;
  if (!p) return null;

  const domains = p.scorecard?.domains?.length ? p.scorecard.domains : p.verifiedDomains.map((d) => ({ ...d, verified: true }));
  const claimed = claimedSlugs(p.scorecard?.claimedOnly?.length ? p.scorecard.claimedOnly : p.claimedDomains);
  const tier = tierFor(p.overallScore ?? p.scorecard?.overallScore);
  const level = p.reputationLevel ?? p.reputation?.level ?? null;
  const levelIdx = REPUTATION_LEVELS.findIndex((l) => l.slug === level);
  const providerName = typeof p.provider === 'string' ? p.provider : p.provider?.name;

  return (
    <div className="space-y-6">
      <BackLink href="/app/marketplace">Marketplace</BackLink>
      <section className="card relative overflow-hidden p-5 sm:p-6">
        <div className="pointer-events-none absolute -right-16 -top-24 h-64 w-64 rounded-full bg-electric/10 blur-3xl" aria-hidden />
        <div className="relative flex flex-col gap-5 sm:flex-row sm:items-start">
          <Avatar name={p.name} seed={p.id} src={p.avatar} size={80} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold">{p.name}</h1>
              {p.verificationStatus === 'verified' && <VerifiedBadge label="Verified agent" />}
              {tier && <Badge tone={tier.tone}>{tier.label}</Badge>}
              {level && <Badge tone="gold">{reputationName(level)}</Badge>}
            </div>
            <p className="mt-1 text-sm text-fg-muted">{p.description || 'No description provided.'}</p>
            <ProfileBadgeRow slug={p.slug ?? slug} className="mt-3" />
            <CertificationBadges slug={p.slug ?? slug} className="mt-2" />
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-fg-muted">
              <Rating value={p.rating} count={p.ratingCount} />
              <span>{p.sessionsCompleted} sessions completed</span>
              {providerName && <span>{providerName}{p.modelName ? ` · ${p.modelName}` : ''}</span>}
              {p.owner?.name && <span>by {p.owner.name}</span>}
              {p.health && <span>Health: {titleCase(p.health)}</span>}
            </div>
          </div>
          <div className="flex items-center gap-4 sm:flex-col sm:items-end">
            <ScoreRing score={p.overallScore ?? p.scorecard?.overallScore ?? null} size={76} label="Verified overall score" />
            <div className="flex flex-wrap justify-end gap-2">
              <FollowButton targetType="agent" targetId={p.id} size="sm" />
              <Button size="sm" variant="outline" aria-pressed={fav.has(p.id, 'favourite')} onClick={() => fav.toggle(p, 'favourite')} icon={<Heart className={cn('h-4 w-4', fav.has(p.id, 'favourite') && 'fill-danger text-danger')} />}>Favourite</Button>
              <Button size="sm" variant="outline" aria-pressed={fav.has(p.id, 'shortlist')} onClick={() => fav.toggle(p, 'shortlist')} icon={<Bookmark className={cn('h-4 w-4', fav.has(p.id, 'shortlist') && 'fill-gold text-gold')} />}>Shortlist</Button>
            </div>
          </div>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Section title="Training listings" subtitle="Sessions this agent offers as a trainer">
            {!p.listings.length ? <p className="py-6 text-center text-sm text-fg-subtle">This agent has no active training listings.</p> : (
              <ul className="space-y-3">
                {p.listings.map((l) => (
                  <li key={l.id} className="flex flex-col gap-3 rounded-xl border border-line/70 p-4 sm:flex-row sm:items-center">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{l.title}</p>
                      <p className="mt-0.5 text-xs text-fg-muted">{domainName(l.domainSlug)}{l.durationMinutes ? ` · ${l.durationMinutes} min` : ''}{l.minImprovement != null ? ` · min improvement ${l.minImprovement} pts` : ''}</p>
                      {l.description && <p className="mt-1.5 line-clamp-2 text-sm text-fg-muted">{l.description}</p>}
                    </div>
                    <div className="flex items-center justify-between gap-4 sm:flex-col sm:items-end">
                      <p className="font-display text-lg font-semibold text-gold">{fmtCredits(l.priceCredits)}<span className="text-xs font-normal text-fg-subtle">/{l.pricingModel === 'per_hour' ? 'hour' : 'session'}</span></p>
                      {can('training.request') ? <Button variant="ai" size="sm" onClick={() => setRequestFor(l)} icon={<GraduationCap className="h-4 w-4" />}>Request training</Button> : <span className="text-xs text-fg-subtle">Your role can&apos;t request training</span>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Capability scores" subtitle="Verified by independent Hive Mind assessments. Claimed domains are self-reported and labelled separately.">
            {domains.length || claimed.length ? <DomainScoreBars domains={domains} claimed={claimed} /> : <p className="py-6 text-center text-sm text-fg-subtle">Not assessed yet.</p>}
          </Section>

          <ProfileExtras slug={p.slug ?? slug} roomHref={(id) => `/app/rooms/${id}`} />

          <Reviews slug={slug} initial={p.reviews} />
        </div>

        <div className="space-y-6">
          <Section title="Reputation">
            {level ? (
              <ol className="space-y-1.5">
                {REPUTATION_LEVELS.map((l, i) => (
                  <li key={l.slug} className={cn('flex items-center justify-between rounded-lg px-2.5 py-1.5 text-sm', i === levelIdx ? 'bg-gold/15 font-medium text-gold-soft' : i < levelIdx ? 'text-fg-muted' : 'text-fg-subtle')}>
                    <span>{l.name}</span>{i === levelIdx && <Star className="h-3.5 w-3.5 fill-gold text-gold" aria-label="Current level" />}
                  </li>
                ))}
              </ol>
            ) : <p className="text-sm text-fg-subtle">No reputation level yet.</p>}
            {p.reputation?.components && (
              <dl className="mt-4 space-y-1 border-t border-line/60 pt-3 text-xs">
                {Object.entries(p.reputation.components).map(([k, v]) => <div key={k} className="flex justify-between"><dt className="text-fg-muted">{titleCase(k)}</dt><dd className="tabular-nums">{v == null ? '—' : Number(v).toFixed(1)}</dd></div>)}
              </dl>
            )}
          </Section>
          <Section title="Details">
            <dl className="space-y-3 text-sm">
              {!!p.languages?.length && <div><dt className="mb-1 flex items-center gap-1.5 text-xs text-fg-muted"><Globe2 className="h-3.5 w-3.5" aria-hidden />Languages</dt><dd className="flex flex-wrap gap-1">{p.languages.map((l) => <Badge key={l}>{l}</Badge>)}</dd></div>}
              {!!p.tools?.length && <div><dt className="mb-1 flex items-center gap-1.5 text-xs text-fg-muted"><Wrench className="h-3.5 w-3.5" aria-hidden />Tools</dt><dd className="flex flex-wrap gap-1">{p.tools.map((t, i) => { const n = typeof t === 'string' ? t : t?.name ?? 'Tool'; return <Badge key={`${n}-${i}`}>{n}</Badge>; })}</dd></div>}
              {p.availability && <div><dt className="mb-1 flex items-center gap-1.5 text-xs text-fg-muted"><Clock className="h-3.5 w-3.5" aria-hidden />Availability</dt><dd>{availabilityText(p.availability)}</dd></div>}
            </dl>
            <Button className="mt-4" size="sm" variant="ghost" onClick={() => setReportOpen(true)} icon={<Flag className="h-3.5 w-3.5" />}>Report this agent</Button>
          </Section>
        </div>
      </div>

      {requestFor && <RequestTrainingModal trainer={p} listing={requestFor} preselect={sp.get('learner')} onClose={() => setRequestFor(null)} />}
      <ReportModal open={reportOpen} onClose={() => setReportOpen(false)} targetId={p.id} />
    </div>
  );
}

function Reviews({ slug, initial }: { slug: string; initial?: Review[] }) {
  const { data, error, isLoading, mutate } = useApi<Review[] | Paged<Review>>(`/marketplace/agents/${encodeURIComponent(slug)}/reviews`);
  const items = data ? listOf(data) : initial ?? [];
  return (
    <Section title="Reviews" subtitle="Only learner organisations of completed sessions can review">
      {isLoading && !initial ? <ListSkeleton rows={3} /> : error && !initial ? <ErrorState error={error} onRetry={() => mutate()} /> : !items.length ? (
        <p className="py-6 text-center text-sm text-fg-subtle">No reviews yet.</p>
      ) : (
        <ul className="divide-y divide-line/50">
          {items.map((r) => (
            <li key={r.id} className="py-3">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-0.5" aria-label={`${r.rating} out of 5 stars`}>{Array.from({ length: 5 }).map((_, i) => <Star key={i} className={cn('h-3.5 w-3.5', i < r.rating ? 'fill-gold text-gold' : 'text-ink-600')} aria-hidden />)}</span>
                <span className="text-[11px] text-fg-subtle">{fmtDate(r.createdAt)}</span>
              </div>
              <p className="mt-1.5 text-sm">{r.body}</p>
              <p className="mt-1 text-xs text-fg-subtle">{r.author?.name ?? r.reviewerName ?? r.learnerAgent?.name ?? 'Verified learner'}</p>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function RequestTrainingModal({ trainer, listing, preselect, onClose }: { trainer: Profile; listing: Listing; preselect: string | null; onClose: () => void }) {
  const { data: agentsData, isLoading } = useApi<Agent[] | Paged<Agent>>('/agents');
  const { data: wallet } = useApi<Wallet>('/wallet');
  const mine = listOf(agentsData).filter((a) => a.id !== trainer.id);
  const [learner, setLearner] = useState('');
  const [objectives, setObjectives] = useState<string[]>(['']);
  const [message, setMessage] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [insufficient, setInsufficient] = useState(false);
  const [done, setDone] = useState(false);
  const { busy, run } = useAction();

  useEffect(() => {
    if (learner || !mine.length) return;
    let pre = preselect;
    try { pre = pre ?? sessionStorage.getItem(LEARNER_KEY); } catch { /* storage unavailable */ }
    setLearner(mine.find((a) => a.id === pre)?.id ?? mine[0]!.id);
  }, [mine, preselect, learner]);

  const available = wallet?.available ?? null;
  const short = available != null && available < listing.priceCredits;
  const objs = objectives.map((o) => o.trim()).filter(Boolean);

  const submit = async () => {
    setErr(null); setInsufficient(false);
    if (!learner) return setErr('Choose which of your agents will learn.');
    if (!objs.length) return setErr('Add at least one learning objective.');
    const r = await run('req', async () => {
      try {
        return await api.post('/training/requests', { learnerAgentId: learner, trainerAgentId: trainer.id, domainSlug: listing.domainSlug, objectives: objs, message: message.trim() || undefined, listingId: listing.id });
      } catch (e) {
        if (e instanceof ApiError && (e.status === 402 || e.code === 'insufficient_funds')) setInsufficient(true);
        setErr(errorMessage(e));
        throw e;
      }
    }, 'Training request sent');
    if (r !== undefined) setDone(true);
  };

  return (
    <Modal open onClose={onClose} size="lg" title={`Request training from ${trainer.name}`} description={`${listing.title} · ${domainName(listing.domainSlug)}`}
      footer={done ? <Button variant="primary" href="/app/training">Go to Training Hub</Button> : <><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy === 'req'} disabled={!mine.length} onClick={submit}>Send request</Button></>}>
      {done ? (
        <Alert tone="success" title="Request sent">The trainer&apos;s owner will accept or decline. IDLE is escrowed only when the request is accepted.</Alert>
      ) : isLoading ? <ListSkeleton rows={2} /> : !mine.length ? (
        <EmptyState title="You need an agent to learn" description="Connect one of your agents first; it will be the learner in this session." action={<Button variant="primary" href="/app/agents/new">Connect an agent</Button>} />
      ) : (
        <div className="space-y-4">
          <Field label="Learner agent (yours)" htmlFor="learner" required>
            <Select id="learner" value={learner} onChange={(e) => setLearner(e.target.value)}>
              {mine.map((a) => <option key={a.id} value={a.id}>{a.name}{a.status !== 'active' ? ` (${a.status})` : ''}</option>)}
            </Select>
          </Field>
          <fieldset className="space-y-2">
            <legend className="mb-1.5 text-xs font-medium text-fg-muted">Learning objectives <span className="text-gold">*</span></legend>
            {objectives.map((o, i) => (
              <div key={i} className="flex gap-2">
                <Input aria-label={`Objective ${i + 1}`} value={o} placeholder={i === 0 ? 'e.g. Reconcile quarterly tax filings accurately' : 'Another objective'} onChange={(e) => setObjectives(objectives.map((x, j) => (j === i ? e.target.value : x)))} />
                {objectives.length > 1 && <Button variant="ghost" size="md" aria-label={`Remove objective ${i + 1}`} onClick={() => setObjectives(objectives.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>}
              </div>
            ))}
            {objectives.length < 8 && <Button size="sm" variant="ghost" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setObjectives([...objectives, ''])}>Add objective</Button>}
          </fieldset>
          <Field label="Message to trainer (optional)" htmlFor="msg"><Textarea id="msg" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={1000} /></Field>
          <div className="rounded-xl border border-line/70 bg-ink-950/50 p-3 text-sm">
            <div className="flex justify-between"><span className="text-fg-muted">Price</span><span className="flex items-center gap-1.5 font-semibold text-gold"><IdleToken size={16} />{fmtCredits(listing.priceCredits)}</span></div>
            <div className="mt-1 flex justify-between"><span className="text-fg-muted">Your IDLE balance</span><span className={cn('font-medium', short && 'text-danger-soft')}>{fmtCredits(available)}</span></div>
          </div>
          {(short || insufficient) && (
            <Alert tone="warning" title="Insufficient IDLE">You need {fmtCredits(listing.priceCredits)} available. IDLE can&apos;t be bought — <Link href="/app/wallet#earn-idle" className="font-medium text-gold underline">earn more by teaching or selling knowledge</Link>.</Alert>
          )}
          {err && !insufficient && <Alert tone="danger">{err}</Alert>}
        </div>
      )}
    </Modal>
  );
}

function ReportModal({ open, onClose, targetId }: { open: boolean; onClose: () => void; targetId: string }) {
  const [reason, setReason] = useState('misleading_claims');
  const [details, setDetails] = useState('');
  const { busy, run } = useAction();
  const submit = async () => {
    const r = await run('report', () => api.post('/marketplace/reports', { targetType: 'agent', targetId, reason, details }), 'Report submitted to Hive Mind moderation');
    if (r !== undefined) { setDetails(''); onClose(); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Report agent" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" loading={busy === 'report'} onClick={submit} icon={<X className="h-4 w-4" />}>Submit report</Button></>}>
      <div className="space-y-4">
        <Field label="Reason" htmlFor="reason"><Select id="reason" value={reason} onChange={(e) => setReason(e.target.value)}>
          {['misleading_claims', 'unsafe_content', 'plagiarism', 'spam', 'other'].map((r) => <option key={r} value={r}>{titleCase(r)}</option>)}
        </Select></Field>
        <Field label="Details" htmlFor="details"><Textarea id="details" value={details} onChange={(e) => setDetails(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

/** Availability arrives as an object from the API ({status, health, acceptsTraining, …}); older shapes may be a string. */
function availabilityText(a: NonNullable<Profile['availability']>): string {
  if (typeof a === 'string') return a;
  const cap = (s?: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : null);
  return [cap(a.status), cap(a.health), a.acceptsTraining ? 'Accepting training' : a.acceptsTraining === false ? 'Not accepting training' : null]
    .filter(Boolean).join(' · ') || '—';
}
