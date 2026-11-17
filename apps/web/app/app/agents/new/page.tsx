'use client';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Activity, ArrowLeft, ArrowRight, Check, CheckCircle2, Eye, EyeOff, Gauge, KeyRound, Sparkles, XCircle } from 'lucide-react';
import { Alert, Badge, Button, ErrorState, Field, Input, PageHeader, Select, Skeleton, Textarea, cn, useToast } from '@/components/ui';
import { api, errorMessage, useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { BackLink, Chip, ChipRow, DomainPicker } from '@/components/app/primitives';
import { listOf, type Agent, type ConnectionMethod, type Provider } from '@/components/app/types';

const STEPS = ['Provider', 'Model & connection', 'Credentials', 'Profile', 'Test & assess'] as const;

const METHODS: { value: ConnectionMethod; label: string; hint: string }[] = [
  { value: 'api_key', label: 'Provider API key', hint: 'Call the provider API with your key (encrypted at rest).' },
  { value: 'custom_rest', label: 'Custom REST', hint: 'StringMind POSTs messages to your HTTPS endpoint.' },
  { value: 'webhook', label: 'Webhook', hint: 'StringMind sends signed webhooks; your agent replies via callback.' },
  { value: 'a2a', label: 'A2A', hint: 'Agent-to-Agent protocol endpoint (agent card URL).' },
  { value: 'mcp', label: 'MCP', hint: 'Model Context Protocol server URL.' },
  { value: 'sandbox', label: 'Sandbox', hint: 'Built-in StringMind sandbox agent, no credentials needed.' },
];

function defaultMethod(p: Provider | undefined): ConnectionMethod {
  switch (p?.adapter) {
    case 'sandbox': return 'sandbox';
    case 'custom_rest': return 'custom_rest';
    case 'webhook': return 'webhook';
    case 'a2a': return 'a2a';
    case 'mcp': return 'mcp';
    default: return 'api_key';
  }
}

const ROLES = ['assistant', 'specialist', 'trainer', 'learner', 'researcher', 'support', 'other'];
const LANGS = ['English', 'Hindi', 'Spanish', 'French', 'German', 'Portuguese', 'Arabic', 'Japanese', 'Chinese', 'Tamil', 'Bengali'];

type TestResult = { ok: boolean; latencyMs?: number; error?: string; sample?: string };

export default function NewAgentPage() {
  const router = useRouter();
  const toast = useToast();
  const { can } = useSession();
  const { data: provData, error: provErr, isLoading: provLoading, mutate: reloadProv } = useApi<Provider[] | { items: Provider[] }>('/agents/providers');
  const providers = useMemo(() => {
    const list = listOf(provData).filter((p) => p.status !== 'disabled');
    return [...list].sort((a, b) => (a.slug === 'xai' ? -1 : b.slug === 'xai' ? 1 : 0));
  }, [provData]);

  const [step, setStep] = useState(0);
  const [providerSlug, setProviderSlug] = useState<string | null>(null);
  const provider = providers.find((p) => p.slug === providerSlug);
  const [model, setModel] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [modelVersion, setModelVersion] = useState('');
  const [method, setMethod] = useState<ConnectionMethod>('api_key');
  const [endpointUrl, setEndpointUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [role, setRole] = useState('assistant');
  const [languages, setLanguages] = useState<string[]>(['English']);
  const [claimed, setClaimed] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const [assessing, setAssessing] = useState(false);

  const effectiveModel = model === '__custom' ? customModel.trim() : model;
  const needsKey = method === 'api_key';
  const needsUrl = ['custom_rest', 'webhook', 'a2a', 'mcp'].includes(method);

  const pickProvider = (p: Provider) => {
    setProviderSlug(p.slug);
    setModel(p.defaultModels?.[0] ?? '__custom');
    setMethod(defaultMethod(p));
    setEndpointUrl('');
  };

  const stepValid = [
    !!provider,
    !!effectiveModel && !!method,
    method === 'sandbox' || ((!needsKey || apiKey.trim().length >= 8) && (!needsUrl || /^https?:\/\//.test(endpointUrl.trim()))),
    name.trim().length >= 2 && description.trim().length >= 1,
    true,
  ];

  const create = async () => {
    setCreating(true);
    try {
      const connection: Record<string, unknown> = { method };
      if (endpointUrl.trim()) connection.endpointUrl = endpointUrl.trim();
      if (apiKey.trim()) connection.apiKey = apiKey.trim();
      const a = await api.post<Agent>('/agents', {
        name: name.trim(), description: description.trim(), providerSlug, modelName: effectiveModel, modelVersion: modelVersion.trim() || undefined,
        instructions: instructions.trim() || undefined, role, languages, claimedDomains: claimed, connection,
      });
      setApiKey(''); // never keep the secret around after submission
      setAgent(a);
      setStep(4);
      toast('success', `${a.name} created. Now test the connection.`);
    } catch (e) {
      toast('danger', errorMessage(e));
    } finally { setCreating(false); }
  };

  const runTest = async () => {
    if (!agent) return;
    setTesting(true);
    try {
      const r = await api.post<TestResult>(`/agents/${agent.id}/test`);
      setTest(r);
      toast(r.ok ? 'success' : 'danger', r.ok ? 'Connection test passed' : `Connection test failed${r.error ? `: ${r.error}` : ''}`);
    } catch (e) {
      setTest({ ok: false, error: errorMessage(e) });
      toast('danger', errorMessage(e));
    } finally { setTesting(false); }
  };

  const assess = async () => {
    if (!agent) return;
    setAssessing(true);
    try {
      const r = await api.post<{ id: string }>('/assessments', { agentId: agent.id });
      toast('success', 'Capability assessment queued');
      router.push(`/app/assessments/${r.id}`);
    } catch (e) { toast('danger', errorMessage(e)); setAssessing(false); }
  };

  if (!can('agents.create')) {
    return <div><BackLink href="/app/agents">My agents</BackLink><Alert tone="warning" title="You can't connect agents">Your role in this organisation doesn't include the <code>agents.create</code> permission. Ask an owner or admin.</Alert></div>;
  }

  return (
    <div className="mx-auto max-w-3xl">
      <BackLink href="/app/agents">My agents</BackLink>
      <PageHeader title="Connect an agent" description="Bring any AI agent to StringMind. Credentials are encrypted and never shown again after you save them." />

      <ol className="mb-6 flex gap-2 overflow-x-auto pb-1" aria-label="Progress">
        {STEPS.map((s, i) => (
          <li key={s} aria-current={i === step ? 'step' : undefined} className={cn('flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-xs', i === step ? 'border-gold/50 bg-gold/10 text-gold-soft' : i < step ? 'border-success/30 text-success-soft' : 'border-line text-fg-subtle')}>
            <span className={cn('flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold', i < step ? 'bg-success text-ink-950' : i === step ? 'bg-gold text-ink-950' : 'bg-ink-800')}>{i < step ? <Check className="h-3 w-3" /> : i + 1}</span>{s}
          </li>
        ))}
      </ol>

      <div className="card p-5 sm:p-6">
        {step === 0 && (
          <div>
            <h2 className="mb-1 text-lg font-semibold">Choose a provider</h2>
            <p className="mb-4 text-sm text-fg-muted">Pick the platform your agent runs on.</p>
            {provErr ? <ErrorState error={provErr} onRetry={() => reloadProv()} />
              : provLoading ? <div className="grid gap-3 sm:grid-cols-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-20" />)}</div>
              : providers.length === 0 ? <Alert tone="warning">No providers are enabled on this StringMind instance.</Alert>
              : (
                <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Provider">
                  {providers.map((p) => {
                    const featured = p.slug === 'xai';
                    const sel = providerSlug === p.slug;
                    return (
                      <button key={p.id} type="button" role="radio" aria-checked={sel} onClick={() => pickProvider(p)}
                        className={cn('relative rounded-xl border p-4 text-left transition', sel ? 'border-gold/60 bg-gold/10' : featured ? 'border-electric/40 bg-electric/5 hover:border-electric/70 sm:col-span-2' : 'border-line hover:border-ink-600 hover:bg-ink-850')}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium">{p.name}</span>
                          {featured && <Badge tone="electric" icon={<Sparkles className="h-3 w-3" />}>Featured</Badge>}
                          {p.status !== 'active' && p.status !== 'enabled' && !featured && <Badge>{p.status}</Badge>}
                        </div>
                        <p className="mt-1 text-xs text-fg-muted">{p.adapter.replace(/_/g, ' ')}{p.defaultModels?.length ? ` · ${p.defaultModels.slice(0, 3).join(', ')}` : ''}</p>
                        {sel && <CheckCircle2 className="absolute bottom-3 right-3 h-4 w-4 text-gold" aria-hidden />}
                      </button>
                    );
                  })}
                </div>
              )}
          </div>
        )}

        {step === 1 && provider && (
          <div className="space-y-5">
            <h2 className="text-lg font-semibold">Model & connection</h2>
            <Field label="Model" htmlFor="model" required>
              <Select id="model" value={model} onChange={(e) => setModel(e.target.value)}>
                {provider.defaultModels?.map((m) => <option key={m} value={m}>{m}</option>)}
                <option value="__custom">Other / custom model…</option>
              </Select>
            </Field>
            {model === '__custom' && <Field label="Custom model name" htmlFor="cm" required><Input id="cm" value={customModel} onChange={(e) => setCustomModel(e.target.value)} placeholder="e.g. my-finetune-v2" /></Field>}
            <Field label="Model version (optional)" htmlFor="mv"><Input id="mv" value={modelVersion} onChange={(e) => setModelVersion(e.target.value)} placeholder="e.g. 2026-10-01" /></Field>
            <fieldset>
              <legend className="mb-2 text-xs font-medium text-fg-muted">Connection method</legend>
              <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Connection method">
                {METHODS.map((m) => (
                  <button key={m.value} type="button" role="radio" aria-checked={method === m.value} onClick={() => setMethod(m.value)}
                    className={cn('rounded-xl border p-3 text-left', method === m.value ? 'border-gold/60 bg-gold/10' : 'border-line hover:bg-ink-850')}>
                    <p className="text-sm font-medium">{m.label}</p><p className="mt-0.5 text-xs text-fg-muted">{m.hint}</p>
                  </button>
                ))}
              </div>
            </fieldset>
          </div>
        )}

        {step === 2 && provider && (
          <div className="space-y-5">
            <h2 className="flex items-center gap-2 text-lg font-semibold"><KeyRound className="h-5 w-5 text-gold" />Credentials</h2>
            {method === 'sandbox' ? (
              <Alert tone="info" title="No credentials needed">The sandbox agent runs inside StringMind — great for trying assessments and training flows.</Alert>
            ) : (
              <>
                <Field label={needsUrl ? (method === 'a2a' ? 'Agent card / endpoint URL' : method === 'mcp' ? 'MCP server URL' : 'Endpoint URL') : 'Base URL (optional)'} htmlFor="url" required={needsUrl}
                  hint={!needsUrl && provider.defaultBaseUrl ? `Defaults to ${provider.defaultBaseUrl}` : 'Must be reachable from the StringMind API server.'}>
                  <Input id="url" type="url" inputMode="url" value={endpointUrl} onChange={(e) => setEndpointUrl(e.target.value)} placeholder={provider.defaultBaseUrl ?? 'https://'} />
                </Field>
                <Field label={needsKey ? 'API key' : method === 'webhook' ? 'Signing secret / auth token (optional)' : 'Auth token (optional)'} htmlFor="key" required={needsKey}
                  hint="Encrypted at rest. StringMind only ever shows the last 4 characters after saving.">
                  <div className="relative">
                    <Input id="key" type={showKey ? 'text' : 'password'} autoComplete="off" spellCheck={false} value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={needsKey ? 'sk-…' : ''} className="pr-10 font-mono" />
                    <button type="button" onClick={() => setShowKey((s) => !s)} aria-label={showKey ? 'Hide key' : 'Show key while typing'} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-fg-subtle hover:text-fg">{showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button>
                  </div>
                </Field>
              </>
            )}
          </div>
        )}

        {step === 3 && (
          <div className="space-y-5">
            <h2 className="text-lg font-semibold">Agent profile</h2>
            <Field label="Name" htmlFor="name" required><Input id="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="e.g. TaxExpert" /></Field>
            <Field label="Description" htmlFor="desc" required><Textarea id="desc" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} placeholder="What does this agent do?" /></Field>
            <Field label="System instructions" htmlFor="instr" hint="Changing instructions later creates a new version you can roll back to."><Textarea id="instr" value={instructions} onChange={(e) => setInstructions(e.target.value)} className="min-h-[120px] font-mono text-xs" /></Field>
            <Field label="Role" htmlFor="role"><Select id="role" value={role} onChange={(e) => setRole(e.target.value)}>{ROLES.map((r) => <option key={r} value={r}>{r[0]!.toUpperCase() + r.slice(1)}</option>)}</Select></Field>
            <div>
              <p className="mb-2 text-xs font-medium text-fg-muted">Languages</p>
              <ChipRow label="Languages">{LANGS.map((l) => <Chip key={l} active={languages.includes(l)} onClick={() => setLanguages((x) => x.includes(l) ? x.filter((y) => y !== l) : [...x, l])}>{l}</Chip>)}</ChipRow>
            </div>
            <div>
              <p className="mb-1 text-xs font-medium text-fg-muted">Claimed domains</p>
              <p className="mb-2 text-xs text-fg-subtle">Claims are labelled “claimed” and never used for ranking. Only independent assessment produces verified scores.</p>
              <DomainPicker value={claimed} onChange={setClaimed} />
            </div>
          </div>
        )}

        {step === 4 && agent && (
          <div className="space-y-5">
            <h2 className="text-lg font-semibold">Test connection</h2>
            <p className="text-sm text-fg-muted"><strong className="text-fg">{agent.name}</strong> is saved as a draft. A passing test activates it.</p>
            <Button variant="ai" loading={testing} onClick={runTest} icon={<Activity className="h-4 w-4" />}>{test ? 'Run test again' : 'Test connection'}</Button>
            {test && (
              <div role="status" className={cn('rounded-xl border p-4', test.ok ? 'border-success/40 bg-success/5' : 'border-danger/40 bg-danger/5')}>
                <p className="flex items-center gap-2 font-medium">{test.ok ? <CheckCircle2 className="h-5 w-5 text-success" /> : <XCircle className="h-5 w-5 text-danger" />}{test.ok ? 'Connected' : 'Connection failed'}{test.latencyMs != null && <span className="text-xs font-normal text-fg-muted">· {test.latencyMs} ms</span>}</p>
                {test.error && <p className="mt-1 text-sm text-danger-soft">{test.error}</p>}
                {test.sample && <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-ink-950 p-3 font-mono text-xs text-fg-muted">{test.sample}</pre>}
              </div>
            )}
            {test?.ok && (
              <div className="rounded-xl border border-gold/30 bg-gold/5 p-4">
                <p className="font-medium">Next: run a capability assessment</p>
                <p className="mt-1 text-sm text-fg-muted">StringMind tests your agent across domains with held-out benchmarks to produce verified scores.</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {can('assessments.run') && <Button variant="primary" loading={assessing} onClick={assess} icon={<Gauge className="h-4 w-4" />}>Run capability assessment</Button>}
                  <Button variant="outline" href={`/app/agents/${agent.id}`}>Go to agent</Button>
                </div>
              </div>
            )}
            {test && !test.ok && <p className="text-xs text-fg-subtle">Fix the credentials from the agent’s Overview tab, then test again. <a className="text-electric-soft underline" href={`/app/agents/${agent.id}`}>Open agent</a></p>}
          </div>
        )}

        {step < 4 && (
          <div className="mt-6 flex items-center justify-between gap-3 border-t border-line/60 pt-4">
            <Button variant="ghost" disabled={step === 0} onClick={() => setStep((s) => s - 1)} icon={<ArrowLeft className="h-4 w-4" />}>Back</Button>
            {step < 3
              ? <Button variant="primary" disabled={!stepValid[step]} onClick={() => setStep((s) => s + 1)}>Continue <ArrowRight className="h-4 w-4" /></Button>
              : <Button variant="primary" disabled={!stepValid[3] || !stepValid[2]} loading={creating} onClick={create}>Create agent <ArrowRight className="h-4 w-4" /></Button>}
          </div>
        )}
      </div>
    </div>
  );
}
