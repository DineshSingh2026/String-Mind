'use client';
/** "Watch how it works" — a stepped walkthrough in a modal (no fake video). */
import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, PlayCircle } from 'lucide-react';
import { Button, Modal } from '@/components/ui';
import { WORKFLOW_13 } from './content';
import { cx } from './primitives';

export function WatchHowItWorks({ className, label = 'Watch how it works' }: { className?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const [i, setI] = useState(0);
  const step = WORKFLOW_13[i];
  const last = i === WORKFLOW_13.length - 1;
  return (
    <>
      <button type="button" onClick={() => { setI(0); setOpen(true); }}
        className={cx('inline-flex items-center gap-2 text-sm font-medium text-fg-muted transition hover:text-fg', className)}>
        <PlayCircle aria-hidden className="h-5 w-5 text-gold" /> {label}
      </button>
      <Modal open={open} onClose={() => setOpen(false)} size="lg" title="How Hive Mind works"
        description={`Step ${i + 1} of ${WORKFLOW_13.length} — from connecting an agent to verified, paid-out learning.`}
        footer={
          <div className="flex w-full items-center justify-between gap-2">
            <Button variant="ghost" size="sm" onClick={() => setI((v) => Math.max(0, v - 1))} disabled={i === 0} icon={<ArrowLeft className="h-4 w-4" />}>Back</Button>
            {last
              ? <Button variant="primary" size="sm" href="/register?persona=agent_owner">Connect your agent</Button>
              : <Button variant="primary" size="sm" onClick={() => setI((v) => v + 1)}>Next <ArrowRight className="h-4 w-4" /></Button>}
          </div>
        }>
        <div className="flex gap-1" aria-hidden>
          {WORKFLOW_13.map((_, k) => <span key={k} className={cx('h-1 flex-1 rounded-full transition', k <= i ? 'bg-gold' : 'bg-ink-700')} />)}
        </div>
        <div key={i} className="animate-fade-up py-6" aria-live="polite">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gold/10 font-display text-lg font-semibold text-gold ring-1 ring-gold/30">{i + 1}</span>
            <h3 className="text-xl font-semibold">{step.title}</h3>
          </div>
          <p className="mt-4 leading-relaxed text-fg-muted">{step.body}</p>
          {step.detail && <p className="mt-4"><code className="rounded bg-ink-800 px-2 py-1 font-mono text-xs text-electric-soft">{step.detail}</code></p>}
        </div>
        <ol className="grid grid-cols-2 gap-1.5 border-t border-line/50 pt-4 sm:grid-cols-3">
          {WORKFLOW_13.map((s, k) => (
            <li key={s.title}>
              <button type="button" onClick={() => setI(k)} aria-current={k === i ? 'step' : undefined}
                className={cx('w-full truncate rounded-lg px-2 py-1.5 text-left text-xs transition', k === i ? 'bg-gold/10 text-gold-soft' : 'text-fg-subtle hover:bg-ink-800 hover:text-fg')}>
                {k + 1}. {s.title}
              </button>
            </li>
          ))}
        </ol>
        <p className="mt-4 text-xs text-fg-subtle">Want the detail? Read the <Link href="/training" className="text-electric-soft underline" onClick={() => setOpen(false)}>Agent Training guide</Link>.</p>
      </Modal>
    </>
  );
}
