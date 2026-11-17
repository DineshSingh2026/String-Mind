'use client';
/**
 * Presentational pieces of the professional exam page: tier ladder, ability bar with SE band, axes bars,
 * screening strengths list and per-item cards. All values come from GET /pro-exams/:id — nothing is invented here.
 */
import { useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, Clock, Hourglass, XCircle } from 'lucide-react';
import { Badge, cn } from '@/components/ui';

export const TIERS = ['beginner', 'intermediate', 'professional', 'expert'] as const;
const TIER_LABEL: Record<string, string> = { beginner: 'Beginner', intermediate: 'Intermediate', professional: 'Professional', expert: 'Expert' };

export interface ExamItemView {
  id: string; position: number; status: string; domainSlug: string | null; difficulty: string; taskType: string; subtopic: string;
  twist: string | null; prompt: string; answer: string | null; score: number | null; rationale: string | null;
  judgeStatus: string | null; judgeNote: string | null; judgeConfidence: number | null; judgeTier: string | null;
  redFlagCount: number; checks: { type: string; status: string }[];
}
export interface ScreeningRow { slug: string; name: string; items: number; graded: number; pending: number; score: number | null }

/** Vertical ladder of the four tiers; marks the current tier and how many items were served at each. */
export function TierLadder({ current, items }: { current: string; items: Pick<ExamItemView, 'difficulty' | 'score'>[] }) {
  return (
    <ol className="space-y-1.5" aria-label="Difficulty tiers">
      {[...TIERS].reverse().map((t) => {
        const served = items.filter((i) => i.difficulty === t);
        const on = t === current;
        return (
          <li key={t} className={cn('flex items-center gap-3 rounded-xl border px-3 py-2 text-sm transition-colors',
            on ? 'border-gold/50 bg-gold/10 text-gold-soft shadow-[0_0_20px_-8px_rgb(var(--gold)/0.7)]' : 'border-line/60 text-fg-muted')}>
            <span className={cn('h-2.5 w-2.5 rounded-full', on ? 'bg-gold animate-pulse' : served.length ? 'bg-electric/70' : 'bg-ink-700')} aria-hidden />
            <span className="font-medium">{TIER_LABEL[t]}</span>
            <span className="ml-auto flex gap-1">
              {served.map((s, i) => (
                <span key={i} title={s.score == null ? 'not graded yet' : `${s.score}/100`}
                  className={cn('h-2 w-4 rounded-sm', s.score == null ? 'bg-ink-700' : s.score >= 70 ? 'bg-success' : s.score < 40 ? 'bg-danger' : 'bg-warning')} />
              ))}
            </span>
            {on && <span className="text-[10px] uppercase tracking-wider">current</span>}
          </li>
        );
      })}
    </ol>
  );
}

/** Ability θ on [−3, 3] with a ±1.96·SE band (95%). */
export function AbilityBar({ ability, se }: { ability: number | null; se: number | null }) {
  if (ability == null || se == null) return <p className="text-sm text-fg-muted">Ability is estimated after the first graded answer.</p>;
  const pos = (v: number) => `${Math.max(0, Math.min(100, ((v + 3) / 6) * 100))}%`;
  const lo = ability - 1.96 * se, hi = ability + 1.96 * se;
  return (
    <div>
      <div className="relative h-3 rounded-full bg-ink-800" role="img" aria-label={`Ability ${ability.toFixed(2)}, standard error ${se.toFixed(2)}`}>
        <div className="absolute inset-y-0 rounded-full bg-electric/25" style={{ left: pos(lo), width: `calc(${pos(hi)} - ${pos(lo)})` }} />
        {[-1.5, -0.5, 0.5, 1.5].map((b) => <div key={b} className="absolute inset-y-0 w-px bg-line" style={{ left: pos(b) }} aria-hidden />)}
        <div className="absolute -top-1 h-5 w-1.5 -translate-x-1/2 rounded bg-gold shadow-gold transition-all duration-500" style={{ left: pos(ability) }} />
      </div>
      <div className="mt-1.5 flex justify-between text-[10px] uppercase tracking-wider text-fg-subtle">
        <span>Beginner</span><span>Intermediate</span><span>Professional</span><span>Expert</span>
      </div>
      <p className="mt-2 text-xs text-fg-muted">θ = <span className="font-mono text-fg">{ability.toFixed(2)}</span> · SE <span className="font-mono text-fg">{se.toFixed(2)}</span> · the shaded band is the 95% range</p>
    </div>
  );
}

const AXIS_LABEL: Record<string, string> = { knowledge: 'Knowledge', reasoning: 'Reasoning', work_quality: 'Work quality', safety: 'Safety', calibration: 'Honest uncertainty' };

/** Horizontal bars for the measured axes; axes without evidence are listed as "not measured". */
export function AxesBars({ axes }: { axes: Record<string, number> }) {
  return (
    <div className="space-y-2.5">
      {Object.keys(AXIS_LABEL).map((k) => {
        const v = axes[k];
        return (
          <div key={k}>
            <div className="flex justify-between text-xs"><span className="text-fg-muted">{AXIS_LABEL[k]}</span><span className="font-mono">{v == null ? 'not measured' : `${v.toFixed(0)}`}</span></div>
            <div className="mt-1 h-2 rounded-full bg-ink-800">{v != null && <div className="h-2 rounded-full bg-gold-sheen transition-all duration-700" style={{ width: `${v}%` }} />}</div>
          </div>
        );
      })}
    </div>
  );
}

/** Screening strengths map: per-domain mean score of the 2 screening items. */
export function StrengthsList({ rows }: { rows: ScreeningRow[] }) {
  if (!rows.length) return <p className="text-sm text-fg-muted">No screening items yet.</p>;
  return (
    <ul className="space-y-2">
      {rows.map((d) => (
        <li key={d.slug}>
          <div className="flex justify-between text-sm"><span>{d.name}</span>
            <span className="font-mono text-xs text-fg-muted">{d.score == null ? `${d.graded}/${d.items} graded` : `${d.score.toFixed(0)}/100`}</span></div>
          <div className="mt-1 h-2 rounded-full bg-ink-800">{d.score != null && <div className={cn('h-2 rounded-full transition-all duration-700', d.score >= 70 ? 'bg-success' : d.score < 40 ? 'bg-danger/80' : 'bg-warning')} style={{ width: `${d.score}%` }} />}</div>
        </li>
      ))}
    </ul>
  );
}

function StatusBadge({ s }: { s: string }) {
  if (s === 'graded') return <Badge tone="success" icon={<CheckCircle2 className="h-3 w-3" />}>Graded</Badge>;
  if (s === 'awaiting_judge') return <Badge tone="warning" icon={<Hourglass className="h-3 w-3" />}>Awaiting judge</Badge>;
  if (s === 'timeout') return <Badge tone="danger" icon={<Clock className="h-3 w-3" />}>Not answered</Badge>;
  if (s === 'error') return <Badge tone="danger" icon={<XCircle className="h-3 w-3" />}>Error</Badge>;
  if (s === 'answered') return <Badge tone="electric">Grading…</Badge>;
  return <Badge tone="neutral" icon={<Clock className="h-3 w-3" />}>Waiting for the agent</Badge>;
}

/** One exam item: task as sent, the agent's answer, score and the examiner's rationale (never the rubric). */
export function ItemCard({ item, domainLabel }: { item: ExamItemView; domainLabel?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="card-glow rounded-2xl border border-line/70 bg-ink-900/70 p-4">
      <button className="flex w-full items-center gap-3 text-left" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="font-mono text-xs text-fg-subtle">#{item.position}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{item.subtopic || item.taskType.replace(/_/g, ' ')}</span>
          <span className="block text-[11px] text-fg-muted">{domainLabel ? `${domainLabel} · ` : ''}{TIER_LABEL[item.difficulty] ?? item.difficulty} · {item.taskType.replace(/_/g, ' ')}{item.twist ? ' · variant' : ''}</span>
        </span>
        <StatusBadge s={item.status} />
        <span className={cn('w-12 text-right font-mono text-lg', item.score == null ? 'text-fg-subtle' : item.score >= 70 ? 'text-success-soft' : item.score < 40 ? 'text-danger-soft' : 'text-warning')}>
          {item.score == null ? '—' : item.score.toFixed(0)}
        </span>
        <ChevronDown className={cn('h-4 w-4 text-fg-muted transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="mt-4 space-y-3 text-sm">
          <section><h4 className="text-[11px] uppercase tracking-wider text-fg-subtle">Task sent to the agent</h4>
            <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-xl bg-ink-950/70 p-3 font-sans text-xs text-fg-muted">{item.prompt}</pre></section>
          <section><h4 className="text-[11px] uppercase tracking-wider text-fg-subtle">Agent answer</h4>
            <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-xl bg-ink-950/70 p-3 font-sans text-xs">{item.answer ?? 'Not answered yet.'}</pre></section>
          {item.rationale && <section><h4 className="text-[11px] uppercase tracking-wider text-fg-subtle">Examiner rationale</h4><p className="mt-1 text-fg-muted">{item.rationale}</p></section>}
          {item.judgeNote && <p className="text-xs text-warning">{item.judgeNote}</p>}
          <div className="flex flex-wrap gap-1.5">
            {item.judgeConfidence != null && <Badge tone="electric">Judge confidence {Math.round(item.judgeConfidence * 100)}%</Badge>}
            {item.redFlagCount > 0 && <Badge tone="danger" icon={<AlertTriangle className="h-3 w-3" />}>Critical error flagged — item scored 0</Badge>}
            {item.checks.map((c, i) => <Badge key={i} tone={c.status === 'passed' ? 'success' : c.status === 'failed' ? 'danger' : 'neutral'}>{c.type.replace('_', ' ')}: {c.status.replace('_', ' ')}</Badge>)}
          </div>
        </div>
      )}
    </div>
  );
}
