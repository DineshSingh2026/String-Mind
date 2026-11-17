'use client';
import { useState } from 'react';
import { Button, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { AdminHeader, DataCard, StatusBadge, mono, useMutate, when } from '@/components/admin/kit';

export default function AdminJobsPage() {
  const [status, setStatus] = useState('failed');
  const { busy, run } = useMutate('/admin/jobs');
  return (
    <div>
      <AdminHeader title="Background jobs" description="Durable job queue (assessments, training orchestration, webhooks, health checks). Retry failed jobs after fixing the cause."
        actions={<Select aria-label="Job status" className="h-9 w-36" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="failed">Failed</option><option value="queued">Queued</option><option value="running">Running</option><option value="completed">Completed</option><option value="">All</option>
        </Select>} />
      <DataCard title="Jobs" path={`/admin/jobs?status=${status}`} empty="No jobs in this state" columns={[
        { header: 'Type', cell: (j) => <div><code className="font-mono text-xs">{j.type}</code><div>{mono(j.id)}</div></div> },
        { header: 'Status', cell: (j) => <StatusBadge value={j.status} /> },
        { header: 'Attempts', cell: (j) => <span className="tabular-nums">{j.attempts ?? 0}/{j.maxAttempts ?? '—'}</span> },
        { header: 'Run at', cell: (j) => when(j.runAt) },
        { header: 'Last error', cell: (j) => <p className="max-w-xs truncate text-xs text-danger-soft" title={j.lastError ?? ''}>{j.lastError ?? ''}</p> },
        { header: 'Created', cell: (j) => when(j.createdAt) },
        { header: '', cell: (j) => j.status === 'failed' && <Button size="sm" variant="outline" loading={busy === j.id} onClick={() => run(j.id, () => api.post(`/admin/jobs/${j.id}/retry`), 'Job re-queued')}>Retry</Button> },
      ]} />
    </div>
  );
}
