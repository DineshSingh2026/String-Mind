'use client';
import { useState } from 'react';
import { Badge, Button, Input } from '@/components/ui';
import { AdminHeader, DataCard, Val, mono, nameOf, when } from '@/components/admin/kit';

export default function AdminAuditPage() {
  const [action, setAction] = useState('');
  const [actor, setActor] = useState('');
  const [applied, setApplied] = useState({ action: '', actor: '' });
  return (
    <div>
      <AdminHeader title="Audit logs" description="Append-only record of security-relevant and administrative actions." />
      <form className="mb-4 flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); setApplied({ action: action.trim(), actor: actor.trim() }); }}>
        <Input aria-label="Action" placeholder="Action, e.g. admin.agent.suspend" value={action} onChange={(e) => setAction(e.target.value)} className="sm:max-w-xs" />
        <Input aria-label="Actor" placeholder="Actor user ID or email" value={actor} onChange={(e) => setActor(e.target.value)} className="sm:max-w-xs" />
        <Button type="submit" variant="outline">Apply filters</Button>
        {(applied.action || applied.actor) && <Button type="button" variant="ghost" onClick={() => { setAction(''); setActor(''); setApplied({ action: '', actor: '' }); }}>Clear</Button>}
      </form>
      <DataCard title="Events" path={`/admin/audit?action=${encodeURIComponent(applied.action)}&actor=${encodeURIComponent(applied.actor)}`} empty="No audit events match" columns={[
        { header: 'Time', cell: (r) => when(r.createdAt) },
        { header: 'Action', cell: (r) => <code className="font-mono text-xs text-electric-soft">{r.action}</code> },
        { header: 'Actor', cell: (r) => <div><Badge>{r.actorType}</Badge> <span className="text-xs">{nameOf(r, 'actor', 'actorEmail') !== '—' ? nameOf(r, 'actor', 'actorEmail') : mono(r.actorUserId)}</span></div> },
        { header: 'Target', cell: (r) => <span className="text-xs">{r.targetType ?? '—'} {mono(r.targetId)}</span> },
        { header: 'IP', cell: (r) => <code className="font-mono text-xs text-fg-muted">{r.ip ?? '—'}</code> },
        { header: 'Metadata', cell: (r) => <Val v={r.metadata} /> },
      ]} />
    </div>
  );
}
