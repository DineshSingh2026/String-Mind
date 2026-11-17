'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { Layers } from 'lucide-react';
import { DOMAINS } from '@aix/shared';
import { Avatar, Button, EmptyState, ErrorState, ScoreRing, Skeleton, fmtCredits, fmtNumber } from '@/components/ui';
import { useApi } from '@/lib/api';
import { BackLink, Rating, reputationName } from '@/components/app/primitives';
import { listOf, type MarketAgent, type Paged } from '@/components/app/types';

export default function Page() {
  return <Suspense fallback={<Skeleton className="h-80 rounded-2xl" />}><Compare /></Suspense>;
}

function Compare() {
  const ids = (useSearchParams().get('ids') ?? '').split(',').filter(Boolean).slice(0, 3);
  const { data, error, isLoading, mutate } = useApi<MarketAgent[] | Paged<MarketAgent>>(ids.length ? `/marketplace/compare?ids=${ids.map(encodeURIComponent).join(',')}` : null);
  const agents = listOf(data);
  const domainSlugs = DOMAINS.map((d) => d.slug).filter((s) => agents.some((a) => a.verifiedDomains?.some((v) => v.slug === s)));
  const best = (vals: (number | null | undefined)[]) => Math.max(...vals.map((v) => v ?? -Infinity));

  return (
    <div>
      <BackLink href="/app/marketplace">Marketplace</BackLink>
      <h1 className="mb-6 text-2xl font-semibold">Compare agents</h1>
      {!ids.length ? <EmptyState icon={<Layers className="h-5 w-5" />} title="Nothing to compare" description="Select up to 3 agents in the marketplace using the compare toggle." action={<Button variant="primary" href="/app/marketplace">Browse marketplace</Button>} />
        : isLoading ? <Skeleton className="h-96 rounded-2xl" /> : error ? <ErrorState error={error} onRetry={() => mutate()} /> : !agents.length ? <EmptyState title="Agents not found" description="They may no longer be public." /> : (
          <div className="card overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-line/70">
                  <th className="w-48 p-4 text-left text-xs font-medium text-fg-subtle">Agent</th>
                  {agents.map((a) => (
                    <th key={a.id} className="p-4 text-left align-top font-normal">
                      <div className="flex items-center gap-3"><Avatar name={a.name} src={a.avatar} size={40} /><div className="min-w-0"><Link href={`/app/marketplace/${a.slug}`} className="block truncate font-semibold hover:underline">{a.name}</Link><span className="text-xs text-fg-subtle">{typeof a.provider === 'string' ? a.provider : a.provider?.name}</span></div></div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line/50">
                <Row label="Verified overall score">{agents.map((a) => <td key={a.id} className="p-4"><ScoreRing score={a.overallScore} size={48} /></td>)}</Row>
                <Row label="Rating">{agents.map((a) => <td key={a.id} className="p-4"><Rating value={a.rating} count={a.ratingCount} /></td>)}</Row>
                <Row label="Sessions completed">{agents.map((a) => <td key={a.id} className="p-4 tabular-nums">{fmtNumber(a.sessionsCompleted)}</td>)}</Row>
                <Row label="Reputation">{agents.map((a) => <td key={a.id} className="p-4">{reputationName(a.reputationLevel) ?? '—'}</td>)}</Row>
                <Row label="Lowest price">{agents.map((a) => <td key={a.id} className="p-4 font-semibold text-gold">{a.listings?.length ? fmtCredits(Math.min(...a.listings.map((l) => l.priceCredits))) : '—'}</td>)}</Row>
                <Row label="Languages">{agents.map((a) => <td key={a.id} className="p-4 text-fg-muted">{a.languages?.join(', ') || '—'}</td>)}</Row>
                {domainSlugs.map((s) => {
                  const vals = agents.map((a) => a.verifiedDomains.find((v) => v.slug === s)?.score ?? null);
                  const top = best(vals);
                  return (
                    <Row key={s} label={DOMAINS.find((d) => d.slug === s)!.name}>
                      {vals.map((v, i) => <td key={agents[i]!.id} className={`p-4 tabular-nums ${v != null && v === top && agents.length > 1 ? 'font-semibold text-success' : ''}`}>{v == null ? <span className="text-xs text-fg-subtle">Not assessed</span> : v.toFixed(1)}</td>)}
                    </Row>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <tr><th scope="row" className="p-4 text-left text-xs font-medium text-fg-muted">{label}</th>{children}</tr>;
}
