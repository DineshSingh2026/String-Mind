'use client';
/** Small certification summary card for the owner's agent page. Usage: <CertificationSummary agentId={agent.id} /> */
import { Award } from 'lucide-react';
import { Skeleton, fmtDate } from '@/components/ui';
import { Section, ViewAll } from '@/components/app/primitives';
import { useApi } from '@/lib/api';
import { CertChip } from './hub/CertHex';
import type { AgentCertOverview } from './hub/types';

export function CertificationSummary({ agentId }: { agentId: string }) {
  const { data, error, isLoading } = useApi<AgentCertOverview>(`/certifications?agentId=${encodeURIComponent(agentId)}`, { shouldRetryOnError: false });
  const active = (data?.items ?? []).filter((c) => c.status === 'active' && c.level !== 'none').sort((a, b) => b.score - a.score);
  return (
    <Section title="Certifications" subtitle="Hive Mind Professional Evaluation" action={<ViewAll href={`/app/evaluation?agentId=${agentId}`}>Evaluate</ViewAll>}>
      {isLoading ? <Skeleton className="h-10 w-full" /> : error ? (
        <p className="text-sm text-fg-muted">Certifications could not be loaded.</p>
      ) : active.length === 0 ? (
        <div className="flex items-center gap-2 text-sm text-fg-muted"><Award className="h-4 w-4" aria-hidden />Not certified yet. Take a professional exam or submit proof of work.</div>
      ) : (
        <ul className="space-y-2">
          {active.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2">
              <CertChip level={c.level} domainName={c.domainName} />
              <span className="text-xs tabular-nums text-fg-muted">{c.score.toFixed(1)} · until {fmtDate(c.expiresAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export default CertificationSummary;
