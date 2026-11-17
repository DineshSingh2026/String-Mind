'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Send } from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import { Alert, Button, Field, Input, Select, Textarea } from '@/components/ui';

const TOPICS = [
  { v: 'general', l: 'General question' }, { v: 'sales', l: 'Sales & enterprise' }, { v: 'support', l: 'Account support' },
  { v: 'partnerships', l: 'Partnerships & integrations' }, { v: 'security', l: 'Security disclosure' }, { v: 'press', l: 'Press' },
];

export function ContactForm() {
  const sp = useSearchParams();
  const initTopic = TOPICS.some((t) => t.v === sp.get('topic')) ? sp.get('topic')! : 'general';
  const [f, setF] = useState({ name: '', email: '', company: '', topic: initTopic, message: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const reduce = useReducedMotion();
  const spTopic = sp.get('topic');
  useEffect(() => { if (spTopic && TOPICS.some((t) => t.v === spTopic)) setF((x) => ({ ...x, topic: spTopic })); }, [spTopic]);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(null);
    const v: Record<string, string> = {};
    if (f.name.trim().length < 2) v.name = 'Please enter your name.';
    if (!/^\S+@\S+\.\S+$/.test(f.email.trim())) v.email = 'Please enter a valid email.';
    if (f.message.trim().length < 10) v.message = 'Please write at least 10 characters.';
    if (f.message.length > 5000) v.message = 'Please keep your message under 5,000 characters.';
    setErrors(v);
    if (Object.keys(v).length) return;
    setBusy(true);
    try {
      await api.post('/public/contact', { name: f.name.trim(), email: f.email.trim(), company: f.company.trim() || undefined, topic: f.topic, message: f.message.trim() });
      setSent(true);
    } catch (x) { setErr(errorMessage(x)); } finally { setBusy(false); }
  };

  return (
    <AnimatePresence mode="wait" initial={false}>
    {sent ? (
      <motion.div key="sent" className="flex flex-col items-center py-10 text-center" role="status"
        initial={reduce ? false : { opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.4 }}>
        <div className="relative h-24 w-24">
          {!reduce && [0, 1].map((i) => <motion.span key={i} aria-hidden className="absolute inset-0 rounded-full border border-success/50" initial={{ scale: 0.6, opacity: 0.8 }} animate={{ scale: 1.8, opacity: 0 }} transition={{ duration: 1.4, delay: 0.3 + i * 0.4, ease: 'easeOut' }} />)}
          <svg viewBox="0 0 96 96" className="h-24 w-24" aria-hidden>
            <motion.circle cx="48" cy="48" r="40" fill="rgb(var(--success) / 0.1)" stroke="rgb(var(--success))" strokeWidth="3" initial={reduce ? false : { pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.6 }} />
            <motion.path d="M30 49 L43 62 L67 36" fill="none" stroke="rgb(var(--success))" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" initial={reduce ? false : { pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.45, delay: 0.5 }} />
          </svg>
        </div>
        <h2 className="mt-6 text-2xl font-semibold">Message sent</h2>
        <p className="mt-2 max-w-sm text-fg-muted">Thanks, {f.name.split(' ')[0]}. We’ll reply to <span className="text-fg">{f.email}</span>.</p>
        <Button variant="outline" className="mt-7" onClick={() => { setSent(false); setF({ name: '', email: '', company: '', topic: 'general', message: '' }); }}>Send another message</Button>
      </motion.div>
    ) : (
    <motion.form key="form" onSubmit={submit} className="space-y-5" noValidate initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={reduce ? undefined : { opacity: 0, y: -8 }}>
      <AnimatePresence>{err && <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden"><Alert tone="danger" title="Couldn’t send your message">{err}</Alert></motion.div>}</AnimatePresence>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Name" htmlFor="c-name" required error={errors.name}><Input id="c-name" value={f.name} onChange={set('name')} autoComplete="name" aria-invalid={!!errors.name} /></Field>
        <Field label="Email" htmlFor="c-email" required error={errors.email}><Input id="c-email" type="email" value={f.email} onChange={set('email')} autoComplete="email" aria-invalid={!!errors.email} /></Field>
        <Field label="Company" htmlFor="c-co" hint="Optional"><Input id="c-co" value={f.company} onChange={set('company')} autoComplete="organization" /></Field>
        <Field label="Topic" htmlFor="c-topic" required><Select id="c-topic" value={f.topic} onChange={set('topic')}>{TOPICS.map((t) => <option key={t.v} value={t.v}>{t.l}</option>)}</Select></Field>
      </div>
      <Field label="Message" htmlFor="c-msg" required error={errors.message} hint={`${f.message.length}/5000`}>
        <Textarea id="c-msg" rows={6} value={f.message} onChange={set('message')} aria-invalid={!!errors.message} />
      </Field>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-fg-subtle">Fields marked <span className="text-gold">*</span> are required.</p>
        <Button type="submit" variant="primary" size="lg" loading={busy} className="w-full sm:w-auto" icon={busy ? undefined : <Send className="h-4 w-4" />}>{busy ? 'Sending…' : 'Send message'}</Button>
      </div>
    </motion.form>
    )}
    </AnimatePresence>
  );
}
