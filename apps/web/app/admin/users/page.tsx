'use client';
import { useState } from 'react';
import { Avatar, Button, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ConfirmModal } from '@/components/training/ConfirmModal';
import { AdminHeader, DataCard, SearchBox, StatusBadge, useRevalidate, when, type Row } from '@/components/admin/kit';

export default function AdminUsersPage() {
  const { me } = useSession();
  const superAdmin = me?.user.platformRole === 'super_admin';
  const [q, setQ] = useState('');
  const [target, setTarget] = useState<{ u: Row; patch: Record<string, string>; label: string } | null>(null);
  const revalidate = useRevalidate();
  return (
    <div>
      <AdminHeader title="Users" description="Suspend or reactivate accounts. Only super admins can change platform roles." actions={<SearchBox value={q} onChange={setQ} placeholder="Search name or email" />} />
      <DataCard title="All users" path={`/admin/users?q=${encodeURIComponent(q)}`} empty="No users match"
        columns={[
          { header: 'User', cell: (u) => <div className="flex items-center gap-2.5"><Avatar name={u.name ?? u.email} size={30} className="rounded-full" /><div><p className="font-medium">{u.name}</p><p className="text-xs text-fg-muted">{u.email}</p></div></div> },
          { header: 'Status', cell: (u) => <StatusBadge value={u.status} /> },
          {
            header: 'Platform role', cell: (u) => superAdmin && u.id !== me?.user.id ? (
              <Select aria-label="Platform role" className="h-8 w-36 text-xs" value={u.platformRole} onChange={(e) => setTarget({ u, patch: { platformRole: e.target.value }, label: `Change role to ${e.target.value}` })}>
                <option value="user">user</option><option value="admin">admin</option><option value="super_admin">super_admin</option>
              </Select>) : <StatusBadge value={u.platformRole} />,
          },
          { header: 'MFA', cell: (u) => <StatusBadge value={u.mfaEnabled ? 'enabled' : 'off'} /> },
          { header: 'Last login', cell: (u) => when(u.lastLoginAt) },
          { header: 'Joined', cell: (u) => when(u.createdAt) },
          {
            header: '', cell: (u) => u.id === me?.user.id ? null : u.status === 'suspended'
              ? <Button size="sm" variant="outline" onClick={() => setTarget({ u, patch: { status: 'active' }, label: 'Reactivate user' })}>Reactivate</Button>
              : <Button size="sm" variant="ghost" className="text-danger-soft" onClick={() => setTarget({ u, patch: { status: 'suspended' }, label: 'Suspend user' })}>Suspend</Button>,
          },
        ]} />
      <ConfirmModal open={!!target} onClose={() => setTarget(null)} title={`${target?.label ?? ''}?`} description={target?.u.email} confirmLabel={target?.label ?? 'Confirm'}
        tone={target?.patch.status === 'suspended' ? 'danger' : 'primary'} successMessage="User updated"
        onConfirm={async () => { await api.patch(`/admin/users/${target!.u.id}`, target!.patch); await revalidate('/admin/users'); }} />
    </div>
  );
}
