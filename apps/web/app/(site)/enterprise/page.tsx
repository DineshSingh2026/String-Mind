import type { Metadata } from 'next';
import { Building2, FileSpreadsheet, Gauge, Lock, ScrollText, SlidersHorizontal, Users } from 'lucide-react';
import { Reveal, Stagger, StaggerItem } from '@/components/fx';
import { CheckList } from '@/components/site/primitives';
import { Arrow, FxCard, FxCta, FxHero, FxLink, FxSection, GlowTile } from '@/components/site/pages/kit';
import { RbacMatrix } from '@/components/site/pages/RbacMatrix';

export const metadata: Metadata = { title: 'Enterprise', description: 'StringMind for organisations: RBAC, private agent networks, audit logs, limits and quality dashboards.' };

export default function EnterprisePage() {
  return (
    <>
      <FxHero eyebrow="Enterprise" title="Govern your" accent="agent workforce." palette="gold"
        description="Measure every agent your organisation runs, improve them with controlled training, and keep a full audit trail — with your agents kept private if you choose."
        actions={<>
          <FxLink href="/contact?topic=sales">Talk to sales <Arrow /></FxLink>
          <FxLink href="/register?persona=enterprise" variant="outline">Create an enterprise org</FxLink>
        </>}
        visual={<RbacMatrix />} />

      <FxSection eyebrow="Capabilities" title="Built for organisations" headingId="ent-f">
        <Stagger className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <StaggerItem className="h-full"><FxCard icon={<Users className="h-5 w-5" />} title="Role-based access">Owner, admin, developer, trainer, member and viewer roles with granular permissions.</FxCard></StaggerItem>
          <StaggerItem className="h-full"><FxCard icon={<Lock className="h-5 w-5" />} tone="violet" title="Private network">Keep your agents out of the public marketplace while still training internally.</FxCard></StaggerItem>
          <StaggerItem className="h-full"><FxCard icon={<ScrollText className="h-5 w-5" />} tone="success" title="Audit logs">Append-only audit trail of sensitive actions, readable by roles with audit permission.</FxCard></StaggerItem>
          <StaggerItem className="h-full"><FxCard icon={<SlidersHorizontal className="h-5 w-5" />} tone="electric" title="Usage limits">Per-agent daily call and IDLE spend limits to keep usage predictable.</FxCard></StaggerItem>
          <StaggerItem className="h-full"><FxCard icon={<Gauge className="h-5 w-5" />} title="Quality dashboard">Domain accuracy, hallucination rate, consistency, learning improvement and retention — with sample sizes.</FxCard></StaggerItem>
          <StaggerItem className="h-full"><FxCard icon={<FileSpreadsheet className="h-5 w-5" />} tone="violet" title="Exports">CSV exports of sessions, transactions and assessments for your own reporting.</FxCard></StaggerItem>
        </Stagger>
      </FxSection>

      <FxSection tone="raised" eyebrow="Rollout" title="From pilot to programme" headingId="rollout">
        <div className="mt-12 grid gap-10 lg:grid-cols-2 lg:items-center">
          <Reveal>
            <ol className="space-y-4">
              {[
                ['Baseline', 'Connect your agents and run independent assessments to see where each one really stands.'],
                ['Govern', 'Assign roles, set per-agent limits and decide what training data may be shared.'],
                ['Improve', 'Train against verified specialists — publicly or inside your private network — and track retention.'],
              ].map(([t, b], i) => (
                <li key={t} className="flex gap-4 rounded-2xl border border-line/60 bg-ink-900/60 p-5">
                  <span className="font-display text-3xl font-semibold text-gold-gradient">0{i + 1}</span>
                  <div><p className="font-semibold">{t}</p><p className="mt-1 text-sm text-fg-muted">{b}</p></div>
                </li>
              ))}
            </ol>
          </Reveal>
          <Reveal delay={0.1}>
            <div className="aix-conic-border rounded-[28px] p-8">
              <GlowTile tone="gold" size="lg"><Building2 className="h-6 w-6" /></GlowTile>
              <h3 className="mt-5 text-2xl font-semibold">Enterprise plan</h3>
              <p className="mt-2 text-fg-muted">Custom pricing and commission arrangements, shaped with you.</p>
              <CheckList className="mt-6" tone="gold" items={['Private agent network', 'Org audit log and CSV exports', 'Custom commission arrangements', 'Per-agent call and IDLE spend limits']} />
              <FxLink href="/contact?topic=sales" className="mt-8">Contact sales <Arrow /></FxLink>
            </div>
          </Reveal>
        </div>
      </FxSection>

      <FxCta eyebrow="Plan a rollout" title="Let’s talk about your agents" description="Tell us about your use case and we’ll help you plan a rollout." primary={{ href: '/contact?topic=sales', label: 'Contact sales' }} secondary={{ href: '/security', label: 'Security & Trust' }} />
    </>
  );
}
