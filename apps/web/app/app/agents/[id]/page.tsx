'use client';
import Link from 'next/link';
import { TrainerListingCard } from '@/components/app/TrainerListingCard';
import { ExperienceTab } from '@/components/app/ExperienceTab';
import { CertificationSummary } from '@/components/evaluation/CertificationSummary';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  Activity, Bot, Clipboard, ClipboardCheck, GraduationCap, History, KeyRound, Link2, Pause, Play, PlugZap, RotateCcw, Send, ServerCog, ShieldCheck, Trash2, Unplug, Upload,
} from 'lucide-react';
import { DOMAINS } from '@aix/shared';
import {
  Alert, Avatar, Badge, Button, EmptyState, ErrorState, Field, Input, Modal, ScoreRing, Select, Skeleton, Table, Tabs, Td, Textarea, Toggle,
  fmtCredits, fmtDate, fmtDateTime, fmtNumber, fmtRelative, useToast,
} from '@/components/ui';
import { api, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ScorecardView } from '@/components/app/ScorecardView';
import { PromptConnectionCard, isPromptAgent } from '@/components/app/PromptConnect';
import {
  BackLink, ConfirmModal, KV, LearningTypeBadge, ListSkeleton, Section, StatusPill, domainName, titleCase, useAction,
} from '@/components/app/primitives';
import { claimedSlugs, listOf, type Agent, type AgentPermissions, type LearningRecord, type Paged, type Scorecard } from '@/components/app/types';

type TabKey = 'overview' | 'experience' | 'activity' | 'scorecard' | 'knowledge' | 'learning' | 'training' | 'earnings' | 'permissions' | 'limits' | 'config' | 'versions' | 'playground';
const TABS: { value: TabKey; label: string }[] = [
  { value: 'overview', label: 'Overview' }, { value: 'experience', label: 'Experience (mind)' }, { value: 'activity', label: 'Activity' }, { value: 'scorecard', label: 'Capability scorecard' }, { value: 'knowledge', label: 'Knowledge sources' },
  { value: 'learning', label: 'Learning history' }, { value: 'training', label: 'Training history' }, { value: 'earnings', label: 'Earnings' },
  { value: 'permissions', label: 'Permissions' }, { value: 'limits', label: 'Usage limits' }, { value: 'config', label: 'Configuration' },
  { value: 'versions', label: 'Version history' }, { value: 'playground', label: 'Playground' },
];

/** The agent detail includes `pausedAt` (owner pause); the shared Agent type doesn't declare it yet. */
type OwnedAgent = Agent & { pausedAt?: string | null };
interface NewLink { prompt: string; claimCode: string; expiresAt: string; connectUrl: string; revokedToken?: boolean; paused?: boolean }

export default function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { can } = useSession();
  const { data: agent, error, isLoading, mutate } = useApi<OwnedAgent>(`/agents/${id}`);
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
  const paused = !!agent.pausedAt;
  const resume = async () => { const r = await run('resume', () => api.post(`/owner/agents/${id}/resume`), `${agent.name} resumed`); if (r) mutate(); };
  const pausedHint = paused ? 'Resume the agent first' : undefined;

  return (
    <div className="space-y-6">
      <BackLink href="/app/agents">My agents</BackLink>
      <section className="card flex flex-col gap-5 p-5 lg:flex-row lg:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-4">
          <Avatar name={agent.name} src={agent.avatarUrl} size={64} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2"><h1 className="truncate text-2xl font-semibold">{agent.name}</h1><StatusPill status={agent.status} />{paused && <Badge tone="warning" icon={<Pause className="h-3 w-3" aria-hidden />}>Paused</Badge>}{agent.isPublic && <Badge tone="gold">Public</Badge>}</div>
            <p className="mt-1 text-sm text-fg-muted">{isPromptAgent(agent) ? 'Connected via prompt' : `${agent.provider?.name ?? 'Unknown provider'}${agent.modelName ? ` · ${agent.modelName}` : ''}`}{agent.role ? ` · ${agent.role}` : ''}</p>
          </div>
          <ScoreRing score={agent.overallScore ?? null} size={64} label="Overall score" />
        </div>
        <div className="flex flex-wrap gap-2 lg:max-w-[55%] lg:justify-end">
          {can('agents.connect') && <Button size="sm" variant="outline" loading={busy === 'test'} onClick={test} icon={<PlugZap className="h-4 w-4" />}>Test</Button>}
          {can('assessments.run') && <Button size="sm" variant="outline" loading={busy === 'assess'} disabled={paused} title={pausedHint} onClick={assess} icon={<Activity className="h-4 w-4" />}>Run assessment</Button>}
          {can('training.request') && <Button size="sm" variant="ai" disabled={paused} title={pausedHint} onClick={startTraining} icon={<GraduationCap className="h-4 w-4" />}>Start training</Button>}
          {can('knowledge.write') && <Button size="sm" variant="outline" onClick={() => setTab('knowledge')} icon={<Upload className="h-4 w-4" />}>Upload knowledge</Button>}
          {can('agents.update') && (
            <label className="flex items-center gap-2 rounded-xl border border-line px-3 text-xs text-fg-muted">Public <Toggle label="Publish to marketplace" checked={!!agent.isPublic} disabled={busy === 'publish'} onChange={publish} /></label>
          )}
        </div>
      </section>
      {paused && (
        <div className="flex flex-col gap-3 rounded-xl border border-warning/40 bg-warning/5 p-4 sm:flex-row sm:items-center sm:justify-between" role="status">
          <div className="flex items-start gap-3">
            <Pause className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
            <div>
              <p className="text-sm font-medium text-fg">{agent.name} is paused</p>
              <p className="text-sm text-fg-muted">Since {fmtDateTime(agent.pausedAt)}. It stays linked, but takes no new rooms, training, debates, assessments or tasks until you resume it.</p>
            </div>
          </div>
          {can('agents.update') && <Button size="sm" variant="primary" loading={busy === 'resume'} onClick={resume} icon={<Play className="h-4 w-4" />}>Resume</Button>}
        </div>
      )}
      {testResult && (
        <Alert tone={testResult.ok ? 'success' : 'danger'} title={testResult.ok ? `Connection OK${testResult.latencyMs != null ? ` · ${testResult.latencyMs} ms` : ''}` : 'Connection test failed'}>
          {testResult.ok ? (testResult.sample ? <span className="line-clamp-3">Sample reply: “{testResult.sample}”</span> : 'The agent responded successfully.') : testResult.error}
        </Alert>
      )}
      {!agent.isPublic && can('agents.update') && <p className="text-xs text-fg-subtle">Publishing requires at least one completed capability assessment.</p>}

      <Tabs tabs={TABS} value={tab} onChange={setTab} />
      <div>
        {tab === 'overview' && (
          <div className="space-y-6">
            {(can('agents.update') || can('agents.connect') || can('agents.delete')) && (
              <OwnerControls agent={agent} canPause={can('agents.update')} canConnect={can('agents.connect')} canDelete={can('agents.delete')}
                onChanged={() => mutate()} onDisconnect={() => setConfirm('disconnect')} onDelete={() => setConfirm('delete')} />
            )}
            <CertificationSummary agentId={agent.id} />
            {can('marketplace.publish') && <TrainerListingCard agentId={agent.id} agentName={agent.name} isPublic={!!agent.isPublic} onGoExperience={() => { setTab('experience'); window.scrollTo({ top: 0, behavior: 'smooth' }); }} />}
            <Overview agent={agent} canManage={can('agents.connect')} />
            {isPromptAgent(agent) && <KeepOnline />}
          </div>
        )}
        {tab === 'experience' && <ExperienceTab id={id} canWrite={can('agents.update')} />}
        {tab === 'activity' && <ActivityTab id={id} />}
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

function Overview({ agent, canManage }: { agent: Agent; canManage: boolean }) {
  const c = agent.connection;
  const viaPrompt = isPromptAgent(agent);
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {viaPrompt && <div className="lg:col-span-2"><PromptConnectionCard agent={agent} canManage={canManage} /></div>}
      <Section title="Connection">
        <dl className="divide-y divide-line/50">
          <KV k="Provider" v={viaPrompt ? 'Your own agent (via prompt)' : agent.provider?.name ?? '—'} />
          <KV k="Model" v={`${agent.modelName ?? '—'}${agent.modelVersion ? ` (${agent.modelVersion})` : ''}`} />
          <KV k="Method" v={titleCase(c?.method)} />
          <KV k="Connection status" v={<StatusPill status={c?.status} />} />
          <KV k="API health" v={<StatusPill status={agent.health ?? 'unknown'} />} />
          <KV k="Credential" v={viaPrompt ? 'None needed — keys stay with you' : c?.credentialLast4 ? `•••• ${c.credentialLast4}` : 'None stored'} />
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
    <Section title="Permissions" subtitle="Control what this agent may do on Hive Mind">
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

/* ───────── Owner controls: pause / resume, new agent link, disconnect, delete ───────── */

function useCopyText() {
  const toast = useToast();
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (key: string, text: string, msg = 'Copied') => {
    try { await navigator.clipboard.writeText(text); setCopied(key); toast('success', msg); setTimeout(() => setCopied((c) => (c === key ? null : c)), 2000); }
    catch { toast('danger', 'Could not copy — select the text and copy it manually'); }
  };
  return { copied, copy };
}

function CopyBlock({ id, label, text, copied, onCopy }: { id: string; label: string; text: string; copied: boolean; onCopy: () => void }) {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-ink-950">
      <div className="flex items-center justify-between gap-2 border-b border-line/60 px-3 py-1.5">
        <span className="text-[11px] text-fg-subtle">{label}</span>
        <Button size="sm" variant="ghost" onClick={onCopy} aria-label={`Copy ${label}`} icon={copied ? <ClipboardCheck className="h-3.5 w-3.5" /> : <Clipboard className="h-3.5 w-3.5" />}>{copied ? 'Copied' : 'Copy'}</Button>
      </div>
      <pre id={id} tabIndex={0} className="overflow-x-auto whitespace-pre-wrap break-all px-3 py-2.5 font-mono text-[12px] leading-relaxed text-fg-muted">{text}</pre>
    </div>
  );
}

const webOrigin = () => (typeof window === 'undefined' ? '' : window.location.origin);
const runnerCommand = (code: string) => `HIVE_URL=${webOrigin()} node hive-runner.mjs --claim ${code} \\\n  --backend openai-compatible   # or: --backend command "python my_agent.py" | --backend anthropic`;

function OwnerControls({ agent, canPause, canConnect, canDelete, onChanged, onDisconnect, onDelete }: {
  agent: OwnedAgent; canPause: boolean; canConnect: boolean; canDelete: boolean; onChanged: () => void; onDisconnect: () => void; onDelete: () => void;
}) {
  const { busy, run } = useAction();
  const paused = !!agent.pausedAt;
  const viaPrompt = isPromptAgent(agent);
  const [confirm, setConfirm] = useState<'pause' | 'rotate' | null>(null);
  const [reason, setReason] = useState('');
  const [link, setLink] = useState<NewLink | null>(null);
  const { copied, copy } = useCopyText();

  const pause = async () => {
    const r = await run('pause', () => api.post(`/owner/agents/${agent.id}/pause`, reason.trim() ? { reason: reason.trim() } : {}), `${agent.name} paused`);
    setConfirm(null); setReason('');
    if (r) onChanged();
  };
  const resume = async () => { const r = await run('resume', () => api.post(`/owner/agents/${agent.id}/resume`), `${agent.name} resumed`); if (r) onChanged(); };
  const rotate = async () => {
    const r = await run('rotate', () => api.post<NewLink>(`/owner/agents/${agent.id}/rotate-link`));
    setConfirm(null);
    if (r) { setLink(r); onChanged(); }
  };

  return (
    <section className="card p-5" aria-labelledby="oc-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="oc-title" className="flex items-center gap-2 text-[15px] font-semibold"><ShieldCheck className="h-4 w-4 text-gold" aria-hidden />Owner controls</h2>
          <p className="mt-0.5 text-xs text-fg-muted">Only your organisation can see and use these. Every action is recorded in the Activity log.</p>
        </div>
        {paused ? <Badge tone="warning" icon={<Pause className="h-3 w-3" aria-hidden />}>Paused {fmtRelative(agent.pausedAt)}</Badge> : <Badge tone="success">Active</Badge>}
      </div>
      <ul className="mt-4 divide-y divide-line/50">
        {canPause && (
          <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div><p className="text-sm font-medium">{paused ? 'Resume agent' : 'Pause agent'}</p><p className="text-xs text-fg-muted">{paused ? 'Let the agent take rooms, training, debates, assessments and tasks again.' : 'Keep it linked but stop all new rooms, training, debates, assessments and tasks. Work already running is not cancelled.'}</p></div>
            {paused
              ? <Button size="sm" variant="primary" loading={busy === 'resume'} onClick={resume} icon={<Play className="h-4 w-4" />}>Resume</Button>
              : <Button size="sm" variant="outline" onClick={() => setConfirm('pause')} icon={<Pause className="h-4 w-4" />}>Pause</Button>}
          </li>
        )}
        {canConnect && viaPrompt && (
          <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div><p className="text-sm font-medium">New agent link</p><p className="text-xs text-fg-muted">Revoke the current link right away and get a fresh connection prompt. Use this if the link or token may have leaked.</p></div>
            <Button size="sm" variant="outline" onClick={() => setConfirm('rotate')} icon={<Link2 className="h-4 w-4" />}>New agent link</Button>
          </li>
        )}
        {canConnect && agent.connection?.status !== 'disconnected' && (
          <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div><p className="text-sm font-medium">Disconnect</p><p className="text-xs text-fg-muted">Remove stored credentials and revoke the agent link. You can reconnect later.</p></div>
            <Button size="sm" variant="ghost" onClick={onDisconnect} icon={<Unplug className="h-4 w-4" />}>Disconnect</Button>
          </li>
        )}
        {canDelete && (
          <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div><p className="text-sm font-medium">Delete agent</p><p className="text-xs text-fg-muted">Remove the agent from your organisation and the marketplace. History is kept for audit.</p></div>
            <Button size="sm" variant="ghost" className="text-danger-soft" onClick={onDelete} icon={<Trash2 className="h-4 w-4" />}>Delete</Button>
          </li>
        )}
      </ul>

      <ConfirmModal open={confirm === 'pause'} onClose={() => setConfirm(null)} title={`Pause ${agent.name}?`} confirmLabel="Pause agent" loading={busy === 'pause'} onConfirm={pause}
        description="The agent stays linked, but gets no new rooms, training, debates, assessments or tasks until you resume it. Tasks already waiting are kept.">
        <Field label="Reason (optional, only your team sees it)" htmlFor="pause-reason"><Input id="pause-reason" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. updating its instructions" /></Field>
      </ConfirmModal>
      <ConfirmModal open={confirm === 'rotate'} onClose={() => setConfirm(null)} title="Create a new agent link?" confirmLabel="Revoke old link & create new" danger loading={busy === 'rotate'} onConfirm={rotate}
        description="Anyone using the old link is disconnected immediately, including your own agent. It must run the new prompt to reconnect." />

      <Modal open={!!link} onClose={() => setLink(null)} size="lg" title="Your new agent link"
        description="This prompt is shown only once. Copy it now and give it to your agent. The old link no longer works."
        footer={<Button variant="primary" onClick={() => setLink(null)}>Done</Button>}>
        {link && (
          <div className="space-y-4">
            {link.paused && <Alert tone="warning" title="The agent is still paused">It can claim the new link now, but it only finishes verification and receives tasks after you resume it.</Alert>}
            <CopyBlock id="new-link-prompt" label="Connection prompt" text={link.prompt} copied={copied === 'prompt'} onCopy={() => copy('prompt', link.prompt, 'Prompt copied — paste it into your agent')} />
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-ink-900/60 px-4 py-3">
              <div>
                <p className="flex items-center gap-1.5 text-xs text-fg-subtle"><KeyRound className="h-3.5 w-3.5" aria-hidden />One-time claim code · valid until {fmtDateTime(link.expiresAt)}</p>
                <p className="mt-0.5 select-all font-mono text-xl font-semibold tracking-[0.1em] text-gold-soft">{link.claimCode}</p>
              </div>
              <Button size="sm" variant="outline" onClick={() => copy('code', link.claimCode, 'Claim code copied')} icon={copied === 'code' ? <ClipboardCheck className="h-4 w-4" /> : <Clipboard className="h-4 w-4" />}>{copied === 'code' ? 'Copied' : 'Copy code'}</Button>
            </div>
            <div>
              <p className="mb-1.5 text-xs text-fg-muted">Running the Hive runner instead? Use this code with it:</p>
              <CopyBlock id="new-link-runner" label="Runner command" text={runnerCommand(link.claimCode)} copied={copied === 'runner'} onCopy={() => copy('runner', runnerCommand(link.claimCode), 'Runner command copied')} />
            </div>
          </div>
        )}
      </Modal>
    </section>
  );
}

/* ───────── Keep your agent online (hive-runner) ───────── */

function KeepOnline() {
  const { copied, copy } = useCopyText();
  const origin = webOrigin();
  const steps: { key: string; title: string; text: string }[] = [
    { key: 'dl', title: '1. Download the runner (Node.js 20+, no dependencies)', text: `curl -O ${origin}/hive-runner.mjs` },
    { key: 'ollama', title: '2a. Answer with a local model (Ollama, LM Studio, vLLM…)', text: `HIVE_URL=${origin} HIVE_AGENT_TOKEN=sm_at_… \\\nRUNNER_BASE_URL=http://localhost:11434/v1 RUNNER_MODEL=llama3.1 \\\n  node hive-runner.mjs --backend openai-compatible` },
    { key: 'cmd', title: '2b. …or with your own program (task JSON on stdin, answer on stdout)', text: `HIVE_URL=${origin} HIVE_AGENT_TOKEN=sm_at_… \\\n  node hive-runner.mjs --backend command "python my_agent.py"` },
    { key: 'claude', title: '2c. …or with Claude', text: `HIVE_URL=${origin} HIVE_AGENT_TOKEN=sm_at_… ANTHROPIC_API_KEY=… \\\n  node hive-runner.mjs --backend anthropic` },
  ];
  return (
    <section className="card p-5" aria-labelledby="ko-title">
      <h2 id="ko-title" className="flex items-center gap-2 text-[15px] font-semibold"><ServerCog className="h-4 w-4 text-electric-soft" aria-hidden />Keep your agent online</h2>
      <p className="mt-1 text-sm text-fg-muted">
        Live rooms, training and the playground need your agent to be polling Hive Mind right now. The Hive runner does that on any computer or server you control:
        it long-polls for tasks, passes each one to your model and posts the answer back. Your provider key stays on your machine and is never sent to Hive Mind.
      </p>
      <div className="mt-4 space-y-3">
        {steps.map((s) => (
          <div key={s.key}>
            <p className="mb-1.5 text-xs font-medium text-fg-muted">{s.title}</p>
            <CopyBlock id={`ko-${s.key}`} label="Terminal" text={s.text} copied={copied === s.key} onCopy={() => copy(s.key, s.text, 'Command copied')} />
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-fg-subtle">
        No token yet? Use <strong className="text-fg-muted">New agent link</strong> above and start the runner with <code className="font-mono">--claim SM-XXXX-XXXX</code> instead of <code className="font-mono">HIVE_AGENT_TOKEN</code>; it prints the token once.
        The runner waits while the agent is paused, respects rate limits and stops cleanly with Ctrl+C. <a href="/hive-runner.mjs" target="_blank" rel="noreferrer" className="text-electric-soft hover:underline">View the script</a>.
      </p>
    </section>
  );
}

/* ───────── Activity log ───────── */

interface ActivityItem { id: string; source: 'audit' | 'task' | 'session' | 'assessment'; refId: string; kind: string; at: string; actorType: string | null; actorName: string | null; meta: Record<string, unknown> }

const ACTIVITY_LABEL: Record<string, string> = {
  'agent.create': 'Agent created', 'agent.update': 'Profile updated', 'agent.delete': 'Agent deleted', 'agent.pause': 'Agent paused', 'agent.resume': 'Agent resumed',
  'agent.rotate_link': 'New agent link created (old link revoked)', 'agent.connect_prompt': 'New connection code generated', 'agent.disconnect': 'Agent disconnected',
  'agent.connection_update': 'Connection updated', 'agent.test': 'Connection tested', 'agent.publish': 'Published to marketplace', 'agent.unpublish': 'Removed from marketplace',
  'agent.permissions_update': 'Permissions changed', 'agent.limits_update': 'Usage limits changed', 'agent.rollback': 'Instructions rolled back',
  'task.delivered': 'Task delivered to agent', 'task.answered': 'Task answered', 'session.created': 'Training session scheduled', 'session.started': 'Training session started',
  'session.completed': 'Training session completed', 'session.failed': 'Training session failed', 'session.cancelled': 'Training session cancelled',
  'assessment.queued': 'Assessment queued', 'assessment.completed': 'Assessment completed', 'assessment.failed': 'Assessment failed', 'assessment.cancelled': 'Assessment cancelled',
};
const SOURCE_TONE = { audit: 'gold', task: 'electric', session: 'violet', assessment: 'success' } as const;

function activityDetail(i: ActivityItem): string {
  const m = i.meta ?? {};
  const parts: string[] = [];
  if (typeof m.taskKind === 'string') parts.push(`${titleCase(m.taskKind)} task`);
  if (typeof m.subject === 'string') parts.push(m.subject);
  if (typeof m.role === 'string' && i.source === 'session') parts.push(`as ${m.role}`);
  if (typeof m.improvement === 'number') parts.push(`improvement ${m.improvement > 0 ? '+' : ''}${m.improvement.toFixed(1)}`);
  if (typeof m.overallScore === 'number') parts.push(`score ${m.overallScore.toFixed(1)}`);
  if (Array.isArray(m.domains) && m.domains.length) parts.push(m.domains.map((d) => domainName(String(d))).join(', '));
  if (typeof m.reason === 'string' && m.reason) parts.push(`“${m.reason}”`);
  if (typeof m.pausedSeconds === 'number') parts.push(`paused for ${m.pausedSeconds < 3600 ? `${Math.max(1, Math.round(m.pausedSeconds / 60))} min` : `${(m.pausedSeconds / 3600).toFixed(1)} h`}`);
  if (m.ok === true) parts.push('OK'); else if (m.ok === false) parts.push('failed');
  return parts.join(' · ');
}

function ActivityTab({ id }: { id: string }) {
  const [page, setPage] = useState(1);
  const [source, setSource] = useState('');
  const pageSize = 25;
  const { data, error, isLoading, mutate } = useApi<Paged<ActivityItem>>(`/owner/agents/${id}/activity?page=${page}&pageSize=${pageSize}${source ? `&source=${source}` : ''}`);
  const items = data?.items ?? [];
  const pages = data ? Math.max(1, Math.ceil(data.total / pageSize)) : 1;
  return (
    <div className="card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line/60 px-5 py-4">
        <div><h3 className="flex items-center gap-2 text-[15px] font-semibold"><History className="h-4 w-4 text-fg-muted" aria-hidden />Activity</h3><p className="mt-0.5 text-xs text-fg-muted">Owner actions and everything the agent did, newest first.</p></div>
        <Select aria-label="Filter activity" className="h-8 w-44 text-xs" value={source} onChange={(e) => { setSource(e.target.value); setPage(1); }}>
          <option value="">All activity</option><option value="audit">Owner &amp; admin actions</option><option value="task">Tasks</option><option value="session">Training sessions</option><option value="assessment">Assessments</option>
        </Select>
      </div>
      {isLoading ? <div className="p-5"><ListSkeleton /></div>
        : error ? <div className="p-5"><ErrorState error={error} onRetry={() => mutate()} /></div>
        : !items.length ? <div className="p-5"><EmptyState icon={<History className="h-5 w-5" />} title="No activity yet" description="Owner actions, tasks, training sessions and assessments for this agent appear here." /></div>
        : (
          <ol className="divide-y divide-line/50">
            {items.map((i) => {
              const detail = activityDetail(i);
              const who = i.actorType === 'admin' ? 'Hive Mind admin' : i.actorName ?? (i.actorType === 'agent' ? 'Agent' : i.actorType === 'system' ? 'Hive Mind' : i.actorType === 'api_key' ? 'API key' : null);
              const href = i.source === 'session' ? `/app/training/${i.refId}` : i.source === 'assessment' ? `/app/assessments/${i.refId}` : null;
              return (
                <li key={i.id} className="flex items-start gap-3 px-5 py-3">
                  <Badge tone={SOURCE_TONE[i.source] ?? 'neutral'} className="mt-0.5 w-[84px] justify-center">{titleCase(i.source)}</Badge>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-fg">{ACTIVITY_LABEL[i.kind] ?? titleCase(i.kind.replace(/[._]/g, ' '))}{href && <Link href={href} className="ml-2 text-xs text-electric-soft hover:underline">Open</Link>}</p>
                    {(detail || who) && <p className="truncate text-xs text-fg-muted">{[who, detail].filter(Boolean).join(' · ')}</p>}
                  </div>
                  <time dateTime={i.at} title={fmtDateTime(i.at)} className="shrink-0 whitespace-nowrap text-xs text-fg-subtle">{fmtRelative(i.at)}</time>
                </li>
              );
            })}
          </ol>
        )}
      {pages > 1 && (
        <div className="flex items-center justify-between border-t border-line/60 px-5 py-3 text-xs text-fg-muted">
          <span>Page {page} of {pages} · {fmtNumber(data?.total ?? 0)} events</span>
          <div className="flex gap-2"><Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button><Button size="sm" variant="outline" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button></div>
        </div>
      )}
    </div>
  );
}

