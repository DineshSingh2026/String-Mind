'use client';
import { useState, type DragEvent } from 'react';
import { BookOpen, Check, FileText, Library, Plus, Search, ShoppingCart, Store, Trash2, Upload, X } from 'lucide-react';
import { DOMAINS } from '@aix/shared';
import {
  Alert, Badge, Button, Checkbox, EmptyState, ErrorState, Field, Input, Modal, PageHeader, Select, Table, Tabs, Td, Textarea, cn,
  fmtCredits, fmtDate,
} from '@/components/ui';
import { ApiError, api, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ConfirmModal, GridSkeleton, LearningTypeBadge, ListSkeleton, Section, StatusPill, domainName, titleCase, useAction } from '@/components/app/primitives';
import { listOf, type Agent, type Paged } from '@/components/app/types';

/* Assumed shapes (API.md names fields only for create bodies). */
interface Source { id: string; name: string; description?: string | null; type: string; visibility: string; domainSlug?: string | null; agentId?: string | null; licence?: string | null; documentsCount?: number; createdAt?: string }
interface Doc { id: string; title: string; status?: string; chunks?: number; chunkCount?: number; sizeBytes?: number; createdAt: string; flagged?: boolean }
interface Hit { chunkId: string; content: string; score: number; document: { id: string; title: string }; source: { id: string; name: string } }
interface Artefact { id: string; sessionId?: string | null; agentId?: string; type?: string; learningType?: string; title?: string | null; content?: string | null; summary?: string | null; status: string; domainSlug?: string | null; createdAt: string }
interface Memory { id: string; agentId?: string; content: string; type?: string; createdAt: string; agent?: { name: string } | null }
interface XListing { id: string; title: string; description?: string | null; category?: string; domainSlug?: string | null; licence?: string; priceCredits: number; contributor?: { name: string } | null; qualityScore?: number | null; usageRestrictions?: string | null; moderation?: string; status?: string; earnings?: number | null; salesCount?: number | null }
interface Licence { id: string; listing?: { id: string; title: string } | null; listingTitle?: string; agent?: { name: string } | null; createdAt: string; priceCredits?: number; status?: string }

type TabKey = 'sources' | 'search' | 'artefacts' | 'memories' | 'licensed' | 'exchange';
const ACCEPT = ['.txt', '.md', '.csv', '.json'];

export default function KnowledgePage() {
  const [tab, setTab] = useState<TabKey>('sources');
  return (
    <div className="space-y-6">
      <PageHeader title="Knowledge Bank" description="Sources your agents retrieve from (RAG), learning artefacts from training, memories, and licensed knowledge." />
      <Tabs value={tab} onChange={setTab} tabs={[
        { value: 'sources', label: 'Sources' }, { value: 'search', label: 'Search playground' }, { value: 'artefacts', label: 'Learning artefacts' },
        { value: 'memories', label: 'Memories' }, { value: 'licensed', label: 'Licensed knowledge' }, { value: 'exchange', label: 'Knowledge Exchange' },
      ]} />
      {tab === 'sources' && <Sources />}
      {tab === 'search' && <SearchPlayground />}
      {tab === 'artefacts' && <Artefacts />}
      {tab === 'memories' && <Memories />}
      {tab === 'licensed' && <Licensed />}
      {tab === 'exchange' && <Exchange />}
    </div>
  );
}

function Sources() {
  const { can } = useSession();
  const { data, error, isLoading, mutate } = useApi<Source[] | Paged<Source>>('/knowledge/sources');
  const sources = listOf(data);
  const [open, setOpen] = useState<string | null>(null);
  const [create, setCreate] = useState(false);
  return (
    <div className="space-y-4">
      {can('knowledge.write') && <div className="flex justify-end"><Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setCreate(true)}>New source</Button></div>}
      {isLoading ? <ListSkeleton /> : error ? <ErrorState error={error} onRetry={() => mutate()} /> : !sources.length ? (
        <EmptyState icon={<Library className="h-5 w-5" />} title="No knowledge sources" description="Create a source, then upload documents. Agents retrieve relevant chunks with citations at answer time."
          action={can('knowledge.write') ? <Button variant="primary" onClick={() => setCreate(true)}>Create a source</Button> : undefined} />
      ) : (
        <ul className="space-y-3">
          {sources.map((s) => (
            <li key={s.id} className="card">
              <button className="flex w-full items-center gap-3 p-4 text-left" aria-expanded={open === s.id} onClick={() => setOpen(open === s.id ? null : s.id)}>
                <BookOpen className="h-5 w-5 shrink-0 text-electric" aria-hidden />
                <span className="min-w-0 flex-1"><span className="block truncate font-medium">{s.name}</span><span className="block truncate text-xs text-fg-subtle">{titleCase(s.type)} · {domainName(s.domainSlug)} · {s.licence ?? 'No licence'}</span></span>
                <Badge>{titleCase(s.visibility)}</Badge>
                {s.documentsCount != null && <span className="text-xs text-fg-muted">{s.documentsCount} docs</span>}
              </button>
              {open === s.id && <Documents source={s} canWrite={can('knowledge.write')} />}
            </li>
          ))}
        </ul>
      )}
      <CreateSourceModal open={create} onClose={() => setCreate(false)} onCreated={() => { setCreate(false); mutate(); }} />
    </div>
  );
}

function CreateSourceModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const { data: agents } = useApi<Agent[] | Paged<Agent>>(open ? '/agents' : null);
  const [f, setF] = useState({ name: '', description: '', type: 'documents', visibility: 'private', domainSlug: '', agentId: '', licence: 'proprietary', ownershipAttested: false });
  const { busy, run } = useAction();
  const submit = async () => {
    const r = await run('c', () => api.post('/knowledge/sources', { ...f, domainSlug: f.domainSlug || undefined, agentId: f.agentId || undefined }), 'Source created');
    if (r !== undefined) onCreated();
  };
  return (
    <Modal open={open} onClose={onClose} title="New knowledge source" size="lg" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy === 'c'} disabled={!f.name.trim() || !f.ownershipAttested} onClick={submit}>Create</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="sn" required><Input id="sn" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Type" htmlFor="st"><Select id="st" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{['documents', 'faq', 'dataset', 'policy', 'notes'].map((t) => <option key={t} value={t}>{titleCase(t)}</option>)}</Select></Field>
        <Field label="Visibility" htmlFor="sv"><Select id="sv" value={f.visibility} onChange={(e) => setF({ ...f, visibility: e.target.value })}><option value="private">Private (my org)</option><option value="org_network">Private network</option><option value="public">Public</option></Select></Field>
        <Field label="Domain" htmlFor="sd"><Select id="sd" value={f.domainSlug} onChange={(e) => setF({ ...f, domainSlug: e.target.value })}><option value="">None</option>{DOMAINS.map((d) => <option key={d.slug} value={d.slug}>{d.name}</option>)}</Select></Field>
        <Field label="Attach to agent" htmlFor="sa"><Select id="sa" value={f.agentId} onChange={(e) => setF({ ...f, agentId: e.target.value })}><option value="">Organisation-wide</option>{listOf(agents).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
        <Field label="Licence" htmlFor="sl"><Select id="sl" value={f.licence} onChange={(e) => setF({ ...f, licence: e.target.value })}>{['proprietary', 'cc-by-4.0', 'cc-by-sa-4.0', 'cc0', 'mit'].map((l) => <option key={l} value={l}>{l}</option>)}</Select></Field>
        <div className="sm:col-span-2"><Field label="Description" htmlFor="sdesc"><Textarea id="sdesc" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field></div>
        <div className="sm:col-span-2"><Checkbox checked={f.ownershipAttested} onChange={(v) => setF({ ...f, ownershipAttested: v })} label="I confirm my organisation owns this content or has the rights to use it under the selected licence." /></div>
      </div>
    </Modal>
  );
}

function Documents({ source, canWrite }: { source: Source; canWrite: boolean }) {
  const { data, error, isLoading, mutate } = useApi<Doc[] | Paged<Doc>>(`/knowledge/sources/${source.id}/documents`);
  const docs = listOf(data);
  const [drag, setDrag] = useState(false);
  const [paste, setPaste] = useState(false);
  const [text, setText] = useState({ title: '', text: '' });
  const [del, setDel] = useState<Doc | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { busy, run } = useAction();

  const uploadFiles = async (files: FileList | File[]) => {
    setErr(null);
    for (const file of Array.from(files)) {
      if (!ACCEPT.some((ext) => file.name.toLowerCase().endsWith(ext))) { setErr(`${file.name}: only ${ACCEPT.join(', ')} files are supported`); continue; }
      const fd = new FormData(); fd.append('file', file);
      await run('up', async () => {
        try { return await api.upload(`/knowledge/sources/${source.id}/documents`, fd); } catch (e) {
          if (e instanceof ApiError && e.status === 409) setErr(`${file.name}: this content already exists in another organisation and was flagged for plagiarism review.`);
          throw e;
        }
      }, `${file.name} uploaded — processing`);
    }
    mutate();
  };
  const onDrop = (e: DragEvent) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files.length) void uploadFiles(e.dataTransfer.files); };

  return (
    <div className="space-y-4 border-t border-line/60 p-4">
      {canWrite && (
        <>
          <label onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}
            className={cn('flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-6 text-center text-sm transition', drag ? 'border-electric bg-electric/5' : 'border-line hover:border-ink-600')}>
            <Upload className="h-6 w-6 text-fg-muted" aria-hidden />
            <span><span className="font-medium text-fg">Drop files</span> or click to browse</span>
            <span className="text-xs text-fg-subtle">{ACCEPT.join(', ')}</span>
            <input type="file" multiple accept={ACCEPT.join(',')} className="sr-only" onChange={(e) => e.target.files && uploadFiles(e.target.files)} disabled={busy === 'up'} />
          </label>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => setPaste(!paste)}>{paste ? 'Hide' : 'Or paste text'}</Button>
            {busy === 'up' && <span className="text-xs text-fg-muted">Uploading…</span>}
          </div>
          {paste && (
            <div className="space-y-3 rounded-xl border border-line/70 p-3">
              <Field label="Title" htmlFor={`pt${source.id}`}><Input id={`pt${source.id}`} value={text.title} onChange={(e) => setText({ ...text, title: e.target.value })} /></Field>
              <Field label="Text" htmlFor={`px${source.id}`}><Textarea id={`px${source.id}`} value={text.text} onChange={(e) => setText({ ...text, text: e.target.value })} /></Field>
              <Button size="sm" variant="primary" loading={busy === 'paste'} disabled={!text.title.trim() || !text.text.trim()} onClick={async () => {
                const r = await run('paste', () => api.post(`/knowledge/sources/${source.id}/documents`, text), 'Document added');
                if (r !== undefined) { setText({ title: '', text: '' }); mutate(); }
              }}>Add document</Button>
            </div>
          )}
          {err && <Alert tone="warning">{err}</Alert>}
        </>
      )}
      {isLoading ? <ListSkeleton rows={2} /> : error ? <ErrorState error={error} onRetry={() => mutate()} /> : !docs.length ? <p className="text-sm text-fg-subtle">No documents yet.</p> : (
        <ul className="divide-y divide-line/50">
          {docs.map((d) => (
            <li key={d.id} className="flex items-center gap-3 py-2 text-sm">
              <FileText className="h-4 w-4 shrink-0 text-fg-subtle" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{d.title}</span>
              {d.flagged && <Badge tone="danger">Flagged</Badge>}
              {d.status && <StatusPill status={d.status} />}
              {(d.chunkCount ?? d.chunks) != null && <span className="hidden text-xs text-fg-subtle sm:inline">{d.chunkCount ?? d.chunks} chunks</span>}
              <span className="hidden text-xs text-fg-subtle sm:inline">{fmtDate(d.createdAt)}</span>
              {canWrite && <button className="rounded-lg p-1.5 text-fg-muted hover:bg-ink-800 hover:text-danger" aria-label={`Delete ${d.title}`} onClick={() => setDel(d)}><Trash2 className="h-4 w-4" /></button>}
            </li>
          ))}
        </ul>
      )}
      <ConfirmModal open={!!del} onClose={() => setDel(null)} title="Delete document?" danger confirmLabel="Delete" loading={busy === 'del'} description={del?.title}
        onConfirm={async () => { await run('del', () => api.del(`/knowledge/documents/${del!.id}`), 'Document deleted'); setDel(null); mutate(); }} />
    </div>
  );
}

function SearchPlayground() {
  const { data: agents } = useApi<Agent[] | Paged<Agent>>('/agents');
  const [q, setQ] = useState('');
  const [agentId, setAgentId] = useState('');
  const [hits, setHits] = useState<Hit[] | null>(null);
  const { busy, run } = useAction();
  const search = async () => {
    if (!q.trim()) return;
    const r = await run('s', () => api.post<Hit[] | { items: Hit[] }>('/knowledge/search', { query: q, agentId: agentId || undefined, limit: 8 }));
    if (r) setHits(listOf(r));
  };
  return (
    <Section title="Search playground" subtitle="Test what your agents would retrieve. Only sources your organisation may access are searched.">
      <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); void search(); }}>
        <Input aria-label="Query" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. How is input tax credit calculated?" />
        <Select aria-label="Agent scope" value={agentId} onChange={(e) => setAgentId(e.target.value)} className="sm:w-56"><option value="">All my sources</option>{listOf(agents).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>
        <Button type="submit" variant="ai" loading={busy === 's'} icon={<Search className="h-4 w-4" />}>Search</Button>
      </form>
      <div className="mt-4">
        {hits == null ? null : !hits.length ? <p className="py-6 text-center text-sm text-fg-subtle">No matching chunks.</p> : (
          <ol className="space-y-3">
            {hits.map((h, i) => (
              <li key={h.chunkId} className="rounded-xl border border-line/70 p-3">
                <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs"><span className="font-semibold text-electric-soft">[{i + 1}]</span><span className="font-medium">{h.document.title}</span><span className="text-fg-subtle">· {h.source.name}</span><span className="ml-auto tabular-nums text-fg-muted">score {h.score.toFixed(3)}</span></div>
                <p className="whitespace-pre-wrap text-sm text-fg-muted">{h.content}</p>
              </li>
            ))}
          </ol>
        )}
      </div>
    </Section>
  );
}

function Artefacts() {
  const { data, error, isLoading, mutate } = useApi<Artefact[] | Paged<Artefact>>('/knowledge/artefacts');
  const items = listOf(data);
  const { busy, run } = useAction();
  const act = async (a: Artefact, decision: 'approve' | 'reject') => {
    if (!a.sessionId) return;
    await run(`${a.id}${decision}`, () => api.post(`/training/sessions/${a.sessionId}/artefacts/${a.id}/${decision}`), decision === 'approve' ? 'Artefact approved and stored' : 'Artefact rejected');
    mutate();
  };
  if (isLoading) return <ListSkeleton />;
  if (error) return <ErrorState error={error} onRetry={() => mutate()} />;
  if (!items.length) return <EmptyState title="No learning artefacts" description="Artefacts are produced during training sessions. You approve what your agent keeps." action={<Button variant="ai" href="/app/marketplace">Find a trainer</Button>} />;
  return (
    <ul className="space-y-3">
      {items.map((a) => (
        <li key={a.id} className="card p-4">
          <div className="flex flex-wrap items-center gap-2"><LearningTypeBadge type={a.learningType ?? a.type} /><StatusPill status={a.status} /><span className="text-xs text-fg-subtle">{domainName(a.domainSlug)} · {fmtDate(a.createdAt)}</span></div>
          <p className="mt-2 font-medium">{a.title ?? 'Learning artefact'}</p>
          {(a.summary ?? a.content) && <p className="mt-1 line-clamp-4 whitespace-pre-wrap text-sm text-fg-muted">{a.summary ?? a.content}</p>}
          {['pending', 'pending_approval', 'proposed'].includes(a.status) && a.sessionId && (
            <div className="mt-3 flex gap-2">
              <Button size="sm" variant="primary" loading={busy === `${a.id}approve`} onClick={() => act(a, 'approve')} icon={<Check className="h-4 w-4" />}>Approve</Button>
              <Button size="sm" variant="outline" loading={busy === `${a.id}reject`} onClick={() => act(a, 'reject')} icon={<X className="h-4 w-4" />}>Reject</Button>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function Memories() {
  const { can } = useSession();
  const { data, error, isLoading, mutate } = useApi<Memory[] | Paged<Memory>>('/knowledge/memories');
  const items = listOf(data);
  const [del, setDel] = useState<Memory | null>(null);
  const { busy, run } = useAction();
  if (isLoading) return <ListSkeleton />;
  if (error) return <ErrorState error={error} onRetry={() => mutate()} />;
  if (!items.length) return <EmptyState title="No persistent memories" description="Persistent memories are created from approved learning artefacts and injected into your agent's context." />;
  return (
    <>
      <div className="card"><Table head={['Agent', 'Type', 'Memory', 'Created', '']}>
        {items.map((m) => (
          <tr key={m.id}><Td>{m.agent?.name ?? '—'}</Td><Td><LearningTypeBadge type={m.type ?? 'persistent_memory'} /></Td><Td className="max-w-md"><span className="line-clamp-2">{m.content}</span></Td><Td className="whitespace-nowrap text-fg-muted">{fmtDate(m.createdAt)}</Td>
            <Td>{can('knowledge.write') && <button className="rounded-lg p-1.5 text-fg-muted hover:text-danger" aria-label="Delete memory" onClick={() => setDel(m)}><Trash2 className="h-4 w-4" /></button>}</Td></tr>
        ))}
      </Table></div>
      <ConfirmModal open={!!del} onClose={() => setDel(null)} title="Delete memory?" danger confirmLabel="Delete" loading={busy === 'd'} description="The agent will no longer receive this memory."
        onConfirm={async () => { await run('d', () => api.del(`/knowledge/memories/${del!.id}`), 'Memory deleted'); setDel(null); mutate(); }} />
    </>
  );
}

function Licensed() {
  const { data, error, isLoading, mutate } = useApi<Licence[] | Paged<Licence>>('/knowledge-exchange/licences');
  const items = listOf(data);
  if (isLoading) return <ListSkeleton />;
  if (error) return <ErrorState error={error} onRetry={() => mutate()} />;
  if (!items.length) return <EmptyState icon={<Store className="h-5 w-5" />} title="No licensed knowledge" description="Purchase verified knowledge packs from the Knowledge Exchange to give your agents read access for retrieval." />;
  return (
    <div className="card"><Table head={['Knowledge', 'Agent', 'Price', 'Status', 'Purchased']}>
      {items.map((l) => <tr key={l.id}><Td className="font-medium">{l.listing?.title ?? l.listingTitle ?? '—'}</Td><Td>{l.agent?.name ?? 'Organisation'}</Td><Td className="text-gold">{fmtCredits(l.priceCredits ?? null)}</Td><Td><StatusPill status={l.status ?? 'active'} /></Td><Td className="text-fg-muted">{fmtDate(l.createdAt)}</Td></tr>)}
    </Table></div>
  );
}

function Exchange() {
  const { can } = useSession();
  const [q, setQ] = useState('');
  const [domain, setDomain] = useState('');
  const [view, setView] = useState<'browse' | 'mine'>('browse');
  const qs = new URLSearchParams({ ...(q ? { q } : {}), ...(domain ? { domain } : {}) });
  const { data, error, isLoading, mutate } = useApi<XListing[] | Paged<XListing>>(view === 'browse' ? `/knowledge-exchange/listings?${qs}` : '/knowledge-exchange/mine');
  const items = listOf(data);
  const [buy, setBuy] = useState<XListing | null>(null);
  const [contribute, setContribute] = useState(false);
  const { busy, run } = useAction();
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Tabs value={view} onChange={setView} tabs={[{ value: 'browse', label: 'Browse' }, { value: 'mine', label: 'My contributions' }]} className="border-0" />
        {view === 'browse' && <>
          <Input aria-label="Search knowledge" placeholder="Search knowledge…" value={q} onChange={(e) => setQ(e.target.value)} className="sm:ml-auto sm:w-64" />
          <Select aria-label="Domain" value={domain} onChange={(e) => setDomain(e.target.value)} className="sm:w-52"><option value="">All domains</option>{DOMAINS.map((d) => <option key={d.slug} value={d.slug}>{d.name}</option>)}</Select>
        </>}
        {can('knowledge.publish') && <Button variant="primary" className={view === 'mine' ? 'sm:ml-auto' : ''} icon={<Plus className="h-4 w-4" />} onClick={() => setContribute(true)}>Contribute</Button>}
      </div>
      {isLoading ? <GridSkeleton count={3} itemClassName="h-40" /> : error ? <ErrorState error={error} onRetry={() => mutate()} /> : !items.length ? (
        <EmptyState icon={<Store className="h-5 w-5" />} title={view === 'browse' ? 'No verified knowledge listings' : 'No contributions yet'} description={view === 'browse' ? 'Listings appear here after Hive Mind moderation verifies them.' : 'Share verified knowledge and earn IDLE when others license it.'} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((l) => (
            <article key={l.id} className="card flex flex-col p-4">
              <div className="flex items-start justify-between gap-2"><p className="font-medium">{l.title}</p>{view === 'mine' ? <StatusPill status={l.moderation ?? l.status ?? 'pending'} /> : l.qualityScore != null && <Badge tone="success">Quality {l.qualityScore.toFixed(0)}</Badge>}</div>
              <p className="mt-1 line-clamp-3 text-sm text-fg-muted">{l.description}</p>
              <p className="mt-2 text-xs text-fg-subtle">{[domainName(l.domainSlug), titleCase(l.category), l.licence, l.contributor?.name].filter((x) => x && x !== '—').join(' · ')}</p>
              <div className="mt-auto flex items-center justify-between pt-4">
                <span className="font-display text-lg font-semibold text-gold">{fmtCredits(l.priceCredits)}</span>
                {view === 'browse' ? (can('wallet.purchase') && <Button size="sm" variant="primary" icon={<ShoppingCart className="h-4 w-4" />} onClick={() => setBuy(l)}>License</Button>)
                  : <span className="text-xs text-fg-muted">{l.salesCount ?? 0} sales · {fmtCredits(l.earnings ?? 0)}</span>}
              </div>
            </article>
          ))}
        </div>
      )}
      <ConfirmModal open={!!buy} onClose={() => setBuy(null)} title={`License “${buy?.title}”?`} confirmLabel={`Spend ${fmtCredits(buy?.priceCredits)}`} loading={busy === 'buy'}
        description="IDLE is debited from your wallet. Your organisation gets read access to this source for retrieval."
        onConfirm={async () => { const r = await run('buy', () => api.post(`/knowledge-exchange/listings/${buy!.id}/purchase`, {}), 'Knowledge licensed'); if (r !== undefined) setBuy(null); }}>
        {buy?.usageRestrictions && <Alert tone="info" title="Usage restrictions">{buy.usageRestrictions}</Alert>}
      </ConfirmModal>
      <ContributeModal open={contribute} onClose={() => setContribute(false)} onDone={() => { setContribute(false); setView('mine'); mutate(); }} />
    </div>
  );
}

function ContributeModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const { data } = useApi<Source[] | Paged<Source>>(open ? '/knowledge/sources' : null);
  const [f, setF] = useState({ sourceId: '', title: '', description: '', category: 'reference', licence: 'proprietary', priceCredits: '100', usageRestrictions: '', ownershipAttested: false });
  const [err, setErr] = useState<string | null>(null);
  const { busy, run } = useAction();
  const submit = async () => {
    setErr(null);
    if (!f.sourceId || !f.title.trim()) return setErr('Choose a source and add a title.');
    if (!f.ownershipAttested) return setErr('You must attest ownership to contribute.');
    const r = await run('x', () => api.post('/knowledge-exchange/listings', { ...f, priceCredits: Math.max(0, Math.floor(Number(f.priceCredits) || 0)) }), 'Submitted for verification');
    if (r !== undefined) onDone();
  };
  return (
    <Modal open={open} onClose={onClose} title="Contribute to Knowledge Exchange" description="Listings are reviewed by Hive Mind moderation before they become visible." size="lg"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy === 'x'} onClick={submit}>Submit for review</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Source" htmlFor="xs" required><Select id="xs" value={f.sourceId} onChange={(e) => setF({ ...f, sourceId: e.target.value })}><option value="">Choose…</option>{listOf(data).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
        <Field label="Title" htmlFor="xt" required><Input id="xt" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label="Category" htmlFor="xc"><Select id="xc" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{['reference', 'dataset', 'playbook', 'regulation', 'curriculum'].map((c) => <option key={c} value={c}>{titleCase(c)}</option>)}</Select></Field>
        <Field label="Licence" htmlFor="xl"><Select id="xl" value={f.licence} onChange={(e) => setF({ ...f, licence: e.target.value })}>{['proprietary', 'cc-by-4.0', 'cc-by-sa-4.0', 'cc0'].map((l) => <option key={l} value={l}>{l}</option>)}</Select></Field>
        <Field label="Price (IDLE)" htmlFor="xp"><Input id="xp" type="number" min={0} value={f.priceCredits} onChange={(e) => setF({ ...f, priceCredits: e.target.value })} /></Field>
        <Field label="Usage restrictions" htmlFor="xu"><Input id="xu" value={f.usageRestrictions} onChange={(e) => setF({ ...f, usageRestrictions: e.target.value })} placeholder="e.g. No redistribution" /></Field>
        <div className="sm:col-span-2"><Field label="Description" htmlFor="xd"><Textarea id="xd" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field></div>
        <div className="sm:col-span-2"><Checkbox checked={f.ownershipAttested} onChange={(v) => setF({ ...f, ownershipAttested: v })} label="I attest that my organisation owns this knowledge or holds the rights to license it, and it contains no confidential third-party data." /></div>
        {err && <div className="sm:col-span-2"><Alert tone="danger">{err}</Alert></div>}
      </div>
    </Modal>
  );
}

