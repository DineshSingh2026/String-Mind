'use client';
/** Hexagon badge chips (Hive Mind design system). Badges come from BADGES in @aix/shared and are awarded from real activity only. */
import { useId } from 'react';
import { Award, BadgeCheck, BookOpen, GraduationCap, Heart, Swords, type LucideIcon } from 'lucide-react';
import { HIVE_SPECTRUM, hexPoints } from '@/components/brand/hex';
import { cn, fmtDate } from '@/components/ui';

const ICONS: Record<string, LucideIcon> = {
  verified_specialist: BadgeCheck,
  first_lesson: BookOpen,
  mentor_10: GraduationCap,
  crowd_favourite: Heart,
  debate_champion: Swords,
  knowledge_confirmed: Award,
};
const COLORS: Record<string, [string, string]> = {
  verified_specialist: [HIVE_SPECTRUM[5], HIVE_SPECTRUM[4]],
  first_lesson: [HIVE_SPECTRUM[6], HIVE_SPECTRUM[5]],
  mentor_10: [HIVE_SPECTRUM[0], HIVE_SPECTRUM[1]],
  crowd_favourite: [HIVE_SPECTRUM[1], HIVE_SPECTRUM[2]],
  debate_champion: [HIVE_SPECTRUM[2], HIVE_SPECTRUM[3]],
  knowledge_confirmed: [HIVE_SPECTRUM[3], HIVE_SPECTRUM[4]],
};

export interface BadgeView { slug: string; name: string; description: string; rule: string; awardedAt?: string | null }

/** The hexagon emblem on its own. */
export function BadgeHex({ slug, size = 40, locked = false }: { slug: string; size?: number; locked?: boolean }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const [a, b] = COLORS[slug] ?? [HIVE_SPECTRUM[3], HIVE_SPECTRUM[5]];
  const Icon = ICONS[slug] ?? Award;
  return (
    <span className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden className={cn(!locked && 'drop-shadow-[0_0_10px_rgba(255,79,163,0.35)]')}>
        <defs>
          <linearGradient id={`bg-${uid}`} x1="6" y1="4" x2="42" y2="44" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor={a} /><stop offset="1" stopColor={b} />
          </linearGradient>
        </defs>
        {locked ? (
          <polygon points={hexPoints(24, 24, 22)} fill="rgb(var(--ink-900))" stroke="rgb(var(--line))" strokeWidth="1.5" strokeDasharray="3 3" />
        ) : (
          <>
            <polygon points={hexPoints(24, 24, 23)} fill={`url(#bg-${uid})`} />
            <polygon points={hexPoints(24, 24, 17)} fill="rgb(0 0 0 / 0.18)" stroke="white" strokeOpacity="0.3" strokeWidth="1" />
          </>
        )}
      </svg>
      <Icon aria-hidden className={cn('absolute', locked ? 'text-fg-subtle' : 'text-white')} style={{ width: size * 0.4, height: size * 0.4 }} />
    </span>
  );
}

/** Compact chip: hex emblem + name, rule in the tooltip. */
export function BadgeChip({ badge, locked = false, className }: { badge: BadgeView; locked?: boolean; className?: string }) {
  return (
    <span
      className={cn('inline-flex items-center gap-2 rounded-full border py-1 pl-1 pr-3 text-xs font-medium', locked ? 'border-line/60 bg-ink-950/40 text-fg-subtle' : 'border-line bg-ink-900/70 text-fg', className)}
      title={`${badge.name}: ${badge.rule}${badge.awardedAt ? ` · earned ${fmtDate(badge.awardedAt)}` : ''}`}
    >
      <BadgeHex slug={badge.slug} size={24} locked={locked} />
      {badge.name}
    </span>
  );
}

/** Earned badges first, then the ones still to earn (with their rules). */
export function BadgeGrid({ earned, catalog }: { earned: BadgeView[]; catalog: BadgeView[] }) {
  const have = new Set(earned.map((b) => b.slug));
  const rest = catalog.filter((b) => !have.has(b.slug));
  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {[...earned.map((b) => ({ b, locked: false })), ...rest.map((b) => ({ b, locked: true }))].map(({ b, locked }) => (
        <li key={b.slug} className={cn('flex items-start gap-3 rounded-2xl border p-3', locked ? 'border-line/40 bg-ink-950/30' : 'border-line/70 bg-ink-950/50')}>
          <BadgeHex slug={b.slug} size={44} locked={locked} />
          <div className="min-w-0">
            <p className={cn('text-sm font-medium', locked ? 'text-fg-muted' : 'text-fg')}>{b.name}{!locked && b.awardedAt && <span className="ml-1.5 text-[11px] font-normal text-fg-subtle">earned {fmtDate(b.awardedAt)}</span>}</p>
            <p className="mt-0.5 text-xs text-fg-subtle">{locked ? <>Not yet earned · {b.rule}</> : b.rule}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}
