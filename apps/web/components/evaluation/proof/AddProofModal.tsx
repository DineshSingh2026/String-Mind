'use client';
import { useEffect, useState } from 'react';
import { DOMAINS } from '@aix/shared';
import { Alert, Button, Field, Input, Modal, Select, Textarea, useToast } from '@/components/ui';
import { api, errorMessage, useApi } from '@/lib/api';
import { KIND_LABEL, URL_KINDS, type Evidence, type EvidenceKind, type Rules } from './types';

const KINDS: EvidenceKind[] = ['git_repo', 'website', 'link', 'pdf', 'document', 'image'];
const ACCEPT: Partial<Record<EvidenceKind, string>> = { pdf: '.pdf,application/pdf', document: '.txt,.md,.markdown,.csv,.json', image: '.png,.jpg,.jpeg,.gif,.webp' };
const URL_PLACEHOLDER: Partial<Record<EvidenceKind, string>> = { git_repo: 'https://github.com/owner/repo', website: 'https://your-site.com', link: 'https://…' };

export function AddProofModal({ open, onClose, agents, defaultAgentId, defaultDomain, onCreated }: {
  open: boolean; onClose: () => void; agents: { id: string; name: string }[]; defaultAgentId?: string; defaultDomain?: string; onCreated: (e: Evidence) => void;
}) {
  const toast = useToast();
  const [agentId, setAgentId] = useState(defaultAgentId ?? '');
  const [domainSlug, setDomain] = useState(defaultDomain ?? 'programming');
  const [kind, setKind] = useState<EvidenceKind>('git_repo');
  const [title, setTitle] = useState('');
  const [claim, setClaim] = useState('');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rules = useApi<Rules>(open ? `/evidence/rules?domainSlug=${encodeURIComponent(domainSlug)}` : null);

  useEffect(() => { if (open) { setAgentId(defaultAgentId || agents[0]?.id || ''); if (defaultDomain) setDomain(defaultDomain); setError(null); } }, [open, defaultAgentId, defaultDomain, agents]);

  const isUrl = URL_KINDS.includes(kind);
  const trust = rules.data?.scoring.baseTrust[kind];
  const submit = async () => {
    setError(null);
    if (!agentId) return setError('Choose an agent');
    if (isUrl && !url.trim()) return setError('Enter the URL');
    if (!isUrl && !file) return setError('Choose a file');
    setBusy(true);
    try {
      let created: Evidence;
      if (isUrl) {
        created = await api.post<Evidence>('/evidence', { agentId, domainSlug, kind, title, claim, url: url.trim() });
      } else {
        const fd = new FormData();
        // fields first, then the file
        fd.append('agentId', agentId); fd.append('domainSlug', domainSlug); fd.append('kind', kind); fd.append('title', title); fd.append('claim', claim);
        fd.append('file', file!);
        created = await api.upload<Evidence>('/evidence', fd);
      }
      toast('success', 'Proof submitted — checks are running');
      setTitle(''); setClaim(''); setUrl(''); setFile(null);
      onCreated(created);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} size="lg" title="Add proof of real work"
      description="Results speak: proof can earn up to 80 points in a domain; a live skill check adds the last 20."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={submit}>Submit proof</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Agent" htmlFor="pf-agent" required>
          <Select id="pf-agent" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            <option value="">Choose…</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
        </Field>
        <Field label="Domain" htmlFor="pf-domain" required>
          <Select id="pf-domain" value={domainSlug} onChange={(e) => setDomain(e.target.value)}>
            {DOMAINS.map((d) => <option key={d.slug} value={d.slug}>{d.name}</option>)}
          </Select>
        </Field>
      </div>
      <fieldset className="mt-4">
        <legend className="mb-2 text-sm font-medium">Type of proof</legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {KINDS.map((k) => (
            <button key={k} type="button" aria-pressed={kind === k} onClick={() => { setKind(k); setFile(null); }}
              className={`rounded-xl border px-3 py-2 text-left text-xs transition ${kind === k ? 'border-gold/60 bg-gold/10 text-fg' : 'border-line bg-ink-900 text-fg-muted hover:border-line hover:text-fg'}`}>
              <span className="block font-medium">{KIND_LABEL[k]}</span>
              {rules.data && <span className="text-[11px] text-fg-subtle">trust {URL_KINDS.includes(k) ? `${rules.data.scoring.baseTrust[k].unverified}–${rules.data.scoring.baseTrust[k].verified}` : rules.data.scoring.baseTrust[k].verified}</span>}
            </button>
          ))}
        </div>
      </fieldset>
      {rules.data && <p className="mt-2 text-xs text-fg-muted">{rules.data.kinds[kind]}{trust && URL_KINDS.includes(kind) ? ` Trust ${trust.unverified} until ownership is verified, then ${trust.verified}.` : ''}</p>}
      {rules.data?.guidance?.proofTypes?.length ? (
        <div className="mt-2 rounded-lg border border-line/60 bg-ink-900/60 p-2 text-xs text-fg-muted">
          <p className="font-medium text-fg">Strong proof in this domain</p>
          <ul className="mt-1 list-disc pl-4">{rules.data.guidance.proofTypes.slice(0, 5).map((p) => <li key={p.label}>{p.label}{p.description ? ` — ${p.description}` : ''}</li>)}</ul>
        </div>
      ) : null}
      <div className="mt-4 grid gap-4">
        <Field label="Title" htmlFor="pf-title" required><Input id="pf-title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Booking API for a dental clinic" /></Field>
        <Field label="What does this prove?" htmlFor="pf-claim" required hint={`${claim.length}/1000 — be specific: the judge checks the artifact against this claim.`}>
          <Textarea id="pf-claim" rows={3} value={claim} maxLength={1000} onChange={(e) => setClaim(e.target.value)} placeholder="e.g. The agent designed and built this REST API end to end, including idempotent payments and the test suite." />
        </Field>
        {isUrl ? (
          <Field label="URL" htmlFor="pf-url" required hint={kind === 'git_repo' ? 'Public GitHub or GitLab repository.' : 'Public http(s) address.'}>
            <Input id="pf-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={URL_PLACEHOLDER[kind]} />
          </Field>
        ) : (
          <Field label="File" htmlFor="pf-file" required hint={kind === 'pdf' ? 'Text-based PDF, max 10 MB.' : kind === 'document' ? '.txt, .md, .csv or .json, max 5 MB.' : '.png, .jpg, .gif or .webp, max 8 MB. No OCR is available: images add no points on their own.'}>
            <Input id="pf-file" type="file" accept={ACCEPT[kind]} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </Field>
        )}
      </div>
      {error && <div className="mt-4"><Alert tone="danger">{error}</Alert></div>}
    </Modal>
  );
}
