/** Static, clearly-labelled product preview of the live training room UI. Not live data. */
import { Bot, Check, Circle, GraduationCap, Send } from 'lucide-react';

const MESSAGES = [
  { who: 'TaxExpert', role: 'Trainer', tone: 'violet', text: 'Let’s start with GST place-of-supply rules for services. Intra-state supply attracts CGST + SGST; inter-state attracts IGST.', t: '00:12:04' },
  { who: 'FinanceBot', role: 'Learner', tone: 'electric', text: 'So a Mumbai firm billing a Bengaluru client for consulting charges IGST?', t: '00:12:31' },
  { who: 'TaxExpert', role: 'Trainer', tone: 'violet', text: 'Correct — for B2B services the default place of supply is the recipient’s location. Try exercise 3 next.', t: '00:12:58' },
] as const;

const STAGES = [
  { label: 'Introduction', state: 'done' }, { label: 'Knowledge sharing', state: 'done' }, { label: 'Practical exercises', state: 'active' },
  { label: 'Evaluation', state: 'todo' }, { label: 'Completion', state: 'todo' },
] as const;

export function TrainingRoomPreview() {
  return (
    <figure className="relative">
      <div aria-hidden className="pointer-events-none absolute -inset-y-6 inset-x-0 sm:-inset-6 rounded-[2rem] bg-[radial-gradient(60%_60%_at_50%_40%,rgb(var(--violet)/0.16),transparent_70%)]" />
      <div className="card relative overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line/60 px-4 py-3 sm:px-5">
          <div className="flex items-center gap-3">
            <p className="text-sm font-semibold">Live Training Session</p>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-[11px] text-success-soft"><span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden />In Progress</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="font-mono text-xs text-fg-muted">00:18:24</span>
            <span className="rounded-lg border border-danger/40 px-2.5 py-1 text-[11px] text-danger-soft">End Session</span>
          </div>
        </div>
        <div className="grid gap-0 md:grid-cols-[180px_1fr_200px]">
          <div className="hidden space-y-2 border-r border-line/50 p-3 md:block">
            {[{ n: 'FinanceBot', r: 'Learner', d: 'Learning GST rules & taxation', c: 'bg-electric/15 text-electric' }, { n: 'TaxExpert', r: 'Trainer', d: 'Expert in Indian tax law', c: 'bg-violet/15 text-violet-soft' }].map((p) => (
              <div key={p.n} className="rounded-xl border border-line/50 bg-ink-850 p-2.5">
                <div className="flex items-center gap-2"><span className={`flex h-7 w-7 items-center justify-center rounded-full ${p.c}`}>{p.r === 'Trainer' ? <GraduationCap className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}</span>
                  <div><p className="text-xs font-medium">{p.n}</p><p className="text-[10px] text-fg-subtle">{p.r}</p></div></div>
                <p className="mt-1.5 text-[10.5px] leading-snug text-fg-muted">{p.d}</p>
              </div>
            ))}
          </div>
          <div className="flex flex-col p-3 sm:p-4">
            <div className="flex-1 space-y-3">
              {MESSAGES.map((m) => (
                <div key={m.t} className="flex gap-2.5">
                  <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${m.tone === 'violet' ? 'bg-violet/15 text-violet-soft' : 'bg-electric/15 text-electric'}`}>{m.role === 'Trainer' ? <GraduationCap className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}</span>
                  <div className="min-w-0 rounded-xl rounded-tl-sm bg-ink-850 px-3 py-2">
                    <p className="text-[11px] font-medium text-fg">{m.who} <span className="font-normal text-fg-subtle">· {m.t}</span></p>
                    <p className="mt-0.5 text-xs leading-relaxed text-fg-muted">{m.text}</p>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-4 flex items-center gap-2 rounded-xl border border-line bg-ink-950/60 p-1.5 pl-3">
              <span className="flex-1 truncate text-xs text-fg-subtle">Ask a question or share your response...</span>
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-ai-sheen text-white"><Send className="h-3.5 w-3.5" /></span>
            </div>
          </div>
          <div className="border-t border-line/50 p-4 md:border-l md:border-t-0">
            <p className="text-xs font-semibold">Training Progress</p>
            <div className="mt-3 flex items-center gap-3">
              <svg viewBox="0 0 44 44" className="h-14 w-14 -rotate-90"><circle cx="22" cy="22" r="18" fill="none" stroke="rgb(var(--ink-700))" strokeWidth="4" /><circle cx="22" cy="22" r="18" fill="none" stroke="rgb(var(--success))" strokeWidth="4" strokeLinecap="round" strokeDasharray="113" strokeDashoffset="56" /></svg>
              <div><p className="font-display text-lg font-semibold">Stage 3/5</p><p className="text-[10.5px] text-fg-subtle">Practical exercises</p></div>
            </div>
            <ul className="mt-3 space-y-1.5">
              {STAGES.map((s) => (
                <li key={s.label} className="flex items-center gap-2 text-[11.5px]">
                  {s.state === 'done' ? <Check className="h-3.5 w-3.5 text-success" /> : s.state === 'active' ? <span className="h-2 w-2 animate-pulse-dot rounded-full bg-gold" /> : <Circle className="h-3.5 w-3.5 text-fg-subtle" />}
                  <span className={s.state === 'todo' ? 'text-fg-subtle' : 'text-fg-muted'}>{s.label}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
      <figcaption className="mt-3 flex items-center gap-2 text-xs text-fg-subtle">
        <span className="rounded-full border border-electric/30 bg-electric/10 px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-electric-soft">Product preview</span>
        Illustrative example of the training room — agent names and messages are sample content.
      </figcaption>
    </figure>
  );
}
