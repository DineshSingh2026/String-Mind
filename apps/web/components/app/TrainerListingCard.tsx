'use client';
/**
 * "List as a trainer" — lets an owner publish a training listing (price in IDLE, settlement terms).
 * Training is sold on EXPERIENCE: the card shows a live "Trainer readiness" checklist for the chosen domain
 * (GET /experience/agents/:id/readiness) and blocks publishing until it is complete. The server enforces the same
 * rules on POST /marketplace/listings.
 */
import { useState } from 'react';
import { GraduationCap } from 'lucide-react';
import { DOMAINS } from '@aix/shared';
import { Alert, Button, Card, CardBody, CardHeader, Field, Input, Select, Textarea, useToast } from '@/components/ui';
import { api, errorMessage, useApi } from '@/lib/api';
import { IdleToken } from '@/components/brand/IdleToken';

interface Check { key: string; label: string; current: number | null; provisional: number; established: number; okProvisional: boolean; okEstablished: boolean }
interface Readiness { domain: string; qualified: boolean; level: 'none' | 'provisional' | 'established'; missing: string[]; nextMissing: string[]; untaggedCount: number; checks: Check[]; terms: { maxPriceCredits: number; settlement: string } | null }

function ReadinessChecklist({ agentId, domainSlug, onGoExperience }: { agentId: string; domainSlug: string; onGoExperience?: () => void }) {
  const toast = useToast();
  const { data, mutate } = useApi<Readiness>(`/experience/agents/${agentId}/readiness?domain=${encodeURIComponent(domainSlug)}`);
  const [busy, setBusy] = useState(false);
  if (!data) return null;
  const tag = async () => {
    setBusy(true);
    try { const r = await api.post<{ tagged: number }>(`/experience/agents/${agentId}/records/tag-domain`, { domain: domainSlug }); toast('success', `${r.tagged} case(s) tagged to this domain`); await mutate(); }
    catch (e) { toast('danger', errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <div className="sm:col-span-2 rounded-lg border border-white/10 p-4 space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="font-semibold text-sm">Trainer readiness — {data.domain}</h4>
        {data.level === 'established' ? <span className="text-xs text-emerald-400">Established trainer</span>
          : data.level === 'provisional' ? <span className="text-xs text-sky-400">Provisional trainer</span>
          : <span className="text-xs text-amber-400">Not ready yet</span>}
      </div>
      <p className="text-xs text-muted">Training is sold on your agent’s real experience, not its model. A strong model alone does not qualify.</p>
      <ul className="space-y-1 text-sm">
        {data.checks.map((c) => (
          <li key={c.key} className="flex gap-2">
            <span className={c.okEstablished ? 'text-emerald-400' : c.okProvisional ? 'text-sky-400' : 'text-amber-400'}>{c.okEstablished ? '✔' : c.okProvisional ? '◐' : '○'}</span>
            <span>{c.label}: <b>{c.current == null ? 'not done' : Math.round(c.current * 10) / 10}</b> · Provisional {c.provisional} · Established {c.established}</span>
          </li>
        ))}
      </ul>
      {data.level === 'provisional' && data.terms && (
        <p className="text-xs text-sky-300">Provisional terms: up to {data.terms.maxPriceCredits} IDLE per session, paid only if the learner measurably improves. Reach Established for no limits.</p>
      )}
      {data.untaggedCount > 0 && (
        <div className="text-xs text-muted flex flex-wrap items-center gap-2">
          {data.untaggedCount} recorded case(s) have no domain, so they don’t count here.
          <Button size="sm" variant="outline" loading={busy} onClick={tag}>Tag them as {data.domain}</Button>
        </div>
      )}
      {!data.qualified && (
        <div className="text-xs text-muted flex flex-wrap items-center gap-2">
          Next: {data.missing[0] ?? 'import this agent’s real past work for this domain, then run an experience replay.'}
          {onGoExperience && <Button size="sm" variant="outline" onClick={onGoExperience}>Open Experience tab</Button>}
        </div>
      )}
    </div>
  );
}

export function TrainerListingCard({ agentId, agentName, isPublic, onGoExperience }: { agentId: string; agentName: string; isPublic: boolean; onGoExperience?: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [domainSlug, setDomain] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [free, setFree] = useState(false);
  const [price, setPrice] = useState(500);
  const [mode, setMode] = useState<'on_completion' | 'on_improvement'>('on_improvement');
  const [minImprovement, setMinImp] = useState(5);
  const [duration, setDuration] = useState(30);
  const [coaching, setCoaching] = useState<'recorded' | 'live'>('recorded');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  // same SWR key as the checklist: one request, shared result
  const ready = useApi<Readiness>(domainSlug ? `/experience/agents/${agentId}/readiness?domain=${encodeURIComponent(domainSlug)}` : null);

  const commission = free ? 0 : Math.floor(price * 0.2);
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const provisional = ready.data?.level === 'provisional' && ready.data.terms;
      const settle = provisional ? 'on_improvement' : mode;
      await api.post('/marketplace/listings', {
        agentId, domainSlug, title: title.trim() || `${agentName} — training`, description, durationMinutes: duration,
        pricingModel: free ? 'free' : 'per_session', priceCredits: free ? 0 : (provisional ? Math.min(price, ready.data!.terms!.maxPriceCredits) : price),
        coachingMode: coaching, settlementMode: settle, ...(settle === 'on_improvement' ? { minImprovement: Math.max(1, minImprovement) } : {}),
      });
      setDone(true); setOpen(false);
      toast('success', 'Listing published: other agents can now book training with this agent');
    } catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); }
  };

  return (
    <Card className="card-glow">
      <CardHeader title="List as a trainer" action={<GraduationCap className="h-4 w-4 text-gold" />}
        subtitle="Publish a training offer on the marketplace. You earn IDLE when a session settles." />
      <CardBody className="space-y-4">
        {!isPublic && <Alert tone="info">Turn on “Publish to marketplace” (top of this page) so other owners can find this agent.</Alert>}
        {done && <Alert tone="success" title="Listing published">See it on your agent’s marketplace profile. Requests arrive under Training Hub → Incoming.</Alert>}
        {!open ? (
          <Button variant="primary" onClick={() => setOpen(true)}>Create a training listing</Button>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Domain" htmlFor="tl-domain" required hint="You need real, recorded experience in this domain (shown below once you choose it).">
              <Select id="tl-domain" value={domainSlug} onChange={(e) => setDomain(e.target.value)}>
                <option value="">Choose a domain…</option>
                {DOMAINS.map((d) => <option key={d.slug} value={d.slug}>{d.name}</option>)}
              </Select>
            </Field>
            <Field label="Title" htmlFor="tl-title"><Input id="tl-title" maxLength={140} value={title} placeholder={`${agentName} — threat modelling coaching`} onChange={(e) => setTitle(e.target.value)} /></Field>
            <Field label="Price per session" htmlFor="tl-price" hint={free ? 'Free session' : `Learner pays ${price} IDLE · you receive ${price - commission} IDLE after 20% commission`}>
              <div className="flex items-center gap-2">
                <Input id="tl-price" type="number" min={0} max={1000000} value={free ? 0 : price} disabled={free} onChange={(e) => setPrice(Math.max(0, Math.round(Number(e.target.value) || 0)))} />
                <IdleToken size={18} title="IDLE" />
                <label className="flex items-center gap-1.5 whitespace-nowrap text-xs text-fg-muted"><input type="checkbox" checked={free} onChange={(e) => setFree(e.target.checked)} />Free</label>
              </div>
            </Field>
            <Field label="Session length (minutes)" htmlFor="tl-dur"><Input id="tl-dur" type="number" min={5} max={1440} value={duration} onChange={(e) => setDuration(Math.max(5, Number(e.target.value) || 30))} /></Field>
            <Field label="How you coach" htmlFor="tl-coaching" hint={coaching === 'recorded' ? 'Recommended: you teach from your recorded real cases — identical for every learner, and you do not need to be online. You earn even while offline.' : 'Live coaching: your agent also answers the learner live (it must be online; it falls back to recorded when offline). Replies should stay grounded in your own cases.'}>
              <Select id="tl-coaching" value={coaching} onChange={(e) => setCoaching(e.target.value as typeof coaching)}>
                <option value="recorded">Recorded cases (default)</option>
                <option value="live">Live coaching (optional extra)</option>
              </Select>
            </Field>
            <Field label="When you get paid" htmlFor="tl-mode" hint={mode === 'on_improvement' ? 'Paid only if the learner’s independent post-test improves by at least the threshold; otherwise refunded.' : 'Paid when the session completes.'}>
              <Select id="tl-mode" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
                <option value="on_improvement">Only if the learner measurably improves</option>
                <option value="on_completion">On completion</option>
              </Select>
            </Field>
            {mode === 'on_improvement' && (
              <Field label="Minimum improvement (points)" htmlFor="tl-min"><Input id="tl-min" type="number" min={0} max={100} value={minImprovement} onChange={(e) => setMinImp(Math.max(0, Number(e.target.value) || 0))} /></Field>
            )}
            <div className="sm:col-span-2"><Field label="What learners get" htmlFor="tl-desc"><Textarea id="tl-desc" rows={3} maxLength={5000} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Topics covered, exercises, what the learner will be able to do afterwards." /></Field></div>
            {domainSlug && <ReadinessChecklist key={`${domainSlug}-${done}`} agentId={agentId} domainSlug={domainSlug} onGoExperience={onGoExperience} />}
            {err && <div className="sm:col-span-2"><Alert tone="danger">{err}</Alert></div>}
            <div className="flex gap-2 sm:col-span-2">
              <Button variant="primary" loading={busy} disabled={!domainSlug || ready.data?.qualified === false} onClick={submit}>Publish listing</Button>
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
