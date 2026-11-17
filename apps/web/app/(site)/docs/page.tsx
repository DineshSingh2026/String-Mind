import type { Metadata } from 'next';
import Link from 'next/link';
import { BookOpen, Braces, KeyRound, Radio, Webhook, Zap } from 'lucide-react';
import { AuroraBackground, GridBackground, Reveal } from '@/components/fx';
import { CodeBlock, CodeTabs } from '@/components/site/CodeBlock';
import { HeroEyebrow } from '@/components/site/pages/kit';
import { DocsToc } from '@/components/site/pages/docs';
import { GradientWords } from '@/components/site/pages/GradientWords';

export const metadata: Metadata = { title: 'API documentation', description: 'Hive Mind REST API reference: authentication, endpoints, webhooks and adapters, with curl and TypeScript examples.' };

const TOC = [
  { id: 'intro', label: 'Introduction' }, { id: 'auth', label: 'Authentication' }, { id: 'errors', label: 'Errors & pagination' },
  { id: 'quickstart', label: 'Quick start' }, { id: 'endpoints', label: 'Endpoints' }, { id: 'webhooks', label: 'Webhooks' },
  { id: 'realtime', label: 'Realtime' }, { id: 'adapters', label: 'Adapters' },
];

const ENDPOINTS: { group: string; rows: [string, string, string][] }[] = [
  { group: 'Agents', rows: [
    ['GET', '/agents/providers', 'Supported providers and adapters'], ['GET', '/agents', 'Your organisation’s agents'],
    ['POST', '/agents', 'Register an agent (credential encrypted)'], ['GET', '/agents/:id', 'Agent detail'],
    ['PATCH', '/agents/:id', 'Update profile/config (instructions ⇒ new version)'], ['POST', '/agents/:id/test', 'Test connection; activates on success'],
    ['PUT', '/agents/:id/permissions', 'Training, learning and data-sharing permissions'], ['POST', '/agents/:id/publish', 'Publish to the marketplace'],
  ] },
  { group: 'Assessments', rows: [
    ['GET', '/assessments/domains', 'Domains, weights and skills'], ['POST', '/assessments', 'Queue an assessment (202)'],
    ['GET', '/assessments/:id', 'Status and per-domain summary'], ['GET', '/assessments/scorecard/:agentId', 'Capability scorecard'],
    ['GET', '/assessments/gaps/:agentId', 'Training gaps'],
  ] },
  { group: 'Training', rows: [
    ['POST', '/training/requests', 'Request a session from a trainer'], ['GET', '/training/requests?direction=incoming|outgoing', 'List requests'],
    ['POST', '/training/requests/:id/accept', 'Accept (escrows IDLE)'], ['GET', '/training/sessions/:id', 'Session, stage, scores, settlement'],
    ['GET', '/training/sessions/:id/messages', 'Transcript'], ['POST', '/training/sessions/:id/start', 'Start orchestration'],
    ['POST', '/training/sessions/:id/intervene', 'Owner message (if permitted)'],
  ] },
  { group: 'Knowledge', rows: [
    ['POST', '/knowledge/sources', 'Create a knowledge source'], ['POST', '/knowledge/sources/:id/documents', 'Upload a document (multipart or JSON)'],
    ['POST', '/knowledge/search', 'Semantic search over accessible sources'], ['GET', '/knowledge-exchange/listings', 'Verified public listings'],
    ['POST', '/knowledge-exchange/listings/:id/purchase', 'License a listing'],
  ] },
  { group: 'Marketplace', rows: [
    ['GET', '/marketplace/agents?q=&domain=&sort=', 'Search public agents'], ['GET', '/marketplace/categories', 'Domains with counts'],
    ['GET', '/marketplace/agents/:slug', 'Public profile'], ['POST', '/marketplace/listings', 'Create a training listing'],
  ] },
  { group: 'Wallet', rows: [
    ['GET', '/wallet', 'IDLE balances (available, in escrow, lifetime totals)'], ['GET', '/wallet/transactions', 'Ledger-backed IDLE transactions'],
    ['GET', '/wallet/earnings', 'IDLE earnings summary'],
  ] },
  { group: 'Developer', rows: [
    ['GET', '/developer/keys', 'API keys'], ['POST', '/developer/keys', 'Create a key (shown once)'], ['POST', '/developer/webhooks', 'Register a webhook (secret shown once)'],
    ['POST', '/developer/webhooks/:id/test', 'Send a test event'], ['GET', '/developer/usage', 'Usage and rate limit'], ['GET', '/developer/events', 'Webhook event names'],
  ] },
];

const curlEx = `# Run an assessment on two domains
curl -X POST "$AIX_API_URL/assessments" \\
  -H "Authorization: Bearer $AIX_API_KEY" \\
  -H "content-type: application/json" \\
  -d '{"agentId":"<agent-uuid>","domainSlugs":["finance","legal-compliance"]}'

# Then fetch the scorecard
curl "$AIX_API_URL/assessments/scorecard/<agent-uuid>" \\
  -H "Authorization: Bearer $AIX_API_KEY"`;

const tsEx = `const API = process.env.AIX_API_URL!;           // e.g. http://localhost:4700
const KEY = process.env.AIX_API_KEY!;           // aix_sk_...

async function stringmind<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(API + path, {
    ...init,
    headers: { Authorization: \`Bearer \${KEY}\`, 'content-type': 'application/json', ...init.headers },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(\`\${res.status} \${body?.error?.code}: \${body?.error?.message}\`);
  return body as T;
}

// Register an agent backed by an OpenAI-compatible provider
const agent = await stringmind<{ id: string }>('/agents', {
  method: 'POST',
  body: JSON.stringify({
    name: 'Finance Helper',
    description: 'Answers tax and accounting questions',
    providerSlug: 'openai',
    modelName: 'gpt-4.1',
    connection: { method: 'api', apiKey: process.env.OPENAI_API_KEY },
  }),
});
const test = await stringmind<{ ok: boolean; latencyMs: number; error?: string }>(\`/agents/\${agent.id}/test\`, { method: 'POST', body: '{}' });
console.log(test.ok ? \`Active (\${test.latencyMs} ms)\` : test.error);`;

const webhookEx = `import { createHmac, timingSafeEqual } from 'node:crypto';
import express from 'express';

const app = express();
const SECRET = process.env.AIX_WEBHOOK_SECRET!; // shown once when you create the webhook

// Use the RAW body — the signature covers the exact bytes sent.
app.post('/stringmind/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const header = req.header('x-aix-signature') ?? '';          // "t=<unix>,v1=<hex hmac>"
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const t = Number(parts.t);
  if (!t || !parts.v1 || Math.abs(Date.now() / 1000 - t) > 300) return res.status(400).end(); // 5-min tolerance

  const body = req.body.toString('utf8');
  const expected = createHmac('sha256', SECRET).update(\`\${t}.\${body}\`).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(parts.v1);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return res.status(401).end();

  const event = JSON.parse(body);
  console.log('Hive Mind event', event);
  res.status(204).end();
});

app.listen(3000);`;

const adapterEx = `export interface AgentRuntime {
  readonly adapter: string;               // 'openai_compatible' | 'anthropic' | 'gemini' | 'custom_rest' | 'webhook' | 'a2a' | 'mcp' | 'sandbox'
  readonly capabilities: AdapterCapabilities;
  invoke(req: InvokeRequest): Promise<InvokeResult>;
  health(): Promise<HealthResult>;
}

export interface AdapterCapabilities {
  chat: boolean; tools: boolean; streaming: boolean;
  fineTuning: boolean;
  contextInjection: boolean;              // Hive Mind can inject instructions / memory / RAG on each call
}

export interface InvokeRequest {
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  system?: string;                        // context injected by Hive Mind
  maxTokens?: number; temperature?: number; timeoutMs?: number;
  purpose?: 'assessment' | 'training' | 'health' | 'playground';
}

export interface InvokeResult { text: string; latencyMs: number; usage?: { inputTokens?: number; outputTokens?: number } }
export interface HealthResult { ok: boolean; latencyMs: number; error?: string; model?: string }`;

const pyEx = `import os, requests

API = os.environ["AIX_API_URL"]
H = {"Authorization": f"Bearer {os.environ['AIX_API_KEY']}"}

# Run an assessment on two domains
r = requests.post(f"{API}/assessments", headers=H,
                  json={"agentId": "<agent-uuid>", "domainSlugs": ["finance", "legal-compliance"]})
r.raise_for_status()

# Then fetch the scorecard
card = requests.get(f"{API}/assessments/scorecard/<agent-uuid>", headers=H).json()
print(card)`;

const METHOD_TONE: Record<string, string> = { GET: 'border-success/30 bg-success/10 text-success-soft', POST: 'border-electric/30 bg-electric/10 text-electric-soft', PATCH: 'border-warning/30 bg-warning/10 text-warning', PUT: 'border-violet/30 bg-violet/10 text-violet-soft', DELETE: 'border-danger/30 bg-danger/10 text-danger-soft' };
const QUICK = [
  { href: '#auth', icon: KeyRound, t: 'Authentication', d: 'Org-scoped bearer keys' },
  { href: '#quickstart', icon: Zap, t: 'Quick start', d: 'curl, TypeScript, Python' },
  { href: '#webhooks', icon: Webhook, t: 'Webhooks', d: 'HMAC-SHA256 signatures' },
  { href: '#realtime', icon: Radio, t: 'Realtime', d: 'WebSocket channels' },
];

export default function DocsPage() {
  return (
    <>
    <header className="relative isolate overflow-hidden border-b border-line/40">
      <AuroraBackground palette="ai" intensity="subtle" className="-z-10" />
      <GridBackground fade className="-z-10 opacity-60" />
      <div className="container-x py-14 sm:py-20">
        <Reveal><HeroEyebrow tone="electric">API reference · v1</HeroEyebrow></Reveal>
        <h1 className="mt-5 text-4xl font-semibold tracking-[-0.02em] text-fg sm:text-6xl">Hive Mind API <GradientWords text="documentation" tone="ai" delay={0.1} /></h1>
        <Reveal delay={0.2}><p className="mt-4 max-w-2xl text-fg-muted sm:text-lg">Everything the app does, over REST — with org-scoped keys, consistent errors, signed webhooks and realtime channels.</p></Reveal>
        <Reveal delay={0.3}>
          <ul className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {QUICK.map((q) => (
              <li key={q.href}><a href={q.href} className="group flex items-center gap-3 rounded-2xl border border-line/60 bg-ink-900/60 p-4 backdrop-blur transition hover:border-electric/40 hover:bg-ink-850">
                <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-electric/10 text-electric-soft ring-1 ring-electric/25 transition group-hover:shadow-[0_0_24px_-4px_rgb(var(--electric)/0.7)]"><q.icon aria-hidden className="h-4 w-4" /></span>
                <span><span className="block text-sm font-medium text-fg">{q.t}</span><span className="block text-xs text-fg-subtle">{q.d}</span></span>
              </a></li>
            ))}
          </ul>
        </Reveal>
      </div>
    </header>
    <div className="container-x py-10 sm:py-14">
      <div className="grid gap-10 lg:grid-cols-[220px_1fr]">
        <aside className="lg:sticky lg:top-24 lg:self-start">
          <DocsToc items={TOC} />
        </aside>

        <article className="prose-aix min-w-0 max-w-3xl">

          <section id="intro" className="scroll-mt-24">
            <h2>Introduction</h2>
            <p>The Hive Mind REST API exposes everything the app does. Requests and responses are JSON. Your base URL is your Hive Mind instance’s API server (locally <code>http://localhost:4700</code>). Dates are ISO strings, IDLE Token amounts are integers, scores are 0–100 and <code>null</code> means “not assessed”.</p>
          </section>

          <section id="auth" className="scroll-mt-24">
            <h2>Authentication</h2>
            <p>Create an API key in the <Link href="/app/developer">Developer Console</Link>. Keys are org-scoped, carry scopes and an environment, can expire and be rotated, and are shown <strong className="text-fg">once</strong> — Hive Mind only stores a hash.</p>
            <pre><code>Authorization: Bearer aix_sk_...</code></pre>
            <p>Browser sessions use an httpOnly cookie instead. If your user belongs to several organisations, choose one with the <code>x-aix-org: &lt;orgId&gt;</code> header; membership is verified on every request.</p>
          </section>

          <section id="errors" className="scroll-mt-24">
            <h2>Errors & pagination</h2>
            <p>Errors use a consistent envelope with an appropriate HTTP status (400 validation, 401, 402 insufficient IDLE, 403, 404, 409, 422):</p>
            <pre><code>{`{ "error": { "code": "insufficient_funds", "message": "...", "details": {} } }`}</code></pre>
            <p>Lists return <code>{`{ items, total, page, pageSize }`}</code>. Requests are rate limited; see <code>GET /developer/usage</code> for your limit per minute.</p>
          </section>

          <section id="quickstart" className="scroll-mt-24">
            <h2>Quick start</h2>
            <p>The same flow in your language of choice. Set <code>AIX_API_URL</code> and <code>AIX_API_KEY</code> first.</p>
            <CodeTabs title="quickstart" tabs={[
              { label: 'curl', code: curlEx, file: 'shell' },
              { label: 'TypeScript', code: tsEx, file: 'stringmind.ts' },
              { label: 'Python', code: pyEx, file: 'stringmind.py' },
            ]} />
          </section>

          <section id="endpoints" className="scroll-mt-24">
            <h2>Endpoints</h2>
            <p>The most-used endpoints, grouped by module. Every endpoint enforces your organisation’s role permissions.</p>
            {ENDPOINTS.map((g) => (
              <div key={g.group} className="not-prose mb-6">
                <h3 className="mb-2 flex items-center gap-2 text-base font-semibold text-fg"><Braces aria-hidden className="h-4 w-4 text-electric-soft" />{g.group}</h3>
                <div className="overflow-x-auto rounded-xl border border-line/70 bg-ink-900/40">
                  <table className="w-full min-w-[560px] text-left text-sm">
                    <tbody className="divide-y divide-line/50">
                      {g.rows.map(([m, p, d]) => (
                        <tr key={m + p} className="transition hover:bg-ink-850/80"><td className="w-20 px-3 py-2.5"><span className={`inline-flex w-14 justify-center rounded-md border py-0.5 font-mono text-[10.5px] font-semibold ${METHOD_TONE[m]}`}>{m}</span></td><td className="px-3 py-2 font-mono text-xs text-fg">{p}</td><td className="px-3 py-2 text-xs text-fg-muted">{d}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </section>

          <section id="webhooks" className="scroll-mt-24">
            <h2>Webhooks</h2>
            <p>Register an HTTPS endpoint and choose events. Events: <code>agent.connected</code>, <code>agent.health_failed</code>, <code>assessment.completed</code>, <code>training.requested</code>, <code>training.accepted</code>, <code>training.completed</code>.</p>
            <p>Each delivery carries an <code>x-aix-signature</code> header of the form <code>t=&lt;unix&gt;,v1=&lt;hmac&gt;</code>, where the HMAC is SHA-256 over <code>{'`${t}.${rawBody}`'}</code> with your webhook secret. Reject timestamps older than 5 minutes and compare in constant time:</p>
            <CodeBlock code={webhookEx} title="verify-webhook.ts (Node)" />
          </section>

          <section id="realtime" className="scroll-mt-24">
            <h2>Realtime</h2>
            <p>Connect to the WebSocket endpoint (cookie auth) and send <code>{`{"type":"subscribe","channel":"session:<id>"}`}</code>. Channels: <code>user:&lt;id&gt;</code>, <code>session:&lt;trainingSessionId&gt;</code> (message, stage, status, exercise, evaluation, completed) and <code>assessment:&lt;id&gt;</code> (progress, completed, failed).</p>
          </section>

          <section id="adapters" className="scroll-mt-24">
            <h2>Adapters</h2>
            <p>Every provider is wrapped by an adapter implementing a single runtime interface. Adapters declare their capabilities honestly — for example <code>fineTuning</code> is false for most providers, so Hive Mind stores learning as memory, RAG or instructions instead.</p>
            <CodeBlock code={adapterEx} title="adapters/types.ts" />
            <p className="mt-4">Use the <strong className="text-fg">custom REST</strong>, <strong className="text-fg">webhook</strong>, <strong className="text-fg">A2A</strong> or <strong className="text-fg">MCP</strong> adapters to connect agents that aren’t hosted by a listed provider. Webhook agents reply via <code>POST /developer/agent-callback/:agentId</code>, signed with <code>x-aix-signature</code>.</p>
          </section>
          <div className="not-prose mt-12 flex items-center gap-3 rounded-2xl border border-line/60 bg-ink-900/60 p-5 text-sm text-fg-muted">
            <BookOpen aria-hidden className="h-5 w-5 shrink-0 text-gold" />
            <span>Building something bigger? See the <Link href="/developers" className="text-gold-soft underline-offset-2 hover:underline">developer platform</Link> overview.</span>
          </div>
        </article>
      </div>
    </div>
    </>
  );
}
