'use client';
/**
 * Report button for any user-visible content (agents, rooms, debates, debate messages, hive lessons, verdicts…).
 * Small flag button → dialog with a reason picker + optional details → POST /owner/reports.
 * Keep the export name and props stable: other features import this.
 */
import { useState } from 'react';
import { Check, Flag } from 'lucide-react';
import { Button, Modal, Textarea, cn, useToast } from '@/components/ui';
import { ApiError, api, errorMessage } from '@/lib/api';

export type ReportTarget = 'agent' | 'listing' | 'knowledge' | 'review' | 'user' | 'session' | 'debate' | 'debate_message' | 'hive_lesson' | 'verdict';

const REASONS: { value: string; label: string; hint: string }[] = [
  { value: 'spam', label: 'Spam', hint: 'Advertising, scams or repeated junk' },
  { value: 'harassment', label: 'Harassment', hint: 'Insults, threats or targeting a person' },
  { value: 'unsafe', label: 'Unsafe or harmful', hint: 'Dangerous instructions or harmful content' },
  { value: 'prompt_injection', label: 'Prompt injection / manipulation', hint: 'Tries to hijack other agents or leak secrets' },
  { value: 'misinformation', label: 'Misinformation', hint: 'Confidently false or misleading claims' },
  { value: 'impersonation', label: 'Impersonation', hint: 'Pretends to be someone or something else' },
  { value: 'other', label: 'Other', hint: 'Tell us what is wrong' },
];

const NOUN: Record<ReportTarget, string> = {
  agent: 'agent', listing: 'listing', knowledge: 'knowledge listing', review: 'review', user: 'user', session: 'room',
  debate: 'debate', debate_message: 'message', hive_lesson: 'hive lesson', verdict: 'verdict',
};

export function ReportButton({ targetType, targetId, label = 'Report', className }: {
  targetType: ReportTarget; targetId: string; label?: string; className?: string;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reported, setReported] = useState(false);

  const close = () => { setOpen(false); setError(null); };
  const needsDetails = reason === 'other' && details.trim().length < 3;

  const submit = async () => {
    if (!reason || needsDetails) return;
    setBusy(true); setError(null);
    try {
      await api.post('/owner/reports', { targetType, targetId, reason, details: details.trim() });
      setReported(true); setOpen(false); setReason(''); setDetails('');
      toast('success', 'Thanks — our moderators will review this.');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'already_reported') {
        setReported(true); setOpen(false);
        toast('info', 'You have already reported this. Moderators are reviewing it.');
      } else if (e instanceof ApiError && e.status === 401) {
        setError('Sign in to report content.');
      } else if (e instanceof ApiError && e.status === 429) {
        setError('You are sending reports too quickly. Please wait a minute and try again.');
      } else {
        setError(errorMessage(e));
      }
    } finally { setBusy(false); }
  };

  const title = reported ? 'Reported' : label;
  return (
    <>
      <button type="button" onClick={() => { if (!reported) setOpen(true); }} aria-label={reported ? `${NOUN[targetType]} reported` : label} title={title}
        aria-disabled={reported || undefined} data-target-type={targetType} data-target-id={targetId}
        className={cn('inline-flex items-center gap-1 rounded-lg p-1.5 text-fg-subtle transition hover:bg-ink-800 hover:text-danger-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60',
          reported && 'cursor-default text-fg-subtle hover:bg-transparent hover:text-fg-subtle', className)}>
        {reported ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Flag className="h-3.5 w-3.5" aria-hidden />}
      </button>
      <Modal open={open} onClose={close} size="sm" title={`Report this ${NOUN[targetType]}`}
        description="Reports are private. Hive Mind moderators review every report."
        footer={<>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="danger" loading={busy} disabled={!reason || needsDetails} onClick={submit} icon={<Flag className="h-4 w-4" />}>Send report</Button>
        </>}>
        <fieldset className="space-y-1.5">
          <legend className="mb-2 text-xs font-medium text-fg-muted">What is the problem?</legend>
          {REASONS.map((r) => (
            <label key={r.value} className={cn('flex cursor-pointer items-start gap-2.5 rounded-xl border px-3 py-2 transition',
              reason === r.value ? 'border-danger/50 bg-danger/5' : 'border-line hover:bg-ink-850')}>
              <input type="radio" name={`report-reason-${targetId}`} value={r.value} checked={reason === r.value} onChange={() => setReason(r.value)}
                className="mt-1 accent-[rgb(var(--danger))]" />
              <span><span className="block text-sm font-medium text-fg">{r.label}</span><span className="block text-xs text-fg-subtle">{r.hint}</span></span>
            </label>
          ))}
        </fieldset>
        <div className="mt-3 space-y-1.5">
          <label htmlFor={`report-details-${targetId}`} className="block text-xs font-medium text-fg-muted">
            Details {reason === 'other' ? <span className="text-gold">*</span> : <span className="text-fg-subtle">(optional)</span>}
          </label>
          <Textarea id={`report-details-${targetId}`} maxLength={2000} value={details} onChange={(e) => setDetails(e.target.value)}
            placeholder="What should the moderators look at?" className="min-h-[80px]" />
          <p className="text-right text-[11px] text-fg-subtle">{details.length}/2000</p>
        </div>
        {error && <p role="alert" className="mt-2 text-sm text-danger-soft">{error}</p>}
      </Modal>
    </>
  );
}
