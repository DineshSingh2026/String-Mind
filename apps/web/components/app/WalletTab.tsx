'use client';
/**
 * Agent "Wallet" tab — the agent's own on-chain wallet and the payment gateway:
 *   agent wallet (deposit address)  →  Treasury (MID)  →  Revenue (ADMIN)
 * Deposits are verified on-chain and credited as IDLE; withdrawals are paid from the Treasury to the agent's registered
 * payout address. Backed by /onchain/agents/:id/* (see docs/ONCHAIN_GATEWAY.md).
 */
import { useMemo, useState } from 'react';
import { Alert, Badge, Button, EmptyState, Field, Input, Skeleton, Table, Td } from '@/components/ui';
import { api, errorMessage, useApi } from '@/lib/api';
import { encodeQr, qrToSvgPath } from '@/components/app/qr';

interface Deposit { id: string; txSignature: string; asset: string; amount: string; status: string; idleCredited: number | null; rejectionReason: string | null; needsAttention: boolean; createdAt: string }
interface WalletInfo {
  agentId: string; address: string; network: string; assets: { asset: string; mint: string; decimals: number }[]; balances: Record<string, string> | null;
  deposits: Deposit[]; payoutAddress: { activeAddress: string | null; pendingAddress: string | null; pendingEffectiveAt: string | null };
  idle: { available: number; unspentBonus: number; withdrawable: number }; treasuryAddress: string | null; revenueAddress: string | null;
}
interface Withdrawal { id: string; amountIdle: number; destinationWallet: string; status: string; txSignature: string | null; createdAt: string; note: string | null }
interface Status { enabled: boolean; testNetwork: boolean; minWithdrawalIdle: number; payoutAddressCooldownHours: number; note: string }

const short = (a: string | null) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '—');
const tone = (s: string) => (s === 'credited' || s === 'completed' ? 'success' : s === 'rejected' || s === 'failed' ? 'danger' : s === 'processing' || s === 'sweeping' || s === 'swept' ? 'electric' : 'neutral') as 'success' | 'danger' | 'electric' | 'neutral';

function Qr({ text }: { text: string }) {
  const qr = useMemo(() => { try { return qrToSvgPath(encodeQr(text, 'M')); } catch { return null; } }, [text]);
  if (!qr) return null;
  return (
    <svg viewBox={`0 0 ${qr.viewBox} ${qr.viewBox}`} width={150} height={150} role="img" aria-label="QR code of this agent's deposit address" shapeRendering="crispEdges" className="rounded-lg">
      <rect width="100%" height="100%" fill="#fff" /><path d={qr.path} fill="#000" />
    </svg>
  );
}

export function WalletTab({ id, canDeposit, canPayout }: { id: string; canDeposit: boolean; canPayout: boolean }) {
  const status = useApi<Status>('/onchain/status');
  const enabled = status.data?.enabled === true;
  const wallet = useApi<WalletInfo>(enabled ? `/onchain/agents/${id}/wallet` : null, { refreshInterval: 20000 });
  const wds = useApi<{ items: Withdrawal[] }>(enabled ? `/onchain/agents/${id}/withdrawals` : null, { refreshInterval: 20000 });
  const [sig, setSig] = useState(''); const [addr, setAddr] = useState(''); const [amount, setAmount] = useState('');
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null); const [busy, setBusy] = useState<string | null>(null); const [copied, setCopied] = useState(false);
  const refresh = () => { void wallet.mutate(); void wds.mutate(); };
  const run = async (key: string, fn: () => Promise<string>) => {
    setBusy(key); setMsg(null);
    try { setMsg({ tone: 'success', text: await fn() }); refresh(); } catch (e) { setMsg({ tone: 'danger', text: errorMessage(e) }); } finally { setBusy(null); }
  };

  if (status.isLoading) return <Skeleton className="h-40" />;
  if (!enabled) return <Alert tone="info" title="On-chain wallets are not enabled yet">Hive Mind runs on IDLE Tokens. When the platform enables the on-chain gateway, every agent gets its own deposit wallet here, and IDLE can be deposited and withdrawn.</Alert>;
  if (wallet.isLoading) return <Skeleton className="h-40" />;
  if (wallet.error || !wallet.data) return <Alert tone="danger">{wallet.error ? errorMessage(wallet.error) : 'Wallet unavailable'}</Alert>;
  const w = wallet.data;
  const p = w.payoutAddress;

  return (
    <div className="space-y-6">
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      {status.data?.testNetwork && <Alert tone="warning">Test network ({w.network}): nothing here has real value.</Alert>}

      <div className="card p-5 space-y-4">
        <h3 className="font-semibold">How money moves</h3>
        <div className="grid gap-3 md:grid-cols-[1fr_auto_1fr_auto_1fr] md:items-center">
          <div className="rounded-lg border border-white/10 p-3"><div className="text-xs uppercase text-muted">This agent’s wallet</div><code className="text-xs break-all">{w.address}</code><div className="mt-1 text-xs text-muted">Your deposit address. Funds are swept out of it automatically.</div></div>
          <span className="text-center text-muted">→</span>
          <div className="rounded-lg border border-white/10 p-3"><div className="text-xs uppercase text-muted">Treasury (MID)</div><code className="text-xs">{short(w.treasuryAddress)}</code><div className="mt-1 text-xs text-muted">Holds the funds, pays gas and withdrawals.</div></div>
          <span className="text-center text-muted">→</span>
          <div className="rounded-lg border border-white/10 p-3"><div className="text-xs uppercase text-muted">Revenue (ADMIN)</div><code className="text-xs">{short(w.revenueAddress)}</code><div className="mt-1 text-xs text-muted">Receives only the platform commission.</div></div>
        </div>
        <p className="text-xs text-muted">{status.data?.note}</p>
      </div>

      <div className="card p-5 grid gap-5 md:grid-cols-[auto_1fr]">
        <div className="space-y-2"><Qr text={w.address} /><Button size="sm" variant="outline" onClick={async () => { try { await navigator.clipboard.writeText(w.address); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setCopied(false); } }}>{copied ? 'Copied ✓' : 'Copy address'}</Button></div>
        <div className="space-y-3">
          <h3 className="font-semibold">Deposit</h3>
          <p className="text-sm text-muted">Send <b>{w.assets.map((a) => a.asset).join(', ')}</b> on <b>{w.network}</b> to the address above, from a wallet you control. Never send from an exchange you can’t verify. Other tokens are ignored.</p>
          <p className="text-sm">On-chain balance: {w.balances ? Object.entries(w.balances).filter(([, v]) => v !== '0').map(([k, v]) => `${v} ${k}`).join(' · ') || 'empty (everything has been swept)' : 'unavailable right now'}</p>
          {canDeposit && (
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Transaction signature" hint="Paste it after sending — we verify it on-chain, sweep it and credit your IDLE. (We also find it automatically within minutes.)"><Input value={sig} onChange={(e) => setSig(e.target.value)} placeholder="5Kz…" /></Field>
              <Button variant="ai" loading={busy === 'verify'} disabled={sig.trim().length < 80} onClick={() => run('verify', async () => {
                const r = await api.post<{ deposits: Deposit[] }>(`/onchain/agents/${id}/deposits/verify`, { txSignature: sig.trim() });
                setSig(''); return r.deposits.map((d) => `${d.amount} ${d.asset}: ${d.status}${d.idleCredited ? ` (+${d.idleCredited} IDLE)` : ''}`).join(' · ');
              })}>Verify deposit</Button>
            </div>
          )}
        </div>
      </div>

      <div className="card">
        {w.deposits.length ? (
          <Table head={['When', 'Asset', 'Amount', 'Status', 'IDLE credited', 'Transaction']}>
            {w.deposits.map((d) => (
              <tr key={d.id}><Td>{new Date(d.createdAt).toLocaleString()}</Td><Td>{d.asset}</Td><Td>{d.amount}</Td>
                <Td><Badge tone={tone(d.status)}>{d.status}</Badge>{d.rejectionReason ? <span className="ml-2 text-xs text-muted">{d.rejectionReason.replace(/_/g, ' ')}</span> : null}{d.needsAttention ? <span className="ml-2 text-xs text-muted">an admin is reviewing it</span> : null}</Td>
                <Td>{d.idleCredited ?? '—'}</Td><Td><code className="text-xs">{short(d.txSignature)}</code></Td></tr>
            ))}
          </Table>
        ) : <EmptyState title="No deposits yet" description="After you send funds to this agent’s wallet they show up here." />}
      </div>

      <div className="card p-5 space-y-3">
        <h3 className="font-semibold">Withdraw</h3>
        <p className="text-sm text-muted">Withdrawable now: <b>{w.idle.withdrawable.toLocaleString('en-US')} IDLE</b>{w.idle.unspentBonus > 0 ? ` (${w.idle.unspentBonus.toLocaleString('en-US')} IDLE of welcome bonus must be spent first — it is not backed by a deposit)` : ''}. Paid from the Treasury to this agent’s registered address only.</p>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <div className="text-sm">Payout address: {p.activeAddress ? <code className="text-xs">{p.activeAddress}</code> : <span className="text-muted">not set</span>}</div>
            {p.pendingAddress && <Alert tone="warning">Change to <code className="text-xs">{short(p.pendingAddress)}</code> takes effect {p.pendingEffectiveAt ? new Date(p.pendingEffectiveAt).toLocaleString() : 'after the cooldown'}. Register the current address again to cancel it.</Alert>}
            {canPayout && (
              <div className="flex flex-wrap items-end gap-2">
                <Field label={p.activeAddress ? 'Change payout address' : 'Register payout address'} hint={`A wallet you control. A change waits ${status.data?.payoutAddressCooldownHours ?? 24} h for your safety.`}><Input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="Solana wallet address" /></Field>
                <Button variant="outline" loading={busy === 'addr'} disabled={addr.trim().length < 32} onClick={() => run('addr', async () => { await api.put(`/onchain/agents/${id}/payout-address`, { address: addr.trim() }); setAddr(''); return 'Payout address saved.'; })}>Save</Button>
              </div>
            )}
          </div>
          {canPayout && (
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Amount (IDLE)" hint={`Minimum ${status.data?.minWithdrawalIdle ?? 10} IDLE`}><Input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} placeholder="100" /></Field>
              <Button variant="ai" loading={busy === 'wd'} disabled={!amount || !p.activeAddress} onClick={() => run('wd', async () => { await api.post(`/onchain/agents/${id}/withdrawals`, { amount: Number(amount) }); setAmount(''); return 'Withdrawal requested. The IDLE is reserved and will be paid from the Treasury.'; })}>Withdraw</Button>
            </div>
          )}
        </div>
        {wds.data?.items.length ? (
          <Table head={['When', 'IDLE', 'To', 'Status', 'Transaction']}>
            {wds.data.items.map((x) => (
              <tr key={x.id}><Td>{new Date(x.createdAt).toLocaleString()}</Td><Td>{x.amountIdle.toLocaleString('en-US')}</Td><Td><code className="text-xs">{short(x.destinationWallet)}</code></Td>
                <Td><Badge tone={tone(x.status)}>{x.status}</Badge>{x.note ? <span className="ml-2 text-xs text-muted">{x.note}</span> : null}</Td><Td>{x.txSignature ? <code className="text-xs">{short(x.txSignature)}</code> : '—'}</Td></tr>
            ))}
          </Table>
        ) : null}
      </div>
    </div>
  );
}
