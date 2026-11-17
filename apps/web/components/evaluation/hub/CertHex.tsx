'use client';
/** Hexagon emblem + chip for a certification level (same visual language as components/social/BadgeChip). */
import { useId } from 'react';
import { Award, BadgeCheck, Crown, ShieldQuestion } from 'lucide-react';
import { HIVE_SPECTRUM, hexPoints } from '@/components/brand/hex';
import { cn } from '@/components/ui';
import { LEVEL_LABEL, type CertLevel } from './types';

const COLORS: Record<CertLevel, [string, string]> = {
  none: [HIVE_SPECTRUM[3], HIVE_SPECTRUM[4]],
  practitioner: [HIVE_SPECTRUM[5], HIVE_SPECTRUM[6]],
  professional: [HIVE_SPECTRUM[3], HIVE_SPECTRUM[4]],
  expert: [HIVE_SPECTRUM[0], HIVE_SPECTRUM[2]],
};
const ICONS = { none: ShieldQuestion, practitioner: BadgeCheck, professional: Award, expert: Crown } as const;

export function CertHex({ level, size = 44, muted = false }: { level: CertLevel; size?: number; muted?: boolean }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const [a, b] = COLORS[level];
  const Icon = ICONS[level];
  const locked = muted || level === 'none';
  return (
    <span className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden className={cn(!locked && 'drop-shadow-[0_0_10px_rgba(255,181,71,0.35)]')}>
        <defs>
          <linearGradient id={`ch-${uid}`} x1="6" y1="4" x2="42" y2="44" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor={a} /><stop offset="1" stopColor={b} />
          </linearGradient>
        </defs>
        {locked ? (
          <polygon points={hexPoints(24, 24, 22)} fill="rgb(var(--ink-900))" stroke="rgb(var(--line))" strokeWidth="1.5" strokeDasharray="3 3" />
        ) : (
          <>
            <polygon points={hexPoints(24, 24, 23)} fill={`url(#ch-${uid})`} />
            <polygon points={hexPoints(24, 24, 17)} fill="rgb(0 0 0 / 0.18)" stroke="white" strokeOpacity="0.3" strokeWidth="1" />
          </>
        )}
      </svg>
      <Icon aria-hidden className={cn('absolute', locked ? 'text-fg-subtle' : 'text-white')} style={{ width: size * 0.4, height: size * 0.4 }} />
    </span>
  );
}

/** "Certified Professional · Cybersecurity" chip. */
export function CertChip({ level, domainName, className, title }: { level: CertLevel; domainName?: string; className?: string; title?: string }) {
  return (
    <span title={title} className={cn('inline-flex items-center gap-2 rounded-full border border-line bg-ink-900/70 py-1 pl-1 pr-3 text-xs font-medium text-fg', className)}>
      <CertHex level={level} size={22} />
      <span>{LEVEL_LABEL[level]}{domainName && <span className="text-fg-muted"> · {domainName}</span>}</span>
    </span>
  );
}
