'use client';
import { useState } from 'react';
import { Avatar, Button, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { ConfirmModal } from '@/components/training/ConfirmModal';
import { AdminHeader, DataCard, SearchBox, StatusBadge, nameOf, useRevalidate, when, type Row } from '@/components/admin/kit';

type Act = { a: Row; kind: 'suspend' | 'unsuspend' | 'verify'; status?: string };

export default function AdminAgentsPage() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [act, setAct] = useState<Act | null>(null);
  const revalidate = useRevalidate();
  return (
    <div>
      <AdminHeader title="Agents" description="Suspend unsafe agents and set verification status. Every action is audited."
        actions={<>
          <Select aria-label="Status" className="h-9 w-36" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option><option value="active">Active</option><option value="draft">Draft</option><option value="suspended">Suspended</option><option value="disconnected">Disconnected</option>
          </Select>
          <SearchBox value={q} onChange={setQ} placeholder="Search agents" />
        </>} />
      <DataCard title="Agents" path={`/admin/agents?q=${encodeURIComponent(q)}&status=${status}`} empty="No agents match"
        columns={[
          { header: 'Agent', cell: (a) => <div className="flex items-center gap-2.5"><Avatar name={a.name} src={a.avatar} size={30} /><div><p className="font-medium">{a.name}</p><p className="text-xs text-fg-muted">{nameOf(a, 'org', 'orgName')} · {nameOf(a, 'provider')}</p></div></div> },
          { header: 'Status', cell: (a) => <StatusBadge value={a.status} /> },
          { header: 'Health', cell: (a) => <StatusBadge value={a.health} /> },
          { header: 'Verification', cell: (a) => <StatusBadge value={a.verificationStatus} /> },
          { header: 'Score', cell: (a) => (a.overallScore != null ? Number(a.overallScore).toFixed(1) : '—') },
          { header: 'Visibility', cell: (a) => <StatusBadge value={a.isPublic ? 'public' : 'private'} /> },
          { header: 'Created', cell: (a) => when(a.createdAt) },
          {
            header: '', cell: (a) => (
              <div className="flex justify-end gap-1.5">
                <Select aria-label="Set verification" className="h-8 w-32 text-xs" value="" onChange={(e) => e.target.value && setAct({ a, kind: 'verify', status: e.target.value })}>
                  <option value="">Verify…</option><option value="verified">verified</option><option value="pending">pending</option><option value="rejected">rejected</option><option value="unverified">unverified</option>
                </Select>
                {a.status === 'suspended'
                  ? <Button size="sm" variant="outline" onClick={() => setAct({ a, kind: 'unsuspend' })}>Unsuspend</Button>
                  : <Button size="sm" variant="ghost" className="text-danger-soft" onClick={() => setAct({ a, kind: 'suspend' })}>Suspend</Button>}
              </div>),
          },
        ]} />
      <ConfirmModal open={act?.kind === 'suspend'} onClose={() => setAct(null)} title={`Suspend ${act?.a.name ?? ''}?`} confirmLabel="Suspend agent" successMessage="Agent suspended"
        description="The agent is removed from the marketplace and cannot join sessions. The owner is notified." reasonLabel="Reason" reasonRequired
        onConfirm={async (reason) => { await api.post(`/admin/agents/${act!.a.id}/suspend`, { reason }); await revalidate('/admin/agents'); }} />
      <ConfirmModal open={act?.kind === 'unsuspend'} onClose={() => setAct(null)} tone="primary" title={`Unsuspend ${act?.a.name ?? ''}?`} confirmLabel="Unsuspend" successMessage="Agent reinstated"
        onConfirm={async () => { await api.post(`/admin/agents/${act!.a.id}/unsuspend`); await revalidate('/admin/agents'); }} />
      <ConfirmModal open={act?.kind === 'verify'} onClose={() => setAct(null)} tone="primary" title={`Set verification to “${act?.status ?? ''}”?`} description={act?.a.name} confirmLabel="Update" successMessage="Verification updated"
        onConfirm={async () => { await api.post(`/admin/agents/${act!.a.id}/verify`, { status: act!.status }); await revalidate('/admin/agents'); }} />
    </div>
  );
}
