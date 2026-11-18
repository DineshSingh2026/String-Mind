'use client';
/** Admin "Treasury & revenue": agent wallets → Treasury (MID) → Revenue (ADMIN). Money is only ever moved by the gateway's
 *  state machines; this page lets an admin pay / decline withdrawals, retry parked items and resolve reconciliation issues. */
import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Input, Skeleton, Table, Td, Toggle, useToast } from '@/components/ui';
import { api, errorMessage, useApi } from '@/lib/api';
import { AdminHeader } from '@/components/admin/kit';

interface Flow { role: string; label: string; description: string; count?: number; address?: string | null; balances?: Record<string, string> | null }
interface Settings { feeMirrorEnabled: boolean; minWithdrawalIdle: number; maxWithdrawalPerRequestIdle: number; maxDailyWithdrawalIdle: number; payoutAddressCooldownHours: number; autoWithdrawalsEnabled: boolean; autoWithdrawalMaxIdle: number; depositPriceMaxDropPct: number }
interface Overview { enabled: boolean; network: string; flow: Flow[]; deposits: Record<string, number>; withdrawals: Record<string, number>; openFeeTransfers: number; feesSentIdle: number; openIssues: number; settings: Settings }
interface Wd { id: string; agentId: string; amountIdle: number; destinationWallet: string; status: string; txSignature: string | null; attempts: number; createdAt: string }
interface Dep { id: string; asset: string; amount: string; status: string; txSignature: string; lastError?: string | null; createdAt: string }
interface Fee { id: string; sourceType: string; amountIdle: number; status: string; transferSignature: string | null; attempts: number; lastError: string | null }
interface Issue { id: string; kind: string; severity: string; refType: string; refKey: string; details: Record<string, unknown>; lastSeenAt: string }

const short = (a?: string | null) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '—');
const tone = (s: string) => (s === 'completed' || s === 'credited' ? 'success' : s === 'failed' || s === 'critical' ? 'danger' : s === 'warning' ? 'warning' : 'neutral') as 'success' | 'danger' | 'warning' | 'neutral';

export default function AdminTreasuryPage() {
  const toast = useToast();
  const ov = useApi<Overview>('/onchain/admin/overview', { refreshInterval: 20000 });
  const enabled = ov.data?.enabled === true;
  const pending = useApi<{ items: Wd[] }>(enabled ? '/onchain/admin/withdrawals?status=pending' : null, { refreshInterval: 20000 });
  const processing = useApi<{ items: Wd[] }>(enabled ? '/onchain/admin/withdrawals?status=processing' : null, { refreshInterval: 20000 });
  const failedDeps = useApi<{ items: Dep[] }>(enabled ? '/onchain/admin/deposits?status=failed' : null, { refreshInterval: 30000 });
  const fees = useApi<{ items: Fee[] }>(enabled ? '/onchain/admin/settlements?limit=20' : null, { refreshInterval: 20000 });
  const issues = useApi<{ items: Issue[] }>(enabled ? '/onchain/admin/issues' : null, { refreshInterval: 30000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState<Settings | null>(null);
  useEffect(() => { if (ov.data && !form) setForm(ov.data.settings); }, [ov.data, form]);
  const refresh = () => { void ov.mutate(); void pending.mutate(); void processing.mutate(); void failedDeps.mutate(); void fees.mutate(); void issues.mutate(); };
  const act = async (key: string, fn: () => Promise<string>) => {
    setBusy(key);
    try { toast('success', await fn()); refresh(); } catch (e) { toast('danger', errorMessage(e)); } finally { setBusy(null); }
  };

  return (
    <div className="space-y-6">
      <AdminHeader title="Treasury & revenue" description="Every agent has its own wallet. Deposits are swept into the Treasury (MID), which holds the funds, pays gas and pays withdrawals. Platform commission moves from the Treasury to the Revenue wallet (ADMIN), whose key this application never loads." />
      {ov.isLoading && <Skeleton className="h-40" />}
      {ov.data && !enabled && <Alert tone="info" title="The on-chain gateway is off">Set ONCHAIN_ENABLED=true with the Solana RPC, the Treasury/Revenue addresses and the wallet secrets (see docs/ONCHAIN_GATEWAY.md), then restart the API.</Alert>}

      {ov.data && (
        <>
          <div className="grid gap-3 md:grid-cols-[1fr_auto_1fr_auto_1fr] md:items-stretch">
            {ov.data.flow.map((f, i) => (
              <div key={f.role} className="contents">
                {i > 0 && <span className="self-center text-center text-muted">→</span>}
                <div className="card p-4 space-y-1">
                  <div className="text-xs uppercase text-muted">{f.label}</div>
                  <div className="text-sm text-muted">{f.description}</div>
                  {f.role === 'AGENT' ? <div className="text-2xl font-semibold">{f.count ?? 0} <span className="text-sm font-normal text-muted">wallets</span></div> : (
                    <>
                      <code className="text-xs break-all">{f.address ?? 'not configured'}</code>
                      {f.balances && <div className="text-xs">{Object.entries(f.balances).filter(([, v]) => v !== '0').map(([k, v]) => `${v} ${k}`).join(' · ') || 'empty'}</div>}
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[['Deposits credited', ov.data.deposits.credited ?? 0], ['Withdrawals pending', ov.data.withdrawals.pending ?? 0], ['Fee transfers open', ov.data.openFeeTransfers], ['Open issues', ov.data.openIssues]].map(([l, v]) => (
              <div key={String(l)} className="card p-4"><div className="text-xs text-muted">{l}</div><div className="text-2xl font-semibold">{v}</div></div>
            ))}
          </div>
        </>
      )}

      {enabled && (
        <>
          <div className="card p-5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">Withdrawals to pay</h3>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" loading={busy === 'scan'} onClick={() => act('scan', async () => { const r = await api.post<{ newDeposits: number }>('/onchain/admin/scan', {}); return `Scan finished: ${r.newDeposits} new deposit(s).`; })}>Scan deposits</Button>
                <Button size="sm" variant="outline" loading={busy === 'recon'} onClick={() => act('recon', async () => { await api.post('/onchain/admin/reconcile', {}); return 'Reconciliation finished.'; })}>Reconcile</Button>
              </div>
            </div>
            {(pending.data?.items.length ?? 0) + (processing.data?.items.length ?? 0) === 0 ? <p className="text-sm text-muted">Nothing waiting.</p> : (
              <Table head={['When', 'IDLE', 'To', 'Status', '']}>
                {[...(pending.data?.items ?? []), ...(processing.data?.items ?? [])].map((w) => (
                  <tr key={w.id}><Td>{new Date(w.createdAt).toLocaleString()}</Td><Td>{w.amountIdle.toLocaleString('en-US')}</Td><Td><code className="text-xs">{short(w.destinationWallet)}</code></Td>
                    <Td><Badge tone={tone(w.status)}>{w.status}</Badge>{w.attempts ? <span className="ml-2 text-xs text-muted">{w.attempts} failed attempt(s)</span> : null}</Td>
                    <Td className="space-x-2">{w.status === 'pending' && (<>
                      <Button size="sm" variant="ai" loading={busy === w.id} onClick={() => act(w.id, async () => { const r = await api.post<{ results: { ok: boolean; error?: string }[] }>('/onchain/admin/withdrawals/settle', { ids: [w.id] }); const x = r.results[0]; return x?.ok ? 'Paid from the Treasury.' : (x?.error ?? 'Not paid.'); })}>Pay from Treasury</Button>
                      <Button size="sm" variant="outline" onClick={() => { const reason = window.prompt('Reason for declining (shown to the owner):'); if (reason !== null) void act(`d${w.id}`, async () => { await api.post(`/onchain/admin/withdrawals/${w.id}/decline`, { reason }); return 'Declined; the IDLE was returned.'; }); }}>Decline</Button></>)}</Td></tr>
                ))}
              </Table>
            )}
          </div>

          {(failedDeps.data?.items.length ?? 0) > 0 && (
            <div className="card p-5 space-y-3"><h3 className="font-semibold">Deposits needing attention</h3>
              <Table head={['When', 'Asset', 'Amount', 'Problem', '']}>
                {failedDeps.data!.items.map((d) => (
                  <tr key={d.id}><Td>{new Date(d.createdAt).toLocaleString()}</Td><Td>{d.asset}</Td><Td>{d.amount}</Td><Td className="text-xs">{d.lastError ?? 'failed'}</Td>
                    <Td><Button size="sm" variant="outline" loading={busy === d.id} onClick={() => act(d.id, async () => { await api.post(`/onchain/admin/deposits/${d.id}/retry`, {}); return 'Retried.'; })}>Retry</Button></Td></tr>
                ))}
              </Table></div>
          )}

          <div className="card p-5 space-y-3"><h3 className="font-semibold">Platform fee → Revenue wallet</h3>
            {fees.data?.items.length ? (
              <Table head={['Source', 'IDLE', 'Status', 'Transaction', '']}>
                {fees.data.items.map((f) => (
                  <tr key={f.id}><Td>{f.sourceType.replace('_', ' ')}</Td><Td>{f.amountIdle.toLocaleString('en-US')}</Td><Td><Badge tone={tone(f.status)}>{f.status}</Badge>{f.lastError ? <span className="ml-2 text-xs text-muted">{f.lastError}</span> : null}</Td>
                    <Td>{f.transferSignature ? <code className="text-xs">{short(f.transferSignature)}</code> : '—'}</Td>
                    <Td>{f.status === 'failed' && <Button size="sm" variant="outline" loading={busy === f.id} onClick={() => act(f.id, async () => { await api.post(`/onchain/admin/settlements/${f.id}/retry`, {}); return 'Queued again.'; })}>Retry</Button>}</Td></tr>
                ))}
              </Table>
            ) : <p className="text-sm text-muted">No fee transfers yet. Each platform commission becomes one Treasury → Revenue transfer.</p>}
          </div>

          <div className="card p-5 space-y-3"><h3 className="font-semibold">Reconciliation issues</h3>
            {issues.data?.items.length ? (
              <Table head={['Severity', 'Issue', 'Reference', 'Details', '']}>
                {issues.data.items.map((i) => (
                  <tr key={i.id}><Td><Badge tone={tone(i.severity)}>{i.severity}</Badge></Td><Td>{i.kind.replace(/_/g, ' ')}</Td><Td><code className="text-xs">{short(i.refKey)}</code></Td><Td className="max-w-xs truncate text-xs">{JSON.stringify(i.details)}</Td>
                    <Td><Button size="sm" variant="outline" onClick={() => { const note = window.prompt('How was this resolved?'); if (note && note.trim().length >= 3) void act(i.id, async () => { await api.post(`/onchain/admin/issues/${i.id}/resolve`, { note }); return 'Resolved.'; }); }}>Resolve</Button></Td></tr>
                ))}
              </Table>
            ) : <p className="text-sm text-muted">No open issues. The gateway raises one for anything that doesn’t add up — it never changes money by itself.</p>}
          </div>
        </>
      )}

      {form && (
        <div className="card p-5 space-y-4"><h3 className="font-semibold">Gateway policy</h3>
          <div className="grid gap-3 md:grid-cols-3">
            {([['minWithdrawalIdle', 'Minimum withdrawal (IDLE)'], ['maxWithdrawalPerRequestIdle', 'Max per request (0 = no limit)'], ['maxDailyWithdrawalIdle', 'Max per day per organisation (0 = no limit)'], ['payoutAddressCooldownHours', 'Payout address cooldown (hours)'], ['autoWithdrawalMaxIdle', 'Automatic payout cap (IDLE; needed for auto)']] as const).map(([k, label]) => (
              <label key={k} className="space-y-1 text-sm"><span className="text-muted">{label}</span><Input inputMode="numeric" value={String(form[k])} onChange={(e) => setForm({ ...form, [k]: Number(e.target.value.replace(/\D/g, '')) })} /></label>
            ))}
          </div>
          <div className="flex flex-wrap gap-6">
            <Toggle checked={form.autoWithdrawalsEnabled} onChange={(v) => setForm({ ...form, autoWithdrawalsEnabled: v })} label="Pay withdrawals automatically (up to the cap)" />
            <Toggle checked={form.feeMirrorEnabled} onChange={(v) => setForm({ ...form, feeMirrorEnabled: v })} label="Mirror platform commission to the Revenue wallet" />
          </div>
          <Button loading={busy === 'save'} onClick={() => act('save', async () => { await api.put('/onchain/admin/settings', form); return 'Saved.'; })}>Save policy</Button>
        </div>
      )}
    </div>
  );
}
