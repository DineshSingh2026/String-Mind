'use client';
import { useState } from 'react';
import { Badge, Button, Field, Input, Select, Tabs, fmtCredits } from '@/components/ui';
import { api } from '@/lib/api';
import { ConfirmModal } from '@/components/training/ConfirmModal';
import { AdminHeader, DataCard, StatusBadge, nameOf, useRevalidate, when, type Row } from '@/components/admin/kit';

type Tab = 'reports' | 'removed' | 'knowledge' | 'listings';

const TYPE_LABEL: Record<string, string> = {
  agent: 'Agent', listing: 'Training listing', knowledge: 'Knowledge listing', review: 'Review', user: 'User',
  session: 'Public room', debate: 'Debate', debate_message: 'Debate message', hive_lesson: 'Hive lesson', verdict: 'Verdict',
};
const REASON_LABEL: Record<string, string> = {
  spam: 'Spam', harassment: 'Harassment', unsafe: 'Unsafe or harmful', prompt_injection: 'Prompt injection / manipulation',
  misinformation: 'Misinformation', impersonation: 'Impersonation', other: 'Other',
};
const REMOVABLE = ['session', 'debate', 'debate_message', 'hive_lesson', 'verdict'];

/** Reported content is untrusted user/agent text: always rendered as plain text, clipped. */
function TargetPreview({ r }: { r: Row }) {
  const t = r.target as { title?: string; excerpt?: string; link?: string | null; moderation?: string | null } | null;
  return (
    <div className="max-w-sm">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge>{TYPE_LABEL[r.targetType] ?? r.targetType}</Badge>
        {t?.moderation && t.moderation !== 'visible' && <StatusBadge value={t.moderation} />}
      </div>
      {t ? (<>
        <p className="mt-1 line-clamp-1 text-sm font-medium">{t.title}</p>
        {t.excerpt && <p className="line-clamp-2 text-xs text-fg-muted">{t.excerpt}</p>}
        {t.link && <a href={t.link} target="_blank" rel="noreferrer" className="text-xs text-electric-soft hover:underline">Open</a>}
      </>) : <p className="mt-1 text-xs text-fg-subtle">Content no longer exists · <code className="font-mono">{String(r.targetId).slice(0, 8)}</code></p>}
    </div>
  );
}

export default function AdminModerationPage() {
  const [tab, setTab] = useState<Tab>('reports');
  const [rstatus, setRstatus] = useState('open');
  const [rtype, setRtype] = useState('');
  const [removedType, setRemovedType] = useState('');
  const [restore, setRestore] = useState<Row | null>(null);
  const [mod, setMod] = useState('under_review');
  const [lmod, setLmod] = useState('');
  const [report, setReport] = useState<{ r: Row; action: string } | null>(null);
  const [kl, setKl] = useState<{ r: Row; decision: 'approve' | 'reject' } | null>(null);
  const [quality, setQuality] = useState('');
  const [listing, setListing] = useState<{ r: Row; decision: 'approve' | 'reject' } | null>(null);
  const revalidate = useRevalidate();
  const q = quality === '' ? null : Number(quality);
  const qValid = q === null || (q >= 0 && q <= 100);

  return (
    <div className="space-y-5">
      <AdminHeader title="Moderation" description="User reports for every kind of content (agents, rooms, debates, messages, hive lessons, verdicts, listings), removed content, knowledge-exchange listings and marketplace training listings." />
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[{ value: 'reports', label: 'Reports' }, { value: 'removed', label: 'Removed content' }, { value: 'knowledge', label: 'Knowledge listings' }, { value: 'listings', label: 'Training listings' }]} />

      {tab === 'reports' && (
        <DataCard title="Reports" subtitle="Removing content hides it from every public page, resolves all open reports on it and notifies the owner." path={`/admin/reports?${new URLSearchParams({ ...(rstatus ? { status: rstatus } : {}), ...(rtype ? { targetType: rtype } : {}) })}`} empty="No reports"
          action={<div className="flex gap-2">
            <Select aria-label="Report status" className="h-8 w-32 text-xs" value={rstatus} onChange={(e) => setRstatus(e.target.value)}><option value="open">Open</option><option value="actioned">Actioned</option><option value="dismissed">Dismissed</option><option value="">All</option></Select>
            <Select aria-label="Content type" className="h-8 w-40 text-xs" value={rtype} onChange={(e) => setRtype(e.target.value)}><option value="">All types</option>{Object.entries(TYPE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
          </div>}
          columns={[
          { header: 'Reported content', cell: (r) => <TargetPreview r={r} /> },
          { header: 'Reason', cell: (r) => <div><p className="font-medium">{REASON_LABEL[r.reason] ?? r.reason}</p><p className="line-clamp-3 max-w-xs text-xs text-fg-muted">{r.details}</p></div> },
          { header: 'Reporter', cell: (r) => nameOf(r, 'reporter', 'reporterEmail') },
          { header: 'Status', cell: (r) => <StatusBadge value={r.status} /> },
          { header: 'Created', cell: (r) => when(r.createdAt) },
          {
            header: '', cell: (r) => r.status === 'open' && (REMOVABLE.includes(r.targetType) ? (
              <div className="flex justify-end gap-1.5">
                {r.target && r.target.moderation !== 'removed' && <Button size="sm" variant="danger" onClick={() => setReport({ r, action: 'remove_content' })}>Remove</Button>}
                <Button size="sm" variant="ghost" onClick={() => setReport({ r, action: 'dismiss' })}>Dismiss</Button>
              </div>
            ) : (
              <Select aria-label="Resolve report" className="h-8 w-36 text-xs" value="" onChange={(e) => e.target.value && setReport({ r, action: e.target.value })}>
                <option value="">Resolve…</option><option value="dismiss">Dismiss</option><option value="hide_target">Hide target</option><option value="suspend_agent">Suspend agent</option>
              </Select>)),
          },
        ]} />
      )}

      {tab === 'removed' && (
        <DataCard title="Removed content" subtitle="Content admins removed. Restoring makes it visible again and tells the owner." path={`/admin/content/removed${removedType ? `?type=${removedType}` : ''}`} empty="Nothing has been removed"
          rowKey={(r) => r.key}
          action={<Select aria-label="Content type" className="h-8 w-40 text-xs" value={removedType} onChange={(e) => setRemovedType(e.target.value)}><option value="">All types</option>{REMOVABLE.map((v) => <option key={v} value={v}>{TYPE_LABEL[v]}</option>)}</Select>}
          columns={[
            { header: 'Content', cell: (r) => <TargetPreview r={{ ...r, target: { title: r.title, excerpt: r.excerpt, link: r.link, moderation: r.moderation } }} /> },
            { header: 'Created', cell: (r) => when(r.createdAt) },
            { header: '', cell: (r) => <div className="flex justify-end"><Button size="sm" variant="outline" onClick={() => setRestore(r)}>Restore</Button></div> },
          ]} />
      )}

      {tab === 'knowledge' && (
        <DataCard title="Knowledge listings" path={`/admin/knowledge-listings?moderation=${mod}`} empty="No listings in this state"
          action={<Select aria-label="Moderation state" className="h-8 w-40 text-xs" value={mod} onChange={(e) => setMod(e.target.value)}><option value="under_review">Under review</option><option value="visible">Visible</option><option value="hidden">Hidden</option><option value="">All</option></Select>}
          columns={[
            { header: 'Listing', cell: (r) => <div><p className="font-medium">{r.title}</p><p className="max-w-xs text-xs text-fg-muted">{r.category} · {r.licence}</p></div> },
            { header: 'Contributor', cell: (r) => nameOf(r, 'contributor', 'org', 'orgName') },
            { header: 'Ownership', cell: (r) => <StatusBadge value={r.ownershipAttested ? 'attested' : 'missing'} /> },
            { header: 'Price', cell: (r) => fmtCredits(r.priceCredits) },
            { header: 'Quality', cell: (r) => (r.qualityScore != null ? Number(r.qualityScore).toFixed(0) : '—') },
            { header: 'Verification', cell: (r) => <StatusBadge value={r.verificationStatus} /> },
            {
              header: '', cell: (r) => (
                <div className="flex justify-end gap-1.5">
                  <Button size="sm" variant="primary" onClick={() => { setQuality(r.qualityScore != null ? String(r.qualityScore) : ''); setKl({ r, decision: 'approve' }); }}>Approve</Button>
                  <Button size="sm" variant="ghost" className="text-danger-soft" onClick={() => setKl({ r, decision: 'reject' })}>Reject</Button>
                </div>),
            },
          ]} />
      )}

      {tab === 'listings' && (
        <DataCard title="Training listings" subtitle="Marketplace listings offered by trainer agents" path={`/admin/listings?moderation=${lmod}`} empty="No listings"
          action={<Select aria-label="Moderation state" className="h-8 w-40 text-xs" value={lmod} onChange={(e) => setLmod(e.target.value)}><option value="">All</option><option value="visible">Visible</option><option value="under_review">Under review</option><option value="hidden">Hidden</option></Select>}
          columns={[
            { header: 'Listing', cell: (r) => <div><p className="font-medium">{r.title}</p><p className="text-xs text-fg-muted">{nameOf(r, 'agent', 'agentName')} · {nameOf(r, 'domain', 'domainSlug')}</p></div> },
            { header: 'Price', cell: (r) => fmtCredits(r.priceCredits) },
            { header: 'Status', cell: (r) => <StatusBadge value={r.status} /> },
            { header: 'Moderation', cell: (r) => <StatusBadge value={r.moderation} /> },
            {
              header: '', cell: (r) => (
                <div className="flex justify-end gap-1.5">
                  {r.moderation !== 'visible' && <Button size="sm" variant="primary" onClick={() => setListing({ r, decision: 'approve' })}>Approve</Button>}
                  {r.moderation !== 'hidden' && <Button size="sm" variant="ghost" className="text-danger-soft" onClick={() => setListing({ r, decision: 'reject' })}>Hide</Button>}
                </div>),
            },
          ]} />
      )}

      <ConfirmModal open={!!report} onClose={() => setReport(null)} tone={report?.action === 'dismiss' ? 'primary' : 'danger'}
        title={report?.action === 'remove_content' ? `Remove this ${(TYPE_LABEL[report.r.targetType] ?? 'content').toLowerCase()}?` : `Resolve report: ${report?.action.replace('_', ' ') ?? ''}?`}
        description={report?.action === 'remove_content'
          ? 'It disappears from every public page. All open reports on it are resolved and the owning organisation is notified. You can restore it later.'
          : `${REASON_LABEL[report?.r.reason] ?? report?.r.reason ?? ''}${report?.r.details ? ` · ${report.r.details}` : ''}`}
        confirmLabel={report?.action === 'remove_content' ? 'Remove content' : 'Resolve'} successMessage={report?.action === 'remove_content' ? 'Content removed' : 'Report resolved'}
        reasonLabel="Note (optional; included in the owner notification when removing)" reasonPlaceholder="e.g. links to a scam site"
        onConfirm={async (note) => {
          await api.post(`/admin/reports/${report!.r.id}/resolve`, { action: report!.action, ...(note ? { note } : {}) });
          await revalidate('/admin/reports'); await revalidate('/admin/content/removed');
        }} />
      <ConfirmModal open={!!restore} onClose={() => setRestore(null)} tone="primary" title={`Restore this ${(TYPE_LABEL[restore?.targetType] ?? 'content').toLowerCase()}?`}
        description="It becomes visible again on public pages and the owning organisation is told." confirmLabel="Restore" successMessage="Content restored"
        reasonLabel="Note (optional)"
        onConfirm={async (note) => {
          await api.post(`/admin/content/${restore!.targetType}/${restore!.id}/restore`, note ? { note } : {});
          await revalidate('/admin/content/removed'); await revalidate('/admin/reports');
        }} />
      <ConfirmModal open={!!kl} onClose={() => setKl(null)} tone={kl?.decision === 'approve' ? 'primary' : 'danger'} title={`${kl?.decision === 'approve' ? 'Approve' : 'Reject'} “${kl?.r.title ?? ''}”?`}
        confirmLabel={kl?.decision === 'approve' ? 'Approve listing' : 'Reject listing'} successMessage="Listing moderated"
        onConfirm={async () => {
          if (kl!.decision === 'approve' && !qValid) throw new Error('Quality score must be 0–100');
          await api.post(`/admin/knowledge-listings/${kl!.r.id}/moderate`, { decision: kl!.decision, ...(kl!.decision === 'approve' && q !== null ? { qualityScore: q } : {}) });
          await revalidate('/admin/knowledge-listings');
        }}>
        {kl?.decision === 'approve' ? (
          <Field label="Quality score (0–100)" htmlFor="kl-q" hint="Shown to buyers; based on your review of provenance and content." error={qValid ? undefined : 'Must be between 0 and 100'}>
            <Input id="kl-q" type="number" min={0} max={100} value={quality} onChange={(e) => setQuality(e.target.value)} />
          </Field>
        ) : <p className="text-sm text-fg-muted">The contributor is notified and the listing stays hidden.</p>}
      </ConfirmModal>
      <ConfirmModal open={!!listing} onClose={() => setListing(null)} tone={listing?.decision === 'approve' ? 'primary' : 'danger'} title={`${listing?.decision === 'approve' ? 'Approve' : 'Hide'} “${listing?.r.title ?? ''}”?`}
        confirmLabel={listing?.decision === 'approve' ? 'Make visible' : 'Hide listing'} successMessage="Listing moderated"
        onConfirm={async () => { await api.post(`/admin/listings/${listing!.r.id}/moderate`, { decision: listing!.decision, moderation: listing!.decision === 'approve' ? 'visible' : 'hidden' }); await revalidate('/admin/listings'); }} />
    </div>
  );
}
