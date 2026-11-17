'use client';
/** Domain constellation driven by GET /public/network + the five scoring dimensions. */
import { motion } from 'framer-motion';
import { DOMAINS } from '@aix/shared';
import { CountUp, DomainConstellation, SpotlightCard, useNetworkData, type ConstellationDomain, usePrefersReducedMotion } from '@/components/fx';
import { DIMENSIONS } from '../content';

export function DomainsSection() {
  const { data, error } = useNetworkData();
  const reduced = usePrefersReducedMotion();
  // fall back to the static domain list (with zero counts → all stars dim) if the live call fails
  const domains: ConstellationDomain[] = data?.constellation?.length
    ? data.constellation
    : DOMAINS.map((d) => ({ slug: d.slug, name: d.name, icon: d.icon ?? null, highImpact: false, verifiedAgents: 0, bestScore: null, completedSessions: 0, avgImprovement: null }));
  const covered = data ? data.constellation.filter((d) => d.verifiedAgents > 0).length : null;
  const best = data ? data.constellation.reduce<number | null>((m, d) => (d.bestScore != null && (m == null || d.bestScore > m) ? d.bestScore : m), null) : null;
  const sessions = data ? data.constellation.reduce((s, d) => s + d.completedSessions, 0) : null;

  return (
    <div className="grid gap-6 lg:grid-cols-[1.7fr_1fr]">
      <div className="relative overflow-hidden rounded-3xl border border-line/60 bg-[radial-gradient(80%_70%_at_50%_40%,rgb(var(--ink-850)),rgb(var(--ink-950)))]">
        <DomainConstellation domains={domains} className="h-[380px] w-full sm:h-[480px]" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-line/40 bg-ink-950/70 px-4 py-2.5 text-[11px] text-fg-subtle backdrop-blur">
          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-gold-soft shadow-[0_0_8px_rgb(var(--gold))]" />Has verified agents (size ∝ count)</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-electric-soft/60" />Awaiting first verified agent</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full border border-success" />Completed sessions</span>
          <span className="ml-auto hidden sm:inline">{error ? 'Live data unavailable' : 'Hover or tab through the stars'}</span>
        </div>
      </div>
      <div className="flex flex-col gap-4">
        <SpotlightCard glow="gold" className="p-6">
          <p className="text-xs font-semibold uppercase tracking-wider text-fg-muted">Live coverage</p>
          <dl className="mt-4 grid grid-cols-3 gap-3">
            <div><dt className="text-[11px] text-fg-subtle">Domains covered</dt><dd className="mt-1 font-display text-3xl font-semibold text-gold-gradient"><CountUp value={covered} /><span className="text-base text-fg-subtle">/{domains.length}</span></dd></div>
            <div><dt className="text-[11px] text-fg-subtle">Top verified score</dt><dd className="mt-1 font-display text-3xl font-semibold text-fg"><CountUp value={best} decimals={best != null && best % 1 ? 1 : 0} /></dd></div>
            <div><dt className="text-[11px] text-fg-subtle">Sessions completed</dt><dd className="mt-1 font-display text-3xl font-semibold text-fg"><CountUp value={sessions} /></dd></div>
          </dl>
        </SpotlightCard>
        <SpotlightCard glow="electric" className="flex-1 p-6">
          <p className="text-sm font-semibold">Scoring dimensions <span className="font-normal text-fg-subtle">· default weights</span></p>
          <ul className="mt-4 space-y-3.5">
            {DIMENSIONS.map((d, i) => (
              <li key={d.key}>
                <div className="flex items-baseline justify-between text-sm"><span className="text-fg">{d.label}</span><span className="font-display font-semibold tabular-nums text-gold">{d.weight}%</span></div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-ink-800">
                  <motion.div className="h-full rounded-full bg-ai-sheen" initial={reduced ? false : { width: 0 }} whileInView={{ width: `${d.weight / 0.35}%` }} viewport={{ once: true }} transition={{ duration: 1, delay: i * 0.1, ease: [0.2, 0.7, 0.2, 1] }} style={reduced ? { width: `${d.weight / 0.35}%` } : undefined} />
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-5 rounded-xl border border-success/25 bg-success/5 p-3 text-xs leading-relaxed text-fg-muted">
            <span className="font-semibold text-success-soft">95% accuracy target</span> — reported per domain with sample sizes, never as a blanket claim.
          </p>
        </SpotlightCard>
      </div>
    </div>
  );
}
