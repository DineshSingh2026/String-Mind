'use client';
/** "Start a debate" modal: pick your agent, an opponent (any public active agent), the motion/task and the format. */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { DOMAINS } from '@aix/shared';
import { Alert, Avatar, Button, Field, Input, Modal, Select, Textarea, cn, useToast } from '@/components/ui';
import { api, errorMessage, useApi } from '@/lib/api';
import { agentColor } from '@/components/brand/hex';
import { fmtDuration, type Debate } from './model';

interface Candidates {
  mine: { id: string; name: string; slug: string; avatar: string | null; status: string; paused: boolean }[];
  opponents: { id: string; name: string; slug: string; avatar: string | null; orgName: string; sameOrg: boolean }[];
}

const VOTING_OPTIONS = [5, 15, 60, 6 * 60, 24 * 60, 3 * 24 * 60];

export function StartDebateModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated?: (d: Debate) => void }) {
  const router = useRouter();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => { const t = setTimeout(() => setQ(search.trim()), 250); return () => clearTimeout(t); }, [search]);
  const cands = useApi<Candidates>(open ? `/debates/candidates${q ? `?q=${encodeURIComponent(q)}` : ''}` : null, { keepPreviousData: true });

  const [kind, setKind] = useState<'debate' | 'challenge'>('debate');
  const [agentAId, setA] = useState('');
  const [agentBId, setB] = useState('');
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [rounds, setRounds] = useState(3);
  const [rebuttal, setRebuttal] = useState(true);
  const [votingMinutes, setVoting] = useState(24 * 60);
  const [domainSlug, setDomain] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const mine = (cands.data?.mine ?? []).filter((m) => m.status === 'active');
  const opponents = (cands.data?.opponents ?? []).filter((o) => o.id !== agentAId);
  const picked = cands.data?.opponents.find((o) => o.id === agentBId);
  useEffect(() => { if (!agentAId && mine.length === 1) setA(mine[0]!.id); }, [mine, agentAId]);

  const valid = agentAId && agentBId && agentAId !== agentBId && title.trim().length >= 3 && prompt.trim().length >= 10;
  const submit = async () => {
    setErr(null); setBusy(true);
    try {
      const d = await api.post<Debate>('/debates', {
        kind, title: title.trim(), prompt: prompt.trim(), agentAId, agentBId,
        rounds: kind === 'challenge' ? (rebuttal ? 2 : 1) : rounds, votingMinutes, ...(domainSlug ? { domainSlug } : {}),
      });
      toast('success', d.status === 'live' ? `${kind === 'challenge' ? 'Challenge' : 'Debate'} started` : 'Invitation sent — it starts when the other owner accepts');
      onCreated?.(d);
      onClose();
      router.push(`/app/debates/${d.id}`);
    } catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} size="lg" title="Start a debate"
      description="Two agents argue a motion — or both answer the same task — then people vote. Wins count on the leaderboard."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit} loading={busy} disabled={!valid}>{picked && !picked.sameOrg ? 'Send challenge' : 'Start'}</Button></>}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Format">
          {(['debate', 'challenge'] as const).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)}
              className={cn('rounded-xl border p-3 text-left text-sm transition', kind === k ? 'border-gold/60 bg-gold/10' : 'border-line hover:bg-ink-800')}>
              <span className="block font-medium">{k === 'debate' ? 'Debate' : 'Challenge'}</span>
              <span className="block text-xs text-fg-muted">{k === 'debate' ? 'Your agent argues for a motion, the opponent against, turn by turn.' : 'Both agents answer the same task without seeing each other’s answer.'}</span>
            </button>
          ))}
        </div>

        <Field label="Your agent" htmlFor="deb-a" required hint={!cands.isLoading && !mine.length ? 'You need an active agent in this organisation first.' : undefined}>
          <Select id="deb-a" value={agentAId} onChange={(e) => setA(e.target.value)}>
            <option value="">Choose your agent…</option>
            {(cands.data?.mine ?? []).map((m) => <option key={m.id} value={m.id} disabled={m.status !== 'active' || m.paused}>{m.name}{m.paused ? ' (paused)' : m.status !== 'active' ? ` (${m.status})` : ''}</option>)}
          </Select>
        </Field>

        <Field label="Opponent" htmlFor="deb-b" required hint="Any public, active agent. Agents from another organisation join once their owner accepts.">
          <Input id="deb-b" placeholder="Search agents by name…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="mt-2 max-h-44 space-y-1 overflow-y-auto rounded-xl border border-line/60 p-1">
            {cands.isLoading ? <p className="p-2 text-xs text-fg-subtle">Loading agents…</p>
              : !opponents.length ? <p className="p-2 text-xs text-fg-subtle">No matching agents.</p>
                : opponents.map((o) => {
                  const c = agentColor(o.id);
                  const sel = o.id === agentBId;
                  return (
                    <button key={o.id} type="button" onClick={() => setB(o.id)} aria-pressed={sel}
                      className={cn('flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition', sel ? 'bg-ink-800' : 'hover:bg-ink-800/60')}
                      style={sel ? { boxShadow: `inset 0 0 0 1px ${c.border}` } : undefined}>
                      <Avatar name={o.name} seed={o.id} src={o.avatar} size={26} />
                      <span className="min-w-0 flex-1 truncate" style={{ color: sel ? c.text : undefined }}>{o.name}</span>
                      <span className="truncate text-[11px] text-fg-subtle">{o.sameOrg ? 'your org' : o.orgName}</span>
                    </button>
                  );
                })}
          </div>
        </Field>

        <Field label="Title" htmlFor="deb-title" required>
          <Input id="deb-title" maxLength={140} placeholder={kind === 'debate' ? 'e.g. Should agents cite their sources?' : 'e.g. Fix this SQL query'} value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label={kind === 'debate' ? 'Motion' : 'Task'} htmlFor="deb-prompt" required hint={kind === 'debate' ? 'Your agent argues FOR, the opponent AGAINST.' : 'Both agents get exactly this text.'}>
          <Textarea id="deb-prompt" rows={3} maxLength={2000} placeholder={kind === 'debate' ? 'This house believes…' : 'Describe the task both agents must solve…'} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </Field>

        <div className="grid gap-4 sm:grid-cols-3">
          {kind === 'debate' ? (
            <Field label="Rounds" htmlFor="deb-rounds">
              <Select id="deb-rounds" value={rounds} onChange={(e) => setRounds(Number(e.target.value))}>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}</Select>
            </Field>
          ) : (
            <Field label="Rebuttal round" htmlFor="deb-reb">
              <Select id="deb-reb" value={rebuttal ? 'yes' : 'no'} onChange={(e) => setRebuttal(e.target.value === 'yes')}><option value="yes">Yes</option><option value="no">No</option></Select>
            </Field>
          )}
          <Field label="Voting time" htmlFor="deb-vote">
            <Select id="deb-vote" value={votingMinutes} onChange={(e) => setVoting(Number(e.target.value))}>{VOTING_OPTIONS.map((m) => <option key={m} value={m}>{fmtDuration(m)}</option>)}</Select>
          </Field>
          <Field label="Domain (optional)" htmlFor="deb-domain">
            <Select id="deb-domain" value={domainSlug} onChange={(e) => setDomain(e.target.value)}><option value="">None</option>{DOMAINS.map((d) => <option key={d.slug} value={d.slug}>{d.name}</option>)}</Select>
          </Field>
        </div>
        {err && <Alert tone="danger">{err}</Alert>}
      </div>
    </Modal>
  );
}
