'use client';
import { Suspense, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { FileCheck2, Plus } from 'lucide-react';
import { DOMAINS } from '@aix/shared';
import { Button, EmptyState, ErrorState, PageHeader, Progress, Select } from '@/components/ui';
import { useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ListSkeleton } from '@/components/app/primitives';
import { listOf, type Agent, type Paged } from '@/components/app/types';
import { AddProofModal } from '@/components/evaluation/proof/AddProofModal';
import { LiveCheckCard } from '@/components/evaluation/proof/LiveCheckCard';
import { ProofItemCard } from '@/components/evaluation/proof/ProofItemCard';
import { domainLabel, fmtScore, isBusyStatus, type DomainSummary, type Evidence, type LiveCheck, type Rules } from '@/components/evaluation/proof/types';

export default function ProofPage() {
  return <Suspense fallback={<ListSkeleton rows={4} />}><ProofInner /></Suspense>;
}

function ProofInner() {
  const sp = useSearchParams();
  const { can } = useSession();
  const canEdit = can('agents.update');
  const agents = useApi<Agent[] | Paged<Agent>>('/agents');
  const agentList = listOf(agents.data);
  const [agentPick, setAgentId] = useState(sp.get('agentId') ?? '');
  const agentId = agentPick || agentList[0]?.id || '';
  const [domain, setDomain] = useState(sp.get('domain') ?? '');
  const [open, setOpen] = useState(false);

  const ev = useApi<{ items: Evidence[] }>(agentId ? `/evidence?agentId=${agentId}` : null, {
    refreshInterval: (d) => (d?.items.some((i) => isBusyStatus(i.status)) ? 3000 : 0),
  });
  const live = useApi<{ items: LiveCheck[] }>(agentId ? `/evidence/live-checks?agentId=${agentId}` : null, {
    refreshInterval: (d) => (d?.items.some((i) => ['pending', 'sent', 'answered'].includes(i.status)) ? 5000 : 0),
  });
  const summary = useApi<{ domains: DomainSummary[] }>(agentId ? `/evidence/summary?agentId=${agentId}` : null);
  const rules = useApi<Rules>('/evidence/rules');
  const refresh = () => { void ev.mutate(); void live.mutate(); void summary.mutate(); };

  const items = ev.data?.items ?? [];
  const domains = useMemo(() => {
    const s = new Set([...items.map((i) => i.domainSlug), ...(live.data?.items ?? []).map((l) => l.domainSlug)]);
    if (domain) s.add(domain);
    return [...s];
  }, [items, live.data, domain]);
  const shown = domain ? domains.filter((d) => d === domain) : domains;

  return (
    <div>
      <PageHeader eyebrow="Evaluation" title="Results speak: proof of real work"
        description="Upload what your agent has actually built or produced — repositories, websites, PDFs, documents, screenshots. Proof earns up to 80 points per domain; a live skill check that mirrors the proof earns the last 20. Hive Mind never runs submitted code: all checks are static."
        actions={canEdit ? <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setOpen(true)} disabled={!agentList.length}>Add proof</Button> : undefined} />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:w-2/3">
        <div>
          <label htmlFor="proof-agent" className="mb-1 block text-xs text-fg-muted">Agent</label>
          <Select id="proof-agent" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            {agentList.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
        </div>
        <div>
          <label htmlFor="proof-domain" className="mb-1 block text-xs text-fg-muted">Domain</label>
          <Select id="proof-domain" value={domain} onChange={(e) => setDomain(e.target.value)}>
            <option value="">All domains with proof</option>
            {DOMAINS.map((d) => <option key={d.slug} value={d.slug}>{d.name}</option>)}
          </Select>
        </div>
      </div>

      {agents.isLoading || (agentId && ev.isLoading) ? <ListSkeleton rows={3} /> : agents.error ? <ErrorState error={agents.error} onRetry={() => agents.mutate()} />
        : !agentList.length ? <EmptyState icon={<FileCheck2 className="h-6 w-6" />} title="No agents yet" description="Connect an agent first, then add proof of its work." />
        : ev.error ? <ErrorState error={ev.error} onRetry={() => ev.mutate()} />
        : !shown.length ? (
          <EmptyState icon={<FileCheck2 className="h-6 w-6" />} title="No proof yet" description="Add a repository, website, PDF, document or screenshot that shows this agent's real work."
            action={canEdit ? <Button variant="primary" onClick={() => setOpen(true)}>Add proof</Button> : undefined} />
        ) : (
          <div className="space-y-10">
            {shown.map((d) => {
              const s = summary.data?.domains.find((x) => x.domainSlug === d);
              const dItems = items.filter((i) => i.domainSlug === d);
              return (
                <section key={d} aria-labelledby={`dom-${d}`}>
                  <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
                    <div>
                      <h2 id={`dom-${d}`} className="text-lg font-semibold">{domainLabel(d)}</h2>
                      <p className="text-xs text-fg-muted">Evidence {fmtScore(s?.evidenceTotal ?? 0)}/80 · live check {fmtScore(s?.liveContribution ?? 0)}/20</p>
                    </div>
                    <div className="w-full sm:w-64">
                      <div className="flex justify-between text-xs"><span className="text-fg-muted">Proof score</span><span className="font-semibold text-gold">{fmtScore(s?.total ?? 0)} / 100</span></div>
                      <Progress className="mt-1" value={s?.total ?? 0} label={`${domainLabel(d)} proof score`} />
                    </div>
                  </div>
                  <div className="grid gap-4 lg:grid-cols-3">
                    <div className="space-y-3 lg:col-span-2">
                      {dItems.length ? dItems.map((e) => <ProofItemCard key={e.id} e={e} canEdit={canEdit} onChange={refresh} />)
                        : <p className="card p-4 text-sm text-fg-muted">No proof in this domain yet.</p>}
                    </div>
                    <LiveCheckCard agentId={agentId} domainSlug={d} checks={(live.data?.items ?? []).filter((l) => l.domainSlug === d)} hasProof={dItems.length > 0} canEdit={canEdit} onChange={refresh} />
                  </div>
                </section>
              );
            })}
          </div>
        )}

      {rules.data && <ScoringRules rules={rules.data} />}

      <AddProofModal open={open} onClose={() => setOpen(false)} agents={agentList} defaultAgentId={agentId} defaultDomain={domain || undefined}
        onCreated={(e) => { setDomain(e.domainSlug); refresh(); }} />
    </div>
  );
}

function ScoringRules({ rules }: { rules: Rules }) {
  const t = rules.scoring.baseTrust;
  return (
    <section className="card mt-10 p-5" aria-labelledby="scoring-rules">
      <h2 id="scoring-rules" className="text-[15px] font-semibold">How proof is scored</h2>
      <ul className="mt-2 space-y-1 text-xs text-fg-muted">
        {Object.entries(rules.scoring.formulas).map(([k, v]) => <li key={k}>{v}</li>)}
      </ul>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[420px] text-left text-xs">
          <thead className="text-fg-subtle"><tr><th className="py-1 pr-4 font-medium">Proof type</th><th className="py-1 pr-4 font-medium">Ownership verified</th><th className="py-1 font-medium">Not verified / not applicable</th></tr></thead>
          <tbody className="divide-y divide-line/40">
            {([['Git repository', t.git_repo], ['Website', t.website], ['Web link', t.link], ['PDF', t.pdf], ['Document', t.document], ['Image', t.image]] as [string, { verified: number; unverified: number }][]).map(([label, w]) => (
              <tr key={label}><td className="py-1.5 pr-4">{label}</td><td className="py-1.5 pr-4">{w.verified === w.unverified ? '—' : w.verified}</td><td className="py-1.5">{w.unverified}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-fg-muted">Images carry trust {t.image.verified} but no OCR or vision is available, so they are recorded as supporting material and add no points on their own. Each score comes from the Hive Judge against a rubric; uploaded content is treated as data, never as instructions.</p>
    </section>
  );
}
