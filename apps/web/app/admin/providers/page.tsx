'use client';
import { useState } from 'react';
import { Badge, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { ConfirmModal } from '@/components/training/ConfirmModal';
import { AdminHeader, DataCard, StatusBadge, useRevalidate, type Row } from '@/components/admin/kit';

export default function AdminProvidersPage() {
  const [act, setAct] = useState<{ p: Row; status: string } | null>(null);
  const revalidate = useRevalidate();
  return (
    <div>
      <AdminHeader title="Providers" description="Enable, mark as beta or disable model providers. Disabling stops new connections for that provider." />
      <DataCard title="Agent providers" path="/admin/providers" rowKey={(p) => p.id ?? p.slug}
        columns={[
          { header: 'Provider', cell: (p) => <div><p className="font-medium">{p.name}</p><p className="font-mono text-xs text-fg-muted">{p.slug}</p></div> },
          { header: 'Adapter', cell: (p) => <Badge tone="electric">{p.adapter}</Badge> },
          { header: 'Models', cell: (p) => <span className="text-xs text-fg-muted">{(p.defaultModels ?? []).join(', ') || '—'}</span> },
          { header: 'Agents', cell: (p) => p.agentCount ?? '—' },
          { header: 'Status', cell: (p) => <StatusBadge value={p.status} /> },
          {
            header: '', cell: (p) => (
              <Select aria-label={`Status for ${p.name}`} className="h-8 w-32 text-xs" value={p.status} onChange={(e) => setAct({ p, status: e.target.value })}>
                <option value="active">active</option><option value="beta">beta</option><option value="disabled">disabled</option>
              </Select>),
          },
        ]} />
      <ConfirmModal open={!!act} onClose={() => setAct(null)} tone={act?.status === 'disabled' ? 'danger' : 'primary'} title={`Set ${act?.p.name ?? ''} to “${act?.status ?? ''}”?`} confirmLabel="Update provider" successMessage="Provider updated"
        onConfirm={async () => { await api.patch(`/admin/providers/${act!.p.id}`, { status: act!.status }); await revalidate('/admin/providers'); }} />
    </div>
  );
}
