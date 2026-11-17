'use client';
/**
 * Embeddable proof-based evaluation summary for one agent (optionally one domain):
 *   <ProofPanel agentId={id} domainSlug="programming" />
 * Shows evidence points (≤ 80) + live check points (≤ 20) per domain and links to the full proof page.
 */
import Link from 'next/link';
import { FileCheck2 } from 'lucide-react';
import { Badge, Progress, Skeleton } from '@/components/ui';
import { useApi } from '@/lib/api';
import { fmtScore, type DomainSummary } from './proof/types';

export function ProofPanel({ agentId, domainSlug }: { agentId: string; domainSlug?: string }) {
  const q = `/evidence/summary?agentId=${encodeURIComponent(agentId)}${domainSlug ? `&domainSlug=${encodeURIComponent(domainSlug)}` : ''}`;
  const { data, error, isLoading } = useApi<{ domains: DomainSummary[] }>(q);
  const href = `/app/evaluation/proof?agentId=${encodeURIComponent(agentId)}${domainSlug ? `&domain=${encodeURIComponent(domainSlug)}` : ''}`;
  const domains = (data?.domains ?? []).filter((d) => d.items > 0 || d.liveCheck);
  return (
    <section className="card card-glow p-4" aria-label="Proof-based evaluation">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-[15px] font-semibold"><FileCheck2 className="h-4 w-4 text-gold" aria-hidden />Results speak</h2>
          <p className="mt-0.5 text-xs text-fg-muted">Proof of real work (up to 80) + live skill check (up to 20).</p>
        </div>
        <Link href={href} className="btn-hive shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium">{domains.length ? 'Manage proof' : 'Add proof'}</Link>
      </div>
      {isLoading ? <Skeleton className="mt-4 h-16" /> : error ? <p className="mt-3 text-xs text-fg-muted">Proof summary unavailable.</p> : !domains.length ? (
        <p className="mt-3 text-xs text-fg-muted">No proof submitted yet. Upload a repo, website, PDF or document the agent produced to be evaluated on real results.</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {domains.map((d) => (
            <li key={d.domainSlug}>
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="font-medium">{d.domainName}</span>
                <span><span className="text-base font-semibold text-gold">{fmtScore(d.total)}</span><span className="text-fg-muted"> / 100</span></span>
              </div>
              <Progress className="mt-1" value={d.total} label={`${d.domainName} proof score`} />
              <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-fg-muted">
                <span>Evidence {fmtScore(d.evidenceTotal)}/80</span>
                <span>Live check {d.liveCheck ? `${fmtScore(d.liveContribution)}/20` : 'not done'}</span>
                <span>{d.items} item(s)</span>
                {d.awaitingJudge > 0 && <Badge tone="warning">{d.awaitingJudge} under admin review</Badge>}
                {d.flags.map((f) => <Badge key={f} tone="danger">{f.replace(/_/g, ' ')}</Badge>)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default ProofPanel;
