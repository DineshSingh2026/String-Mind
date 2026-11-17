'use client';
/** Interactive comparison of the five learning types — never conflated. */
import { useState, type KeyboardEvent } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Brain, Cpu, Database, FileCog, MessagesSquare, Check, X } from 'lucide-react';
import { LEARNING_TYPE_LABELS, type LearningType } from '@aix/shared';
import { cx } from '../primitives';

const TYPES: { k: LearningType; icon: typeof Brain; level: 0 | 1 | 2; persists: string; how: string; applied: string; survives: boolean; note: string; tone: string }[] = [
  { k: 'temporary_context', icon: MessagesSquare, level: 0, persists: 'This session only', how: 'Messages exchanged during a session.', applied: 'Inside the live session', survives: false, note: 'Not learning in any lasting sense — gone when the session ends.', tone: 'fg' },
  { k: 'persistent_memory', icon: Brain, level: 1, persists: 'Across sessions', how: 'Approved facts and rules stored for the agent and injected into future calls.', applied: 'By StringMind on each call', survives: true, note: 'Owner can view and delete individual memories.', tone: 'gold' },
  { k: 'knowledge_retrieval', icon: Database, level: 1, persists: 'Across sessions', how: 'Documents chunked and embedded; relevant passages retrieved per call.', applied: 'By StringMind on each call', survives: true, note: 'Only sources your organisation owns or has licensed.', tone: 'electric' },
  { k: 'instruction_update', icon: FileCog, level: 1, persists: 'Across sessions', how: 'A new versioned system instruction for the agent.', applied: 'By StringMind on each call', survives: true, note: 'Every change creates a version you can roll back.', tone: 'violet' },
  { k: 'fine_tuning', icon: Cpu, level: 2, persists: 'In the model', how: 'Provider-side training of model weights.', applied: 'Natively by the provider', survives: true, note: 'Only where the provider adapter supports it. Most do not.', tone: 'success' },
];
const LEVELS = ['Session', 'Via StringMind', 'Model weights'];
const TONE: Record<string, string> = { fg: 'text-fg-muted', gold: 'text-gold', electric: 'text-electric-soft', violet: 'text-violet-soft', success: 'text-success' };

export function LearningTypes() {
  const [i, setI] = useState(1);
  const reduce = useReducedMotion();
  const t = TYPES[i];
  const Icon = t.icon;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); setI((x) => (x + 1) % TYPES.length); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); setI((x) => (x - 1 + TYPES.length) % TYPES.length); }
  };
  return (
    <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
      <div role="tablist" aria-label="Learning types" aria-orientation="vertical" onKeyDown={onKey} className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0">
        {TYPES.map((x, n) => {
          const on = n === i; const I = x.icon;
          return (
            <button key={x.k} id={`lt-${x.k}`} role="tab" type="button" aria-selected={on} aria-controls="lt-panel" tabIndex={on ? 0 : -1} onClick={() => setI(n)}
              className={cx('relative flex shrink-0 items-center gap-3 rounded-2xl px-4 py-3 text-left text-sm transition lg:shrink', on ? 'text-fg' : 'text-fg-muted hover:bg-ink-900 hover:text-fg')}>
              {on && <motion.span layoutId="lt-active" className="absolute inset-0 rounded-2xl border border-gold/35 bg-gradient-to-r from-gold/[0.12] to-ink-900 shadow-[0_0_30px_-12px_rgb(var(--gold)/0.7)]" transition={{ type: 'spring', stiffness: 420, damping: 36 }} />}
              <I aria-hidden className={cx('relative h-4 w-4 shrink-0', on ? TONE[x.tone] : '')} />
              <span className="relative whitespace-nowrap font-medium lg:whitespace-normal">{LEARNING_TYPE_LABELS[x.k]}</span>
              <span className={cx('relative ml-auto hidden rounded-full px-1.5 py-0.5 text-[10px] lg:inline', x.survives ? 'bg-success/10 text-success-soft' : 'bg-danger/10 text-danger-soft')}>{x.survives ? 'persists' : 'ephemeral'}</span>
            </button>
          );
        })}
      </div>

      <div id="lt-panel" role="tabpanel" aria-labelledby={`lt-${t.k}`} className="aix-panel relative min-h-[360px] overflow-hidden rounded-[28px] p-6 sm:p-8">
        <div aria-hidden className="aix-dots pointer-events-none absolute inset-0 opacity-40 [mask-image:radial-gradient(60%_60%_at_80%_20%,#000,transparent)]" />
        <AnimatePresence mode="wait">
          <motion.div key={t.k} className="relative" initial={reduce ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={reduce ? undefined : { opacity: 0, y: -10 }} transition={{ duration: 0.3 }}>
            <div className="flex items-center gap-4">
              <span aria-hidden className={cx('inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-ink-800 ring-1 ring-line', TONE[t.tone])}><Icon className="h-6 w-6" /></span>
              <div>
                <p className="font-mono text-[11px] text-fg-subtle">{t.k}</p>
                <h3 className="text-2xl font-semibold">{LEARNING_TYPE_LABELS[t.k]}</h3>
              </div>
            </div>
            <p className="mt-5 max-w-2xl text-fg-muted">{t.how}</p>

            {/* persistence meter */}
            <div className="mt-8">
              <p className="text-[10.5px] uppercase tracking-[0.14em] text-fg-subtle">Where it lives</p>
              <div className="relative mt-3 grid grid-cols-3 gap-2">
                {LEVELS.map((l, n) => (
                  <div key={l} className={cx('relative rounded-xl border px-3 py-3 text-center text-xs transition', n === t.level ? 'border-transparent text-fg' : 'border-line/60 text-fg-subtle')}>
                    {n === t.level && <motion.span layoutId="lt-level" className="absolute inset-0 rounded-xl border border-gold/50 bg-gold/10" transition={{ type: 'spring', stiffness: 380, damping: 32 }} />}
                    <span className="relative">{l}</span>
                  </div>
                ))}
              </div>
            </div>

            <dl className="mt-6 grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-line/60 bg-ink-950/50 p-3.5"><dt className="text-[10.5px] uppercase tracking-wider text-fg-subtle">Lasts</dt><dd className="mt-1 text-sm text-fg">{t.persists}</dd></div>
              <div className="rounded-xl border border-line/60 bg-ink-950/50 p-3.5"><dt className="text-[10.5px] uppercase tracking-wider text-fg-subtle">Applied</dt><dd className="mt-1 text-sm text-fg">{t.applied}</dd></div>
              <div className="rounded-xl border border-line/60 bg-ink-950/50 p-3.5"><dt className="text-[10.5px] uppercase tracking-wider text-fg-subtle">Survives the session?</dt>
                <dd className={cx('mt-1 inline-flex items-center gap-1.5 text-sm font-medium', t.survives ? 'text-success-soft' : 'text-danger-soft')}>{t.survives ? <Check aria-hidden className="h-4 w-4" /> : <X aria-hidden className="h-4 w-4" />}{t.survives ? 'Yes' : 'No'}</dd></div>
            </dl>
            <p className="mt-5 rounded-xl border border-line/50 bg-ink-900/60 px-4 py-3 text-sm text-fg-muted">{t.note}</p>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
