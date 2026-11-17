'use client';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { KeyRound, LogOut, Monitor, ShieldCheck, ShieldOff, Trash2, User } from 'lucide-react';
import { Alert, Badge, Button, ErrorState, Field, Input, Modal, PageHeader, Tabs, fmtDateTime } from '@/components/ui';
import { api, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { encodeQr, qrToSvgPath } from '@/components/app/qr';
import { ListSkeleton, Section, useAction } from '@/components/app/primitives';
import { listOf, type Paged } from '@/components/app/types';

interface SessionRow { id: string; userAgent?: string | null; ip?: string | null; createdAt: string; lastSeenAt?: string | null; expiresAt?: string | null; current?: boolean }
type TabKey = 'profile' | 'security' | 'sessions' | 'danger';

export default function SettingsPage() {
  const [tab, setTab] = useState<TabKey>('profile');
  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description="Your profile, password, two-factor authentication and sessions." />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'profile', label: 'Profile' }, { value: 'security', label: 'Password & MFA' }, { value: 'sessions', label: 'Active sessions' }, { value: 'danger', label: 'Delete account' }]} />
      <div className="max-w-3xl space-y-6">
        {tab === 'profile' && <Profile />}
        {tab === 'security' && <><Password /><Mfa /></>}
        {tab === 'sessions' && <Sessions />}
        {tab === 'danger' && <DeleteAccount />}
      </div>
    </div>
  );
}

function Profile() {
  const { me, refresh } = useSession();
  const [name, setName] = useState(me?.user.name ?? '');
  const [avatarUrl, setAvatarUrl] = useState('');
  const { busy, run } = useAction();
  return (
    <Section title="Profile" action={<User className="h-4 w-4 text-fg-subtle" aria-hidden />}>
      <form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); const r = await run('p', () => api.patch('/auth/me', { name: name.trim(), ...(avatarUrl.trim() ? { avatarUrl: avatarUrl.trim() } : {}) }), 'Profile updated'); if (r !== undefined) refresh(); }}>
        <Field label="Email" htmlFor="em" hint="Contact support to change your email."><Input id="em" value={me?.user.email ?? ''} disabled /></Field>
        <Field label="Full name" htmlFor="nm" required><Input id="nm" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} /></Field>
        <Field label="Avatar URL (optional)" htmlFor="av"><Input id="av" type="url" value={avatarUrl} onChange={(e) => setAvatarUrl(e.target.value)} placeholder="https://…" /></Field>
        <Button type="submit" variant="primary" loading={busy === 'p'} disabled={name.trim().length < 2}>Save profile</Button>
      </form>
    </Section>
  );
}

const pwIssues = (pw: string) => [pw.length < 10 && 'at least 10 characters', !/[a-z]/.test(pw) && 'a lowercase letter', !/[A-Z]/.test(pw) && 'an uppercase letter', !/\d/.test(pw) && 'a number'].filter(Boolean) as string[];

function Password() {
  const [f, setF] = useState({ current: '', next: '', confirm: '' });
  const { busy, run } = useAction();
  const issues = f.next ? pwIssues(f.next) : [];
  const mismatch = !!f.confirm && f.confirm !== f.next;
  const valid = f.current && f.next && !issues.length && f.confirm === f.next;
  return (
    <Section title="Change password" action={<KeyRound className="h-4 w-4 text-fg-subtle" aria-hidden />}>
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={async (e) => { e.preventDefault(); if (!valid) return; const r = await run('pw', () => api.post('/auth/password', { currentPassword: f.current, newPassword: f.next }), 'Password changed'); if (r !== undefined) setF({ current: '', next: '', confirm: '' }); }}>
        <div className="sm:col-span-2"><Field label="Current password" htmlFor="cp"><Input id="cp" type="password" autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} /></Field></div>
        <Field label="New password" htmlFor="np" error={issues.length ? `Needs ${issues.join(', ')}` : undefined}><Input id="np" type="password" autoComplete="new-password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} /></Field>
        <Field label="Confirm new password" htmlFor="cf" error={mismatch ? 'Passwords do not match' : undefined}><Input id="cf" type="password" autoComplete="new-password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} /></Field>
        <div className="sm:col-span-2"><Button type="submit" variant="primary" loading={busy === 'pw'} disabled={!valid}>Update password</Button></div>
      </form>
    </Section>
  );
}

function QrSvg({ text }: { text: string }) {
  const qr = useMemo(() => { try { return qrToSvgPath(encodeQr(text, 'M')); } catch { return null; } }, [text]);
  if (!qr) return null;
  return (
    <svg viewBox={`0 0 ${qr.viewBox} ${qr.viewBox}`} width={192} height={192} role="img" aria-label="QR code for your authenticator app" shapeRendering="crispEdges" className="rounded-xl">
      <rect width="100%" height="100%" fill="#fff" /><path d={qr.path} fill="#000" />
    </svg>
  );
}

function Mfa() {
  const { me, refresh } = useSession();
  const enabled = !!me?.user.mfaEnabled;
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [disableOpen, setDisableOpen] = useState(false);
  const { busy, run } = useAction();
  const codeOk = /^\d{6}$/.test(code);
  return (
    <Section title="Two-factor authentication" action={enabled ? <Badge tone="success" icon={<ShieldCheck className="h-3 w-3" />}>Enabled</Badge> : <Badge tone="warning">Off</Badge>}>
      {enabled ? (
        <div className="space-y-3">
          <p className="text-sm text-fg-muted">Sign-ins require a 6-digit code from your authenticator app.</p>
          <Button variant="outline" icon={<ShieldOff className="h-4 w-4" />} onClick={() => { setCode(''); setDisableOpen(true); }}>Disable MFA</Button>
        </div>
      ) : !setup ? (
        <div className="space-y-3">
          <p className="text-sm text-fg-muted">Protect your account and wallet with a time-based one-time password (TOTP) app such as Google Authenticator, 1Password or Authy.</p>
          <Button variant="primary" loading={busy === 'setup'} onClick={async () => { const r = await run('setup', () => api.post<{ secret: string; otpauthUrl: string }>('/auth/mfa/setup')); if (r) setSetup(r); }}>Set up MFA</Button>
        </div>
      ) : (
        <div className="grid gap-5 sm:grid-cols-[auto_1fr]">
          <div className="flex justify-center"><QrSvg text={setup.otpauthUrl} /></div>
          <div className="min-w-0 space-y-3 text-sm">
            <p className="text-fg-muted">1. Scan the QR code with your authenticator app. Can&apos;t scan? Enter the secret manually or open the link on this device.</p>
            <div><p className="text-xs text-fg-subtle">Secret</p><code className="block break-all rounded-lg bg-ink-950 px-3 py-2 font-mono text-xs text-gold-soft">{setup.secret}</code></div>
            <a href={setup.otpauthUrl} className="inline-block break-all text-xs text-electric-soft underline">Open in authenticator app</a>
            <form className="space-y-2" onSubmit={async (e) => { e.preventDefault(); if (!codeOk) return; const r = await run('en', () => api.post('/auth/mfa/enable', { code }), 'Two-factor authentication enabled'); if (r !== undefined) { setSetup(null); setCode(''); refresh(); } }}>
              <Field label="2. Enter the 6-digit code" htmlFor="code"><Input id="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} className="w-40 font-mono tracking-widest" /></Field>
              <div className="flex gap-2"><Button type="submit" variant="primary" loading={busy === 'en'} disabled={!codeOk}>Verify &amp; enable</Button><Button type="button" variant="ghost" onClick={() => setSetup(null)}>Cancel</Button></div>
            </form>
          </div>
        </div>
      )}
      <Modal open={disableOpen} onClose={() => setDisableOpen(false)} title="Disable two-factor authentication" size="sm"
        footer={<><Button variant="ghost" onClick={() => setDisableOpen(false)}>Cancel</Button><Button variant="danger" disabled={!codeOk} loading={busy === 'dis'} onClick={async () => { const r = await run('dis', () => api.post('/auth/mfa/disable', { code }), 'MFA disabled'); if (r !== undefined) { setDisableOpen(false); refresh(); } }}>Disable</Button></>}>
        <Field label="Current 6-digit code" htmlFor="dcode"><Input id="dcode" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} className="font-mono tracking-widest" /></Field>
      </Modal>
    </Section>
  );
}

function Sessions() {
  const { data, error, isLoading, mutate } = useApi<Paged<SessionRow> | SessionRow[]>('/auth/sessions');
  const items = listOf(data);
  const { busy, run } = useAction();
  if (isLoading) return <ListSkeleton />;
  if (error) return <ErrorState error={error} onRetry={() => mutate()} />;
  return (
    <Section title="Active sessions" subtitle="Revoke any session you don't recognise.">
      {!items.length ? <p className="text-sm text-fg-subtle">No active sessions.</p> : (
        <ul className="divide-y divide-line/50">
          {items.map((s) => (
            <li key={s.id} className="flex items-center gap-3 py-3">
              <Monitor className="h-5 w-5 shrink-0 text-fg-subtle" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{s.userAgent ?? 'Unknown device'} {s.current && <Badge tone="success">This device</Badge>}</p>
                <p className="text-[11px] text-fg-subtle">{s.ip ?? 'Unknown IP'} · Signed in {fmtDateTime(s.createdAt)}{s.lastSeenAt ? ` · Last active ${fmtDateTime(s.lastSeenAt)}` : ''}</p>
              </div>
              {!s.current && <Button size="sm" variant="outline" loading={busy === s.id} icon={<LogOut className="h-3.5 w-3.5" />} onClick={async () => { await run(s.id, () => api.del(`/auth/sessions/${s.id}`), 'Session revoked'); mutate(); }}>Revoke</Button>}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function DeleteAccount() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const { busy, run } = useAction();
  return (
    <Section title="Delete account">
      <Alert tone="danger" title="This is permanent">Your account is scheduled for deletion and personal data is anonymised. Organisations you solely own, their agents and wallet balances may become inaccessible. Unspent IDLE Tokens in wallets you solely own are forfeited.</Alert>
      <Button className="mt-4" variant="danger" icon={<Trash2 className="h-4 w-4" />} onClick={() => setOpen(true)}>Delete my account</Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Delete your Hive Mind account?" size="sm"
        footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button variant="danger" disabled={!pw || confirm !== 'DELETE'} loading={busy === 'del'}
          onClick={async () => { const r = await run('del', () => api.post('/auth/delete-account', { password: pw }), 'Account scheduled for deletion'); if (r !== undefined) router.push('/sign-in'); }}>Delete account</Button></>}>
        <div className="space-y-4">
          <Field label="Password" htmlFor="dpw"><Input id="dpw" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
          <Field label='Type "DELETE" to confirm' htmlFor="dconf"><Input id="dconf" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
        </div>
      </Modal>
    </Section>
  );
}
