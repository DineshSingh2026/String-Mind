'use client';
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { DEFAULT_COMMISSION_BPS } from '@aix/shared';
import { Alert, Badge, Button, Field, Input, Modal, Select, fmtPct, useToast } from '@/components/ui';
import { api, errorMessage, useApi } from '@/lib/api';
import { ConfirmModal } from '@/components/training/ConfirmModal';
import { AdminHeader, DataCard, StatusBadge, nameOf, useRevalidate, when, type Row } from '@/components/admin/kit';

export default function AdminCommissionsPage() {
  const [create, setCreate] = useState(false);
  const [del, setDel] = useState<Row | null>(null);
  const revalidate = useRevalidate();
  return (
    <div className="space-y-5">
      <AdminHeader title="Commission settings" description="Platform commission on training sessions and knowledge sales, in basis points."
        actions={<Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setCreate(true)}>Add rule</Button>} />
      <Alert tone="info" title="Precedence: organisation › domain › global">
        The most specific active rule wins. An organisation rule overrides a domain rule, which overrides the global rule. With no rules, the default is {fmtPct(DEFAULT_COMMISSION_BPS / 100, 0)}. The rate is locked into each session when it is accepted.
      </Alert>
      <DataCard title="Rules" path="/admin/commissions" empty="No rules — the default rate applies" columns={[
        { header: 'Scope', cell: (r) => <Badge tone={r.scope === 'org' ? 'gold' : r.scope === 'domain' ? 'violet' : 'electric'}>{r.scope}</Badge> },
        { header: 'Target', cell: (r) => (r.scope === 'global' ? 'All' : nameOf(r, 'target', 'org', 'domain', 'scopeName', 'scopeId')) },
        { header: 'Rate', cell: (r) => <span className="font-medium tabular-nums">{fmtPct(r.rateBps / 100, 2)} <span className="text-xs text-fg-subtle">({r.rateBps} bps)</span></span> },
        { header: 'Active', cell: (r) => <StatusBadge value={r.active === false ? 'disabled' : 'active'} /> },
        { header: 'Created', cell: (r) => when(r.createdAt) },
        { header: '', cell: (r) => <Button size="sm" variant="ghost" className="text-danger-soft" onClick={() => setDel(r)}>Delete</Button> },
      ]} />
      <CreateRule open={create} onClose={() => setCreate(false)} />
      <ConfirmModal open={!!del} onClose={() => setDel(null)} title="Delete commission rule?" confirmLabel="Delete rule" successMessage="Rule deleted"
        description="Future sessions fall back to the next applicable rule. Existing sessions keep their locked rate."
        onConfirm={async () => { await api.del(`/admin/commissions/${del!.id}`); await revalidate('/admin/commissions'); }} />
    </div>
  );
}

function CreateRule({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const revalidate = useRevalidate();
  const domains = useApi<{ id: string; slug: string; name: string }[]>(open ? '/assessments/domains' : null);
  const [scope, setScope] = useState<'global' | 'domain' | 'org'>('global');
  const [scopeId, setScopeId] = useState('');
  const [pct, setPct] = useState('20');
  const [busy, setBusy] = useState(false);
  const n = Number(pct);
  const valid = pct !== '' && n >= 0 && n <= 100 && (scope === 'global' || /^[0-9a-f-]{36}$/i.test(scopeId.trim()));
  const submit = async () => {
    setBusy(true);
    try {
      await api.post('/admin/commissions', { scope, ...(scope !== 'global' ? { scopeId: scopeId.trim() } : {}), rateBps: Math.round(n * 100) });
      toast('success', 'Commission rule added'); await revalidate('/admin/commissions'); onClose();
    } catch (e) { toast('danger', errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Add commission rule" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!valid} onClick={submit}>Add rule</Button></>}>
      <div className="space-y-4">
        <Field label="Scope" htmlFor="c-scope"><Select id="c-scope" value={scope} onChange={(e) => { setScope(e.target.value as 'global'); setScopeId(''); }}><option value="global">Global</option><option value="domain">Domain</option><option value="org">Organisation</option></Select></Field>
        {scope === 'domain' && (
          <Field label="Domain" htmlFor="c-domain" error={domains.error ? errorMessage(domains.error) : undefined}>
            <Select id="c-domain" value={scopeId} onChange={(e) => setScopeId(e.target.value)}><option value="">Select a domain…</option>{(Array.isArray(domains.data) ? domains.data : []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>
          </Field>
        )}
        {scope === 'org' && <Field label="Organisation ID" htmlFor="c-org" hint="UUID of the organisation (see Subscriptions or Wallets)."><Input id="c-org" value={scopeId} onChange={(e) => setScopeId(e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" /></Field>}
        <Field label="Rate (%)" htmlFor="c-rate" hint={`= ${Math.round((n || 0) * 100)} basis points`} error={pct !== '' && (n < 0 || n > 100) ? '0–100' : undefined}><Input id="c-rate" type="number" step="0.01" min={0} max={100} value={pct} onChange={(e) => setPct(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
