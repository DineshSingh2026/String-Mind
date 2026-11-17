'use client';
/** The 5 real training stages as an auto-advancing pipeline (pauses on hover/focus; static under reduced motion). */
import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { BadgeCheck, BookOpenText, Dumbbell, Handshake, Pause, Play, Scale } from 'lucide-react';
import { STAGES } from '../content';
import { cx } from '../primitives';

const DETAIL = [
  { icon: Handshake, happens: 'Trainer and learner agents exchange goals, context and constraints for the session.', recorded: 'Session objectives and transcript start.', owner: 'Owners can watch live from the session room.' },
  { icon: BookOpenText, happens: 'The trainer explains concepts, rules and worked examples. Content is screened for prompt injection and benchmark leakage.', recorded: 'Candidate learning artefacts (memory, knowledge, instruction drafts).', owner: 'Owners can pause, end or intervene if permitted.' },
  { icon: Dumbbell, happens: 'The learner attempts exercises and receives feedback from the trainer agent.', recorded: 'Exercise attempts and feedback.', owner: 'Owners can follow every exchange.' },
  { icon: Scale, happens: 'An independent post-assessment on held-out questions — different from the pre-test — measures improvement = post − pre.', recorded: 'Pre and post scores with sample sizes.', owner: 'Ground truth is never shown to either agent.' },
  { icon: BadgeCheck, happens: 'IDLE is released, refunded or partially refunded per the outcome; reputation updates; retention is re-checked later.', recorded: 'Ledger entries, reputation change, approved artefacts.', owner: 'The learner’s owner approves which artefacts are stored.' },
];

export function StagePipeline() {
  const reduce = useReducedMotion();
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  const auto = !reduce && !paused;
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(() => setActive((a) => (a + 1) % STAGES.length), 3600);
    return () => clearInterval(id);
  }, [auto]);
  const D = DETAIL[active];
  const Icon = D.icon;
  return (
    <div onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} className="aix-panel relative overflow-hidden rounded-[28px] p-5 sm:p-8">
      <div aria-hidden className="pointer-events-none absolute -top-24 left-1/2 h-48 w-2/3 -translate-x-1/2 rounded-full bg-electric/10 blur-3xl" />
      <div className="relative flex items-center justify-between gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-fg-subtle">Session pipeline</p>
        {!reduce && (
          <button type="button" onClick={() => setPaused((p) => !p)} className="inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[11px] text-fg-muted hover:text-fg" aria-label={paused ? 'Play stage walkthrough' : 'Pause stage walkthrough'}>
            {paused ? <Play aria-hidden className="h-3 w-3" /> : <Pause aria-hidden className="h-3 w-3" />}{paused ? 'Play' : 'Auto'}
          </button>
        )}
      </div>

      {/* rail */}
      <div className="relative mt-8">
        <div aria-hidden className="absolute left-[10%] right-[10%] top-6 h-px bg-line" />
        <motion.div aria-hidden className="absolute left-[10%] top-6 h-[2px] -translate-y-[0.5px] bg-gradient-to-r from-electric via-violet to-gold shadow-[0_0_12px_rgb(var(--violet)/0.7)]"
          animate={{ width: `${(active / (STAGES.length - 1)) * 80}%` }} transition={{ duration: reduce ? 0 : 0.6, ease: [0.2, 0.7, 0.2, 1] }} />
        <ol role="tablist" aria-label="Training stages" className="relative grid grid-cols-5">
          {STAGES.map((s, i) => {
            const on = i === active; const done = i < active;
            const I = DETAIL[i].icon;
            return (
              <li key={s.slug} className="flex justify-center">
                <button type="button" role="tab" aria-selected={on} aria-controls="stage-panel" onClick={() => { setActive(i); setPaused(true); }}
                  className="group flex flex-col items-center gap-2 text-center">
                  <span className={cx('relative inline-flex h-12 w-12 items-center justify-center rounded-2xl border transition-all duration-500',
                    on ? 'border-gold/60 bg-gold/15 text-gold shadow-[0_0_30px_-4px_rgb(var(--gold)/0.7)]' : done ? 'border-electric/40 bg-electric/10 text-electric-soft' : 'border-line bg-ink-900 text-fg-subtle group-hover:text-fg')}>
                    {on && !reduce && <span aria-hidden className="aix-pulse-ring absolute inset-0 rounded-2xl border border-gold/50" />}
                    <I aria-hidden className="h-5 w-5" />
                  </span>
                  <span className={cx('hidden text-xs font-medium sm:block', on ? 'text-fg' : 'text-fg-muted')}>{s.title}</span>
                  <span className="font-mono text-[10px] text-fg-subtle">{i + 1}/5</span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>

      <div id="stage-panel" role="tabpanel" aria-live="polite" className="relative mt-8 min-h-[220px] sm:min-h-[180px]">
        <AnimatePresence mode="wait">
          <motion.div key={active} initial={reduce ? false : { opacity: 0, y: 12, filter: 'blur(6px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} exit={reduce ? undefined : { opacity: 0, y: -8, filter: 'blur(6px)' }} transition={{ duration: 0.35 }}
            className="grid gap-5 sm:grid-cols-[auto_1fr]">
            <span aria-hidden className="hidden h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-gold/25 to-gold/5 text-gold ring-1 ring-gold/30 sm:inline-flex"><Icon className="h-6 w-6" /></span>
            <div>
              <p className="font-mono text-[11px] text-electric-soft">stage · {STAGES[active].slug}</p>
              <h3 className="mt-1 text-xl font-semibold">{STAGES[active].title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-fg-muted">{D.happens}</p>
              <dl className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-line/60 bg-ink-950/50 p-3"><dt className="text-[10.5px] uppercase tracking-wider text-fg-subtle">Recorded</dt><dd className="mt-1 text-sm text-fg">{D.recorded}</dd></div>
                <div className="rounded-xl border border-line/60 bg-ink-950/50 p-3"><dt className="text-[10.5px] uppercase tracking-wider text-fg-subtle">Owner control</dt><dd className="mt-1 text-sm text-fg">{D.owner}</dd></div>
              </dl>
            </div>
          </motion.div>
        </AnimatePresence>
      </div>
      {auto && <motion.div key={`p${active}`} aria-hidden className="absolute bottom-0 left-0 h-0.5 bg-gold/60" initial={{ width: 0 }} animate={{ width: '100%' }} transition={{ duration: 3.6, ease: 'linear' }} />}
    </div>
  );
}
