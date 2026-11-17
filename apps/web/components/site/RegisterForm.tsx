'use client';
import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { mutate } from 'swr';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ArrowLeft, ArrowRight, Bot, Building2, Check, Code2, Eye, EyeOff, GraduationCap, User, X, type LucideIcon } from 'lucide-react';
import { PERSONAS, type Persona } from '@aix/shared';
import { api, errorMessage } from '@/lib/api';
import { Alert, Button, Checkbox, Field, Input } from '@/components/ui';
import { safeNext } from './AuthShell';
import { cx } from './primitives';
import { stashWelcomeBonus, type WelcomeBonusGrant } from '@/lib/tokens';

const PERSONA_CARDS: Record<Persona, { label: string; body: string; icon: LucideIcon }> = {
  individual: { label: 'Individual', body: 'Explore agents and knowledge', icon: User },
  agent_owner: { label: 'Agent Owner', body: 'Connect, assess and train agents', icon: Bot },
  developer: { label: 'Developer', body: 'Build with the API & webhooks', icon: Code2 },
  trainer: { label: 'Trainer', body: 'Earn from expert agents', icon: GraduationCap },
  enterprise: { label: 'Enterprise', body: 'Team, RBAC & private network', icon: Building2 },
};

const RULES = [
  { test: (p: string) => p.length >= 10, label: 'At least 10 characters' },
  { test: (p: string) => /[a-z]/.test(p) && /[A-Z]/.test(p), label: 'Upper and lower case letters' },
  { test: (p: string) => /\d/.test(p), label: 'At least one number' },
  { test: (p: string) => /[^A-Za-z0-9]/.test(p), label: 'A symbol (recommended)', optional: true },
];
const STRENGTH = [
  { l: 'Weak', c: 'rgb(var(--danger))' }, { l: 'Weak', c: 'rgb(var(--danger))' }, { l: 'Fair', c: 'rgb(var(--warning))' },
  { l: 'Good', c: 'rgb(var(--success))' }, { l: 'Strong', c: 'rgb(var(--success))' },
];

export function RegisterForm() {
  const router = useRouter();
  const params = useSearchParams();
  const reduce = useReducedMotion();
  const initial = params.get('persona');
  const preset = (PERSONAS as readonly string[]).includes(initial ?? '');
  const [persona, setPersona] = useState<Persona>(preset ? (initial as Persona) : 'agent_owner');
  const [step, setStep] = useState<1 | 2>(preset ? 2 : 1);
  const [dir, setDir] = useState(1);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [orgName, setOrgName] = useState('');
  const [terms, setTerms] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const passed = RULES.filter((r) => r.test(password)).length;
  const st = STRENGTH[passed];
  const go = (s: 1 | 2) => { setDir(s > step ? 1 : -1); setStep(s); setErr(null); };

  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(null);
    if (step === 1) { go(2); return; }
    const v: Record<string, string> = {};
    if (name.trim().length < 2) v.name = 'Enter your full name.';
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) v.email = 'Enter a valid email address.';
    if (!RULES.filter((r) => !r.optional).every((r) => r.test(password))) v.password = 'Password must be 10+ characters with upper, lower case and a number.';
    if (persona === 'enterprise' && orgName.trim().length < 2) v.orgName = 'Enter your organisation name.';
    if (!terms) v.terms = 'Please accept the terms to continue.';
    setErrors(v);
    if (Object.keys(v).length) return;
    setBusy(true);
    try {
      const r = await api.post<{ welcomeBonus?: WelcomeBonusGrant | null }>('/auth/register', { name: name.trim(), email: email.trim(), password, persona, ...(persona === 'enterprise' ? { orgName: orgName.trim() } : {}) });
      stashWelcomeBonus(r?.welcomeBonus);
      await mutate('/auth/me');
      router.push(safeNext(params.get('next')));
      router.refresh();
    } catch (x) { setErr(errorMessage(x)); setBusy(false); }
  };

  const slide = reduce ? {} : {
    initial: { opacity: 0, x: 28 * dir }, animate: { opacity: 1, x: 0 }, exit: { opacity: 0, x: -28 * dir },
    transition: { duration: 0.3, ease: [0.2, 0.7, 0.2, 1] as const },
  };
  const P = PERSONA_CARDS[persona];

  return (
    <form onSubmit={submit} className="space-y-6" noValidate>
      {/* step indicator */}
      <ol className="flex items-center gap-3 text-xs" aria-label="Sign-up progress">
        {[['1', 'Your role'], ['2', 'Your details']].map(([n, l], i) => {
          const on = step === i + 1; const done = step > i + 1;
          return (
            <li key={n} className="flex flex-1 items-center gap-2" aria-current={on ? 'step' : undefined}>
              <span className={cx('inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border font-semibold transition', on ? 'border-gold bg-gold text-ink-950' : done ? 'border-success/60 bg-success/15 text-success' : 'border-line text-fg-subtle')}>{done ? <Check aria-hidden className="h-3.5 w-3.5" /> : n}</span>
              <span className={on ? 'font-medium text-fg' : 'text-fg-subtle'}>{l}</span>
              {i === 0 && <span aria-hidden className="relative h-px flex-1 overflow-hidden bg-line"><motion.span className="absolute inset-y-0 left-0 bg-gold" animate={{ width: step > 1 ? '100%' : '0%' }} transition={{ duration: 0.4 }} /></span>}
            </li>
          );
        })}
      </ol>

      <AnimatePresence>{err && <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden"><Alert tone="danger" title="Couldn’t create your account">{err}</Alert></motion.div>}</AnimatePresence>

      <AnimatePresence mode="wait" initial={false}>
        {step === 1 ? (
          <motion.fieldset key="s1" {...slide}>
            <legend className="text-xs font-medium text-fg-muted">I’m joining as <span className="text-gold">*</span></legend>
            <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3" role="radiogroup">
              {PERSONAS.map((p) => {
                const c = PERSONA_CARDS[p]; const Icon = c.icon; const on = persona === p;
                return (
                  <label key={p} className={cx('relative flex cursor-pointer flex-col rounded-2xl border p-3.5 transition focus-within:shadow-focus', on ? 'border-transparent' : 'border-line hover:border-ink-600 hover:bg-ink-850')}>
                    {on && <motion.span layoutId="persona-on" className="absolute inset-0 rounded-2xl border border-gold/60 bg-gold/[0.08] shadow-[0_0_28px_-10px_rgb(var(--gold)/0.8)]" transition={{ type: 'spring', stiffness: 450, damping: 34 }} />}
                    <input type="radio" name="persona" value={p} checked={on} onChange={() => setPersona(p)} className="sr-only" />
                    <Icon aria-hidden className={cx('relative h-5 w-5 transition', on ? 'text-gold' : 'text-fg-muted')} />
                    <span className="relative mt-2.5 text-sm font-medium text-fg">{c.label}</span>
                    <span className="relative mt-0.5 text-[11px] leading-snug text-fg-subtle">{c.body}</span>
                    {on && <Check aria-hidden className="absolute right-3 top-3 h-4 w-4 text-gold" />}
                  </label>
                );
              })}
            </div>
            <Button type="submit" variant="primary" size="lg" className="mt-6 w-full">Continue <ArrowRight className="h-4 w-4" /></Button>
          </motion.fieldset>
        ) : (
          <motion.div key="s2" {...slide} className="space-y-5">
            <button type="button" onClick={() => go(1)} className="group flex w-full items-center gap-3 rounded-2xl border border-line/70 bg-ink-950/40 p-3 text-left transition hover:border-ink-600">
              <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-gold/10 text-gold ring-1 ring-gold/30"><P.icon aria-hidden className="h-4 w-4" /></span>
              <span className="flex-1"><span className="block text-[11px] text-fg-subtle">Joining as</span><span className="text-sm font-medium">{P.label}</span></span>
              <span className="inline-flex items-center gap-1 text-xs text-fg-muted group-hover:text-fg"><ArrowLeft aria-hidden className="h-3.5 w-3.5" />Change</span>
            </button>
            {persona === 'enterprise' && (
              <Field label="Organisation name" htmlFor="org" required error={errors.orgName}>
                <Input id="org" value={orgName} onChange={(e) => setOrgName(e.target.value)} autoComplete="organization" aria-invalid={!!errors.orgName} />
              </Field>
            )}
            <Field label="Full name" htmlFor="name" required error={errors.name}>
              <Input id="name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" aria-invalid={!!errors.name} />
            </Field>
            <Field label="Work email" htmlFor="email" required error={errors.email}>
              <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" aria-invalid={!!errors.email} />
            </Field>
            <Field label="Password" htmlFor="password" required error={errors.password}>
              <div className="relative">
                <Input id="password" type={show ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" aria-invalid={!!errors.password} aria-describedby="pw-rules" className="pr-10" />
                <button type="button" onClick={() => setShow((v) => !v)} aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show} className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-fg-subtle hover:text-fg">{show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button>
              </div>
            </Field>
            <div id="pw-rules" className="-mt-2 space-y-2.5">
              <div className="flex items-center gap-3">
                <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-ink-700" aria-hidden>
                  <motion.div className="absolute inset-y-0 left-0 rounded-full" animate={{ width: `${(passed / RULES.length) * 100}%`, backgroundColor: st.c }}
                    style={{ boxShadow: password ? `0 0 12px ${st.c}` : 'none' }} transition={{ type: 'spring', stiffness: 220, damping: 26 }} />
                </div>
                <AnimatePresence mode="wait">{password && <motion.span key={st.l} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} className="w-12 text-right text-xs font-medium" style={{ color: st.c }} aria-live="polite">{st.l}</motion.span>}</AnimatePresence>
              </div>
              <ul className="grid gap-1 sm:grid-cols-2">
                {RULES.map((r) => {
                  const ok = r.test(password);
                  return <li key={r.label} className={cx('flex items-center gap-1.5 text-xs transition-colors', ok ? 'text-success-soft' : 'text-fg-subtle')}>
                    <motion.span animate={{ scale: ok ? [1, 1.35, 1] : 1 }} transition={{ duration: 0.3 }} className="inline-flex">{ok ? <Check aria-hidden className="h-3.5 w-3.5" /> : <X aria-hidden className="h-3.5 w-3.5" />}</motion.span>
                    {r.label}<span className="sr-only">{ok ? ' — met' : ' — not met'}</span></li>;
                })}
              </ul>
            </div>
            <div>
              <Checkbox checked={terms} onChange={setTerms} label={<>I agree to the StringMind platform terms and acceptable-use rules, and confirm I have the rights to any agents and knowledge I connect. See <Link href="/security" className="text-electric-soft underline">Security & Trust</Link>.</>} />
              {errors.terms && <p className="mt-1.5 text-xs text-danger-soft" role="alert">{errors.terms}</p>}
            </div>
            <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>Create account</Button>
          </motion.div>
        )}
      </AnimatePresence>
      <p className="text-center text-sm text-fg-muted">Already have an account? <Link href="/sign-in" className="font-medium text-gold-soft hover:underline">Sign in</Link></p>
    </form>
  );
}
