'use client';
import { useState } from 'react';
import { Select } from '@/components/ui';
import { api } from '@/lib/api';
import { ConfirmModal } from '@/components/training/ConfirmModal';
import { AdminHeader, DataCard, StatusBadge, mono, nameOf, useRevalidate, when, type Row } from '@/components/admin/kit';

export default function AdminSubscriptionsPage() {
  const [act, setAct] = useState<{ s: Row; plan: string } | null>(null);
  const revalidate = useRevalidate();
  return (
    <div>
      <AdminHeader title="Subscriptions & plans" description="Organisation plans (free / pro / enterprise). Changing a plan takes effect immediately and is audited." />
      <DataCard title="Subscriptions" path="/admin/subscriptions" columns={[
        { header: 'Organisation', cell: (s) => <div><p className="font-medium">{nameOf(s, 'org', 'orgName')}</p>{mono(s.orgId)}</div> },
        { header: 'Plan', cell: (s) => <StatusBadge value={s.plan} /> },
        { header: 'Status', cell: (s) => <StatusBadge value={s.status} /> },
        { header: 'Period end', cell: (s) => when(s.currentPeriodEnd) },
        { header: 'Since', cell: (s) => when(s.createdAt) },
        {
          header: 'Change plan', cell: (s) => (
            <Select aria-label="Change plan" className="h-8 w-32 text-xs" value={s.plan} onChange={(e) => setAct({ s, plan: e.target.value })}>
              <option value="free">free</option><option value="pro">pro</option><option value="enterprise">enterprise</option>
            </Select>),
        },
      ]} />
      <ConfirmModal open={!!act} onClose={() => setAct(null)} tone="primary" title={`Move ${nameOf(act?.s, 'org', 'orgName')} to “${act?.plan ?? ''}”?`} confirmLabel="Change plan" successMessage="Plan updated"
        onConfirm={async () => { await api.patch(`/admin/orgs/${act!.s.orgId ?? act!.s.org?.id}/plan`, { plan: act!.plan }); await revalidate('/admin/subscriptions'); }} />
    </div>
  );
}
