'use client';
/**
 * App-level building blocks shared by /app pages. Built on '@/components/ui'.
 */
import Link from 'next/link';
import { useCallback, useState, type ReactNode } from 'react';
import { ArrowDownRight, ArrowUpRight, BadgeCheck, ChevronLeft, ChevronRight, Star } from 'lucide-react';
import { DOMAINS, LEARNING_TYPE_LABELS, REPUTATION_LEVELS, type LearningType } from '@aix/shared';
import { Badge, Button, Modal, Skeleton, cn, useToast } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { fmtIdle } from '@/lib/tokens';
import { motion, useReducedMotion } from 'framer-motion';
import { Sparkline } from './charts';

/* ───────── domain helpers ───────── */
export const domainName = (slug: string | null | undefined) => (slug ? DOMAINS.find((d) => d.slug === slug)?.name ?? slug : '—');
export const shortDomainName = (slug: string | null | undefined) => domainName(slug).split(/ [&(]/)[0]!;
export const reputationName = (slug: string | null | undefined) => (slug ? REPUTATION_LEVELS.find((l) => l.slug === slug)?.name ?? slug.replace(/_/g, ' ') : null);
export const learningTypeLabel = (t: string | null | undefined) => (t ? LEARNING_TYPE_LABELS[t as LearningType] ?? t.replace(/_/g, ' ') : 'Unknown type');
export const titleCase = (s: string | null | undefined) => (s ? s.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '—');

/* ───────── async action helper with toasts ───────── */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(async <T,>(key: string, fn: () => Promise<T>, success?: string | ((r: T) => string)): Promise<T | undefined> => {
    setBusy(key);
    try {
      const r = await fn();
      if (success) toast('success', typeof success === 'function' ? success(r) : success);
      return r;
    } catch (e) {
      toast('danger', errorMessage(e));
      return undefined;
    } finally {
      setBusy(null);
    }
  }, [toast]);
  return { busy, run };
}

/* ───────── KPI card with delta (delta only rendered when non-null) ───────── */
const KPI_TONE = {
  gold: { tile: 'bg-gold/10 text-gold border-gold/25', glow: 'bg-gold/20', spot: 'ax-spot--gold', line: 'rgb(255 181 71)' },
  electric: { tile: 'bg-electric/10 text-electric border-electric/25', glow: 'bg-electric/20', spot: '', line: 'rgb(72 148 255)' },
  violet: { tile: 'bg-violet/10 text-violet border-violet/25', glow: 'bg-violet/20', spot: 'ax-spot--violet', line: 'rgb(139 108 255)' },
  success: { tile: 'bg-success/10 text-success border-success/25', glow: 'bg-success/20', spot: 'ax-spot--success', line: 'rgb(52 199 133)' },
} as const;
export function KpiCard({ label, value, delta, deltaSuffix = '%', icon, tone = 'gold', loading, hint, href, spark }: {
  label: string; value: ReactNode; delta?: number | null; deltaSuffix?: string; icon: ReactNode;
  tone?: 'gold' | 'electric' | 'violet' | 'success'; loading?: boolean; hint?: ReactNode; href?: string;
  /** Real series for the selected period (rendered only when it has ≥2 points and any non-zero value). */
  spark?: number[] | null;
}) {
  const t = KPI_TONE[tone];
  const showSpark = !loading && spark && spark.length > 1 && spark.some((v) => v !== 0);
  const body = (
    <div className={cn('card ax-spot ax-lift relative flex h-full flex-col overflow-hidden p-4 sm:p-5', t.spot, href && 'hover:border-ink-600')}>
      <div className={cn('pointer-events-none absolute -right-8 -top-8 h-24 w-24 rounded-full blur-2xl transition-opacity duration-500 group-hover:opacity-100', t.glow, 'opacity-40')} aria-hidden />
      <div className="relative flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-fg-muted">{label}</p>
          {loading ? <Skeleton className="mt-2.5 h-8 w-28" /> : <p className="mt-1.5 truncate font-display text-2xl font-semibold tabular-nums sm:text-[26px]">{value}</p>}
        </div>
        <span className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border shadow-[inset_0_1px_0_rgb(255_255_255/0.06)] transition-transform duration-300 group-hover:scale-110 group-hover:-rotate-6', t.tile)} aria-hidden>{icon}</span>
      </div>
      <div className="relative mt-auto flex items-end justify-between gap-2">
        <div className="min-w-0">
          {!loading && typeof delta === 'number' && <Delta value={delta} suffix={deltaSuffix} className="mt-1.5" />}
          {!loading && hint && <p className="mt-1.5 truncate text-xs text-fg-subtle">{hint}</p>}
        </div>
        {showSpark && <span className="mt-1.5 hidden sm:block"><Sparkline values={spark!} color={t.line} width={76} height={26} /></span>}
      </div>
    </div>
  );
  return href ? <Link href={href} className="group block h-full rounded-2xl">{body}</Link> : <div className="group h-full">{body}</div>;
}

export function Delta({ value, suffix = '%', className, label = 'vs previous period' }: { value: number; suffix?: string; className?: string; label?: string }) {
  const up = value >= 0;
  const reduce = useReducedMotion();
  return (
    <p className={cn('flex flex-wrap items-center gap-1.5 text-xs', className)}>
      <motion.span initial={reduce ? false : { opacity: 0, scale: 0.8, y: 4 }} animate={{ opacity: 1, scale: 1, y: 0 }} transition={{ type: 'spring', stiffness: 400, damping: 24, delay: 0.5 }}
        className={cn('inline-flex items-center gap-0.5 rounded-full border px-1.5 py-0.5 font-medium', up ? 'border-success/30 bg-success/10 text-success' : 'border-danger/30 bg-danger/10 text-danger-soft')}>
        {up ? <ArrowUpRight className="h-3.5 w-3.5" aria-hidden /> : <ArrowDownRight className="h-3.5 w-3.5" aria-hidden />}
        {up ? '+' : ''}{value.toFixed(1)}{suffix}
      </motion.span>
      <span className="text-fg-subtle">{label}</span>
    </p>
  );
}

/* ───────── chips ───────── */
export function Chip({ active, onClick, children, className, ...rest }: { active?: boolean; onClick?: () => void; children: ReactNode; className?: string } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick}
      className={cn('inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs transition',
        active ? 'border-gold/50 bg-gold/15 text-gold-soft' : 'border-line bg-ink-900 text-fg-muted hover:border-ink-600 hover:text-fg', className)} {...rest}>
      {children}
    </button>
  );
}
/** Horizontal-scroll chip row on mobile, wraps on larger screens. */
export function ChipRow({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
  return <div role="group" aria-label={label} className={cn('-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0', className)}>{children}</div>;
}

/** Multi-select of the 20 Hive Mind domains. */
export function DomainPicker({ value, onChange, allowed }: { value: string[]; onChange: (v: string[]) => void; allowed?: string[] }) {
  const list = allowed ? DOMAINS.filter((d) => allowed.includes(d.slug)) : DOMAINS;
  const toggle = (s: string) => onChange(value.includes(s) ? value.filter((x) => x !== s) : [...value, s]);
  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-xs text-fg-subtle">
        <span>{value.length} selected</span>
        <span className="flex gap-3">
          <button type="button" className="hover:text-fg" onClick={() => onChange(list.map((d) => d.slug))}>Select all</button>
          <button type="button" className="hover:text-fg" onClick={() => onChange([])}>Clear</button>
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {list.map((d) => <Chip key={d.slug} active={value.includes(d.slug)} onClick={() => toggle(d.slug)}>{d.name}{d.highImpact && <span className="text-[10px] text-warning" title="High-impact domain">●</span>}</Chip>)}
      </div>
    </div>
  );
}

/* ───────── status pills ───────── */
export function StatusPill({ status }: { status: string | null | undefined }) {
  const s = (status ?? 'unknown').toLowerCase();
  const tone = ['active', 'healthy', 'completed', 'succeeded', 'success', 'paid', 'connected', 'approved', 'verified', 'accepted', 'settled'].includes(s) ? 'success'
    : ['running', 'in_progress', 'queued', 'pending', 'processing', 'created', 'requested', 'scheduled', 'draft', 'pending_verification'].includes(s) ? 'electric'
    : ['degraded', 'paused', 'warning', 'locked', 'on_hold', 'disputed'].includes(s) ? 'warning'
    : ['failed', 'error', 'down', 'suspended', 'rejected', 'declined', 'cancelled', 'disconnected', 'refunded'].includes(s) ? 'danger' : 'neutral';
  return <Badge tone={tone as 'success'}>{tone === 'success' && <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden />}{titleCase(s)}</Badge>;
}

export function VerifiedBadge({ label = 'Verified' }: { label?: string }) {
  return <Badge tone="success" icon={<BadgeCheck className="h-3 w-3" aria-hidden />}>{label}</Badge>;
}

export function Rating({ value, count, className }: { value: number | null | undefined; count?: number; className?: string }) {
  if (value == null || !count) return <span className={cn('text-xs text-fg-subtle', className)}>No ratings yet</span>;
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs text-fg-muted', className)} aria-label={`Rated ${value.toFixed(1)} out of 5 from ${count} reviews`}>
      <Star className="h-3.5 w-3.5 fill-gold text-gold" aria-hidden /><span className="font-medium text-fg">{value.toFixed(1)}</span>({count})
    </span>
  );
}

/** Rank coin: 1 gold, 2 silver, 3 bronze, rest neutral. */
export function RankCoin({ rank, size = 28 }: { rank: number; size?: number }) {
  const style = rank === 1 ? 'bg-gold-sheen text-ink-950 shadow-[0_0_16px_rgb(var(--gold)/0.55)] ring-1 ring-gold-soft/60' : rank === 2 ? 'bg-gradient-to-br from-slate-200 to-slate-400 text-ink-950' : rank === 3 ? 'bg-gradient-to-br from-amber-600 to-amber-800 text-white' : 'bg-ink-800 text-fg-muted border border-line';
  return <span className={cn('inline-flex shrink-0 items-center justify-center rounded-full font-display text-xs font-bold tabular-nums', style)} style={{ width: size, height: size }} aria-label={`Rank ${rank}`}>{rank}</span>;
}

export function LearningTypeBadge({ type }: { type: string | null | undefined }) {
  const tone = type === 'temporary_context' ? 'neutral' : type === 'persistent_memory' ? 'violet' : type === 'knowledge_retrieval' ? 'electric' : type === 'instruction_update' ? 'gold' : type === 'fine_tuning' ? 'success' : 'neutral';
  return <Badge tone={tone}>{learningTypeLabel(type)}</Badge>;
}

/* ───────── section card ───────── */
export function Section({ title, subtitle, action, children, className, bodyClassName }: { title: ReactNode; subtitle?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <section className={cn('card ax-spot', className)}>
      <div className="flex items-start justify-between gap-3 px-5 pb-1 pt-4">
        <div className="min-w-0"><h2 className="text-[15px] font-semibold">{title}</h2>{subtitle && <p className="mt-0.5 text-xs text-fg-muted">{subtitle}</p>}</div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      <div className={cn('p-5 pt-3', bodyClassName)}>{children}</div>
    </section>
  );
}

export function ViewAll({ href, children = 'View All' }: { href: string; children?: ReactNode }) {
  return <Link href={href} className="inline-flex items-center gap-1 text-xs font-medium text-gold hover:text-gold-soft">{children}<ChevronRight className="h-3.5 w-3.5" aria-hidden /></Link>;
}

export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return <Link href={href} className="mb-4 inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"><ChevronLeft className="h-4 w-4" aria-hidden />{children}</Link>;
}

/* ───────── list skeletons ───────── */
export function ListSkeleton({ rows = 4, className }: { rows?: number; className?: string }) {
  return <div className={cn('space-y-3', className)} aria-busy="true" aria-label="Loading">{Array.from({ length: rows }).map((_, i) => <div key={i} className="flex items-center gap-3"><Skeleton className="h-9 w-9 rounded-full" /><div className="flex-1 space-y-1.5"><Skeleton className="h-3.5 w-2/3" /><Skeleton className="h-3 w-1/3" /></div></div>)}</div>;
}
export function GridSkeleton({ count = 6, className, itemClassName = 'h-56' }: { count?: number; className?: string; itemClassName?: string }) {
  return <div className={cn('grid gap-4 sm:grid-cols-2 xl:grid-cols-3', className)} aria-busy="true" aria-label="Loading">{Array.from({ length: count }).map((_, i) => <Skeleton key={i} className={cn('rounded-2xl', itemClassName)} />)}</div>;
}

/* ───────── pagination ───────── */
export function Pagination({ page, pageSize, total, onChange }: { page: number; pageSize: number; total: number; onChange: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  if (pages <= 1) return null;
  return (
    <nav aria-label="Pagination" className="mt-4 flex items-center justify-between gap-3 text-sm text-fg-muted">
      <span>Page {page} of {pages} · {total} total</span>
      <span className="flex gap-2">
        <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => onChange(page - 1)} aria-label="Previous page"><ChevronLeft className="h-4 w-4" />Prev</Button>
        <Button size="sm" variant="outline" disabled={page >= pages} onClick={() => onChange(page + 1)} aria-label="Next page">Next<ChevronRight className="h-4 w-4" /></Button>
      </span>
    </nav>
  );
}

/* ───────── confirmation modal ───────── */
export function ConfirmModal({ open, onClose, onConfirm, title, description, confirmLabel = 'Confirm', danger, loading, children }: {
  open: boolean; onClose: () => void; onConfirm: () => void; title: string; description?: ReactNode; confirmLabel?: string; danger?: boolean; loading?: boolean; children?: ReactNode;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title} description={description} size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant={danger ? 'danger' : 'primary'} loading={loading} onClick={onConfirm}>{confirmLabel}</Button></>}>
      {children}
    </Modal>
  );
}

/** Small key/value row for detail panels. */
export function KV({ k, v }: { k: ReactNode; v: ReactNode }) {
  return <div className="flex items-start justify-between gap-4 py-2 text-sm"><dt className="text-fg-muted">{k}</dt><dd className="min-w-0 text-right font-medium text-fg">{v}</dd></div>;
}

/** Inline amount coloured by sign. */
export function SignedCredits({ amount, className }: { amount: number; className?: string }) {
  const pos = amount > 0;
  return <span className={cn('font-semibold tabular-nums', pos ? 'text-success' : amount < 0 ? 'text-danger-soft' : 'text-fg-muted', className)}>{pos ? '+' : amount < 0 ? '−' : ''}{fmtIdle(Math.abs(amount))}</span>;
}

/** Download helper for authenticated CSV exports through the proxy. */
export function downloadHref(path: string) { return `/api${path}`; }
