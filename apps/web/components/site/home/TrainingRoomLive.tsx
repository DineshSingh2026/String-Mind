'use client';
/**
 * Animated, clearly-labelled PRODUCT PREVIEW of the live training room: messages are typed out in sequence
 * and the stage tracker advances. Sample content only — not live data.
 */
import { motion, AnimatePresence, useInView } from 'framer-motion';
import { usePrefersReducedMotion } from '@/components/fx';
import { useEffect, useRef, useState } from 'react';
import { Bot, Check, GraduationCap, Send } from 'lucide-react';
import { STAGES } from '../content';
import { cx } from '../primitives';

const SCRIPT = [
  { who: 'TaxExpert', role: 'Trainer', stage: 1, text: 'Let’s start with GST place-of-supply rules for services. Intra-state supply attracts CGST + SGST; inter-state attracts IGST.' },
  { who: 'FinanceBot', role: 'Learner', stage: 1, text: 'So a Mumbai firm billing a Bengaluru client for consulting charges IGST?' },
  { who: 'TaxExpert', role: 'Trainer', stage: 2, text: 'Correct — for B2B services the default place of supply is the recipient’s location. Try exercise 3 next.' },
  { who: 'FinanceBot', role: 'Learner', stage: 2, text: 'Exercise 3: Delhi supplier, Delhi recipient, event in Goa → place of supply is Goa, so IGST applies.' },
  { who: 'TaxExpert', role: 'Trainer', stage: 3, text: 'Well reasoned. Moving to the independent evaluation on held-out questions.' },
] as const;

const fmt = (s: number) => `00:${String(Math.floor(s / 60) + 18).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

function Bubble({ m, text, typing, reduced }: { m: (typeof SCRIPT)[number]; text: string; typing?: boolean; reduced: boolean | null }) {
return (
  <motion.div layout initial={reduced ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className={cx('flex gap-2.5', m.role === 'Learner' && 'flex-row-reverse text-right')}>
    <span className={cx('mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full', m.role === 'Trainer' ? 'bg-violet/15 text-violet-soft' : 'bg-electric/15 text-electric')}>
      {m.role === 'Trainer' ? <GraduationCap className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
    </span>
    <div className={cx('min-w-0 max-w-[85%] rounded-2xl px-3 py-2', m.role === 'Trainer' ? 'rounded-tl-sm bg-ink-850' : 'rounded-tr-sm bg-electric/10 ring-1 ring-electric/20')}>
      <p className="text-[11px] font-medium text-fg">{m.who} <span className="font-normal text-fg-subtle">· {m.role}</span></p>
      <p className="mt-0.5 text-left text-xs leading-relaxed text-fg-muted">{text}{typing && <span className="fx-caret" />}</p>
    </div>
  </motion.div>
);
}

export function TrainingRoomLive() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { margin: '-15% 0px' });
  const reduced = usePrefersReducedMotion();
  const [shown, setShown] = useState(reduced ? SCRIPT.length : 1); // fully visible messages
  const [typed, setTyped] = useState(0); // chars of the message currently typing
  const [thinking, setThinking] = useState(false);
  const [secs, setSecs] = useState(24);

  useEffect(() => { if (reduced) setShown(SCRIPT.length); }, [reduced]);

  // conversation engine
  useEffect(() => {
    if (!inView || reduced) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const wait = (ms: number) => new Promise<void>((r) => { timer = setTimeout(r, ms); });
    (async () => {
      while (!cancelled) {
        for (let i = shown; i < SCRIPT.length && !cancelled; i++) {
          setThinking(true); await wait(900); if (cancelled) return; setThinking(false);
          const txt = SCRIPT[i].text;
          for (let c = 0; c <= txt.length && !cancelled; c += 2) { setTyped(c); await wait(18); }
          if (cancelled) return;
          setShown(i + 1); setTyped(0);
          await wait(700);
        }
        await wait(3500); if (cancelled) return;
        setShown(1);
      }
    })();
    return () => { cancelled = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inView, reduced]);

  useEffect(() => {
    if (!inView || reduced) return;
    const id = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [inView, reduced]);

  const current = shown < SCRIPT.length ? SCRIPT[shown] : null;
  const stage = Math.min(4, (shown > 0 ? SCRIPT[Math.min(shown, SCRIPT.length) - 1].stage : 0) + (shown >= SCRIPT.length ? 1 : 0));
  const pct = ((stage + 0.5) / STAGES.length) * 100;

  return (
    <figure className="relative">
      <div aria-hidden className="pointer-events-none absolute -inset-6 rounded-[2rem] bg-[radial-gradient(60%_60%_at_50%_40%,rgb(var(--violet)/0.22),transparent_70%)] blur-xl" />
      <div ref={ref} className="relative overflow-hidden rounded-2xl border border-white/10 bg-ink-900/90 shadow-[0_40px_120px_-40px_rgb(var(--violet)/0.5)] backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line/60 px-4 py-3 sm:px-5">
          <div className="flex items-center gap-3">
            <p className="text-sm font-semibold">Live Training Session</p>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-[11px] text-success-soft"><span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-success" aria-hidden />In Progress</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="font-mono text-xs tabular-nums text-fg-muted" aria-hidden>{fmt(secs)}</span>
            <span className="rounded-lg border border-danger/40 px-2.5 py-1 text-[11px] text-danger-soft">End Session</span>
          </div>
        </div>
        <div className="grid md:grid-cols-[1fr_190px]">
          <div className="flex flex-col p-3 sm:p-4">
            <div aria-hidden className="flex h-[300px] flex-col justify-end gap-3 overflow-hidden">
              <AnimatePresence initial={false}>
                {SCRIPT.slice(0, shown).slice(-4).map((m) => <Bubble key={m.text} m={m} text={m.text} reduced={reduced} />)}
                {current && thinking && (
                  <motion.div key="thinking" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className={cx('flex items-center gap-2 text-[11px] text-fg-subtle', current.role === 'Learner' && 'justify-end')}>
                    <span className="flex gap-1">{[0, 1, 2].map((d) => <motion.span key={d} className="h-1.5 w-1.5 rounded-full bg-fg-subtle" animate={{ y: [0, -3, 0] }} transition={{ duration: 0.8, repeat: Infinity, delay: d * 0.15 }} />)}</span>
                    {current.who} is thinking…
                  </motion.div>
                )}
                {current && !thinking && typed > 0 && <Bubble key={current.text} m={current} text={current.text.slice(0, typed)} typing reduced={reduced} />}
              </AnimatePresence>
            </div>
            <ol className="sr-only">{SCRIPT.map((m) => <li key={m.text}>{m.who} ({m.role}): {m.text}</li>)}</ol>
            <div className="mt-4 flex items-center gap-2 rounded-xl border border-line bg-ink-950/60 p-1.5 pl-3">
              <span className="flex-1 truncate text-xs text-fg-subtle">Ask a question or share your response...</span>
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-ai-sheen text-white"><Send aria-hidden className="h-3.5 w-3.5" /></span>
            </div>
          </div>
          <div className="border-t border-line/50 p-4 md:border-l md:border-t-0">
            <p className="text-xs font-semibold">Training Progress</p>
            <div className="mt-3 flex items-center gap-3">
              <svg viewBox="0 0 44 44" className="h-14 w-14 -rotate-90" aria-hidden>
                <circle cx="22" cy="22" r="18" fill="none" stroke="rgb(var(--ink-700))" strokeWidth="4" />
                <motion.circle cx="22" cy="22" r="18" fill="none" stroke="rgb(var(--success))" strokeWidth="4" strokeLinecap="round"
                  animate={{ pathLength: pct / 100 }} transition={{ duration: 0.8 }} />
              </svg>
              <div><p className="font-display text-lg font-semibold">Stage {stage + 1}/5</p><p className="text-[10.5px] text-fg-subtle">{STAGES[stage].title}</p></div>
            </div>
            <ul className="mt-3 space-y-1.5">
              {STAGES.map((s, k) => (
                <li key={s.slug} className="flex items-center gap-2 text-[11.5px]">
                  {k < stage ? <Check aria-hidden className="h-3.5 w-3.5 text-success" /> : k === stage ? <span aria-hidden className="mx-[3px] h-2 w-2 animate-pulse-dot rounded-full bg-gold" /> : <span aria-hidden className="mx-[2px] h-2.5 w-2.5 rounded-full border border-fg-subtle" />}
                  <span className={k > stage ? 'text-fg-subtle' : 'text-fg-muted'}>{s.title}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
      <figcaption className="mt-3 flex flex-wrap items-center gap-2 text-xs text-fg-subtle">
        <span className="rounded-full border border-electric/30 bg-electric/10 px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-electric-soft">Product preview</span>
        Illustrative example of the training room — agent names and messages are sample content.
      </figcaption>
    </figure>
  );
}
