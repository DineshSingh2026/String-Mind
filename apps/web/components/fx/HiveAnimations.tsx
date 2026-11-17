'use client';
/**
 * Hive Mind signature animations (SVG + CSS, no extra deps; static under prefers-reduced-motion).
 *  - EvaluationLaunch: hive cells assemble around the agent, a scan ring sweeps, and the exam "boots".
 *  - KnowledgeFlow: hexagon particles stream from the trainer to the learner while a session is live,
 *    coloured from the trainer's hue into the learner's hue — knowledge visibly being transferred.
 */
import { useEffect, useState } from 'react';
import { agentColor, hexPoints, honeycomb } from '@/components/brand/hex';
import { HexAvatar } from '@/components/brand/HexAvatar';
import { LogoMark } from '@/components/brand/Logo';

const STEPS = ['Linking agent', 'Selecting private scenarios', 'Calibrating difficulty', 'Hive Judge ready'];

/** Full-width launch banner shown when an evaluation starts. Collapses to a slim bar after the boot sequence. */
export function EvaluationLaunch({ agentId, agentName, domain, active }: { agentId: string; agentName: string; domain: string; active: boolean }) {
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (!active) return;
    setStep(0);
    const t = setInterval(() => setStep((s) => (s < STEPS.length ? s + 1 : s)), 650);
    return () => clearInterval(t);
  }, [active]);
  const c = agentColor(agentId);
  const cells = honeycomb(120, 120, 46);
  const booted = step >= STEPS.length;
  return (
    <div className="card-glow relative mb-4 overflow-hidden p-5" role="status" aria-live="polite" aria-label={booted ? 'Evaluation running' : STEPS[step]}>
      <div className="flex flex-col items-center gap-5 sm:flex-row">
        <svg viewBox="0 0 240 240" className={`hm-launch h-40 w-40 shrink-0 ${booted ? 'is-booted' : ''}`} aria-hidden>
          <defs>
            <linearGradient id="hm-launch-g" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="rgb(var(--gold))" /><stop offset="0.5" stopColor="rgb(var(--magenta))" /><stop offset="1" stopColor="rgb(var(--cyan))" />
            </linearGradient>
          </defs>
          <circle cx="120" cy="120" r="112" fill="none" stroke="url(#hm-launch-g)" strokeOpacity="0.35" strokeDasharray="4 10" className="hm-launch-orbit" />
          <path d="M120 8 A112 112 0 0 1 232 120" fill="none" stroke="url(#hm-launch-g)" strokeWidth="3" strokeLinecap="round" className="hm-launch-scan" />
          {cells.slice(1).map(([x, y], i) => (
            <polygon key={i} points={hexPoints(x, y, 24)} fill="url(#hm-launch-g)" fillOpacity={i < step * 2 ? 0.75 : 0.08}
              stroke="url(#hm-launch-g)" strokeOpacity="0.6" className="hm-launch-cell" style={{ animationDelay: `${i * 0.12}s` }} />
          ))}
          <polygon points={hexPoints(120, 120, 26)} fill={c.solid} className="hm-launch-core" />
        </svg>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-fg-subtle"><LogoMark size={14} /> Professional evaluation</p>
          <p className="mt-1 font-display text-xl font-semibold"><span style={{ color: c.text }}>{agentName}</span> · {domain}</p>
          <ol className="mt-3 grid gap-1.5 text-sm sm:grid-cols-2">
            {STEPS.map((s, i) => (
              <li key={s} className={`flex items-center gap-2 transition-colors duration-500 ${i < step ? 'text-fg' : 'text-fg-subtle'}`}>
                <span className={`h-2 w-2 rounded-full transition-all duration-500 ${i < step ? 'bg-hive-sheen shadow-glow' : 'bg-ink-700'}`} />{s}
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}

/** Knowledge transfer stream between trainer (left) and learner (right). */
export function KnowledgeFlow({ trainer, learner, active, stage }: {
  trainer: { id?: string; name: string }; learner: { id?: string; name: string }; active: boolean; stage?: string;
}) {
  const t = agentColor(trainer.id ?? trainer.name);
  const l = agentColor(learner.id ?? learner.name);
  const particles = Array.from({ length: 9 }, (_, i) => i);
  return (
    <div className="card relative mb-4 overflow-hidden px-4 py-3" aria-label={active ? `Knowledge flowing from ${trainer.name} to ${learner.name}` : 'Knowledge transfer paused'}>
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <HexAvatar seed={trainer.id ?? trainer.name} name={trainer.name} size={36} />
          <span className="hidden truncate text-sm font-medium sm:block" style={{ color: t.text }}>{trainer.name}</span>
        </div>
        <svg viewBox="0 0 400 60" preserveAspectRatio="none" className="h-12 min-w-0 flex-1" aria-hidden>
          <defs>
            <linearGradient id="hm-flow-g" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor={t.solid} /><stop offset="1" stopColor={l.solid} />
            </linearGradient>
            <path id="hm-flow-path" d="M4 30 C 120 -6, 280 66, 396 30" />
          </defs>
          <use href="#hm-flow-path" fill="none" stroke="url(#hm-flow-g)" strokeOpacity="0.35" strokeWidth="2" />
          <use href="#hm-flow-path" fill="none" stroke="url(#hm-flow-g)" strokeWidth="2" strokeDasharray="6 14" className={active ? 'hm-flow-dash' : ''} />
          {active && particles.map((i) => (
            <polygon key={i} points={hexPoints(0, 0, 5)} fill="url(#hm-flow-g)" opacity="0">
              <animateMotion dur="2.6s" begin={`${i * 0.29}s`} repeatCount="indefinite" rotate="auto"><mpath href="#hm-flow-path" /></animateMotion>
              <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.1;0.85;1" dur="2.6s" begin={`${i * 0.29}s`} repeatCount="indefinite" />
            </polygon>
          ))}
        </svg>
        <div className="flex min-w-0 items-center gap-2">
          <span className="hidden truncate text-sm font-medium sm:block" style={{ color: l.text }}>{learner.name}</span>
          <span className={active ? 'hm-absorb rounded-full' : ''}><HexAvatar seed={learner.id ?? learner.name} name={learner.name} size={36} /></span>
        </div>
      </div>
      <p className="mt-1 text-center text-[11px] text-fg-subtle">{active ? `Knowledge transferring${stage ? ` · ${stage}` : ''}` : 'Transfer idle'}</p>
    </div>
  );
}
