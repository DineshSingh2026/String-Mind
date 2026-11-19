'use client';
/**
 * Agent command-deck header: a living logo in an orbit of the agent's own colour, a vital-signs strip (Experience,
 * capability, trainer level, sessions, cases) and a live pulse of what the agent just did. Everything shown is real data
 * from the API — a tile with no data says so instead of inventing a number.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Avatar } from '@/components/ui';
import { agentColor } from '@/components/brand/hex';
import { useApi } from '@/lib/api';

interface Score { domain: string; score: number; resolvedCount: number; replayScore: number | null; level?: string }
interface Profile { totals: { records: number; pending: number }; scores: Score[] }
interface Opp { items: { domain: string; name: string; level: string; qualified: boolean; listed: boolean }[] }
interface Act { items: { id: string; kind: string; at: string; source: string; meta: Record<string, unknown> }[] }
interface Sess { id: string; status: string; trainer?: { id?: string } | null; learner?: { id?: string } | null; trainerAgentId?: string; learnerAgentId?: string }

/** Smoothly counts up to `value` (respects reduced motion). */
function CountUp({ value, decimals = 0 }: { value: number; decimals?: number }) {
  const [v, setV] = useState(0); const raf = useRef(0);
  useEffect(() => {
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setV(value); return; }
    const t0 = performance.now(); const from = 0;
    const tick = (t: number) => { const k = Math.min(1, (t - t0) / 900); setV(from + (value - from) * (1 - (1 - k) ** 3)); if (k < 1) raf.current = requestAnimationFrame(tick); };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [value]);
  return <>{v.toFixed(decimals)}</>;
}

function Vital({ label, value, suffix, hint, accent }: { label: string; value: number | null; suffix?: string; hint?: string; accent: string }) {
  return (
    <div className="ah-vital relative overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] p-3.5 backdrop-blur" style={{ ['--ah-accent' as string]: accent }}>
      <div className="text-[10px] uppercase tracking-[0.25em] text-[color:var(--lux-gold)]/75">{label}</div>
      <div className="mt-1 font-lux text-4xl font-medium tabular-nums">{value == null ? <span className="text-fg-subtle">—</span> : <><CountUp value={value} decimals={value % 1 ? 1 : 0} />{suffix && <span className="ml-0.5 text-sm text-fg-muted">{suffix}</span>}</>}</div>
      {hint && <div className="mt-0.5 truncate text-[11px] text-fg-muted">{hint}</div>}
      <span aria-hidden className="ah-vital-bar absolute inset-x-0 bottom-0 h-[2px]" />
    </div>
  );
}

const LABEL: Record<string, string> = {
  'agent.create': 'Agent created', 'agent.test': 'Connection tested', 'agent.publish': 'Published to marketplace', 'experience.add': 'Experience recorded',
  'experience.import': 'History imported', 'experience.replay.start': 'Replay started', 'marketplace.listing.create': 'Training listing published',
};
const label = (k: string) => LABEL[k] ?? k.replace(/[._]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
const ago = (iso: string) => { const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };

export function AgentHero({ agent, badges, subtitle, actions, overallScore }: {
  agent: { id: string; name: string; avatarUrl?: string | null }; badges: ReactNode; subtitle: ReactNode; actions: ReactNode; overallScore: number | null;
}) {
  const c = agentColor(agent.id);
  const prof = useApi<Profile>(`/experience/agents/${agent.id}`, { refreshInterval: 30000 });
  const opp = useApi<Opp>(`/experience/agents/${agent.id}/opportunities`, { refreshInterval: 60000 });
  const act = useApi<Act>(`/owner/agents/${agent.id}/activity?page=1&pageSize=6`, { refreshInterval: 15000 });
  const sess = useApi<Sess[] | { items: Sess[] }>('/training/sessions', { refreshInterval: 30000 });

  const all = prof.data?.scores.find((s) => s.domain === 'all');
  const levels = opp.data?.items ?? [];
  const best = levels.find((l) => l.level === 'established') ?? levels.find((l) => l.level === 'provisional');
  const sessions = (Array.isArray(sess.data) ? sess.data : sess.data?.items ?? []).filter((s) => [s.trainerAgentId, s.learnerAgentId, s.trainer?.id, s.learner?.id].includes(agent.id));
  const live = sessions.filter((s) => s.status === 'active').length;

  return (
    <section className="ah-root lux-panel relative overflow-hidden rounded-[32px] p-6 sm:p-9" style={{ ['--ah-c1' as string]: c.solid, ['--ah-c2' as string]: c.deep }}>
      <div aria-hidden className="ah-aurora pointer-events-none absolute inset-0" />
      <div aria-hidden className="ah-grid pointer-events-none absolute inset-0" />
      <div className="relative grid gap-6 xl:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
            <div className="ah-orbit relative grid h-[124px] w-[124px] shrink-0 place-items-center">
              <span aria-hidden className="ah-ring ah-ring-1" /><span aria-hidden className="ah-ring ah-ring-2" /><span aria-hidden className="ah-sat" />
              <Avatar name={agent.name} seed={agent.id} src={agent.avatarUrl} size={96} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate font-lux text-5xl font-medium leading-tight sm:text-6xl"><span className="lux-title italic">{agent.name}</span></h1>
                {badges}
                {live > 0 && <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2.5 py-0.5 text-xs text-emerald-300"><span className="ah-live-dot" />{live} live session{live > 1 ? 's' : ''}</span>}
              </div>
              <p className="mt-1.5 text-sm text-fg-muted">{subtitle}</p>
              <div className="mt-4 flex flex-wrap gap-2">{actions}</div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Vital label="Experience" value={all?.score ?? (prof.data ? 0 : null)} suffix="/100" hint={all ? `${all.resolvedCount} real cases` : 'no recorded history yet'} accent="#ffb547" />
            <Vital label="Capability" value={overallScore} suffix="/100" hint="verified assessments" accent="#22d3ee" />
            <Vital label="Replay" value={all?.replayScore ?? null} suffix="/100" hint="decides like its past self" accent="#a78bfa" />
            <Vital label="Training sessions" value={sess.data ? sessions.length : null} hint={live ? `${live} running now` : 'as trainer or learner'} accent="#34d399" />
            <Vital label="Teaches" value={opp.data ? levels.filter((l) => l.qualified).length : null} suffix={opp.data ? ' topics' : undefined} hint={best ? `${best.level} in ${best.name}` : 'not a trainer yet'} accent="#ff4fa3" />
          </div>
        </div>

        <aside className="ah-pulse rounded-2xl border border-white/10 bg-black/20 p-4 backdrop-blur">
          <div className="mb-3 flex items-center justify-between"><h2 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">Live pulse</h2><span className="ah-live-dot" aria-label="live" /></div>
          {act.data?.items.length ? (
            <ol className="relative space-y-3 before:absolute before:inset-y-1 before:left-[5px] before:w-px before:bg-gradient-to-b before:from-white/25 before:to-transparent">
              {act.data.items.map((e, i) => (
                <li key={e.id} className="ah-pulse-item relative pl-5" style={{ animationDelay: `${i * 70}ms` }}>
                  <span aria-hidden className="absolute left-0 top-1.5 h-[11px] w-[11px] rounded-full border-2 border-[var(--ah-c1)] bg-ink-950" />
                  <div className="text-sm leading-snug">{label(e.kind)}</div>
                  <div className="text-[11px] text-fg-subtle">{ago(e.at)}</div>
                </li>
              ))}
            </ol>
          ) : <p className="text-sm text-fg-muted">{act.isLoading ? 'Listening…' : 'No activity yet. Connect the agent, record experience or start a session — it shows up here live.'}</p>}
        </aside>
      </div>
    </section>
  );
}
