'use client';
import { useState } from 'react';
import { Building2, Plus, Shield, Trash2, UserPlus } from 'lucide-react';
import { ORG_ROLES, type OrgRole } from '@aix/shared';
import { Alert, Avatar, Badge, Button, EmptyState, ErrorState, Field, Input, Modal, PageHeader, Select, Skeleton, Table, Tabs, Td, Toggle, fmtDate, fmtDateTime, fmtNumber } from '@/components/ui';
import { api, useApi } from '@/lib/api';
import { switchOrg, useSession } from '@/lib/session';
import { ConfirmModal, KV, ListSkeleton, Pagination, Section, titleCase, useAction } from '@/components/app/primitives';
import { listOf, type Paged } from '@/components/app/types';

/* Assumed: GET /orgs/current → { id, name, slug, type, plan, privateNetwork, memberCount, createdAt } (may also nest as { org, plan, memberCount }). */
interface OrgCurrent { id: string; name: string; slug?: string; type: string; plan?: string | { name?: string; slug?: string }; privateNetwork?: boolean; memberCount?: number; createdAt?: string; org?: Omit<OrgCurrent, 'org'> }
interface Member { userId: string; name: string; email: string; role: OrgRole; createdAt: string }
interface AuditRow { id: string; action: string; actor?: { name?: string; email?: string } | null; actorName?: string; targetType?: string | null; targetId?: string | null; ip?: string | null; createdAt: string; metadata?: unknown }

type TabKey = 'details' | 'members' | 'audit';

export default function OrganisationPage() {
  const { can } = useSession();
  const [tab, setTab] = useState<TabKey>('details');
  const [create, setCreate] = useState(false);
  const tabs: { value: TabKey; label: string }[] = [{ value: 'details', label: 'Details' }, { value: 'members', label: 'Members & roles' }, ...(can('audit.read') ? [{ value: 'audit' as const, label: 'Audit log' }] : [])];
  return (
    <div className="space-y-6">
      <PageHeader title="Organisation" description="Manage your organisation, members and access." actions={<Button variant="outline" icon={<Plus className="h-4 w-4" />} onClick={() => setCreate(true)}>Create enterprise org</Button>} />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'details' && <Details />}
      {tab === 'members' && <Members />}
      {tab === 'audit' && <Audit />}
      <CreateOrgModal open={create} onClose={() => setCreate(false)} />
    </div>
  );
}

function Details() {
  const { me, can } = useSession();
  const { data, error, isLoading, mutate } = useApi<OrgCurrent>('/orgs/current');
  const [name, setName] = useState<string | null>(null);
  const { busy, run } = useAction();
  if (isLoading) return <Skeleton className="h-64 rounded-2xl" />;
  if (error || !data) return <ErrorState error={error ?? 'Not found'} onRetry={() => mutate()} />;
  const org = { ...data, ...(data.org ?? {}) };
  const plan = typeof data.plan === 'string' ? data.plan : data.plan?.name ?? data.plan?.slug ?? org.plan;
  const manage = can('org.manage');
  const save = async (patch: Record<string, unknown>, msg: string) => { await run('save', () => api.patch('/orgs/current', patch), msg); mutate(); };
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Section title="Organisation details">
        <div className="space-y-4">
          <Field label="Name" htmlFor="on">
            <div className="flex gap-2"><Input id="on" disabled={!manage} value={name ?? org.name} onChange={(e) => setName(e.target.value)} />
              {manage && <Button variant="primary" loading={busy === 'save'} disabled={!name || name === org.name} onClick={() => save({ name }, 'Organisation renamed')}>Save</Button>}</div>
          </Field>
          <dl className="divide-y divide-line/50">
            <KV k="Type" v={titleCase(org.type)} />
            <KV k="Plan" v={<Badge tone="gold">{titleCase(typeof plan === 'string' ? plan : '—')}</Badge>} />
            <KV k="Members" v={fmtNumber(data.memberCount ?? null)} />
            <KV k="Created" v={fmtDate(org.createdAt)} />
            <KV k="Your role" v={titleCase(me?.role)} />
          </dl>
          <div className="flex items-center justify-between gap-4 rounded-xl border border-line/70 p-3">
            <div><p className="flex items-center gap-1.5 text-sm font-medium"><Shield className="h-4 w-4 text-electric" aria-hidden />Private network</p><p className="text-xs text-fg-muted">Restrict training and knowledge sharing to agents inside your organisation.</p></div>
            <Toggle label="Private network" checked={!!org.privateNetwork} disabled={!manage || busy === 'save'} onChange={(v) => save({ privateNetwork: v }, v ? 'Private network enabled' : 'Private network disabled')} />
          </div>
        </div>
      </Section>
      <Section title="Your organisations">
        <ul className="divide-y divide-line/50">
          {me?.orgs.map((o) => (
            <li key={o.id} className="flex items-center gap-3 py-2.5">
              <Building2 className="h-4 w-4 text-fg-subtle" aria-hidden />
              <span className="min-w-0 flex-1"><span className="block truncate text-sm">{o.name}</span><span className="text-[11px] text-fg-subtle">{titleCase(o.type)} · {titleCase(o.role)}</span></span>
              {o.id === me.org?.id ? <Badge tone="success">Current</Badge> : <Button size="sm" variant="outline" onClick={() => switchOrg(o.id)}>Switch</Button>}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

function Members() {
  const { me, can } = useSession();
  const manage = can('org.members.manage');
  const { data, error, isLoading, mutate } = useApi<Member[] | Paged<Member>>('/orgs/current/members');
  const members = listOf(data);
  const [invite, setInvite] = useState({ email: '', role: 'member' as OrgRole });
  const [remove, setRemove] = useState<Member | null>(null);
  const { busy, run } = useAction();
  return (
    <div className="space-y-4">
      {manage && (
        <Section title="Add member" subtitle="The person must already have an Hive Mind account.">
          <form className="flex flex-col gap-2 sm:flex-row" onSubmit={async (e) => { e.preventDefault(); const r = await run('add', () => api.post('/orgs/current/members', invite), 'Member added'); if (r !== undefined) { setInvite({ email: '', role: 'member' }); mutate(); } }}>
            <Input type="email" required aria-label="Email" placeholder="colleague@company.com" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} />
            <Select aria-label="Role" value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value as OrgRole })} className="sm:w-40">{ORG_ROLES.filter((r) => r !== 'owner').map((r) => <option key={r} value={r}>{titleCase(r)}</option>)}</Select>
            <Button type="submit" variant="primary" loading={busy === 'add'} icon={<UserPlus className="h-4 w-4" />}>Add</Button>
          </form>
        </Section>
      )}
      {isLoading ? <ListSkeleton /> : error ? <ErrorState error={error} onRetry={() => mutate()} /> : !members.length ? <EmptyState title="No members" /> : (
        <div className="card"><Table head={['Member', 'Role', 'Joined', '']}>
          {members.map((m) => {
            const self = m.userId === me?.user.id;
            return (
              <tr key={m.userId}>
                <Td><div className="flex items-center gap-3"><Avatar name={m.name} size={32} className="rounded-full" /><div className="min-w-0"><p className="truncate font-medium">{m.name}{self && <span className="text-fg-subtle"> (you)</span>}</p><p className="truncate text-xs text-fg-subtle">{m.email}</p></div></div></Td>
                <Td>{manage && !self && m.role !== 'owner' ? (
                  <Select aria-label={`Role for ${m.name}`} value={m.role} className="h-9 w-36 text-xs" disabled={busy === m.userId}
                    onChange={async (e) => { await run(m.userId, () => api.patch(`/orgs/current/members/${m.userId}`, { role: e.target.value }), 'Role updated'); mutate(); }}>
                    {ORG_ROLES.filter((r) => r !== 'owner').map((r) => <option key={r} value={r}>{titleCase(r)}</option>)}
                  </Select>) : <Badge tone={m.role === 'owner' ? 'gold' : 'neutral'}>{titleCase(m.role)}</Badge>}</Td>
                <Td className="text-fg-muted">{fmtDate(m.createdAt)}</Td>
                <Td>{manage && !self && m.role !== 'owner' && <button aria-label={`Remove ${m.name}`} className="rounded-lg p-1.5 text-fg-muted hover:text-danger" onClick={() => setRemove(m)}><Trash2 className="h-4 w-4" /></button>}</Td>
              </tr>
            );
          })}
        </Table></div>
      )}
      <ConfirmModal open={!!remove} onClose={() => setRemove(null)} title={`Remove ${remove?.name}?`} danger confirmLabel="Remove" loading={busy === 'rm'} description="They lose access to this organisation's agents, wallet and data."
        onConfirm={async () => { await run('rm', () => api.del(`/orgs/current/members/${remove!.userId}`), 'Member removed'); setRemove(null); mutate(); }} />
    </div>
  );
}

function Audit() {
  const [page, setPage] = useState(1);
  const { data, error, isLoading, mutate } = useApi<Paged<AuditRow>>(`/orgs/current/audit?page=${page}`);
  if (isLoading) return <ListSkeleton />;
  if (error) return <ErrorState error={error} onRetry={() => mutate()} />;
  const items = listOf(data);
  if (!items.length) return <EmptyState title="No audit events" />;
  return (
    <div className="card">
      <Table head={['When', 'Actor', 'Action', 'Target', 'IP']}>
        {items.map((r) => <tr key={r.id}><Td className="whitespace-nowrap text-fg-muted">{fmtDateTime(r.createdAt)}</Td><Td>{r.actor?.name ?? r.actorName ?? r.actor?.email ?? 'System'}</Td><Td><code className="text-xs text-electric-soft">{r.action}</code></Td><Td className="text-xs text-fg-muted">{r.targetType ? `${r.targetType}${r.targetId ? ` · ${r.targetId.slice(0, 8)}` : ''}` : '—'}</Td><Td className="text-xs text-fg-subtle">{r.ip ?? '—'}</Td></tr>)}
      </Table>
      {data && <div className="px-4 pb-4"><Pagination page={data.page ?? page} pageSize={data.pageSize ?? 20} total={data.total ?? items.length} onChange={setPage} /></div>}
    </div>
  );
}

function CreateOrgModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  const { busy, run } = useAction();
  const submit = async () => {
    const r = await run('org', () => api.post<{ id?: string; org?: { id: string } }>('/orgs', { name, type: 'enterprise' }), 'Enterprise organisation created');
    const id = r?.id ?? r?.org?.id;
    if (id) switchOrg(id);
  };
  return (
    <Modal open={open} onClose={onClose} title="Create enterprise organisation" description="You'll be the owner. It gets its own wallet, agents and private network."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={name.trim().length < 2} loading={busy === 'org'} onClick={submit}>Create &amp; switch</Button></>}>
      <Field label="Organisation name" htmlFor="newOrg" required><Input id="newOrg" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <div className="mt-3"><Alert tone="info">Switching reloads the app in the new organisation context.</Alert></div>
    </Modal>
  );
}
