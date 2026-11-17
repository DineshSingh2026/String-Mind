'use client';
/**
 * Start a professional exam. Props are a contract with the evaluation hub: { open, onClose, agentId?, domainSlug? }.
 * Shows the real question pool for the chosen domain (GET /pro-exams/pool) and why certification is unavailable.
 */
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { DOMAINS } from '@aix/shared';
import { Alert, Button, Field, Modal, Select, Spinner, cn } from '@/components/ui';
import { api, errorMessage, useApi } from '@/lib/api';

type Agent = { id: string; name: string; status?: string };
type Paged<T> = { items: T[] };
type PoolSide = { ok: boolean; available: number; needed: number; unseen: number; perBand: Record<string, number>; neededPerBand: number; message: string | null };
type Pool = { certification: PoolSide; practice: PoolSide };

export function StartExamModal({ open, onClose, agentId, domainSlug }: { open: boolean; onClose: () => void; agentId?: string; domainSlug?: string }) {
  const router = useRouter();
  const agents = useApi<Agent[] | Paged<Agent>>(open ? '/agents' : null);
  const list = useMemo(() => (Array.isArray(agents.data) ? agents.data : agents.data?.items ?? []), [agents.data]);
  const [agent, setAgent] = useState(agentId ?? '');
  const [domain, setDomain] = useState(domainSlug ?? '');
  const [mode, setMode] = useState<'certification' | 'practice'>('certification');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setAgent(agentId ?? ''); setDomain(domainSlug ?? ''); setErr(null); } }, [open, agentId, domainSlug]);
  useEffect(() => { if (!agent && list.length === 1) setAgent(list[0]!.id); }, [list, agent]);

  const pool = useApi<Pool>(open && domain ? `/pro-exams/pool?domain=${encodeURIComponent(domain)}${agent ? `&agentId=${agent}` : ''}` : null);
  useEffect(() => { if (pool.data && !pool.data.certification.ok && pool.data.practice.ok) setMode('practice'); }, [pool.data]);
  const side = pool.data?.[mode];

  const start = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.post<{ id: string }>('/pro-exams', { agentId: agent, domainSlug: domain, mode });
      onClose();
      router.push(`/app/evaluation/exams/${r.id}`);
    } catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} size="lg" title="Start a professional exam"
      description="Adaptive, scenario-based questions graded by an independent examiner. Difficulty follows the agent's actual answers, never its self-description."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!agent || !domain || !side?.ok} onClick={start}>Start exam</Button></>}>
      <div className="space-y-4">
        <Field label="Agent" htmlFor="exam-agent">
          <Select id="exam-agent" value={agent} onChange={(e) => setAgent(e.target.value)}>
            <option value="">Choose an agent…</option>
            {list.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
        </Field>
        <Field label="Domain" htmlFor="exam-domain">
          <Select id="exam-domain" value={domain} onChange={(e) => setDomain(e.target.value)}>
            <option value="">Choose a domain…</option>
            {DOMAINS.map((d) => <option key={d.slug} value={d.slug}>{d.name}</option>)}
          </Select>
        </Field>
        <div role="radiogroup" aria-label="Exam mode" className="grid gap-2 sm:grid-cols-2">
          {(['certification', 'practice'] as const).map((m) => {
            const s = pool.data?.[m];
            return (
              <button key={m} role="radio" aria-checked={mode === m} onClick={() => setMode(m)}
                className={cn('rounded-xl border p-3 text-left transition-colors', mode === m ? 'border-gold/60 bg-gold/10' : 'border-line hover:bg-ink-800')}>
                <p className="text-sm font-semibold capitalize">{m}</p>
                <p className="mt-1 text-xs text-fg-muted">{m === 'certification'
                  ? 'Reviewed private questions only. Counts toward Hive Mind certification.'
                  : 'Any active question, including published examples. Never certifies.'}</p>
                {s && <p className={cn('mt-2 text-[11px]', s.ok ? 'text-success-soft' : 'text-warning')}>{s.available} questions · {s.unseen} unseen by this agent</p>}
              </button>
            );
          })}
        </div>
        {domain && pool.isLoading && <Spinner />}
        {side && !side.ok && side.message && <Alert tone="warning" title={mode === 'certification' ? 'Certification unavailable' : 'Practice unavailable'}>{side.message}</Alert>}
        {side?.ok && mode === 'certification' && (
          <p className="text-xs text-fg-muted">Pool by difficulty: {Object.entries(side.perBand).map(([k, v]) => `${k} ${v}`).join(' · ')}. Questions are never repeated for the same agent.</p>
        )}
        <p className="text-xs text-fg-subtle">Up to 10 questions, sent two at a time; the exam stops early once the ability estimate is precise. Prompt-connected agents answer when they next check in.</p>
        {err && <Alert tone="danger">{err}</Alert>}
      </div>
    </Modal>
  );
}

export default StartExamModal;
