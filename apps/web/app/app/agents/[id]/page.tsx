'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { Activity, Bot, GraduationCap, PlugZap, RotateCcw, Send, Trash2, Unplug, Upload } from 'lucide-react';
import { DOMAINS } from '@aix/shared';
import {
  Alert, Avatar, Badge, Button, EmptyState, ErrorState, Field, Input, ScoreRing, Select, Skeleton, Table, Tabs, Td, Textarea, Toggle,
  fmtCredits, fmtDate, fmtDateTime, fmtNumber,
} from '@/components/ui';
import { api, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ScorecardView } from '@/components/app/ScorecardView';
import {
  BackLink, ConfirmModal, KV, LearningTypeBadge, ListSkeleton, Section, StatusPill, domainName, titleCase, useAction,
} from '@/components/app/primitives';
import { claimedSlugs, listOf, type Agent, type AgentPermissions, type LearningRecord, type Paged, type Scorecard } from '@/components/app/types';

type TabKey = 'overview' | 'scorecard' | 'knowledge' | 'learning' | 'training' | 'earnings' | 'permissions' | 'limits' | 'config' | 'versions' | 'playground';
const TABS: { value: TabKey; label: string }[] = [
  { value: 'overview', label: 'Overview' }, { value: 'scorecard', label: 'Capability scorecard' }, { value: 'knowledge', label: 'Knowledge sources' },
  { value: 'learning', label: 'Learning history' }, { value: 'training', label: 'Training history' }, { value: 'earnings', label: 'Earnings' },
  { value: 'permissions', label: 'Permissions' }, { value: 'limits', label: 'Usage limits' }, { value: 'config', label: 'Configuration' },
  { value: 'versions', label: 'Version history' }, { value: 'playground', label: 'Playground' },
];

export default function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { can } = useSession();
  const { data: agent, error, isLoading, mutate } = useApi<Agent>(`/agents/${id}`);
  const [tab, setTab] = useState<TabKey>('overview');
  const [confirm, setConfirm] = useState<'disconnect' | 'delete' | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; latencyMs?: number; error?: string; sample?: string } | null>(null);
  const { busy, run } = useAction();

  if (isLoading) return <div className="space-y-4"><Skeleton className="h-32 rounded-2xl" /><Skeleton className="h-10 w-full" /><Skeleton className="h-64 rounded-2xl" /></div>;
  if (error || !agent) return <><BackLink href="/app/agents">My agents</BackLink><ErrorState error={error ?? 'Agent not found'} onRetry={() => mutate()} /></>;

  const test = async () => {
    const r = await run('test', () => api.post<{ ok: boolean; latencyMs?: number; error?: string; sample?: string }>(`/agents/${id}/test`));
    if (r) { setTestResult(r); mutate(); }
  };
  const assess = async () => {
    const r = await run('assess', () => api.post<{ id: string }>('/assessments', { agentId: id }), 'Assessment queued');
    if (r?.id) router.push(`/app/assessments/${r.id}`);
  };
  const startTraining = async () => {
    const gaps = await api.get<unknown>(`/assessments/gaps/${id}`).catch(() => null);
    const g = listOf(gaps as { domainSlug?: string; slug?: string; score?: number | null }[]).sort((a, b) => (a.score ?? 100) - (b.score ?? 100))[0];
    const dom = g?.domainSlug ?? g?.slug;
    router.push(`/app/marketplace?learner=${id}${dom ? `&domain=${encodeURIComponent(dom)}` : ''}`);
  };
  const publish = async (v: boolean) => {
    await run('publish', () => api.post(`/agents/${id}/publish`, { isPublic: v }), v ? 'Agent published to marketplace' : 'Agent unpublished');
    mutate();
  };

  return (
    <div className="space-y-6">
      <BackLink href="/app/agents">My agents</BackLink>
      <section className="card flex flex-col gap-5 p-5 lg:flex-row lg:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-4">
          <Avatar name={agent.name} src={agent.avatarUrl} size={64} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2"><h1 className="truncate text-2xl font-semibold">{agent.name}</h1><StatusPill status={agent.status} />{agent.isPublic && <Badge tone="gold">Public</Badge>}</div>
            <p className="mt-1 text-sm text-fg-muted">{agent.provider?.name ?? 'Unknown provider'}{agent.modelName ? ` · ${agent.modelName}` : ''}{agent.role ? ` · ${agent.role}` : ''}</p>
          </div>
          <ScoreRing score={agent.overallScore ?? null} size={64} label="Overall score" />
        </div>
        <div className="flex flex-wrap gap-2">
          {can('agents.connect') && <Button size="sm" variant="outline" loading={busy === 'test'} onClick={test} icon={<PlugZap className="h-4 w-4" />}>Test</Button>}
          {can('assessments.run') && <Button size="sm" variant="outline" loading={busy === 'assess'} onClick={assess} icon={<Activity className="h-4 w-4" />}>Run assessment</Button>}
          {can('training.request') && <Button size="sm" variant="ai" onClick={startTraining} icon={<GraduationCap className="h-4 w-4" />}>Start training</Button>}
          {can('knowledge.write') && <Button size="sm" variant="outline" onClick={() => setTab('knowledge')} icon={<Upload className="h-4 w-4" />}>Upload knowledge</Button>}
          {can('agents.update') && (
            <label className="flex items-center gap-2 rounded-xl border border-line px-3 text-xs text-fg-muted">Public <Toggle label="Publish to marketplace" checked={!!agent.isPublic} disabled={busy === 'publish'} onChange={publish} /></label>
          )}
          {can('agents.connect') && agent.connection?.status !== 'disconnected' && <Button size="sm" variant="ghost" onClick={() => setConfirm('disconnect')} icon={<Unplug className="h-4 w-4" />}>Disconnect</Button>}
          {can('agents.delete') && <Button size="sm" variant="ghost" onClick={() => setConfirm('delete')} icon={<Trash2 className="h-4 w-4" />} aria-label="Delete agent" />}
        </div>
      </section>
      {testResult && (
        <Alert tone={testResult.ok ? 'success' : 'danger'} title={testResult.ok ? `Connection OK${testResult.latencyMs != null ? ` · ${testResult.latencyMs} ms` : ''}` : 'Connection test failed'}>
          {testResult.ok ? (testResult.sample ? <span className="line-clamp-3">Sample reply: “{testResult.sample}”</span> : 'The agent responded successfully.') : testResult.error}
        </Alert>
      )}
      {!agent.isPublic && can('agents.update') && <p className="text-xs text-fg-subtle">Publishing requires at least one completed capability assessment.</p>}

      <Tabs tabs={TABS} value={tab} onChange={setTab} />
      <div>
        {tab === 'overview' && <Overview agent={agent} />}
        {tab === 'scorecard' && <ScorecardTab id={id} canAssess={can('assessments.run')} onAssess={assess} />}
        {tab === 'knowledge' && <KnowledgeTab id={id} canWrite={can('knowledge.write')} />}
        {tab === 'learning' && <LearningTab id={id} />}
        {tab === 'training' && <TrainingTab id={id} />}
        {tab === 'earnings' && <EarningsTab id={id} />}
        {tab === 'permissions' && <PermissionsTab agent={agent} canEdit={can('agents.update')} onSaved={() => mutate()} />}
        {tab === 'limits' && <LimitsTab agent={agent} canEdit={can('agents.update')} onSaved={() => mutate()} />}
        {tab === 'config' && <ConfigTab agent={agent} canEdit={can('agents.update')} onSaved={() => mutate()} />}
        {tab === 'versions' && <VersionsTab id={id} canEdit={can('agents.update')} onRolledBack={() => mutate()} />}
        {tab === 'playground' && <Playground id={id} />}
      </div>

      <ConfirmModal open={confirm === 'disconnect'} onClose={() => setConfirm(null)} title="Disconnect agent?" confirmLabel="Disconnect" danger loading={busy === 'disc'}
        description="Stored credentials are removed and the agent stops receiving calls. You can reconnect later."
        onConfirm={async () => { await run('disc', () => api.post(`/agents/${id}/disconnect`), 'Agent disconnected'); setConfirm(null); mutate(); }} />
      <ConfirmModal open={confirm === 'delete'} onClose={() => setConfirm(null)} title={`Delete ${agent.name}?`} confirmLabel="Delete agent" danger loading={busy === 'del'}
        description="The agent is removed from your organisation and the marketplace. History is retained for audit."
        onConfirm={async () => { const r = await run('del', () => api.del(`/agents/${id}`), 'Agent deleted'); if (r !== undefined) router.push('/app/agents'); }} />
    </div>
  );
}

function Overview({ agent }: { agent: Agent }) {
  const c = agent.connection;
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Section title="Connection">
        <dl className="divide-y divide-line/50">
          <KV k="Provider" v={agent.provider?.name ?? '—'} />
          <KV k="Model" v={`${agent.modelName ?? '—'}${agent.modelVersion ? ` (${agent.modelVersion})` : ''}`} />
          <KV k="Method" v={titleCase(c?.method)} />
          <KV k="Connection status" v={<StatusPill status={c?.status} />} />
          <KV k="API health" v={<StatusPill status={agent.health ?? 'unknown'} />} />
          <KV k="Credential" v={c?.credentialLast4 ? `•••• ${c.credentialLast4}` : 'None stored'} />
          <KV k="Last test" v={fmtDateTime(c?.lastTestedAt)} />
        </dl>
        {c?.lastError && <div className="mt-3"><Alert tone="danger" title="Last error">{c.lastError}</Alert></div>}
      </Section>
      <Section title="Profile">
        <p className="text-sm text-fg-muted">{agent.description || 'No description.'}</p>
        <dl className="mt-3 divide-y divide-line/50">
          <KV k="Languages" v={agent.languages?.join(', ') || '—'} />
          <KV k="Created" v={fmtDate(agent.createdAt)} />
          <KV k="Versions" v={fmtNumber(agent.versionsCount ?? agent.currentVersion ?? null)} />
        </dl>
        {!!agent.claimedDomains?.length && (
          <div className="mt-3"><p className="mb-1.5 text-xs text-fg-muted">Claimed domains (self-reported, not verified)</p><div className="flex flex-wrap gap-1">{claimedSlugs(agent.claimedDomains).map((d) => <Badge key={d} className="border-dashed">{domainName(d)}</Badge>)}</div></div>
        )}
        {agent.learningSummary && Object.keys(agent.learningSummary).length > 0 && (
          <div className="mt-4"><p className="mb-1.5 text-xs text-fg-muted">Learning summary</p><div className="flex flex-wrap gap-1.5">{Object.entries(agent.learningSummary).map(([k, n]) => <span key={k} className="flex items-center gap-1"><LearningTypeBadge type={k} /><span className="text-xs text-fg-muted">{n}</span></span>)}</div></div>
        )}
      </Section>
    </div>
  );
}

function ScorecardTab({ id, canAssess, onAssess }: { id: string; canAssess: boolean; onAssess: () => void }) {
  const { data, error, isLoading, mutate } = useApi<Scorecard>(`/assessments/scorecard/${id}`);
  if (isLoading) return <Skeleton className="h-72 rounded-2xl" />;
  if (error) return <ErrorState error={error} onRetry={() => mutate()} />;
  return data ? <ScorecardView card={data} agentId={id} canAssess={canAssess} onRunAssessment={onAssess} /> : null;
}

interface Source { id: string; name: string; type?: string; visibility?: string; domainSlug?: string | null; agentId?: string | null; documentsCount?: number; createdAt?: string }
function KnowledgeTab({ id, canWrite }: { id: string; canWrite: boolean }) {
  const { data, error, isLoading, mutate } = useApi<Source[] | Paged<Source>>('/knowledge/sources');
  const sources = listOf(data).filter((s) => s.agentId === id);
  const [target, setTarget] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const { busy, run } = useAction();
  const upload = async () => {
    if (!file || !target) return;
    const f = new FormData(); f.append('file', file);
    const r = await run('up', () => api.upload(`/knowledge/sources/${target}/documents`, f), 'Document uploaded — chunking & embedding queued');
    if (r !== undefined) { setFile(null); mutate(); }
  };
  if (isLoading) return <ListSkeleton />;
  if (error) return <ErrorState error={error} onRetry={() => mutate()} />;
  return (
    <div className="space-y-4">
      {!sources.length ? (
        <EmptyState title="No knowledge sources for this agent" description="Create a source in the Knowledge Bank and attach it to this agent, then upload documents for retrieval (RAG)." action={<Button variant="primary" href="/app/knowledge">Open Knowledge Bank</Button>} />
      ) : (
        <div className="card"><Table head={['Source', 'Type', 'Visibility', 'Domain', 'Documents']}>
          {sources.map((s) => <tr key={s.id}><Td className="font-medium">{s.name}</Td><Td>{titleCase(s.type)}</Td><Td>{titleCase(s.visibility)}</Td><Td>{domainName(s.domainSlug)}</Td><Td>{fmtNumber(s.documentsCount ?? null)}</Td></tr>)}
        </Table></div>
      )}
      {canWrite && sources.length > 0 && (
        <Section title="Upload a document" subtitle=".txt, .md, .csv, .json">
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <Field label="Source" htmlFor="src"><Select id="src" value={target} onChange={(e) => setTarget(e.target.value)}><option value="">Choose source…</option>{sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
            <Field label="File" htmlFor="file"><Input id="file" type="file" accept=".txt,.md,.csv,.json" className="pt-2" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
            <Button variant="primary" disabled={!file || !target} loading={busy === 'up'} onClick={upload} icon={<Upload className="h-4 w-4" />}>Upload</Button>
          </div>
        </Section>
      )}
    </div>
  );
}

function LearningTab({ id }: { id: string }) {
  const { data, error, isLoading, mutate } = useApi<LearningRecord[] | Paged<LearningRecord>>(`/knowledge/learning-records?agentId=${id}`);
  const items = listOf(data);
  if (isLoading) return <ListSkeleton />;
  if (error) return <ErrorState error={error} onRetry={() => mutate()} />;
  if (!items.length) return <EmptyState title="No learning recorded yet" description="Learning records appear after training sessions complete and artefacts are approved." action={<Button variant="ai" href={`/app/marketplace?learner=${id}`}>Find a trainer</Button>} />;
  return (
    <div className="card"><Table head={['Date', 'Learning type', 'Domain', 'Summary', 'Pre → Post', 'Improvement', 'Retention']}>
      {items.map((r) => (
        <tr key={r.id}>
          <Td className="whitespace-nowrap text-fg-muted">{fmtDate(r.createdAt)}</Td>
          <Td><LearningTypeBadge type={r.learningType ?? r.type} /></Td>
          <Td>{domainName(r.domainSlug)}</Td>
          <Td className="max-w-xs"><span className="line-clamp-2">{r.summary ?? r.title ?? r.description ?? '—'}</span>{r.sessionId && <Link className="text-xs text-electric-soft hover:underline" href={`/app/training/${r.sessionId}`}>View session</Link>}</Td>
          <Td className="tabular-nums">{r.preScore == null ? '—' : r.preScore.toFixed(1)} → {r.postScore == null ? '—' : r.postScore.toFixed(1)}</Td>
          <Td className={r.improvement == null ? '' : r.improvement >= 0 ? 'text-success' : 'text-danger-soft'}>{r.improvement == null ? '—' : `${r.improvement > 0 ? '+' : ''}${r.improvement.toFixed(1)}`}</Td>
          <Td>{r.retentionScore == null ? 'Pending' : r.retentionScore.toFixed(1)}</Td>
        </tr>
      ))}
    </Table></div>
  );
}

interface SessionRow { id: string; status: string; stage?: string; domainSlug?: string; createdAt: string; priceCredits?: number | null; improvement?: number | null; learner?: { agentId?: string; id?: string; name?: string } | null; trainer?: { agentId?: string; id?: string; name?: string } | null; learnerAgentId?: string; trainerAgentId?: string }
function TrainingTab({ id }: { id: string }) {
  const { data, error, isLoading, mutate } = useApi<SessionRow[] | Paged<SessionRow>>('/training/sessions');
  const lid = (s: SessionRow) => s.learnerAgentId ?? s.learner?.agentId ?? s.learner?.id;
  const tid = (s: SessionRow) => s.trainerAgentId ?? s.trainer?.agentId ?? s.trainer?.id;
  const items = listOf(data).filter((s) => lid(s) === id || tid(s) === id);
  if (isLoading) return <ListSkeleton />;
  if (error) return <ErrorState error={error} onRetry={() => mutate()} />;
  if (!items.length) return <EmptyState title="No training sessions yet" description="Sessions where this agent learned or taught will appear here." action={<Button variant="ai" href={`/app/marketplace?learner=${id}`}>Find a trainer</Button>} />;
  return (
    <div className="card"><Table head={['Date', 'Role', 'Counterpart', 'Domain', 'Status', 'Improvement', '']}>
      {items.map((s) => {
        const learner = lid(s) === id;
        return (
          <tr key={s.id}>
            <Td className="whitespace-nowrap text-fg-muted">{fmtDate(s.createdAt)}</Td>
            <Td><Badge tone={learner ? 'electric' : 'gold'}>{learner ? 'Learner' : 'Trainer'}</Badge></Td>
            <Td>{(learner ? s.trainer?.name : s.learner?.name) ?? '—'}</Td>
            <Td>{domainName(s.domainSlug)}</Td>
            <Td><StatusPill status={s.status} /></Td>
            <Td>{s.improvement == null ? '—' : `${s.improvement > 0 ? '+' : ''}${s.improvement.toFixed(1)}`}</Td>
            <Td><Link className="text-xs text-electric-soft hover:underline" href={`/app/training/${s.id}`}>Open</Link></Td>
          </tr>
        );
      })}
    </Table></div>
  );
}

interface Earnings { totalEarned: number; byMonth: { month: string; earned: number; sessions: number }[]; bySource: { agentId: string; name: string; earned: number; sessions: number }[] }
function EarningsTab({ id }: { id: string }) {
  const { data, error, isLoading, mutate } = useApi<Earnings>('/wallet/earnings');
  if (isLoading) return <Skeleton className="h-48 rounded-2xl" />;
  if (error) return <ErrorState error={error} onRetry={() => mutate()} />;
  const mine = data?.bySource.find((s) => s.agentId === id);
  if (!mine) return <EmptyState icon={<Bot className="h-5 w-5" />} title="No earnings yet" description="This agent earns IDLE Tokens when it trains other agents through marketplace listings. Enable “Be a trainer” in Permissions and publish a listing." />;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="card p-5"><p className="text-xs text-fg-muted">IDLE earned by this agent</p><p className="mt-1 font-display text-3xl font-semibold text-gold">{fmtCredits(mine.earned)}</p></div>
      <div className="card p-5"><p className="text-xs text-fg-muted">Sessions taught</p><p className="mt-1 font-display text-3xl font-semibold">{fmtNumber(mine.sessions)}</p></div>
      <p className="text-xs text-fg-subtle sm:col-span-2">Monthly breakdown across all agents is on <Link href="/app/earnings" className="text-gold hover:underline">Earnings &amp; Rewards</Link>.</p>
    </div>
  );
}

const DEFAULT_PERMS: AgentPermissions = { publicProfile: false, allowTraining: false, allowLearning: true, shareKnowledge: false, allowOwnerIntervention: true, dataSharing: 'artefacts_only', allowedDomains: [] };
function PermissionsTab({ agent, canEdit, onSaved }: { agent: Agent; canEdit: boolean; onSaved: () => void }) {
  const [p, setP] = useState<AgentPermissions>({ ...DEFAULT_PERMS, ...(agent.permissions ?? {}) });
  const { busy, run } = useAction();
  const rows: { k: keyof AgentPermissions; label: string; desc: string }[] = [
    { k: 'publicProfile', label: 'Public profile', desc: 'Show this agent in the marketplace (requires publishing).' },
    { k: 'allowTraining', label: 'Be a trainer', desc: 'Allow this agent to train other agents and earn IDLE.' },
    { k: 'allowLearning', label: 'Allow learning', desc: 'Allow this agent to learn from trainers.' },
    { k: 'shareKnowledge', label: 'Share knowledge', desc: 'Allow approved knowledge to be shared in sessions.' },
    { k: 'allowOwnerIntervention', label: 'Owner intervention', desc: 'Let your team post messages into live sessions.' },
  ];
  return (
    <Section title="Permissions" subtitle="Control what this agent may do on StringMind">
      <ul className="divide-y divide-line/50">
        {rows.map((r) => (
          <li key={r.k} className="flex items-center justify-between gap-4 py-3">
            <div><p className="text-sm font-medium">{r.label}</p><p className="text-xs text-fg-muted">{r.desc}</p></div>
            <Toggle label={r.label} checked={!!p[r.k]} disabled={!canEdit} onChange={(v) => setP({ ...p, [r.k]: v })} />
          </li>
        ))}
      </ul>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <Field label="Data sharing" htmlFor="ds"><Select id="ds" disabled={!canEdit} value={p.dataSharing} onChange={(e) => setP({ ...p, dataSharing: e.target.value as AgentPermissions['dataSharing'] })}>
          <option value="none">None</option><option value="artefacts_only">Approved artefacts only</option><option value="full_session">Full session transcripts</option>
        </Select></Field>
        <Field label="Allowed domains" htmlFor="ad" hint="Leave empty to allow all domains">
          <Select id="ad" multiple disabled={!canEdit} className="h-32 py-2" value={p.allowedDomains} onChange={(e) => setP({ ...p, allowedDomains: Array.from(e.target.selectedOptions).map((o) => o.value) })}>
            {DOMAINS.map((d) => <option key={d.slug} value={d.slug}>{d.name}</option>)}
          </Select>
        </Field>
      </div>
      {canEdit && <Button className="mt-4" variant="primary" loading={busy === 'perm'} onClick={async () => { await run('perm', () => api.put(`/agents/${agent.id}/permissions`, p), 'Permissions saved'); onSaved(); }}>Save permissions</Button>}
    </Section>
  );
}

function LimitsTab({ agent, canEdit, onSaved }: { agent: Agent; canEdit: boolean; onSaved: () => void }) {
  const [calls, setCalls] = useState(agent.usageLimits?.maxCallsPerDay?.toString() ?? '');
  const [credits, setCredits] = useState(agent.usageLimits?.maxCreditsPerDay?.toString() ?? '');
  const { busy, run } = useAction();
  const num = (s: string) => (s.trim() === '' ? null : Math.max(0, Math.floor(Number(s))));
  return (
    <Section title="Usage limits" subtitle="Daily safety caps. Leave empty for no limit.">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Max calls per day" htmlFor="mc"><Input id="mc" type="number" min={0} disabled={!canEdit} value={calls} onChange={(e) => setCalls(e.target.value)} /></Field>
        <Field label="Max IDLE spent per day" htmlFor="mcr"><Input id="mcr" type="number" min={0} disabled={!canEdit} value={credits} onChange={(e) => setCredits(e.target.value)} /></Field>
      </div>
      {canEdit && <Button className="mt-4" variant="primary" loading={busy === 'lim'} onClick={async () => { await run('lim', () => api.put(`/agents/${agent.id}/limits`, { maxCallsPerDay: num(calls), maxCreditsPerDay: num(credits) }), 'Limits saved'); onSaved(); }}>Save limits</Button>}
    </Section>
  );
}

function ConfigTab({ agent, canEdit, onSaved }: { agent: Agent; canEdit: boolean; onSaved: () => void }) {
  const [f, setF] = useState({ name: agent.name, description: agent.description ?? '', role: agent.role ?? '', instructions: agent.instructions ?? '', modelName: agent.modelName ?? '' });
  const { busy, run } = useAction();
  const changedInstr = f.instructions !== (agent.instructions ?? '');
  return (
    <Section title="Configuration">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="n"><Input id="n" disabled={!canEdit} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Model" htmlFor="m"><Input id="m" disabled={!canEdit} value={f.modelName} onChange={(e) => setF({ ...f, modelName: e.target.value })} /></Field>
        <Field label="Role" htmlFor="r"><Input id="r" disabled={!canEdit} value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} /></Field>
        <Field label="Description" htmlFor="d"><Input id="d" disabled={!canEdit} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      </div>
      <div className="mt-4"><Field label="System instructions" htmlFor="i" hint="Changing instructions creates a new version you can roll back."><Textarea id="i" disabled={!canEdit} className="min-h-[180px] font-mono text-xs" value={f.instructions} onChange={(e) => setF({ ...f, instructions: e.target.value })} /></Field></div>
      {changedInstr && <div className="mt-3"><Alert tone="info">Saving will create a new agent version.</Alert></div>}
      {canEdit && <Button className="mt-4" variant="primary" loading={busy === 'cfg'} onClick={async () => { await run('cfg', () => api.patch(`/agents/${agent.id}`, f), changedInstr ? 'Saved — new version created' : 'Configuration saved'); onSaved(); }}>Save changes</Button>}
    </Section>
  );
}

interface Version { id?: string; version: number; instructions?: string | null; createdAt: string; createdBy?: { name: string } | null; note?: string | null; current?: boolean; isCurrent?: boolean }
function VersionsTab({ id, canEdit, onRolledBack }: { id: string; canEdit: boolean; onRolledBack: () => void }) {
  const { data, error, isLoading, mutate } = useApi<Version[] | Paged<Version>>(`/agents/${id}/versions`);
  const [target, setTarget] = useState<number | null>(null);
  const { busy, run } = useAction();
  const items = listOf(data).sort((a, b) => b.version - a.version);
  if (isLoading) return <ListSkeleton />;
  if (error) return <ErrorState error={error} onRetry={() => mutate()} />;
  if (!items.length) return <EmptyState title="No versions yet" description="A version is recorded each time instructions change." />;
  return (
    <>
      <ul className="space-y-3">
        {items.map((v, i) => (
          <li key={v.version} className="card p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-medium">Version {v.version} {(v.current || v.isCurrent || (i === 0 && v.current === undefined && v.isCurrent === undefined)) && <Badge tone="success">Current</Badge>}</p>
              <div className="flex items-center gap-3 text-xs text-fg-subtle">{fmtDateTime(v.createdAt)}{v.createdBy?.name && ` · ${v.createdBy.name}`}
                {canEdit && i > 0 && <Button size="sm" variant="outline" onClick={() => setTarget(v.version)} icon={<RotateCcw className="h-3.5 w-3.5" />}>Roll back</Button>}</div>
            </div>
            {v.instructions && <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded-lg bg-ink-950 p-3 font-mono text-[11px] text-fg-muted">{v.instructions}</pre>}
          </li>
        ))}
      </ul>
      <ConfirmModal open={target != null} onClose={() => setTarget(null)} title={`Roll back to version ${target}?`} confirmLabel="Roll back" loading={busy === 'rb'}
        description="The agent's instructions are restored from that version (recorded as a new version)."
        onConfirm={async () => { await run('rb', () => api.post(`/agents/${id}/versions/${target}/rollback`), 'Rolled back'); setTarget(null); mutate(); onRolledBack(); }} />
    </>
  );
}

interface PlayReply { reply: string; latencyMs?: number; citations?: { title?: string; source?: string; documentTitle?: string; sourceName?: string; score?: number }[]; knowledgeUsed?: { title?: string; source?: string; type?: string }[]; memoriesUsed?: { id?: string; content?: string }[] }
function Playground({ id }: { id: string }) {
  const [msgs, setMsgs] = useState<({ role: 'user'; text: string } | { role: 'agent'; r: PlayReply })[]>([]);
  const [input, setInput] = useState('');
  const { busy, run } = useAction();
  const send = async () => {
    const text = input.trim(); if (!text) return;
    setMsgs((m) => [...m, { role: 'user', text }]); setInput('');
    const r = await run('play', () => api.post<PlayReply>(`/agents/${id}/playground`, { message: text }));
    if (r) setMsgs((m) => [...m, { role: 'agent', r }]);
  };
  return (
    <div className="card flex h-[60vh] min-h-[420px] flex-col">
      <div className="flex-1 space-y-4 overflow-y-auto p-4" aria-live="polite">
        {!msgs.length && <p className="py-10 text-center text-sm text-fg-subtle">Chat with your agent through its real connection. Injected memories and knowledge (RAG) used for each reply are listed below it.</p>}
        {msgs.map((m, i) => m.role === 'user' ? (
          <div key={i} className="ml-auto max-w-[80%] rounded-2xl rounded-br-sm bg-electric/15 px-4 py-2.5 text-sm">{m.text}</div>
        ) : (
          <div key={i} className="max-w-[85%]">
            <div className="whitespace-pre-wrap rounded-2xl rounded-bl-sm border border-line/70 bg-ink-850 px-4 py-2.5 text-sm">{m.r.reply}</div>
            <div className="mt-1.5 space-y-1 text-[11px] text-fg-subtle">
              {m.r.latencyMs != null && <p>{m.r.latencyMs} ms</p>}
              {(() => {
                const used = [...(m.r.citations ?? []).map((c) => `${c.documentTitle ?? c.title ?? 'Document'} — ${c.sourceName ?? c.source ?? ''}`), ...(m.r.knowledgeUsed ?? []).map((k) => `${k.title ?? 'Knowledge'}${k.type ? ` (${k.type})` : ''}`)];
                return used.length ? <p>Knowledge used: {used.join('; ')}</p> : <p>No knowledge sources were cited.</p>;
              })()}
              {!!m.r.memoriesUsed?.length && <p>Memories injected: {m.r.memoriesUsed.length}</p>}
            </div>
          </div>
        ))}
      </div>
      <form className="flex gap-2 border-t border-line/60 p-3" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <Input aria-label="Message" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask your agent something…" />
        <Button type="submit" variant="ai" loading={busy === 'play'} aria-label="Send" icon={<Send className="h-4 w-4" />} />
      </form>
    </div>
  );
}

