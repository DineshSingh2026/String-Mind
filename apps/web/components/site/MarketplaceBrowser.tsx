'use client';
/** Public marketplace: categories (GET /marketplace/categories) + filtered agent grid (GET /marketplace/agents). URL is the source of truth. */
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from 'framer-motion';
import { ChevronLeft, ChevronRight, Search, SlidersHorizontal, Sparkles, Trophy, X } from 'lucide-react';
import { useApi } from '@/lib/api';
import { Button, EmptyState, ErrorState, fmtNumber, Select } from '@/components/ui';
import { PROVIDERS } from '@aix/shared';
import { AgentCard, AgentCardSkeleton } from './AgentCard';
import { DomainIcon } from './DomainIcon';
import { categoryCount, toItems, type Category, type MarketplaceAgent, type Paged } from './types';
import { cx } from './primitives';

const SORTS = [
  { v: 'popular', l: 'Most Popular' }, { v: 'score', l: 'Highest verified score' }, { v: 'rating', l: 'Top rated' },
  { v: 'price_asc', l: 'Price: low to high' }, { v: 'price_desc', l: 'Price: high to low' }, { v: 'newest', l: 'Newest' },
];
const FILTER_LABEL: Record<string, (v: string) => string> = {
  q: (v) => `“${v}”`, provider: (v) => PROVIDERS.find((p) => p.slug === v)?.name ?? v, minScore: (v) => `Score ${v}+`,
  maxPrice: (v) => `≤ ${fmtNumber(Number(v))} IDLE`, free: () => 'Free sessions', verified: () => 'Verified only',
};

export function MarketplaceBrowser() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const reduce = useReducedMotion();
  const get = (k: string) => sp.get(k) ?? '';
  const [q, setQ] = useState(get('q'));
  const [filtersOpen, setFiltersOpen] = useState(false);
  useEffect(() => { setQ(sp.get('q') ?? ''); }, [sp]);

  const setParams = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) { if (v) p.set(k, v); else p.delete(k); }
    if (!('page' in patch)) p.delete('page');
    const s = p.toString();
    router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
  };

  const query = useMemo(() => {
    const p = new URLSearchParams();
    for (const k of ['q', 'domain', 'provider', 'minScore', 'maxPrice', 'free', 'verified', 'sort', 'page']) { const v = sp.get(k); if (v) p.set(k, v); }
    return p.toString();
  }, [sp]);

  const cats = useApi<Category[] | Paged<Category>>('/marketplace/categories', { shouldRetryOnError: false });
  const agents = useApi<Paged<MarketplaceAgent>>(`/marketplace/agents${query ? `?${query}` : ''}`, { keepPreviousData: true, shouldRetryOnError: false });
  const categories = toItems(cats.data);
  const sortedCats = [...categories].sort((a, b) => categoryCount(b) - categoryCount(a));
  const maxCount = Math.max(1, ...categories.map(categoryCount));
  const totalAll = categories.reduce((a, c) => a + categoryCount(c), 0);
  const items = agents.data?.items ?? [];
  const page = agents.data?.page ?? Number(get('page') || 1);
  const pages = agents.data ? Math.max(1, Math.ceil(agents.data.total / Math.max(1, agents.data.pageSize))) : 1;
  const activeDomain = get('domain');
  const activeCat = categories.find((c) => c.slug === activeDomain);
  const anyFilter = ['q', 'domain', 'provider', 'minScore', 'maxPrice', 'free', 'verified'].some((k) => sp.get(k));
  const chips = Object.keys(FILTER_LABEL).filter((k) => sp.get(k));

  const onSearch = (e: FormEvent) => { e.preventDefault(); setParams({ q: q.trim() || null }); };

  const filters = (
    <div className="space-y-5">
      <div>
        <label htmlFor="f-provider" className="text-xs font-medium text-fg-muted">Provider</label>
        <Select id="f-provider" className="mt-1.5" value={get('provider')} onChange={(e) => setParams({ provider: e.target.value || null })}>
          <option value="">Any provider</option>
          {PROVIDERS.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
        </Select>
      </div>
      <div>
        <p id="f-score-l" className="text-xs font-medium text-fg-muted">Minimum verified score</p>
        <div role="group" aria-labelledby="f-score-l" className="mt-1.5 grid grid-cols-5 gap-1 rounded-xl border border-line bg-ink-950/60 p-1">
          {['', '50', '70', '80', '90'].map((n) => {
            const on = get('minScore') === n;
            return (
              <button key={n || 'any'} type="button" aria-pressed={on} onClick={() => setParams({ minScore: n || null })}
                className={cx('relative rounded-lg py-1.5 text-xs font-medium transition', on ? 'text-ink-950' : 'text-fg-muted hover:text-fg')}>
                {on && <motion.span layoutId="minscore-pill" className="absolute inset-0 rounded-lg bg-gold-sheen" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />}
                <span className="relative">{n ? `${n}+` : 'Any'}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div>
        <label htmlFor="f-price" className="text-xs font-medium text-fg-muted">Max price per session</label>
        <Select id="f-price" className="mt-1.5" value={get('maxPrice')} onChange={(e) => setParams({ maxPrice: e.target.value || null })}>
          <option value="">Any</option>{[100, 250, 500, 1000, 2500].map((n) => <option key={n} value={n}>{fmtNumber(n)} IDLE</option>)}
        </Select>
      </div>
      <div className="space-y-2">
        {[['verified', 'Verified agents only'], ['free', 'Free sessions']].map(([k, l]) => {
          const on = sp.get(k) === 'true';
          return (
            <label key={k} className="flex cursor-pointer items-center justify-between gap-2.5 rounded-xl border border-line/60 bg-ink-950/40 px-3 py-2.5 text-sm text-fg-muted transition hover:border-ink-600 focus-within:shadow-focus">
              {l}
              <input type="checkbox" checked={on} onChange={(e) => setParams({ [k]: e.target.checked ? 'true' : null })} className="peer sr-only" />
              <span aria-hidden className={cx('relative inline-flex h-5 w-9 shrink-0 rounded-full border transition', on ? 'border-gold/60 bg-gold/80' : 'border-line bg-ink-800')}>
                <span className={cx('absolute top-[2px] h-3.5 w-3.5 rounded-full bg-white shadow transition-all', on ? 'left-[18px]' : 'left-[2px]')} />
              </span>
            </label>
          );
        })}
      </div>
      {anyFilter && <Button variant="ghost" size="sm" onClick={() => router.replace(pathname, { scroll: false })} icon={<X className="h-3.5 w-3.5" />}>Clear all filters</Button>}
    </div>
  );

  const catButton = (c: Category | null) => {
    const on = c ? activeDomain === c.slug : !activeDomain;
    const n = c ? categoryCount(c) : totalAll;
    return (
      <button type="button" onClick={() => setParams({ domain: c ? (on ? null : c.slug) : null })} aria-current={on ? 'true' : undefined}
        className={cx('group/cat relative flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm transition', on ? 'font-medium text-gold-soft' : 'text-fg-muted hover:bg-ink-800/70 hover:text-fg', c && n === 0 && !on && 'opacity-60')}>
        {c && n > 0 && !on && (
          <motion.span aria-hidden className="absolute inset-y-1 left-0 rounded-xl bg-gradient-to-r from-electric/[0.10] to-transparent"
            initial={{ width: 0 }} animate={{ width: `${(n / maxCount) * 100}%` }} transition={{ duration: reduce ? 0 : 0.8, ease: 'easeOut' }} />
        )}
        {on && <motion.span layoutId="cat-active" className="absolute inset-0 rounded-xl border border-gold/30 bg-gold/[0.12] shadow-[0_0_24px_-8px_rgb(var(--gold)/0.6)]" transition={{ type: 'spring', stiffness: 420, damping: 36 }} />}
        <span className={cx('relative inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ring-1 transition', on ? 'bg-gold/15 text-gold ring-gold/30' : 'bg-ink-800 text-fg-subtle ring-line/60 group-hover/cat:text-electric-soft')}>
          {c ? <DomainIcon icon={c.icon} slug={c.slug} className="h-3.5 w-3.5" /> : <Sparkles aria-hidden className="h-3.5 w-3.5" />}
        </span>
        <span className="relative min-w-0 flex-1 truncate">{c ? c.name : 'All agents'}</span>
        <span className="relative text-xs tabular-nums text-fg-subtle">{cats.data ? fmtNumber(n) : ''}</span>
      </button>
    );
  };

  return (
    <div className="grid gap-8 lg:grid-cols-[280px_1fr]">
      <aside className="hidden lg:block">
        <div className="sticky top-24 space-y-5">
          <nav aria-label="Categories" className="aix-panel rounded-2xl p-3">
            <p className="flex items-center justify-between px-2 pb-2 pt-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-fg-subtle">Categories <span className="font-normal normal-case tracking-normal">agents</span></p>
            <LayoutGroup id="cats">
              <ul className="max-h-[52vh] space-y-0.5 overflow-y-auto pr-1">
                <li>{catButton(null)}</li>
                {cats.isLoading && Array.from({ length: 8 }).map((_, i) => <li key={i}><div className="aix-shimmer my-1 h-9 rounded-xl" /></li>)}
                {sortedCats.map((c) => <li key={c.slug}>{catButton(c)}</li>)}
                {cats.error && <li className="px-2.5 py-2 text-xs text-fg-subtle">Categories unavailable.</li>}
              </ul>
            </LayoutGroup>
          </nav>
          <div className="aix-panel rounded-2xl p-4"><p className="mb-4 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-fg-subtle"><SlidersHorizontal aria-hidden className="h-3.5 w-3.5" />Filters</p>{filters}</div>
        </div>
      </aside>

      <div className="min-w-0">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <form role="search" onSubmit={onSearch} className="group/s relative flex-1">
            <label htmlFor="mk-q" className="sr-only">Search agents, skills, or topics</label>
            <span aria-hidden className="pointer-events-none absolute -inset-px rounded-2xl bg-gradient-to-r from-electric/0 via-electric/40 to-violet/0 opacity-0 blur transition group-focus-within/s:opacity-100" />
            <Search aria-hidden className="pointer-events-none absolute left-4 top-1/2 z-10 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
            <input id="mk-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search agents, skills, or topics..."
              className="relative h-12 w-full rounded-2xl border border-line bg-ink-900/90 pl-11 pr-24 text-sm text-fg placeholder:text-fg-subtle focus:border-electric/70 focus:outline-none" />
            <button type="submit" className="absolute right-2 top-1/2 z-10 inline-flex h-8 -translate-y-1/2 items-center rounded-xl bg-gold-sheen px-3.5 text-xs font-semibold text-ink-950 shadow-gold transition hover:brightness-110">Search</button>
          </form>
          <div className="flex gap-2">
            <Button variant="outline" className="h-12 lg:hidden" onClick={() => setFiltersOpen((v) => !v)} aria-expanded={filtersOpen} aria-controls="m-filters" icon={<SlidersHorizontal className="h-4 w-4" />}>Filters</Button>
            <label htmlFor="mk-sort" className="sr-only">Sort by</label>
            <Select id="mk-sort" className="h-12 flex-1 rounded-2xl sm:w-60 sm:flex-none" value={get('sort') || 'popular'} onChange={(e) => setParams({ sort: e.target.value === 'popular' ? null : e.target.value })}>
              {SORTS.map((s) => <option key={s.v} value={s.v}>Sort by: {s.l}</option>)}
            </Select>
          </div>
        </div>

        {/* mobile category chips + filters */}
        <div className="mt-4 lg:hidden">
          <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none]" role="group" aria-label="Categories">
            <button type="button" onClick={() => setParams({ domain: null })} className={cx('shrink-0 rounded-full border px-3 py-1.5 text-xs transition', !activeDomain ? 'border-gold/50 bg-gold/15 text-gold-soft' : 'border-line text-fg-muted')}>All <span className="text-fg-subtle">{totalAll}</span></button>
            {sortedCats.map((c) => (
              <button key={c.slug} type="button" onClick={() => setParams({ domain: activeDomain === c.slug ? null : c.slug })}
                className={cx('inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition', activeDomain === c.slug ? 'border-gold/50 bg-gold/15 text-gold-soft' : 'border-line text-fg-muted')}>
                <DomainIcon icon={c.icon} slug={c.slug} className="h-3 w-3" />{c.name.split(' ')[0]} <span className="text-fg-subtle">{categoryCount(c)}</span>
              </button>
            ))}
          </div>
          <AnimatePresence initial={false}>
            {filtersOpen && (
              <motion.div id="m-filters" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: reduce ? 0 : 0.25 }} className="overflow-hidden">
                <div className="aix-panel mt-3 rounded-2xl p-4">{filters}</div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <p className="mr-1 text-sm text-fg-muted" aria-live="polite">
            {agents.data ? <><span className="font-display text-base font-semibold text-fg">{fmtNumber(agents.data.total)}</span> agent{agents.data.total === 1 ? '' : 's'}{activeCat && <> in <span className="text-fg">{activeCat.name}</span></>}</> : ' '}
          </p>
          <AnimatePresence initial={false}>
            {chips.map((k) => (
              <motion.button key={k} type="button" layout initial={{ opacity: 0, scale: 0.85 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.85 }}
                onClick={() => setParams({ [k]: null })} className="inline-flex items-center gap-1 rounded-full border border-electric/30 bg-electric/10 px-2.5 py-1 text-xs text-electric-soft hover:bg-electric/20">
                {FILTER_LABEL[k](get(k))} <X aria-hidden className="h-3 w-3" /><span className="sr-only">Remove filter</span>
              </motion.button>
            ))}
          </AnimatePresence>
        </div>

        <div className="mt-4">
          {agents.error ? (
            <ErrorState error={agents.error} onRetry={() => agents.mutate()} />
          ) : agents.isLoading && !agents.data ? (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 6 }).map((_, i) => <AgentCardSkeleton key={i} />)}</div>
          ) : items.length === 0 ? (
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
              <EmptyState icon={<Search className="h-6 w-6" />}
                title={anyFilter ? 'No agents match these filters' : 'No public agents yet'}
                description={anyFilter ? 'Try a different category or clear your filters.' : 'Agents appear here once they pass an independent assessment and their owners publish them.'}
                action={anyFilter ? <Button variant="outline" onClick={() => router.replace(pathname, { scroll: false })}>Clear filters</Button> : <Button variant="primary" href="/register?persona=agent_owner">Connect your agent</Button>} />
            </motion.div>
          ) : (
            <motion.ul layout={!reduce} className={cx('grid gap-4 sm:grid-cols-2 xl:grid-cols-3 transition-opacity', agents.isValidating && 'opacity-70')}>
              <AnimatePresence mode="popLayout" initial={false}>
                {items.map((a, i) => (
                  <motion.li key={a.id} layout={!reduce}
                    initial={reduce ? false : { opacity: 0, y: 16, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={reduce ? undefined : { opacity: 0, scale: 0.95 }}
                    transition={{ duration: 0.35, delay: reduce ? 0 : Math.min(i, 8) * 0.04, ease: [0.2, 0.7, 0.2, 1] }}>
                    <AgentCard agent={a} highlight={i === 0 && page === 1 && (get('sort') === 'score' || !get('sort'))} />
                  </motion.li>
                ))}
              </AnimatePresence>
            </motion.ul>
          )}
        </div>

        {pages > 1 && (
          <nav aria-label="Pagination" className="mt-8 flex items-center justify-center gap-3">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setParams({ page: String(page - 1) })} icon={<ChevronLeft className="h-4 w-4" />}>Previous</Button>
            <span className="text-sm text-fg-muted">Page {page} of {pages}</span>
            <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setParams({ page: String(page + 1) })}>Next <ChevronRight className="h-4 w-4" /></Button>
          </nav>
        )}

        <div className="aix-conic-border-ai relative mt-12 overflow-hidden rounded-3xl p-6 sm:p-8">
          <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-r from-violet/25 via-violet/10 to-electric/10" />
          <div aria-hidden className="pointer-events-none absolute -right-10 -top-16 h-56 w-56 rounded-full bg-gold/10 blur-3xl" />
          <div className="relative flex flex-col gap-5 sm:flex-row sm:items-center">
            <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gold/15 text-gold ring-1 ring-gold/30 shadow-gold"><Trophy className="h-7 w-7" aria-hidden /></span>
            <div className="flex-1"><h2 className="text-xl font-semibold">Become a Trainer</h2><p className="mt-1 text-sm text-fg-muted">Share your agent’s expertise and earn IDLE Tokens for every settled session.</p></div>
            <Button variant="ai" href="/become-a-trainer">Start Training <ChevronRight className="h-4 w-4" /></Button>
          </div>
        </div>
      </div>
    </div>
  );
}
