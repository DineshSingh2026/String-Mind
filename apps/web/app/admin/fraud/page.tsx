'use client';
import { useState } from 'react';
import { Badge, Button } from '@/components/ui';
import { api } from '@/lib/api';
import { ConfirmModal } from '@/components/training/ConfirmModal';
import { AdminHeader, DataCard, StatusBadge, Val, mono, useRevalidate, when, type Row } from '@/components/admin/kit';

export default function AdminFraudPage() {
  const [act, setAct] = useState<{ f: Row; status: 'confirmed' | 'dismissed' | 'open' } | null>(null);
  const revalidate = useRevalidate();
  return (
    <div>
      <AdminHeader title="Fraud flags" description="Automated rules (self-dealing training, wash reviews, IDLE farming…). Confirm or dismiss after investigation." />
      <DataCard title="Flags" path="/admin/fraud-flags" empty="No fraud flags" columns={[
        { header: 'Rule', cell: (f) => <code className="font-mono text-xs">{f.rule}</code> },
        { header: 'Severity', cell: (f) => <StatusBadge value={f.severity} /> },
        { header: 'Target', cell: (f) => <div className="flex items-center gap-1.5"><Badge>{f.targetType}</Badge>{mono(f.targetId)}</div> },
        { header: 'Details', cell: (f) => <Val v={f.details} /> },
        { header: 'Status', cell: (f) => <StatusBadge value={f.status} /> },
        { header: 'Raised', cell: (f) => when(f.createdAt) },
        {
          header: '', cell: (f) => f.status === 'open' ? (
            <div className="flex justify-end gap-1.5">
              <Button size="sm" variant="danger" onClick={() => setAct({ f, status: 'confirmed' })}>Confirm</Button>
              <Button size="sm" variant="outline" onClick={() => setAct({ f, status: 'dismissed' })}>Dismiss</Button>
            </div>) : <Button size="sm" variant="ghost" onClick={() => setAct({ f, status: 'open' })}>Reopen</Button>,
        },
      ]} />
      <ConfirmModal open={!!act} onClose={() => setAct(null)} tone={act?.status === 'confirmed' ? 'danger' : 'primary'} title={`Mark flag as ${act?.status ?? ''}?`} description={act?.f.rule}
        confirmLabel="Update flag" successMessage="Flag updated"
        onConfirm={async () => { await api.post(`/admin/fraud-flags/${act!.f.id}`, { status: act!.status }); await revalidate('/admin/fraud-flags'); }} />
    </div>
  );
}
