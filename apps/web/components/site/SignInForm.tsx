'use client';
import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { mutate } from 'swr';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ArrowLeft, Eye, EyeOff, KeyRound, LogIn } from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import { Alert, Button, Field, Input } from '@/components/ui';
import { safeNext } from './AuthShell';
import { stashWelcomeBonus, type WelcomeBonusGrant } from '@/lib/tokens';

type LoginRes = { user?: unknown; mfaRequired?: boolean; challengeId?: string; welcomeBonus?: WelcomeBonusGrant | null };

export function SignInForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get('next'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);
  const reduce = useReducedMotion();
  const anim = reduce ? {} : { initial: { opacity: 0, x: 24 }, animate: { opacity: 1, x: 0 }, exit: { opacity: 0, x: -24 }, transition: { duration: 0.3, ease: [0.2, 0.7, 0.2, 1] as const } };
  const errBox = <AnimatePresence>{err && <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden"><Alert tone="danger">{err}</Alert></motion.div>}</AnimatePresence>;

  const done = async () => { await mutate('/auth/me'); router.push(next); router.refresh(); };

  const login = async (e: FormEvent) => {
    e.preventDefault(); setErr(null);
    if (!email.trim() || !password) { setErr('Enter your email and password.'); return; }
    setBusy(true);
    try {
      const r = await api.post<LoginRes>('/auth/login', { email: email.trim(), password });
      if (r.mfaRequired && r.challengeId) { setChallenge(r.challengeId); setBusy(false); return; }
      stashWelcomeBonus(r.welcomeBonus);
      await done();
    } catch (x) { setErr(errorMessage(x)); setBusy(false); }
  };
  const verify = async (e: FormEvent) => {
    e.preventDefault(); setErr(null);
    if (!/^\d{6}$/.test(code.trim())) { setErr('Enter the 6-digit code from your authenticator app.'); return; }
    setBusy(true);
    try {
      const r = await api.post<LoginRes>('/auth/mfa/verify-login', { challengeId: challenge, code: code.trim() });
      stashWelcomeBonus(r?.welcomeBonus);
      await done();
    }
    catch (x) { setErr(errorMessage(x)); setBusy(false); }
  };

  return (
    <AnimatePresence mode="wait" initial={false}>
    {challenge ? (
      <motion.form key="mfa" {...anim} onSubmit={verify} className="space-y-5" noValidate>
        <div className="flex items-center gap-3"><span className="relative rounded-xl bg-electric/10 p-2.5 text-electric ring-1 ring-electric/30"><span aria-hidden className="aix-pulse-ring absolute inset-0 rounded-xl border border-electric/50" /><KeyRound className="h-5 w-5" aria-hidden /></span>
          <div><h2 className="font-semibold">Two-factor authentication</h2><p className="text-sm text-fg-muted">Enter the 6-digit code from your authenticator app.</p></div></div>
        {errBox}
        <Field label="Authentication code" htmlFor="mfa" required>
          <Input id="mfa" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} className="h-14 text-center font-mono text-2xl tracking-[0.6em]" />
        </Field>
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>Verify and sign in</Button>
        <div className="flex justify-center gap-1.5" aria-hidden>{Array.from({ length: 6 }).map((_, n) => <span key={n} className={`h-1 w-6 rounded-full transition-colors ${n < code.length ? 'bg-gold' : 'bg-ink-700'}`} />)}</div>
        <button type="button" onClick={() => { setChallenge(null); setCode(''); setErr(null); }} className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"><ArrowLeft className="h-4 w-4" aria-hidden /> Use a different account</button>
      </motion.form>
    ) : (
    <motion.form key="login" {...anim} onSubmit={login} className="space-y-5" noValidate>
      {errBox}
      <Field label="Email" htmlFor="email" required>
        <Input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" required />
      </Field>
      <Field label="Password" htmlFor="password" required>
        <div className="relative">
          <Input id="password" type={show ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required className="pr-10" />
          <button type="button" onClick={() => setShow((v) => !v)} aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show} className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-fg-subtle hover:text-fg">{show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button>
        </div>
      </Field>
      <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} icon={busy ? undefined : <LogIn className="h-4 w-4" />}>Sign In</Button>
      <p className="text-center text-sm text-fg-muted">New to StringMind? <Link href={`/register${next !== '/app' ? `?next=${encodeURIComponent(next)}` : ''}`} className="font-medium text-gold-soft hover:underline">Create an account</Link></p>
      <p className="text-center text-xs text-fg-subtle">Forgot your password? <Link href="/contact?topic=support" className="underline hover:text-fg-muted">Contact support</Link></p>
    </motion.form>
    )}
    </AnimatePresence>
  );
}
