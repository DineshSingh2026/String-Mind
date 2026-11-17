import type { Metadata } from 'next';
import { BarChart3, KeyRound, Plug, Radio, ScrollText, Webhook } from 'lucide-react';
import { PROVIDERS } from '@aix/shared';
import { Reveal, Stagger, StaggerItem } from '@/components/fx';
import { CodeTabs } from '@/components/site/CodeBlock';
import { Arrow, FxCard, FxCta, FxHero, FxLink, FxSection } from '@/components/site/pages/kit';
import { AnimatedTerminal } from '@/components/site/pages/docs';

export const metadata: Metadata = { title: 'Developers', description: 'Build on Hive Mind: REST API, org-scoped API keys, signed webhooks and provider adapters.' };

const curl = `curl -s "$AIX_API_URL/agents" \\
  -H "Authorization: Bearer $AIX_API_KEY"`;
const ts = `const res = await fetch(\`\${process.env.AIX_API_URL}/agents\`, {
  headers: { Authorization: \`Bearer \${process.env.AIX_API_KEY}\` },
});
const { items } = await res.json();   // { items, total, page, pageSize }
console.log(items.map((a) => a.name));`;
const py = `import os, requests

r = requests.get(f"{os.environ['AIX_API_URL']}/agents",
                 headers={"Authorization": f"Bearer {os.environ['AIX_API_KEY']}"})
print([a["name"] for a in r.json()["items"]])`;

const EVENTS = ['agent.connected', 'agent.health_failed', 'assessment.completed', 'training.requested', 'training.accepted', 'training.completed'];

export default function DevelopersPage() {
  return (
    <>
      <FxHero eyebrow="Developers" title="Everything in Hive Mind," accent="via API." accentTone="ai" palette="ai"
        description="Connect agents, run assessments, request training and react to events programmatically. Same permissions model as the app, scoped to your organisation."
        actions={<>
          <FxLink href="/docs" variant="ai">Read the docs <Arrow /></FxLink>
          <FxLink href="/register?persona=developer" variant="outline">Get an API key</FxLink>
        </>}
        visual={
          <AnimatedTerminal title="~/my-agent — zsh" lines={[
            { kind: 'cmd', text: 'export AIX_API_KEY=aix_sk_••••••••' },
            { kind: 'cmd', text: 'curl -s -X POST $AIX_API_URL/assessments -d \'{"agentId":"…","domainSlugs":["finance"]}\'' },
            { kind: 'out', text: '{ "id": "…", "status": "queued" }' },
            { kind: 'dim', text: '# webhook → assessment.completed' },
            { kind: 'cmd', text: 'curl -s $AIX_API_URL/assessments/scorecard/… | jq ".domains[0]"' },
            { kind: 'out', text: '{ "slug": "finance", "score": …, "sampleSize": …, "verified": … }' },
            { kind: 'ok', text: '✓ scorecard ready' },
          ]} />
        } />

      <FxSection eyebrow="Platform" title="Developer building blocks" headingId="dev-f">
        <Stagger className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <StaggerItem className="h-full"><FxCard icon={<KeyRound className="h-5 w-5" />} tone="electric" title="API keys" href="/docs#auth" cta="Authentication">Org-scoped keys with scopes, environments, expiry and rotation. Shown once, stored hashed.</FxCard></StaggerItem>
          <StaggerItem className="h-full"><FxCard icon={<Webhook className="h-5 w-5" />} tone="violet" title="Signed webhooks" href="/docs#webhooks" cta="Verify signatures">HMAC-SHA256 signed events with timestamps, test deliveries and a delivery log.</FxCard></StaggerItem>
          <StaggerItem className="h-full"><FxCard icon={<Plug className="h-5 w-5" />} title="Adapters" href="/docs#adapters" cta="Adapter interface">One standard runtime interface across {PROVIDERS.length} provider types, including REST, webhook, A2A and MCP.</FxCard></StaggerItem>
          <StaggerItem className="h-full"><FxCard icon={<ScrollText className="h-5 w-5" />} tone="success" title="Request logs" href="/docs#endpoints" cta="Endpoints">Every API request logged with status for debugging from the developer console.</FxCard></StaggerItem>
          <StaggerItem className="h-full"><FxCard icon={<BarChart3 className="h-5 w-5" />} tone="electric" title="Usage & limits" href="/docs#errors" cta="Errors & limits">Daily requests and errors, plus your rate limit per minute.</FxCard></StaggerItem>
          <StaggerItem className="h-full"><FxCard icon={<Radio className="h-5 w-5" />} tone="violet" title="Realtime" href="/docs#realtime" cta="Channels">Subscribe to session and assessment channels over WebSocket for live progress.</FxCard></StaggerItem>
        </Stagger>
      </FxSection>

      <FxSection tone="raised" eyebrow="Quick start" title="Your first call in seconds" headingId="dev-q" description="Create a key in the Developer Console, then list your organisation’s agents.">
        <div className="mt-12 grid items-start gap-8 lg:grid-cols-[1.2fr_1fr]">
          <Reveal><CodeTabs title="first-call" tabs={[{ label: 'curl', code: curl, file: 'shell' }, { label: 'TypeScript', code: ts, file: 'list.ts' }, { label: 'Python', code: py, file: 'list.py' }]} /></Reveal>
          <Reveal delay={0.1}>
            <div className="aix-panel rounded-3xl p-6">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-fg-subtle">Webhook events</p>
              <ul className="mt-4 flex flex-wrap gap-2">
                {EVENTS.map((e) => <li key={e} className="rounded-lg border border-violet/25 bg-violet/[0.07] px-2.5 py-1 font-mono text-[11.5px] text-violet-soft">{e}</li>)}
              </ul>
              <p className="mt-5 text-sm text-fg-muted">Each delivery carries <code className="rounded bg-ink-800 px-1 font-mono text-[12px] text-electric-soft">x-aix-signature: t=…,v1=…</code>. Verify it against the raw body with your secret.</p>
            </div>
          </Reveal>
        </div>
      </FxSection>

      <FxSection eyebrow="Adapters" title={`${PROVIDERS.length} ways to connect an agent`} headingId="adapters">
        <Stagger className="mt-12 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {PROVIDERS.map((p) => (
            <StaggerItem key={p.slug}>
              <div className="group rounded-2xl border border-line/60 bg-ink-900/70 p-4 transition hover:-translate-y-0.5 hover:border-electric/40">
                <p className="flex items-center gap-2 text-sm font-medium text-fg"><span aria-hidden className="h-1.5 w-1.5 rounded-full bg-electric shadow-[0_0_8px_rgb(var(--electric))]" />{p.name}</p>
                <p className="mt-1 font-mono text-[11px] text-fg-subtle">{p.adapter}</p>
              </div>
            </StaggerItem>
          ))}
        </Stagger>
      </FxSection>

      <FxCta eyebrow="Free to start" title="Start building" primary={{ href: '/register?persona=developer', label: 'Create a developer account' }} secondary={{ href: '/docs', label: 'API documentation' }} />
    </>
  );
}
