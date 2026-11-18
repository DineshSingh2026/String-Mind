'use client';
import { ShieldAlert, Bot, Crown, Gavel, Info } from 'lucide-react';
import { Avatar, Badge, cn, fmtDateTime } from '@/components/ui';
import { LogoMark } from '@/components/brand/Logo';
import { agentColor } from '@/components/brand/hex';
import { motion, useReducedMotion } from 'framer-motion';
import {
  type AgentRef, type TrainingMessage, agentName, flagReasonLabel, isBlocked, orgName, providerName, senderLabel, statusMeta,
} from './model';

export function StatusPill({ status, className }: { status: string; className?: string }) {
  const m = statusMeta(status);
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full border border-line bg-ink-800/80 px-2.5 py-1 text-xs font-medium text-fg', className)}>
      {status === 'active' ? <span className="ax-pulse" aria-hidden /> : <span className={cn('h-2 w-2 rounded-full', m.dot)} aria-hidden />}
      {m.label}
    </span>
  );
}

/** Green progress ring (stage-based). */
export function ProgressRing({ value, size = 120 }: { value: number; size?: number }) {
  const reduce = useReducedMotion();
  const stroke = 9; const r = size / 2 - stroke; const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }} role="img" aria-label={`Training progress ${pct}%`}>
      <div className="pointer-events-none absolute inset-3 rounded-full bg-success/10 blur-xl" aria-hidden />
      <svg width={size} height={size} className="relative -rotate-90">
        <defs><linearGradient id="ax-prog" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="rgb(var(--success-soft))" /><stop offset="1" stopColor="rgb(var(--success))" /></linearGradient></defs>
        <circle cx={size / 2} cy={size / 2} r={r} stroke="rgb(var(--ink-800))" strokeWidth={stroke} fill="none" />
        <circle cx={size / 2} cy={size / 2} r={r + stroke / 2 + 3} stroke="rgb(var(--line) / 0.5)" strokeWidth={1} strokeDasharray="2 5" fill="none" className={reduce ? undefined : 'ax-spin-slow'} style={{ transformOrigin: 'center' }} />
        <motion.circle cx={size / 2} cy={size / 2} r={r} stroke="url(#ax-prog)" strokeWidth={stroke} fill="none" strokeLinecap="round" strokeDasharray={c}
          initial={reduce ? false : { strokeDashoffset: c }} animate={{ strokeDashoffset: c - (pct / 100) * c }} transition={{ duration: 1.1, ease: [0.2, 0.7, 0.2, 1] }}
          style={{ filter: 'drop-shadow(0 0 6px rgb(var(--success) / 0.55))' }} />
      </svg>
      <span className="absolute text-center">
        <span className="block font-display text-2xl font-semibold tabular-nums">{pct}%</span>
        <span className="block text-[10px] uppercase tracking-wider text-fg-subtle">complete</span>
      </span>
    </div>
  );
}

export function ParticipantCard({ agent, role, subtitle }: { agent: AgentRef | null; role: 'Learner' | 'Trainer'; subtitle?: string | null }) {
  const name = agentName(agent);
  const prov = providerName(agent);
  const org = orgName(agent);
  return (
    <div className={cn('card ax-spot ax-lift flex items-start gap-3 p-4', role === 'Trainer' && 'ax-spot--gold')}>
      <div className={cn('rounded-full p-[2px] shadow-[0_0_18px_-4px_var(--tw-shadow-color)]', role === 'Trainer' ? 'bg-gold-sheen shadow-gold/60' : 'bg-ai-sheen shadow-electric/60')}>
        <Avatar name={name} seed={agent?.id} src={agent?.avatar} size={44} className="rounded-full border-2 border-ink-900" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{name} <span className="text-fg-muted">({role})</span></p>
        {subtitle && <p className="mt-0.5 line-clamp-2 text-xs text-fg-muted">{subtitle}</p>}
        <div className="mt-2 flex flex-wrap gap-1.5">
          {org && <Badge>{org}</Badge>}
          {prov && <Badge tone="electric">{prov}{agent?.modelName ? ` · ${agent.modelName}` : ''}</Badge>}
        </div>
      </div>
    </div>
  );
}

const ROLE_STYLE: Record<string, { bubble: string; icon: React.ReactNode; tag: string; align: 'left' | 'right' | 'center' }> = {
  trainer: { bubble: 'border-gold/25 bg-gold/[0.06]', icon: null, tag: 'Trainer', align: 'left' },
  learner: { bubble: 'border-electric/25 bg-electric/[0.07]', icon: null, tag: 'Learner', align: 'right' },
  owner: { bubble: 'border-violet/35 bg-violet/10', icon: <Crown className="h-3 w-3" />, tag: 'Owner', align: 'right' },
  evaluator: { bubble: 'border-success/30 bg-success/[0.07]', icon: <Gavel className="h-3 w-3" />, tag: 'Evaluator', align: 'left' },
  system: { bubble: 'border-line bg-ink-800/60', icon: <Info className="h-3 w-3" />, tag: 'System', align: 'center' },
};

/** Stable colour key for whoever sent a message (agent id when known). */
export function senderSeed(m: TrainingMessage, learner: AgentRef | null, trainer: AgentRef | null): string {
  const ref = m.senderRole === 'trainer' ? trainer : m.senderRole === 'learner' ? learner : null;
  return m.senderAgentId ?? ref?.id ?? senderLabel(m, learner, trainer);
}

/** Platform voice: system notices and the independent evaluator speak as the Hive. */
const isHive = (role: string) => role === 'system' || role === 'evaluator';

export function MessageBubble({ m, learner, trainer }: { m: TrainingMessage; learner: AgentRef | null; trainer: AgentRef | null }) {
  const st = ROLE_STYLE[m.senderRole] ?? ROLE_STYLE.system!;
  const name = senderLabel(m, learner, trainer);
  const blocked = isBlocked(m);
  if (st.align === 'center' && !m.flagged) {
    return (
      <div className="flex justify-center">
        <div className="bubble--system inline-flex items-center gap-1.5">
          <LogoMark size={14} /><span><span className="font-medium text-fg-muted">Hive</span> · {m.content}</span> <span className="text-fg-subtle">· {fmtDateTime(m.createdAt)}</span>
        </div>
      </div>
    );
  }
  const right = st.align === 'right';
  const isAgent = m.senderRole === 'trainer' || m.senderRole === 'learner';
  const hive = isHive(m.senderRole);
  const seed = senderSeed(m, learner, trainer);
  const color = isAgent ? agentColor(seed) : null;
  const ref = m.senderRole === 'trainer' ? trainer : m.senderRole === 'learner' ? learner : null;
  return (
    <div className={cn('flex gap-2.5', right && 'flex-row-reverse')}>
      {isAgent
        ? <Avatar name={name} seed={seed} src={ref?.avatar} size={32} />
        : hive
          ? <span className="flex h-8 w-8 shrink-0 items-center justify-center"><LogoMark size={30} /></span>
          : <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink-800 text-fg-muted"><Bot className="h-4 w-4" /></div>}
      <div className={cn('min-w-0 max-w-[82%]', right && 'items-end text-right')}>
        <div className={cn('mb-1 flex flex-wrap items-center gap-1.5 text-xs', right && 'justify-end')}>
          <span className={cn('font-medium', hive ? 'text-hive-gradient' : 'text-fg')} style={color ? { color: color.text } : undefined}>{hive ? 'The Hive' : name}</span>
          <Badge tone={m.senderRole === 'trainer' ? 'gold' : m.senderRole === 'learner' ? 'electric' : m.senderRole === 'owner' ? 'violet' : m.senderRole === 'evaluator' ? 'success' : 'neutral'} icon={st.icon}>{st.tag}</Badge>
          <span className="text-fg-subtle">{fmtDateTime(m.createdAt)}</span>
        </div>
        <div
          className={cn('bubble text-left', isAgent ? cn('bubble--agent', right && 'bubble--right') : hive ? 'bubble--hive' : 'bubble--host', m.flagged && '!border-warning/50')}
          style={color ? ({ '--agent': color.solid } as React.CSSProperties) : undefined}
        >
          {m.flagged && (
            <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-warning">
              <ShieldAlert className="h-3.5 w-3.5" aria-hidden />{flagReasonLabel(m.flagReason)}
            </div>
          )}
          {blocked
            ? <p className="italic text-fg-subtle">Content withheld by the Hive Mind safety filter.</p>
            : <p className="whitespace-pre-wrap break-words text-fg">{m.content}</p>}
        </div>
      </div>
    </div>
  );
}

/**
 * Neural link: the trainer and the learner joined by a living conduit. While the session is live, data packets in the
 * trainer's colour flow to the learner (knowledge going in) and the learner's colour flows back (answers coming out).
 */
export function NeuralLink({ trainer, learner, live, stage }: { trainer: AgentRef | null; learner: AgentRef | null; live: boolean; stage?: string | null }) {
  const tName = trainer?.name ?? 'Trainer'; const lName = learner?.name ?? 'Learner';
  const tc = agentColor(trainer?.id ?? tName); const lc = agentColor(learner?.id ?? lName);
  const path = 'M 30 40 C 140 -6, 260 86, 370 40';
  const back = 'M 370 40 C 260 86, 140 -6, 30 40';
  return (
    <div className={cn('relative overflow-hidden rounded-2xl border border-white/10 bg-black/20 px-3 py-4 sm:px-6', live && 'nl-live')}>
      <div className="flex items-center gap-3">
        <div className="flex w-28 shrink-0 flex-col items-center gap-1 text-center sm:w-36">
          <Avatar name={tName} seed={trainer?.id} src={trainer?.avatar} size={56} />
          <span className="truncate text-xs font-medium" style={{ color: tc.text }}>{tName}</span>
          <span className="text-[10px] uppercase tracking-wider text-fg-subtle">Trainer</span>
        </div>
        <div className="relative min-w-0 flex-1">
          <svg viewBox="0 0 400 80" className="h-20 w-full" preserveAspectRatio="none" aria-hidden>
            <defs><linearGradient id="nl-grad" x1="0" x2="1"><stop offset="0" stopColor={tc.solid} /><stop offset="1" stopColor={lc.solid} /></linearGradient></defs>
            <path d={path} fill="none" stroke="url(#nl-grad)" strokeOpacity="0.25" strokeWidth="6" strokeLinecap="round" />
            <path className="nl-path" d={path} fill="none" stroke="url(#nl-grad)" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          {live && [0, 1, 2, 3].map((i) => (
            <span key={`f${i}`} aria-hidden className="nl-packet absolute left-0 top-0 h-2 w-2 rounded-full"
              style={{ offsetPath: `path('${path}')`, background: tc.solid, boxShadow: `0 0 10px 2px ${tc.solid}`, animationDelay: `${i * 0.6}s`, ['--nl-t' as string]: '2.4s' }} />
          ))}
          {live && [0, 1].map((i) => (
            <span key={`b${i}`} aria-hidden className="nl-packet absolute left-0 top-0 h-1.5 w-1.5 rounded-full"
              style={{ offsetPath: `path('${back}')`, background: lc.solid, boxShadow: `0 0 8px 2px ${lc.solid}`, animationDelay: `${0.3 + i * 1.6}s`, ['--nl-t' as string]: '3.2s' }} />
          ))}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 text-center text-[10px] uppercase tracking-[0.2em] text-fg-subtle">
            {live ? `neural link · ${stage ? stage.replace(/_/g, ' ') : 'live'}` : 'link idle'}
          </div>
        </div>
        <div className="flex w-28 shrink-0 flex-col items-center gap-1 text-center sm:w-36">
          <Avatar name={lName} seed={learner?.id} src={learner?.avatar} size={56} />
          <span className="truncate text-xs font-medium" style={{ color: lc.text }}>{lName}</span>
          <span className="text-[10px] uppercase tracking-wider text-fg-subtle">Learner</span>
        </div>
      </div>
    </div>
  );
}
