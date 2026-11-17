'use client';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { ArrowRight, Bookmark, Heart, Layers, Search, SlidersHorizontal, Store, Trophy, X } from 'lucide-react';
import { DOMAINS, PROVIDERS } from '@aix/shared';
import { Button, Checkbox, EmptyState, ErrorState, Field, Input, Modal, PageHeader, Select, Tabs, cn } from '@/components/ui';
import { useApi } from '@/lib/api';
import { AgentCard } from '@/components/app/AgentCard';
import { AnimatePresence, motion, useReducedMotion } from '@/components/app/motion';
import { Chip, ChipRow, GridSkeleton, Pagination, domainName } from '@/components/app/primitives';
import { listOf, type MarketAgent, type Paged } from '@/components/app/types';
import { useFavourites, type FavList } from '@/components/app/marketplace-favourites';

interface Category { slug: string; name?: string; count?: number; agentCount?: number }

const SORTS = [
  { value: 'popular', label: 'Most Popular' },
  { value: 'score', label: 'Highest verified score' },
  { value: 'rating', label: 'Top rated' },
  { value: 'price_asc', label: 'Price: low to high' },
  { value: 'price_desc', label: 'Price: high to low' },
  { value: 'newest', label: 'Newest' },
];
const FILTER_KEYS = ['q', 'domain', 'provider', 'language', 'maxPrice', 'minScore', 'free', 'verified', 'sort', 'page'] as const;
const LEARNER_KEY = 'aix.marketplace.learner';
const MAX_COMPARE = 3;

export default function MarketplacePage() {
  return (
    <Suspense fallback={<GridSkeleton count={6} />}>
      <Marketplace />
    </Suspense>
  );
}

function Marketplace() {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const view = (sp.get('view') as 'browse' | FavList | null) ?? 'browse';
  const learner = sp.get('learner');

  // Remember the learner context so "Request training" on a profile can preselect it.
  useEffect(() => {
    try { if (learner) sessionStorage.setItem(LEARNER_KEY, learner); } catch { /* storage unavailable */ }
  }, [learner]);

  const setParams = (patch: Record<string, string | null>, resetPage = true) => {
    const next = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) { if (v == null || v === '') next.delete(k); else next.set(k, v); }
    if (resetPage && !('page' in patch)) next.delete('page');
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  const fav = useFavourites();
  const [compare, setCompare] = useState<MarketAgent[]>([]);
  const toggleCompare = (a: MarketAgent) => setCompare((c) => (c.some((x) => x.id === a.id) ? c.filter((x) => x.id !== a.id) : c.length >= MAX_COMPARE ? c : [...c, a]));

  const cardProps = (a: MarketAgent) => ({
    agent: a,
    favourite: fav.has(a.id, 'favourite'),
    shortlisted: fav.has(a.id, 'shortlist'),
    onFavourite: () => void fav.toggle(a, 'favourite'),
    onShortlist: () => void fav.toggle(a, 'shortlist'),
    compareSelected: compare.some((x) => x.id === a.id),
    compareDisabled: compare.length >= MAX_COMPARE,
    onCompare: () => toggleCompare(a),
  });

  const favCount = fav.items.filter((f) => (f.list ?? 'favourite') === 'favourite').length;
  const shortCount = fav.items.filter((f) => f.list === 'shortlist').length;

  return (
    <div className={cn(compare.length > 0 && 'pb-20')}>
      <PageHeader eyebrow="Agent Marketplace" title="Find a verified trainer"
        description="Agents are ranked only by independently verified assessment scores and reputation — never by self-claimed skills." />

      {learner && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-electric/30 bg-electric/5 px-4 py-2.5 text-sm">
          <span className="text-fg-muted">Finding a trainer for one of your agents{sp.get('domain') ? <> in <span className="text-fg">{domainName(sp.get('domain'))}</span></> : null}. It will be preselected when you request training.</span>
          <button className="shrink-0 text-xs text-fg-subtle hover:text-fg" onClick={() => { try { sessionStorage.removeItem(LEARNER_KEY); } catch { /* */ } setParams({ learner: null }); }}>Clear</button>
        </div>
      )}

      <Tabs className="mb-5" value={view} onChange={(v) => setParams({ view: v === 'browse' ? null : v }, false)}
        tabs={[{ value: 'browse', label: 'Browse' }, { value: 'favourite', label: 'Favourites', count: fav.isLoading ? undefined : favCount }, { value: 'shortlist', label: 'Shortlist', count: fav.isLoading ? undefined : shortCount }]} />

      {view === 'browse'
        ? <Browse sp={sp} setParams={setParams} cardProps={cardProps} />
        : <SavedList list={view} fav={fav} cardProps={cardProps} />}

      {compare.length > 0 && (
        <div className="fixed inset-x-0 bottom-16 z-30 border-t border-line bg-ink-900/95 px-4 py-3 backdrop-blur lg:bottom-0 lg:left-60" role="region" aria-label="Comparison selection">
          <div className="mx-auto flex max-w-6xl items-center gap-3">
            <Layers className="hidden h-5 w-5 text-electric sm:block" aria-hidden />
            <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto">
              {compare.map((a) => (
                <span key={a.id} className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-ink-800 px-3 py-1 text-xs">
                  {a.name}<button onClick={() => toggleCompare(a)} aria-label={`Remove ${a.name} from comparison`} className="text-fg-subtle hover:text-fg"><X className="h-3.5 w-3.5" /></button>
                </span>
              ))}
              <span className="self-center whitespace-nowrap text-xs text-fg-subtle">{compare.length}/{MAX_COMPARE}</span>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setCompare([])}>Clear</Button>
            <Button variant="ai" size="sm" disabled={compare.length < 2} href={compare.length >= 2 ? `/app/marketplace/compare?ids=${compare.map((a) => a.id).join(',')}` : undefined}>Compare {compare.length >= 2 ? '' : '(pick 2+)'}</Button>
          </div>
        </div>
      )}
    </div>
  );
}

type CardPropsFn = (a: MarketAgent) => React.ComponentProps<typeof AgentCard>;

function Browse({ sp, setParams, cardProps }: { sp: URLSearchParams; setParams: (p: Record<string, string | null>, resetPage?: boolean) => void; cardProps: CardPropsFn }) {
  const [q, setQ] = useState(sp.get('q') ?? '');
  useEffect(() => setQ(sp.get('q') ?? ''), [sp]);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    for (const k of FILTER_KEYS) { const v = sp.get(k); if (v) p.set(k, v); }
    if (!p.get('sort')) p.set('sort', 'popular');
    return p.toString();
  }, [sp]);
  const { data, error, isLoading, mutate } = useApi<Paged<MarketAgent>>(`/marketplace/agents?${query}`, { keepPreviousData: true });
  const cats = useApi<Category[] | Paged<Category>>('/marketplace/categories');
  const categories = listOf(cats.data);
  const totalPublic = categories.reduce((s, c) => s + (c.count ?? c.agentCount ?? 0), 0);

  const domain = sp.get('domain');
  const activeFilterCount = ['provider', 'language', 'maxPrice', 'minScore', 'free', 'verified'].filter((k) => sp.get(k)).length;
  const items = data?.items ?? [];
  const page = Number(sp.get('page') ?? '1') || 1;

  return (
    <div className="grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
      {/* Categories: sidebar on desktop, horizontal chips on mobile */}
      <aside aria-label="Categories">
        <div className="lg:hidden">
          <ChipRow label="Categories">
            <Chip active={!domain} onClick={() => setParams({ domain: null })}>All{totalPublic ? ` · ${totalPublic}` : ''}</Chip>
            {categories.map((c) => <Chip key={c.slug} active={domain === c.slug} onClick={() => setParams({ domain: c.slug })}>{c.name ?? domainName(c.slug)} · {c.count ?? c.agentCount ?? 0}</Chip>)}
          </ChipRow>
        </div>
        <div className="card hidden p-3 lg:block">
          <p className="px-2 pb-2 pt-1 text-xs font-medium uppercase tracking-wider text-fg-subtle">Categories</p>
          {cats.error ? <ErrorState error={cats.error} onRetry={() => cats.mutate()} className="text-xs" /> : (
            <ul className="space-y-0.5">
              <CatItem active={!domain} label="All agents" count={cats.isLoading ? undefined : totalPublic} onClick={() => setParams({ domain: null })} />
              {cats.isLoading ? Array.from({ length: 8 }).map((_, i) => <li key={i} className="ax-shimmer mx-2 my-2 h-4 rounded bg-ink-800" />)
                : categories.map((c) => <CatItem key={c.slug} active={domain === c.slug} label={c.name ?? domainName(c.slug)} count={c.count ?? c.agentCount ?? 0} onClick={() => setParams({ domain: c.slug })} />)}
            </ul>
          )}
        </div>
      </aside>

      <div className="min-w-0">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
          <form role="search" className="relative flex-1" onSubmit={(e) => { e.preventDefault(); setParams({ q: q.trim() || null }); }}>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search agents, skills, or topics..." aria-label="Search the marketplace" className="pl-9" />
          </form>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setFiltersOpen(true)} icon={<SlidersHorizontal className="h-4 w-4" />} aria-label={`Filters${activeFilterCount ? `, ${activeFilterCount} active` : ''}`}>
              Filters{activeFilterCount > 0 && <span className="rounded-full bg-gold/20 px-1.5 text-[11px] text-gold-soft">{activeFilterCount}</span>}
            </Button>
            <label className="flex items-center gap-2 text-xs text-fg-muted">
              <span className="hidden whitespace-nowrap sm:inline">Sort by:</span>
              <Select aria-label="Sort by" value={sp.get('sort') ?? 'popular'} onChange={(e) => setParams({ sort: e.target.value })} className="w-auto min-w-[170px]">
                {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </Select>
            </label>
          </div>
        </div>

        <ActiveFilters sp={sp} setParams={setParams} />

        {error && !data ? <ErrorState error={error} onRetry={() => mutate()} />
          : isLoading && !data ? <GridSkeleton count={6} />
          : items.length === 0 ? (
            <EmptyState icon={<Store className="h-5 w-5" />} title="No agents match these filters"
              description={sp.toString() && (activeFilterCount || sp.get('q') || domain) ? 'Try widening your search or clearing filters. Only agents with public profiles appear here.' : 'No public agents have been published on this Hive Mind instance yet. Publish one of yours once it has a completed assessment.'}
              action={(activeFilterCount || sp.get('q') || domain)
                ? <Button variant="outline" onClick={() => setParams(Object.fromEntries(FILTER_KEYS.map((k) => [k, null])))}>Clear all filters</Button>
                : <Button variant="primary" href="/app/agents">Go to my agents</Button>} />
          ) : (
            <>
              <p className="mb-3 text-xs text-fg-subtle" aria-live="polite">{data?.total ?? items.length} agent{(data?.total ?? items.length) === 1 ? '' : 's'}{domain ? ` in ${domainName(domain)}` : ''}</p>
              <MotionGrid className={cn('grid gap-4 transition-opacity sm:grid-cols-2 xl:grid-cols-3', isLoading && 'opacity-60')}>
                {items.map((a, i) => (
                  <MotionCell key={a.id} index={i}>
                    <AgentCard {...cardProps(a)} top={page === 1 && i === 0 && (sp.get('sort') ?? 'popular') !== 'newest'} />
                  </MotionCell>
                ))}
              </MotionGrid>
              {data && <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onChange={(p) => setParams({ page: String(p) }, false)} />}
            </>
          )}

        <TrainerBanner />
      </div>

      <FiltersModal open={filtersOpen} onClose={() => setFiltersOpen(false)} sp={sp} apply={(p) => { setParams(p); setFiltersOpen(false); }} />
    </div>
  );
}

function CatItem({ active, label, count, onClick }: { active: boolean; label: string; count?: number; onClick: () => void }) {
  return (
    <li>
      <button onClick={onClick} aria-current={active ? 'true' : undefined}
        className={cn('relative flex w-full items-center justify-between gap-2 rounded-xl px-2.5 py-1.5 text-left text-[13px] transition-colors', active ? 'font-medium text-gold-soft' : 'text-fg-muted hover:bg-ink-800 hover:text-fg')}>
        {active && <motion.span layoutId="mkt-cat" aria-hidden className="absolute inset-0 rounded-xl border border-gold/25 bg-gold/15 shadow-[inset_2px_0_0_rgb(var(--gold))]" transition={{ type: 'spring', stiffness: 520, damping: 40 }} />}
        <span className="relative truncate">{label}</span>{count !== undefined && <span className={cn('relative shrink-0 text-[11px] tabular-nums', active ? 'text-gold' : 'text-fg-subtle')}>{count}</span>}
      </button>
    </li>
  );
}

function ActiveFilters({ sp, setParams }: { sp: URLSearchParams; setParams: (p: Record<string, string | null>) => void }) {
  const chips: { key: string; label: string }[] = [];
  if (sp.get('q')) chips.push({ key: 'q', label: `“${sp.get('q')}”` });
  if (sp.get('domain')) chips.push({ key: 'domain', label: domainName(sp.get('domain')) });
  if (sp.get('provider')) chips.push({ key: 'provider', label: PROVIDERS.find((p) => p.slug === sp.get('provider'))?.name ?? sp.get('provider')! });
  if (sp.get('language')) chips.push({ key: 'language', label: `Language: ${sp.get('language')}` });
  if (sp.get('maxPrice')) chips.push({ key: 'maxPrice', label: `≤ ${sp.get('maxPrice')} IDLE` });
  if (sp.get('minScore')) chips.push({ key: 'minScore', label: `Score ≥ ${sp.get('minScore')}` });
  if (sp.get('free')) chips.push({ key: 'free', label: 'Free only' });
  if (sp.get('verified')) chips.push({ key: 'verified', label: 'Verified only' });
  if (!chips.length) return null;
  return (
    <ChipRow className="mb-4" label="Active filters">
      {chips.map((c) => <Chip key={c.key} active onClick={() => setParams({ [c.key]: null })} aria-label={`Remove filter ${c.label}`}>{c.label}<X className="h-3 w-3" aria-hidden /></Chip>)}
    </ChipRow>
  );
}

function FiltersModal({ open, onClose, sp, apply }: { open: boolean; onClose: () => void; sp: URLSearchParams; apply: (p: Record<string, string | null>) => void }) {
  const [f, setF] = useState({ domain: '', provider: '', language: '', maxPrice: '', minScore: '', free: false, verified: false });
  useEffect(() => {
    if (open) setF({ domain: sp.get('domain') ?? '', provider: sp.get('provider') ?? '', language: sp.get('language') ?? '', maxPrice: sp.get('maxPrice') ?? '', minScore: sp.get('minScore') ?? '', free: sp.get('free') === 'true', verified: sp.get('verified') === 'true' });
  }, [open, sp]);
  const submit = () => apply({ domain: f.domain || null, provider: f.provider || null, language: f.language.trim() || null, maxPrice: f.maxPrice || null, minScore: f.minScore || null, free: f.free ? 'true' : null, verified: f.verified ? 'true' : null });
  return (
    <Modal open={open} onClose={onClose} title="Filter agents" description="Scores used for filtering are verified assessment scores only."
      footer={<><Button variant="ghost" onClick={() => apply({ domain: null, provider: null, language: null, maxPrice: null, minScore: null, free: null, verified: null })}>Reset</Button><Button variant="primary" onClick={submit}>Apply filters</Button></>}>
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <Field label="Domain" htmlFor="f-domain">
          <Select id="f-domain" value={f.domain} onChange={(e) => setF({ ...f, domain: e.target.value })}>
            <option value="">Any domain</option>{DOMAINS.map((d) => <option key={d.slug} value={d.slug}>{d.name}</option>)}
          </Select>
        </Field>
        <Field label="Provider" htmlFor="f-provider">
          <Select id="f-provider" value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })}>
            <option value="">Any provider</option>{PROVIDERS.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
          </Select>
        </Field>
        <Field label="Language" htmlFor="f-lang" hint="e.g. en, hi, ta">
          <Input id="f-lang" value={f.language} onChange={(e) => setF({ ...f, language: e.target.value })} placeholder="Any language" />
        </Field>
        <Field label="Max price (IDLE / session)" htmlFor="f-price">
          <Input id="f-price" type="number" min={0} inputMode="numeric" value={f.maxPrice} onChange={(e) => setF({ ...f, maxPrice: e.target.value })} placeholder="No limit" disabled={f.free} />
        </Field>
        <Field label="Minimum verified score" htmlFor="f-score">
          <Select id="f-score" value={f.minScore} onChange={(e) => setF({ ...f, minScore: e.target.value })}>
            <option value="">Any score</option>{[50, 60, 70, 80, 85, 90, 95].map((s) => <option key={s} value={s}>{s}+</option>)}
          </Select>
        </Field>
        <div className="space-y-3 sm:pt-6">
          <Checkbox label="Free sessions only" checked={f.free} onChange={(v) => setF({ ...f, free: v })} />
          <Checkbox label="Verified agents only" checked={f.verified} onChange={(v) => setF({ ...f, verified: v })} />
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function SavedList({ list, fav, cardProps }: { list: FavList; fav: ReturnType<typeof useFavourites>; cardProps: CardPropsFn }) {
  const items = fav.items.filter((f) => (f.list ?? 'favourite') === list);
  if (fav.error) return <ErrorState error={fav.error} onRetry={() => fav.mutate()} />;
  if (fav.isLoading) return <GridSkeleton count={3} />;
  if (!items.length) {
    return (
      <EmptyState icon={list === 'favourite' ? <Heart className="h-5 w-5" /> : <Bookmark className="h-5 w-5" />}
        title={list === 'favourite' ? 'No favourites yet' : 'Your shortlist is empty'}
        description={list === 'favourite' ? 'Tap the heart on any agent card to keep trainers you like close at hand.' : 'Bookmark agents you are evaluating, then compare up to three side by side.'}
        action={<Button variant="primary" href="/app/marketplace">Browse agents <ArrowRight className="h-4 w-4" /></Button>} />
    );
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {items.map((f) => f.agent
        ? <AgentCard key={f.agentId} {...cardProps(f.agent)} />
        : (
          <div key={f.agentId} className="card p-4 text-sm">
            <p className="text-fg-muted">This agent is no longer publicly listed.</p>
            <Button className="mt-3" size="sm" variant="outline" onClick={() => void fav.toggle({ id: f.agentId, name: 'Agent' }, list)}>Remove</Button>
          </div>
        ))}
    </div>
  );
}

function TrainerBanner() {
  return (
    <section className="relative mt-8 overflow-hidden rounded-2xl border border-violet/30 bg-gradient-to-r from-violet/25 via-violet/10 to-electric/10 p-5 sm:p-6">
      <div aria-hidden className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full bg-violet/30 blur-3xl" />
      <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center">
        <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gold/15 text-gold" aria-hidden><Trophy className="h-7 w-7" /></span>
        <div className="flex-1">
          <h2 className="font-display text-lg font-semibold">Become a Trainer</h2>
          <p className="mt-0.5 text-sm text-fg-muted">Share your agent&apos;s verified expertise and earn IDLE Tokens. Listings need a verified score of 70+ in the domain.</p>
        </div>
        <Link href="/app/agents" className="inline-flex items-center justify-center gap-1.5 self-start rounded-full bg-ai-sheen px-5 py-2.5 text-sm font-semibold text-white hover:brightness-110 sm:self-auto">Start Training <ArrowRight className="h-4 w-4" /></Link>
      </div>
    </section>
  );
}

/** Grid whose cards animate in (staggered) and re-flow smoothly when filters/sort change. */
function MotionGrid({ children, className }: { children: React.ReactNode; className?: string }) {
  return <motion.div layout className={className}><AnimatePresence mode="popLayout" initial={true}>{children}</AnimatePresence></motion.div>;
}
function MotionCell({ children, index }: { children: React.ReactNode; index: number }) {
  const reduce = useReducedMotion();
  return (
    <motion.div layout={reduce ? false : 'position'} className="flex [&>*]:w-full" initial={reduce ? false : { opacity: 0, y: 14, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1, transition: { delay: Math.min(index, 9) * 0.045, duration: 0.4, ease: [0.2, 0.7, 0.2, 1] } }}
      exit={reduce ? undefined : { opacity: 0, scale: 0.96, transition: { duration: 0.15 } }}>
      {children}
    </motion.div>
  );
}
