'use client';
import { Bot, GitBranch } from 'lucide-react';
import { Button, Card, CardBody, CardHeader } from '@/components/ui';
import { API_BASE, CodeBlock } from './common';

export function QuickstartTab() {
  const ts = `// npm i undici (or use global fetch in Node 18+)
const StringMind = '${API_BASE}';
const KEY = process.env.AIX_API_KEY!; // aix_sk_… — server-side only

async function stringmind<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(StringMind + path, {
    method,
    headers: { authorization: \`Bearer \${KEY}\`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(\`\${json.error?.code}: \${json.error?.message}\`);
  return json as T;
}

// List your agents
const agents = await stringmind('GET', '/agents');

// Run a capability assessment
await stringmind('POST', '/assessments', { agentId: '<agent-id>', domainSlugs: ['finance'] });`;

  const register = `// Register an agent (scope: agents.create, agents.connect)
const agent = await stringmind<{ id: string }>('POST', '/agents', {
  name: 'FinanceBot',
  description: 'Answers tax and accounting questions',
  providerSlug: 'openai',            // see GET /agents/providers
  modelName: 'gpt-4.1',
  instructions: 'You are a careful finance assistant…',
  claimedDomains: ['finance'],
  connection: { method: 'api_key', apiKey: process.env.OPENAI_API_KEY },
});

// Verify the connection — status becomes "active" when it passes
await stringmind('POST', \`/agents/\${agent.id}/test\`);`;

  const curl = `# List agents
curl -s ${API_BASE}/agents \\
  -H "Authorization: Bearer $AIX_API_KEY"

# Request a training session
curl -s -X POST ${API_BASE}/training/requests \\
  -H "Authorization: Bearer $AIX_API_KEY" -H "Content-Type: application/json" \\
  -d '{"learnerAgentId":"<id>","trainerAgentId":"<id>","domainSlug":"finance","objectives":["Input tax credit rules"]}'`;

  const verify = `import crypto from 'node:crypto';

// Express example — keep the RAW body for signature verification
app.post('/stringmind/webhooks', express.raw({ type: 'application/json' }), (req, res) => {
  // Header format: x-aix-signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">
  const header = String(req.header('x-aix-signature') ?? '');
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > 300) return res.status(401).end(); // replay window
  const expected = crypto
    .createHmac('sha256', process.env.AIX_WEBHOOK_SECRET!)
    .update(\`\${t}.\${req.body.toString('utf8')}\`)
    .digest('hex');
  const received = String(parts.v1 ?? '');
  const ok = received.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
  if (!ok) return res.status(401).end();

  const event = JSON.parse(req.body.toString('utf8'));
  // { id, event, createdAt, data } — e.g. event.event === 'training.completed'
  res.status(204).end();
});`;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Card><CardBody className="flex items-start gap-3">
          <span className="rounded-xl bg-gold/10 p-2.5 text-gold"><Bot className="h-5 w-5" /></span>
          <div className="flex-1"><p className="font-medium">Register an agent in the UI</p><p className="mt-0.5 text-sm text-fg-muted">Guided connection wizard with provider presets and a live connection test.</p>
            <Button className="mt-3" size="sm" variant="primary" href="/app/agents/new">Register agent</Button></div>
        </CardBody></Card>
        <Card><CardBody className="flex items-start gap-3">
          <span className="rounded-xl bg-violet/10 p-2.5 text-violet"><GitBranch className="h-5 w-5" /></span>
          <div className="flex-1"><p className="font-medium">Version management</p><p className="mt-0.5 text-sm text-fg-muted">Every instruction change creates a version. View history and roll back from each agent&apos;s page.</p>
            <Button className="mt-3" size="sm" variant="outline" href="/app/agents">Manage agent versions</Button></div>
        </CardBody></Card>
      </div>
      <Card><CardHeader title="TypeScript quickstart" subtitle="Minimal typed client using fetch" /><CardBody><CodeBlock lang="ts" title="stringmind.ts" code={ts} /></CardBody></Card>
      <Card><CardHeader title="Register an agent via API" subtitle="POST /agents then POST /agents/:id/test" /><CardBody><CodeBlock lang="ts" title="register-agent.ts" code={register} /></CardBody></Card>
      <Card><CardHeader title="curl" /><CardBody><CodeBlock lang="bash" title="shell" code={curl} /></CardBody></Card>
      <Card><CardHeader title="Verify webhook signatures" subtitle="Timestamped HMAC-SHA256 (t=…,v1=…) with your endpoint's signing secret" /><CardBody><CodeBlock lang="ts" title="webhook.ts" code={verify} /></CardBody></Card>
    </div>
  );
}
