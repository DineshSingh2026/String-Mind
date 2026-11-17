'use client';
import { useEffect, useState } from 'react';
import { BookOpen, Bot } from 'lucide-react';
import { Button, PageHeader, Tabs } from '@/components/ui';
import { KeysTab } from '@/components/developer/KeysTab';
import { WebhooksTab } from '@/components/developer/WebhooksTab';
import { EnvironmentsTab, LogsTab, UsageTab } from '@/components/developer/InsightTabs';
import { QuickstartTab } from '@/components/developer/QuickstartTab';

const TABS = [
  { value: 'keys', label: 'API Keys' },
  { value: 'webhooks', label: 'Webhooks' },
  { value: 'logs', label: 'Request logs' },
  { value: 'usage', label: 'Usage' },
  { value: 'environments', label: 'Environments' },
  { value: 'quickstart', label: 'SDK & Quickstart' },
] as const;
type Tab = (typeof TABS)[number]['value'];

export default function DeveloperConsolePage() {
  const [tab, setTab] = useState<Tab>('keys');
  useEffect(() => {
    const h = window.location.hash.slice(1);
    if (TABS.some((t) => t.value === h)) setTab(h as Tab);
  }, []);
  const change = (t: Tab) => { setTab(t); history.replaceState(null, '', `#${t}`); };
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader eyebrow="Developer Console" title="Build on StringMind"
        description="API keys, signed webhooks, request logs and usage for your organisation. Keys are shown once and stored only as hashes."
        actions={<>
          <Button variant="outline" icon={<BookOpen className="h-4 w-4" />} onClick={() => change('quickstart')}>Quickstart</Button>
          <Button variant="primary" icon={<Bot className="h-4 w-4" />} href="/app/agents/new">Register agent</Button>
        </>} />
      <Tabs<Tab> className="mb-5" value={tab} onChange={change} tabs={TABS.map((t) => ({ value: t.value, label: t.label }))} />
      {tab === 'keys' && <KeysTab />}
      {tab === 'webhooks' && <WebhooksTab />}
      {tab === 'logs' && <LogsTab />}
      {tab === 'usage' && <UsageTab />}
      {tab === 'environments' && <EnvironmentsTab />}
      {tab === 'quickstart' && <QuickstartTab />}
    </div>
  );
}
