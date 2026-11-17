'use client';
/** Live verified knowledge listings from GET /knowledge-exchange/listings. */
import './pages/pages.css';
import { useState, type FormEvent } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { SpotlightCard } from '@/components/fx';
import { BookOpen, Search } from 'lucide-react';
import { DOMAINS } from '@aix/shared';
import { useApi } from '@/lib/api';
import { Badge, Button, EmptyState, ErrorState, fmtNumber, Select } from '@/components/ui';
import { domainName } from './DomainIcon';
import type { KnowledgeListing, Paged } from './types';

export function KnowledgeListings() {
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');
  const [domain, setDomain] = useState('');
  const [page, setPage] = useState(1);
  const qs = new URLSearchParams({ ...(applied ? { q: applied } : {}), ...(domain ? { domain } : {}), page: String(page) }).toString();
  const { data, error, isLoading, mutate } = useApi<Paged<KnowledgeListing>>(`/knowledge-exchange/listings?${qs}`, { keepPreviousData: true, shouldRetryOnError: false });
  const items = data?.items ?? [];
  const pages = data ? Math.max(1, Math.ceil(data.total / Math.max(1, data.pageSize))) : 1;
  const submit = (e: FormEvent) => { e.preventDefault(); setApplied(q.trim()); setPage(1); };

  return (
    <div>
      <div className="flex flex-col gap-3 sm:flex-row">
        <form role="search" onSubmit={submit} className="relative flex-1">
          <label htmlFor="kx-q" className="sr-only">Search knowledge</label>
          <Search aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
          <input id="kx-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search knowledge packs..." className="h-12 w-full rounded-2xl border border-line bg-ink-900/90 pl-10 pr-4 text-sm placeholder:text-fg-subtle focus:border-electric focus:shadow-focus focus:outline-none" />
        </form>
        <label htmlFor="kx-d" className="sr-only">Domain</label>
        <Select id="kx-d" className="h-12 rounded-2xl sm:w-64" value={domain} onChange={(e) => { setDomain(e.target.value); setPage(1); }}>
          <option value="">All domains</option>
          {DOMAINS.map((d) => <option key={d.slug} value={d.slug}>{d.name}</option>)}
        </Select>
      </div>
      <div className="mt-6">
        {error ? <ErrorState error={error} onRetry={() => mutate()} /> : isLoading && !data ? (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="aix-shimmer h-44 rounded-2xl" />)}</div>
        ) : items.length === 0 ? (
          <EmptyState icon={<BookOpen className="h-6 w-6" />} title={applied || domain ? 'No listings match' : 'No verified knowledge listings yet'}
            description={applied || domain ? 'Try another search or domain.' : 'Listings appear after moderation and verification. Have expertise to share? Publish the first pack.'}
            action={<Button variant="primary" href="/sign-in?next=%2Fapp%2Fknowledge">Publish knowledge</Button>} />
        ) : (
          <ul className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <AnimatePresence mode="popLayout">
            {items.map((l, i) => (
              <motion.li key={l.id} layout initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96 }} transition={{ delay: Math.min(i, 6) * 0.05 }}>
              <SpotlightCard glow="electric" className="h-full"><div className="flex h-full flex-col p-5">
                <div className="flex flex-wrap gap-1.5">
                  {l.category && <Badge tone="electric">{l.category}</Badge>}
                  {(l.domain?.name ?? domainName(l.domain?.slug ?? l.domainSlug)) && <Badge>{l.domain?.name ?? domainName(l.domain?.slug ?? l.domainSlug)}</Badge>}
                  {l.verificationStatus === 'verified' && <Badge tone="success">Verified</Badge>}
                </div>
                <h3 className="mt-3 font-semibold">{l.title}</h3>
                {l.description && <p className="mt-1.5 line-clamp-3 text-sm text-fg-muted">{l.description}</p>}
                <div className="mt-auto flex items-end justify-between gap-2 pt-4">
                  <div className="text-xs text-fg-subtle">{l.licence && <p>Licence: {l.licence}</p>}{l.contributor?.name && <p>by {l.contributor.name}</p>}{l.qualityScore != null && <p>Quality {Math.round(l.qualityScore)}/100</p>}</div>
                  <div className="text-right">
                    <p className="font-display font-semibold text-gold">{!l.priceCredits ? 'Free' : `${fmtNumber(l.priceCredits)} IDLE`}</p>
                    <Button size="sm" variant="outline" className="mt-2" href="/sign-in?next=%2Fapp%2Fknowledge">License</Button>
                  </div>
                </div>
              </div></SpotlightCard>
              </motion.li>
            ))}
            </AnimatePresence>
          </ul>
        )}
      </div>
      {pages > 1 && (
        <div className="mt-6 flex items-center justify-center gap-3">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
          <span className="text-sm text-fg-muted">Page {page} of {pages}</span>
          <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
        </div>
      )}
    </div>
  );
}
