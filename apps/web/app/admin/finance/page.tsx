'use client';
import { useState, type ReactNode } from 'react';
import { Coins, Gift, Landmark, Percent } from 'lucide-react';
import { Alert, Button, Modal, Skeleton, fmtCredits, fmtNumber, useToast } from '@/components/ui';
import { api, errorMessage, useApi } from '@/lib/api';
import { AdminHeader, DataCard, SearchBox, nameOf, when, type Row } from '@/components/admin/kit';
import { IdleToken } from '@/components/brand/IdleToken';
import { fmtIdle } from '@/lib/tokens';

interface TokenOverview {
  tokens?: { welcomeBonusesGranted?: number; welcomeBonusIssued?: number; inCirculation?: number };
  commissions?: { trainingCommissionCredits?: number; platformRevenueBalance?: number };
}

/** Admin "Token economy": IDLE supply, platform commission, org wallets + ledger reconciliation. No fiat. */
export default function AdminTokenEconomyPage() {
  const [q, setQ] = useState('');
  const [recon, setRecon] = useState<{ w: Row; res: Row | null; err?: string } | null>(null);
  const toast = useToast();
  const ov = useApi<TokenOverview>('/admin/overview', { refreshInterval: 30000 });
  const t = ov.data?.tokens; const c = ov.data?.commissions;

  const reconcile = async (w: Row) => {
    setRecon({ w, res: null });
    try { const res = await api.get<Row>(`/admin/wallets/${w.id}/reconcile`); setRecon({ w, res }); }
    catch (e) { setRecon({ w, res: null, err: errorMessage(e) }); toast('danger', errorMessage(e)); }
  };

  return (
    <div className="space-y-5">
      <AdminHeader title="Token economy"
        description="StringMind runs on IDLE Tokens only — they are granted (welcome bonus), earned and spent, never bought or withdrawn. Wallet balances are a cache of the append-only ledger; reconcile to verify." />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile icon={<Coins className="h-4 w-4" />} label="IDLE in circulation" value={t?.inCirculation} loading={ov.isLoading} />
        <Tile icon={<Gift className="h-4 w-4" />} label="Welcome bonuses issued" value={t?.welcomeBonusIssued} sub={t?.welcomeBonusesGranted != null ? `${fmtNumber(t.welcomeBonusesGranted)} accounts` : undefined} loading={ov.isLoading} />
        <Tile icon={<Percent className="h-4 w-4" />} label="Platform commission" value={c?.trainingCommissionCredits} sub="from settled training" loading={ov.isLoading} />
        <Tile icon={<Landmark className="h-4 w-4" />} label="Platform wallet" value={c?.platformRevenueBalance} loading={ov.isLoading} />
      </div>
      {ov.error && <Alert tone="warning">Token totals unavailable: {errorMessage(ov.error)}</Alert>}

      <DataCard title="Wallets" subtitle="Organisation IDLE wallets" action={<SearchBox value={q} onChange={setQ} placeholder="Search organisation" />} path={`/admin/wallets?q=${encodeURIComponent(q)}`} columns={[
        { header: 'Organisation', cell: (w) => <div><p className="font-medium">{nameOf(w, 'org', 'orgName')}</p><p className="text-xs text-fg-muted">{w.kind}</p></div> },
        { header: 'Available', cell: (w) => <span className="tabular-nums">{fmtCredits(w.available)}</span> },
        { header: 'In escrow', cell: (w) => <span className="tabular-nums">{fmtCredits(w.locked)}</span> },
        { header: 'Earned', cell: (w) => <span className="tabular-nums">{fmtCredits(w.earnedTotal)}</span> },
        { header: 'Spent', cell: (w) => <span className="tabular-nums">{fmtCredits(w.spentTotal)}</span> },
        { header: 'Updated', cell: (w) => when(w.updatedAt) },
        { header: '', cell: (w) => <Button size="sm" variant="outline" onClick={() => void reconcile(w)}>Reconcile</Button> },
      ]} />

      <Modal open={!!recon} onClose={() => setRecon(null)} title="Ledger reconciliation" description={nameOf(recon?.w, 'org', 'orgName')}>
        {recon && (recon.err ? <Alert tone="danger">{recon.err}</Alert> : !recon.res ? <p className="text-sm text-fg-muted">Reconciling…</p> : (
          <div className="space-y-3">
            <Alert tone={recon.res.ok ? 'success' : 'danger'} title={recon.res.ok ? 'Balanced' : 'Mismatch detected'}>{recon.res.ok ? 'Cached IDLE balances match the ledger.' : 'Cached IDLE balances differ from the ledger sum. Investigate before adjusting.'}</Alert>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div><p className="mb-1 text-fg-subtle">Cached</p><pre className="overflow-x-auto rounded-xl border border-line bg-ink-950 p-3 font-mono">{JSON.stringify(recon.res.cached, null, 2)}</pre></div>
              <div><p className="mb-1 text-fg-subtle">Ledger</p><pre className="overflow-x-auto rounded-xl border border-line bg-ink-950 p-3 font-mono">{JSON.stringify(recon.res.ledger, null, 2)}</pre></div>
            </div>
          </div>
        ))}
      </Modal>
    </div>
  );
}

function Tile({ icon, label, value, sub, loading }: { icon: ReactNode; label: string; value?: number | null; sub?: ReactNode; loading?: boolean }) {
  return (
    <div className="card ax-spot relative overflow-hidden p-4">
      <p className="flex items-center gap-1.5 text-xs text-fg-subtle"><span className="text-gold" aria-hidden>{icon}</span>{label}</p>
      {loading ? <Skeleton className="mt-2 h-7 w-24" /> : (
        <p className="mt-1.5 flex items-center gap-1.5 font-display text-xl font-semibold tabular-nums"><IdleToken size={18} />{value == null ? '—' : fmtIdle(value)}</p>
      )}
      {sub && <p className="mt-0.5 text-xs text-fg-muted">{sub}</p>}
    </div>
  );
}
