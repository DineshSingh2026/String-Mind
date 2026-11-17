'use client';
import { useState } from 'react';
import { KeyRound, Plus, RotateCw, Trash2 } from 'lucide-react';
import { PERMISSIONS, type Permission } from '@aix/shared';
import {
  Badge, Button, Card, CardHeader, Checkbox, EmptyState, ErrorState, Field, Input, Modal, Select, Skeleton, Table, Td, cn, fmtDate, fmtRelative, useToast,
} from '@/components/ui';
import { api, errorMessage, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ConfirmModal } from '@/components/training/ConfirmModal';
import { asList } from '@/components/training/model';
import { NoPermission, SecretOnceModal, extractSecret } from './common';

export interface ApiKey {
  id: string; name: string; prefix?: string; scopes: string[]; environment: 'sandbox' | 'production' | string;
  rateLimitPerMin?: number; lastUsedAt?: string | null; expiresAt?: string | null; revokedAt?: string | null; createdAt?: string;
}

const GROUPS = PERMISSIONS.reduce<Record<string, Permission[]>>((acc, p) => { const g = p.split('.')[0]!; (acc[g] ??= []).push(p); return acc; }, {});

export function useKeys() { return useApi<unknown>('/developer/keys?pageSize=100'); }

export function KeysTab() {
  const { can } = useSession();
  const allowed = can('developer.keys.manage');
  const q = useKeys();
  const keys = asList<ApiKey>(q.data);
  const [create, setCreate] = useState(false);
  const [secret, setSecret] = useState<{ title: string; value: string | null } | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'rotate' | 'revoke'; key: ApiKey } | null>(null);

  return (
    <Card>
      <CardHeader title="API keys" subtitle="Authenticate server-to-server calls with Authorization: Bearer aix_sk_…"
        action={allowed && <Button variant="primary" size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setCreate(true)}>Create key</Button>} />
      {!allowed && <div className="px-5 pt-4"><NoPermission perm="developer.keys.manage" /></div>}
      {q.isLoading ? <div className="space-y-2 p-5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)}</div>
        : q.error ? <div className="p-5"><ErrorState error={q.error} onRetry={() => void q.mutate()} /></div>
          : !keys.length ? <div className="p-5"><EmptyState icon={<KeyRound className="h-5 w-5" />} title="No API keys yet" description="Create a sandbox key to start building. Production keys can move real IDLE Tokens." action={allowed && <Button variant="primary" onClick={() => setCreate(true)}>Create your first key</Button>} /></div>
            : (
              <Table head={['Name', 'Key', 'Environment', 'Scopes', 'Last used', 'Expires', '']}>
                {keys.map((k) => {
                  const revoked = !!k.revokedAt;
                  const full = PERMISSIONS.every((p) => k.scopes?.includes(p)) || k.scopes?.includes('*');
                  return (
                    <tr key={k.id} className={cn(revoked && 'opacity-50')}>
                      <Td className="font-medium">{k.name}</Td>
                      <Td><code className="font-mono text-xs text-fg-muted">{k.prefix ? `${k.prefix}…` : '••••'}</code></Td>
                      <Td><Badge tone={k.environment === 'production' ? 'gold' : 'electric'}>{k.environment}</Badge></Td>
                      <Td>{full ? <Badge tone="violet">Full access</Badge> : <span className="text-xs text-fg-muted" title={k.scopes?.join(', ')}>{k.scopes?.length ?? 0} scope{k.scopes?.length === 1 ? '' : 's'}</span>}</Td>
                      <Td className="text-xs text-fg-muted">{k.lastUsedAt ? fmtRelative(k.lastUsedAt) : 'Never'}</Td>
                      <Td className="text-xs text-fg-muted">{revoked ? <Badge tone="danger">Revoked</Badge> : k.expiresAt ? fmtDate(k.expiresAt) : 'Never'}</Td>
                      <Td className="text-right">
                        {allowed && !revoked && (
                          <div className="flex justify-end gap-1.5">
                            <Button size="sm" variant="ghost" icon={<RotateCw className="h-3.5 w-3.5" />} onClick={() => setConfirm({ kind: 'rotate', key: k })}>Rotate</Button>
                            <Button size="sm" variant="ghost" className="text-danger-soft" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setConfirm({ kind: 'revoke', key: k })}>Revoke</Button>
                          </div>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </Table>
            )}

      <CreateKeyModal open={create} onClose={() => setCreate(false)} onCreated={(res) => { setSecret({ title: 'Your new API key', value: extractSecret(res) }); void q.mutate(); }} />
      <SecretOnceModal open={!!secret} onClose={() => setSecret(null)} title={secret?.title ?? ''} secret={secret?.value ?? null} />
      <ConfirmModal open={confirm?.kind === 'rotate'} onClose={() => setConfirm(null)} tone="primary" confirmLabel="Rotate key"
        title={`Rotate “${confirm?.key.name}”?`} description="A new secret is issued and the old key stops working. Update every service that uses it."
        onConfirm={async () => { const res = await api.post(`/developer/keys/${confirm!.key.id}/rotate`); setSecret({ title: 'Rotated API key', value: extractSecret(res) }); void q.mutate(); }} />
      <ConfirmModal open={confirm?.kind === 'revoke'} onClose={() => setConfirm(null)} confirmLabel="Revoke key" successMessage="Key revoked"
        title={`Revoke “${confirm?.key.name}”?`} description="Requests using this key will be rejected immediately. This cannot be undone."
        onConfirm={async () => { await api.del(`/developer/keys/${confirm!.key.id}`); void q.mutate(); }} />
    </Card>
  );
}

function CreateKeyModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (res: unknown) => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [env, setEnv] = useState<'sandbox' | 'production'>('sandbox');
  const [full, setFull] = useState(false);
  const [scopes, setScopes] = useState<Permission[]>(['agents.read', 'training.read']);
  const [expires, setExpires] = useState('90');
  const [busy, setBusy] = useState(false);
  const toggle = (p: Permission) => setScopes((s) => (s.includes(p) ? s.filter((x) => x !== p) : [...s, p]));
  const reset = () => { setName(''); setEnv('sandbox'); setFull(false); setScopes(['agents.read', 'training.read']); setExpires('90'); };
  const submit = async () => {
    setBusy(true);
    try {
      const res = await api.post('/developer/keys', {
        name: name.trim(), environment: env, scopes: full ? [...PERMISSIONS] : scopes,
        ...(expires ? { expiresInDays: Number(expires) } : {}),
      });
      toast('success', 'API key created');
      reset(); onClose(); onCreated(res);
    } catch (e) { toast('danger', errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} size="lg" title="Create API key" description="Grant only the scopes your integration needs."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!name.trim() || (!full && !scopes.length)} onClick={submit}>Create key</Button></>}>
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="sm:col-span-1"><Field label="Name" htmlFor="key-name" required><Input id="key-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="CI pipeline" maxLength={80} /></Field></div>
          <Field label="Environment" htmlFor="key-env">
            <Select id="key-env" value={env} onChange={(e) => setEnv(e.target.value as 'sandbox' | 'production')}><option value="sandbox">Sandbox</option><option value="production">Production</option></Select>
          </Field>
          <Field label="Expires" htmlFor="key-exp">
            <Select id="key-exp" value={expires} onChange={(e) => setExpires(e.target.value)}>
              <option value="30">30 days</option><option value="90">90 days</option><option value="365">1 year</option><option value="">Never</option>
            </Select>
          </Field>
        </div>
        {env === 'production' && <p className="rounded-xl border border-gold/30 bg-gold/5 px-3 py-2 text-xs text-gold-soft">Production keys act on real IDLE wallets, agents and settlements.</p>}
        <Checkbox label={<span><span className="font-medium text-fg">Full access</span> — every current permission of your organisation role</span>} checked={full} onChange={setFull} />
        {!full && (
          <fieldset className="grid gap-3 sm:grid-cols-2">
            <legend className="mb-2 text-xs font-medium text-fg-muted">Scopes ({scopes.length} selected)</legend>
            {Object.entries(GROUPS).map(([g, perms]) => (
              <div key={g} className="rounded-xl border border-line bg-ink-950/40 p-3">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-fg-subtle">{g}</p>
                <div className="space-y-1.5">{perms.map((p) => <Checkbox key={p} label={<code className="font-mono text-xs">{p}</code>} checked={scopes.includes(p)} onChange={() => toggle(p)} />)}</div>
              </div>
            ))}
          </fieldset>
        )}
      </div>
    </Modal>
  );
}
