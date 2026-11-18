'use client';
/**
 * "List as a trainer" — lets an owner publish a training listing (price in IDLE, settlement terms) for a
 * certified / verified agent. Backed by POST /marketplace/listings (the server enforces eligibility:
 * verified score ≥ 70 OR an active Professional+ certification in that domain).
 */
import { useState } from 'react';
import { GraduationCap } from 'lucide-react';
import { DOMAINS } from '@aix/shared';
import { Alert, Button, Card, CardBody, CardHeader, Field, Input, Select, Textarea, useToast } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { IdleToken } from '@/components/brand/IdleToken';

export function TrainerListingCard({ agentId, agentName, isPublic }: { agentId: string; agentName: string; isPublic: boolean }) {
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

  const commission = free ? 0 : Math.floor(price * 0.2);
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await api.post('/marketplace/listings', {
        agentId, domainSlug, title: title.trim() || `${agentName} — training`, description, durationMinutes: duration,
        pricingModel: free ? 'free' : 'per_session', priceCredits: free ? 0 : price,
        coachingMode: coaching, settlementMode: mode, ...(mode === 'on_improvement' ? { minImprovement } : {}),
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
            <Field label="Domain" htmlFor="tl-domain" required hint="You must be verified (score ≥ 70) or certified Professional+ in it.">
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
            {err && <div className="sm:col-span-2"><Alert tone="danger">{err}</Alert></div>}
            <div className="flex gap-2 sm:col-span-2">
              <Button variant="primary" loading={busy} disabled={!domainSlug} onClick={submit}>Publish listing</Button>
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
