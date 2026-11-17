'use client';
import { useState } from 'react';
import { Button, Modal, Select, cn, fmtCredits } from '@/components/ui';
import { AdminHeader, AutoObject, DataCard, StatusBadge, when, type Row } from '@/components/admin/kit';
import { agentName, domainName, scoresOf, settlementOf, sideAgent, STAGE_LABELS, type TrainingSession } from '@/components/training/model';
import type { TrainingStage } from '@aix/shared';

export default function AdminTrainingPage() {
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<Row | null>(null);
  return (
    <div>
      <AdminHeader title="Training sessions" description="Monitor every training session across organisations: stage, independent scores and settlement."
        actions={<Select aria-label="Status" className="h-9 w-40" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>{['scheduled', 'active', 'paused', 'completed', 'failed', 'cancelled', 'disputed'].map((s) => <option key={s} value={s}>{s}</option>)}
        </Select>} />
      <DataCard title="Sessions" path={`/admin/training-sessions?status=${status}`} empty="No sessions"
        columns={[
          { header: 'Learner ← Trainer', cell: (r) => { const s = r as TrainingSession; return <div><p className="font-medium">{agentName(sideAgent(s, 'learner'))} ← {agentName(sideAgent(s, 'trainer'))}</p><p className="text-xs text-fg-muted">{s.subject ?? domainName(s) ?? ''}</p></div>; } },
          { header: 'Status', cell: (r) => <StatusBadge value={r.status} /> },
          { header: 'Stage', cell: (r) => <span className="text-xs">{STAGE_LABELS[r.stage as TrainingStage] ?? r.stage}</span> },
          { header: 'Δ score', cell: (r) => { const i = scoresOf(r as TrainingSession).improvement; return i == null ? '—' : <span className={cn('tabular-nums font-medium', i >= 0 ? 'text-success' : 'text-danger-soft')}>{i >= 0 ? '+' : ''}{i.toFixed(1)}</span>; } },
          { header: 'Fee', cell: (r) => fmtCredits(settlementOf(r as TrainingSession).fee) },
          { header: 'Settlement', cell: (r) => <StatusBadge value={settlementOf(r as TrainingSession).status} /> },
          { header: 'Created', cell: (r) => when(r.createdAt) },
          { header: '', cell: (r) => <Button size="sm" variant="ghost" onClick={() => setOpen(r)}>Details</Button> },
        ]} />
      <Modal open={!!open} onClose={() => setOpen(null)} size="xl" title="Session details" description={open?.id}>
        {open && <AutoObject data={open} />}
      </Modal>
    </div>
  );
}
