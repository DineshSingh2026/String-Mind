'use client';
import { useState } from 'react';
import { Badge, Button, Field, Input, Select, Tabs, fmtCredits } from '@/components/ui';
import { api } from '@/lib/api';
import { ConfirmModal } from '@/components/training/ConfirmModal';
import { AdminHeader, DataCard, StatusBadge, nameOf, useRevalidate, when, type Row } from '@/components/admin/kit';

type Tab = 'reports' | 'knowledge' | 'listings';

export default function AdminModerationPage() {
  const [tab, setTab] = useState<Tab>('reports');
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
      <AdminHeader title="Moderation" description="User reports, knowledge-exchange listings (approve with a quality score) and marketplace training listings." />
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[{ value: 'reports', label: 'Reports' }, { value: 'knowledge', label: 'Knowledge listings' }, { value: 'listings', label: 'Training listings' }]} />

      {tab === 'reports' && (
        <DataCard title="Reports" path="/admin/reports" empty="No reports" columns={[
          { header: 'Target', cell: (r) => <div><Badge>{r.targetType}</Badge> <code className="font-mono text-[11px] text-fg-muted">{String(r.targetId).slice(0, 8)}</code><p className="text-xs">{r.targetName ?? ''}</p></div> },
          { header: 'Reason', cell: (r) => <div><p className="font-medium">{r.reason}</p><p className="max-w-xs text-xs text-fg-muted">{r.details}</p></div> },
          { header: 'Reporter', cell: (r) => nameOf(r, 'reporter', 'reporterEmail') },
          { header: 'Status', cell: (r) => <StatusBadge value={r.status} /> },
          { header: 'Created', cell: (r) => when(r.createdAt) },
          {
            header: '', cell: (r) => r.status === 'open' && (
              <Select aria-label="Resolve report" className="h-8 w-36 text-xs" value="" onChange={(e) => e.target.value && setReport({ r, action: e.target.value })}>
                <option value="">Resolve…</option><option value="dismiss">Dismiss</option><option value="hide_target">Hide target</option><option value="suspend_agent">Suspend agent</option>
              </Select>),
          },
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

      <ConfirmModal open={!!report} onClose={() => setReport(null)} tone={report?.action === 'dismiss' ? 'primary' : 'danger'} title={`Resolve report: ${report?.action.replace('_', ' ') ?? ''}?`}
        description={report?.r.reason} confirmLabel="Resolve" successMessage="Report resolved"
        onConfirm={async () => { await api.post(`/admin/reports/${report!.r.id}/resolve`, { action: report!.action }); await revalidate('/admin/reports'); }} />
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
