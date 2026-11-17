'use client';
import { useState } from 'react';
import { Button, Field, Input, Modal, Select, Textarea, fmtCredits, useToast } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { AdminHeader, DataCard, StatusBadge, mono, nameOf, useRevalidate, when, type Row } from '@/components/admin/kit';

export default function AdminDisputesPage() {
  const [res, setRes] = useState<Row | null>(null);
  return (
    <div>
      <AdminHeader title="Disputes" description="Resolve training disputes: refund the learner, release to the trainer, or split with a partial refund." />
      <DataCard title="Disputes" path="/admin/disputes" empty="No disputes" columns={[
        { header: 'Session', cell: (d) => <div><p className="font-medium">{d.session?.subject ?? 'Training session'}</p>{mono(d.sessionId)}</div> },
        { header: 'Raised by', cell: (d) => nameOf(d, 'raisedByOrg', 'org', 'raisedBy') },
        { header: 'Reason', cell: (d) => <div><p className="font-medium">{String(d.reason).replace(/_/g, ' ')}</p><p className="max-w-xs text-xs text-fg-muted">{d.details}</p></div> },
        { header: 'Fee', cell: (d) => fmtCredits(d.session?.feeCredits ?? d.feeCredits) },
        { header: 'Status', cell: (d) => <StatusBadge value={d.status} /> },
        { header: 'Opened', cell: (d) => when(d.createdAt) },
        { header: '', cell: (d) => (d.status === 'open' || d.status === 'under_review') ? <Button size="sm" variant="primary" onClick={() => setRes(d)}>Resolve</Button> : <span className="text-xs text-fg-muted">{d.resolution ?? ''}</span> },
      ]} />
      <ResolveModal d={res} onClose={() => setRes(null)} />
    </div>
  );
}

function ResolveModal({ d, onClose }: { d: Row | null; onClose: () => void }) {
  const toast = useToast();
  const revalidate = useRevalidate();
  const [outcome, setOutcome] = useState<'refund' | 'release' | 'partial'>('refund');
  const [amount, setAmount] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const fee: number | undefined = d?.session?.feeCredits ?? d?.feeCredits;
  const amt = Number(amount);
  const amtOk = outcome !== 'partial' || (Number.isInteger(amt) && amt > 0 && (fee == null || amt < fee));
  const valid = amtOk && text.trim().length >= 10;
  const submit = async () => {
    setBusy(true);
    try {
      await api.post(`/admin/disputes/${d!.id}/resolve`, { outcome, ...(outcome === 'partial' ? { refundCredits: amt } : {}), resolution: text.trim() });
      toast('success', 'Dispute resolved and settlement posted'); await revalidate('/admin/disputes'); setText(''); setAmount(''); onClose();
    } catch (e) { toast('danger', errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open={!!d} onClose={onClose} title="Resolve dispute" description={d ? `${String(d.reason).replace(/_/g, ' ')} · fee ${fmtCredits(fee)}` : undefined}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!valid} onClick={submit}>Resolve dispute</Button></>}>
      <div className="space-y-4">
        {d?.details && <p className="rounded-xl border border-line bg-ink-950/40 p-3 text-sm text-fg-muted">{d.details}</p>}
        <Field label="Outcome" htmlFor="d-out">
          <Select id="d-out" value={outcome} onChange={(e) => setOutcome(e.target.value as 'refund')}>
            <option value="refund">Full refund to learner</option><option value="release">Release to trainer</option><option value="partial">Partial refund</option>
          </Select>
        </Field>
        {outcome === 'partial' && (
          <Field label="IDLE refunded to learner" htmlFor="d-amt" required hint={fee != null ? `Between 1 and ${fee - 1}; the rest is released to the trainer (minus commission).` : undefined} error={amount && !amtOk ? 'Enter a whole number below the session fee' : undefined}>
            <Input id="d-amt" type="number" min={1} step={1} value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
        )}
        <Field label="Resolution (shared with both parties)" htmlFor="d-res" required hint="At least 10 characters.">
          <Textarea id="d-res" value={text} onChange={(e) => setText(e.target.value)} maxLength={4000} />
        </Field>
      </div>
    </Modal>
  );
}
