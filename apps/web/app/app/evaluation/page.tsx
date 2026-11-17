'use client';
/** Professional Evaluation hub: pick an agent → per-domain view of the three evaluation paths and the resulting certification. */
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { Award, Plus, Search } from 'lucide-react';
import { DOMAINS } from '@aix/shared';
import { Button, EmptyState, ErrorState, Input, PageHeader, Select } from '@/components/ui';
import { api, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ListSkeleton, useAction } from '@/components/app/primitives';
import { listOf, type Agent, type Paged } from '@/components/app/types';
import { HexAvatar } from '@/components/brand/HexAvatar';
import { DomainCard } from '@/components/evaluation/hub/DomainCard';
import { RulesExplainer } from '@/components/evaluation/hub/RulesExplainer';
import { ScreeningMap } from '@/components/evaluation/hub/ScreeningMap';
import { AutoEvaluateToggle } from '@/components/evaluation/hub/AutoEvaluateToggle';
import type { AgentCertOverview, CertificationRules, DomainOverview } from '@/components/evaluation/hub/types';

export default function EvaluationPage() {
  return <Suspense fallback={<ListSkeleton rows={6} />}><EvaluationInner /></Suspense>;
}

function EvaluationInner() {
  const sp = useSearchParams();
  const router = useRouter();
  const { can } = useSession();
  const agents = useApi<Agent[] | Paged<Agent>>('/agents');
  const agentList = listOf(agents.data);
  const [agentId, setAgentId] = useState(sp.get('agentId') ?? '');
  const [query, setQuery] = useState('');
  const [focus, setFocus] = useState(sp.get('domain') ?? '');
  const rules = useApi<{ rules: CertificationRules }>('/certifications/rules');
  const overview = useApi<AgentCertOverview>(agentId ? `/certifications?agentId=${encodeURIComponent(agentId)}` : null);
  const { busy, run } = useAction();

  useEffect(() => {
    if (!agentId && agentList.length) setAgentId(agentList[0]!.id);
  }, [agentId, agentList]);

  const pick = (id: string) => {
    setAgentId(id);
    setQuery('');
    setFocus('');
    router.replace(`/app/evaluation?agentId=${encodeURIComponent(id)}`);
  };

  /** Domains with results first (certified → exam/proof → quick assessment → claimed), then search matches among all 70. */
  const { domains, moreMatches } = useMemo(() => {
    const list = overview.data?.domains ?? [];
    const weight = (d: DomainOverview) => d.certification && d.certification.status === 'active' && d.certification.level !== 'none' ? 0
      : d.certification || d.exam.total || d.proof.submissions ? 1 : d.quick ? 2 : 3;
    const sorted = [...list].sort((a, b) => weight(a) - weight(b) || (b.certification?.score ?? -1) - (a.certification?.score ?? -1) || a.domainName.localeCompare(b.domainName));
    const q = query.trim().toLowerCase();
    const match = (slug: string, name: string) => !q || name.toLowerCase().includes(q) || slug.includes(q);
    const shownList = sorted.filter((d) => match(d.domainSlug, d.domainName));
    const have = new Set(list.map((d) => d.domainSlug));
    const blank = (slug: string): DomainOverview => ({
      domainSlug: slug, domainName: DOMAINS.find((d) => d.slug === slug)?.name ?? slug, claimedOnly: false, quick: null,
      exam: { latest: null, latestCounting: null, total: 0 },
      proof: { submissions: 0, scored: 0, removed: 0, pending: 0, evidenceTotal: null, liveCheck: null },
      certification: null,
    });
    if (focus && !have.has(focus)) shownList.unshift(blank(focus));
    else if (focus) { const k = shownList.findIndex((d) => d.domainSlug === focus); if (k > 0) shownList.unshift(...shownList.splice(k, 1)); }
    const extra = q ? DOMAINS.filter((d) => !have.has(d.slug) && d.slug !== focus && match(d.slug, d.name)) : [];
    return { domains: shownList, moreMatches: extra.map((d) => blank(d.slug)) };
  }, [overview.data, query, focus]);

  const agent = agentList.find((a) => a.id === agentId);

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Certification" title="Professional Evaluation"
        description="Three ways to prove what an agent can do — a quick benchmark assessment, a professional exam, and proof of real work. Hive Mind certifications are earned only from real, completed results." />

      {agents.isLoading ? <ListSkeleton rows={3} /> : agents.error ? <ErrorState error={agents.error} onRetry={() => agents.mutate()} /> : agentList.length === 0 ? (
        <EmptyState icon={<Award className="h-5 w-5" />} title="No agents yet" description="Connect an agent first, then evaluate it here."
          action={<Button variant="primary" href="/app/agents/new">Connect an agent</Button>} />
      ) : (
        <>
          <div className="card flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              {agent && <HexAvatar seed={agent.id} name={agent.name} size={40} />}
              <div className="min-w-0">
                <p className="truncate font-semibold">{agent?.name ?? 'Select an agent'}</p>
                <p className="text-xs text-fg-muted">
                  {overview.data ? `${overview.data.items.filter((c) => c.status === 'active' && c.level !== 'none').length} active certification(s)` : ' '}
                </p>
              </div>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <label htmlFor="eval-agent" className="sr-only">Agent</label>
              <Select id="eval-agent" value={agentId} onChange={(e) => pick(e.target.value)} className="sm:w-56">
                {agentList.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </Select>
              <AutoEvaluateToggle agentId={agentId} canUpdate={can('agents.update')} />
            </div>
          </div>

          {agentId && <ScreeningMap agentId={agentId} onPick={(slug) => { setQuery(''); setFocus(slug); }} />}

          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
            <label htmlFor="eval-search" className="sr-only">Search all 70 domains</label>
            <Input id="eval-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search all 70 domains — domains with results are listed first" className="pl-9" />
          </div>

          {overview.isLoading ? <ListSkeleton rows={4} /> : overview.error ? <ErrorState error={overview.error} onRetry={() => overview.mutate()} /> : domains.length === 0 && !query ? (
            <EmptyState icon={<Plus className="h-5 w-5" />} title="Nothing evaluated yet"
              description="This agent has no assessments, exams or proof yet. Search a domain above to see its evaluation paths, or start with a quick assessment."
              action={<Button variant="primary" href={`/app/assessments?agentId=${agentId}&new=1`}>Run a quick assessment</Button>} />
          ) : (
            <div className="space-y-4">
              {[...domains, ...moreMatches.slice(0, 10)].map((d) => (
                <DomainCard key={d.domainSlug} agentId={agentId} d={d}
                  canRun={can('assessments.run')} canUpdate={can('agents.update')} busy={busy === d.domainSlug}
                  onRecompute={() => void run(d.domainSlug, () => api.post(`/certifications/${agentId}/${d.domainSlug}/recompute`), 'Certification recomputed').then(() => overview.mutate())} />
              ))}
              {moreMatches.length > 10 && <p className="text-center text-xs text-fg-muted">{moreMatches.length - 10} more matching domains — refine the search.</p>}
              {query && domains.length + moreMatches.length === 0 && <p className="text-center text-sm text-fg-muted">No domain matches “{query}”.</p>}
            </div>
          )}
        </>
      )}

      <RulesExplainer rules={rules.data?.rules} />
    </div>
  );
}
