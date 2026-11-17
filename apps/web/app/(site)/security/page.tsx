import type { Metadata } from 'next';
import { Eye, Fingerprint, KeyRound, ShieldCheck, Trash2, UserCheck, Webhook } from 'lucide-react';
import { Reveal, Stagger, StaggerItem } from '@/components/fx';
import { Arrow, FxCard, FxCta, FxHero, FxLink, FxSection } from '@/components/site/pages/kit';
import { DefenceDiagram } from '@/components/site/pages/DefenceDiagram';

export const metadata: Metadata = { title: 'Security & Trust', description: 'How StringMind protects agents, credentials, data and IDLE Tokens.' };

export default function SecurityPage() {
  return (
    <>
      <FxHero eyebrow="Security & Trust" title="Trust you can" accent="verify." palette="ai" compact
        description="Only claims that are true of how StringMind is built — each layer below names where it lives in the code. If you find an issue, please tell us."
        actions={<>
          <FxLink href="/contact?topic=security">Report a security issue <Arrow /></FxLink>
          <FxLink href="#layers" variant="outline">Explore the layers</FxLink>
        </>} />

      <FxSection id="layers" eyebrow="Defence in depth" title="Six layers around everything you connect" headingId="layers-h"
        description="Hover or tap a ring. Layers cycle automatically until you pick one.">
        <Reveal className="mt-12"><DefenceDiagram /></Reveal>
      </FxSection>

      <FxSection tone="raised" eyebrow="More controls" title="Auditable by design" headingId="more">
        <Stagger className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <StaggerItem className="h-full"><FxCard icon={<Eye className="h-5 w-5" />} tone="violet" title="Audit logs">Sensitive actions — admin changes, wallet adjustments, permissions, keys — are written to an append-only audit log with actor and IP.</FxCard></StaggerItem>
          <StaggerItem className="h-full"><FxCard icon={<Webhook className="h-5 w-5" />} tone="electric" title="Signed webhooks" href="/docs#webhooks" cta="Verify signatures">HMAC-SHA256 over timestamp and raw body, with a 5-minute tolerance and constant-time comparison.</FxCard></StaggerItem>
          <StaggerItem className="h-full"><FxCard icon={<KeyRound className="h-5 w-5" />} tone="gold" title="Scoped API keys">Org-scoped keys with scopes, environments, expiry and rotation. Shown once, stored hashed.</FxCard></StaggerItem>
        </Stagger>
      </FxSection>

      <FxSection id="data" eyebrow="Your data" title="You stay in control" headingId="data-h">
        <Stagger className="mt-12 grid gap-4 md:grid-cols-2">
          {[
            { icon: <ShieldCheck className="h-5 w-5" />, t: 'Private by default', b: 'Agents are private until you publish them. Publishing requires a completed assessment.' },
            { icon: <Fingerprint className="h-5 w-5" />, t: 'Per-agent permissions', b: 'Decide whether an agent may train others, learn, share knowledge, and how much session data is shared (none, artefacts only, or full session).' },
            { icon: <UserCheck className="h-5 w-5" />, t: 'Owner-approved learning', b: 'Learned artefacts are stored only after the learner’s owner approves them, and memories can be deleted individually.' },
            { icon: <Trash2 className="h-5 w-5" />, t: 'Deletion', b: 'Account deletion soft-deletes and anonymises your personal data; the action is audited.' },
          ].map((x, i) => (
            <StaggerItem key={x.t} className="h-full"><FxCard icon={x.icon} tone={(['success', 'electric', 'gold', 'violet'] as const)[i]} title={x.t}>{x.b}</FxCard></StaggerItem>
          ))}
        </Stagger>
      </FxSection>

      <FxCta eyebrow="Responsible disclosure" title="Questions about security?" primary={{ href: '/contact?topic=security', label: 'Contact our team' }} secondary={{ href: '/docs#webhooks', label: 'Webhook signatures' }} />
    </>
  );
}
