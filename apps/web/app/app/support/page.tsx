'use client';
import Link from 'next/link';
import { useState } from 'react';
import { BookOpen, Bot, CheckCircle2, Coins, Gauge, GraduationCap, HelpCircle, Mail, ShieldCheck } from 'lucide-react';
import { Alert, Button, Field, Input, PageHeader, Select, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Section, useAction } from '@/components/app/primitives';

const TOPICS = [
  { icon: Bot, title: 'Connecting agents', desc: 'Providers, API keys, custom REST, webhooks, A2A and MCP.', href: '/app/agents/new', cta: 'Connect an agent' },
  { icon: Gauge, title: 'Capability assessments', desc: 'How scores, confidence and verified badges work.', href: '/docs', cta: 'Read the docs' },
  { icon: GraduationCap, title: 'Training sessions', desc: 'Requests, escrow, stages, artefacts and refunds.', href: '/app/training', cta: 'Training Hub' },
  { icon: Coins, title: 'IDLE Tokens & wallet', desc: 'Welcome bonus, earning and spending IDLE, escrow and commission.', href: '/app/wallet', cta: 'Open IDLE wallet' },
  { icon: ShieldCheck, title: 'Security & privacy', desc: 'MFA, sessions, data sharing permissions.', href: '/app/settings', cta: 'Security settings' },
  { icon: HelpCircle, title: 'FAQ', desc: 'Answers to the most common questions.', href: '/faq', cta: 'View FAQ' },
];

export default function SupportPage() {
  const { me } = useSession();
  const [f, setF] = useState({ name: me?.user.name ?? '', email: me?.user.email ?? '', company: me?.org?.name ?? '', topic: 'support', message: '' });
  const [sent, setSent] = useState(false);
  const { busy, run } = useAction();
  const valid = f.name.trim() && /\S+@\S+\.\S+/.test(f.email) && f.message.trim().length >= 10;
  return (
    <div className="space-y-6">
      <PageHeader title="Support" description="Guides for every part of StringMind, and a direct line to our team." actions={<Button variant="outline" href="/docs" icon={<BookOpen className="h-4 w-4" />}>Documentation</Button>} />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {TOPICS.map(({ icon: Icon, ...t }) => (
          <Link key={t.title} href={t.href} className="card group flex gap-3 p-4 transition hover:border-ink-600">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-gold/25 bg-gold/10 text-gold" aria-hidden><Icon className="h-5 w-5" /></span>
            <span><span className="block font-medium">{t.title}</span><span className="mt-0.5 block text-sm text-fg-muted">{t.desc}</span><span className="mt-2 block text-xs font-medium text-gold group-hover:text-gold-soft">{t.cta} →</span></span>
          </Link>
        ))}
      </div>
      <Section title="Contact us" subtitle="We usually reply within one business day." action={<Mail className="h-4 w-4 text-fg-subtle" aria-hidden />} className="max-w-3xl">
        {sent ? (
          <div className="space-y-4"><Alert tone="success" title="Message sent"><span className="flex items-center gap-1"><CheckCircle2 className="h-4 w-4" aria-hidden />Thanks — we&apos;ll reply to {f.email}.</span></Alert><Button variant="outline" onClick={() => { setSent(false); setF({ ...f, message: '' }); }}>Send another</Button></div>
        ) : (
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={async (e) => { e.preventDefault(); if (!valid) return; const r = await run('c', () => api.post('/public/contact', { ...f, company: f.company || undefined }), 'Message sent'); if (r !== undefined) setSent(true); }}>
            <Field label="Name" htmlFor="cn" required><Input id="cn" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Email" htmlFor="ce" required><Input id="ce" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
            <Field label="Company" htmlFor="cc"><Input id="cc" value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} /></Field>
            <Field label="Topic" htmlFor="ct"><Select id="ct" value={f.topic} onChange={(e) => setF({ ...f, topic: e.target.value })}>
              <option value="support">Technical support</option><option value="billing">IDLE wallet & tokens</option><option value="enterprise">Enterprise</option><option value="trust_safety">Trust & safety</option><option value="other">Other</option>
            </Select></Field>
            <div className="sm:col-span-2"><Field label="Message" htmlFor="cm" required hint="At least 10 characters. Never include API keys or passwords."><Textarea id="cm" value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} className="min-h-[140px]" /></Field></div>
            <div className="sm:col-span-2"><Button type="submit" variant="primary" loading={busy === 'c'} disabled={!valid}>Send message</Button></div>
          </form>
        )}
      </Section>
    </div>
  );
}
