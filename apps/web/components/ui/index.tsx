'use client';
/**
 * StringMind UI primitives. Import from '@/components/ui'.
 * Rules: gold = primary CTA & rewards; electric/violet = AI/tech; success = verified/positive.
 * Every async surface must render loading (Skeleton/Spinner), empty (EmptyState) and error (ErrorState) states.
 */
import { clsx } from 'clsx';
import Link from 'next/link';
import {
  createContext, forwardRef, useCallback, useContext, useEffect, useId, useRef, useState,
  type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from 'react';
import { AlertTriangle, CheckCircle2, Info, Loader2, X, XCircle } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { AnimatedNumber } from '@/components/app/motion';
import { fmtIdle } from '@/lib/tokens';
import '@/components/shell/app-motion.css';

export const cn = clsx;

/* ───────── Button ───────── */
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'ai' | 'outline';
type Size = 'sm' | 'md' | 'lg';
const variants: Record<Variant, string> = {
  primary: 'bg-gold-sheen text-ink-950 font-semibold shadow-gold hover:brightness-110',
  secondary: 'bg-ink-800 text-fg border border-line hover:bg-ink-700',
  outline: 'border border-line text-fg hover:bg-ink-800',
  ghost: 'text-fg-muted hover:text-fg hover:bg-ink-800',
  danger: 'bg-danger/90 text-white hover:bg-danger',
  ai: 'bg-ai-sheen text-white font-semibold hover:brightness-110',
};
const sizes: Record<Size, string> = { sm: 'h-8 px-3 text-xs gap-1.5', md: 'h-10 px-4 text-sm gap-2', lg: 'h-12 px-6 text-[15px] gap-2' };

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> { variant?: Variant; size?: Size; loading?: boolean; href?: string; icon?: ReactNode }
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, href, icon, className, children, disabled, ...rest }, ref,
) {
  const cls = cn('ax-btn inline-flex items-center justify-center rounded-xl transition duration-150 disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap select-none', (variant === 'primary' || variant === 'ai') && 'ax-btn--shine', variants[variant], sizes[size], className);
  const content = <>{loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : icon}{children}</>;
  if (href) return <Link href={href} className={cls}>{content}</Link>;
  return <button ref={ref} className={cls} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>{content}</button>;
});

/* ───────── Card ───────── */
export function Card({ className, children, as: As = 'div', ...rest }: { className?: string; children: ReactNode; as?: 'div' | 'section' | 'article' } & React.HTMLAttributes<HTMLElement>) {
  return <As className={cn('card', className)} {...rest}>{children}</As>;
}
export function CardHeader({ title, subtitle, action, className }: { title: ReactNode; subtitle?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-start justify-between gap-4 border-b border-line/60 px-5 py-4', className)}>
      <div className="min-w-0"><h3 className="text-[15px] font-semibold text-fg">{title}</h3>{subtitle && <p className="mt-0.5 text-xs text-fg-muted">{subtitle}</p>}</div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
export const CardBody = ({ className, children }: { className?: string; children: ReactNode }) => <div className={cn('p-5', className)}>{children}</div>;

/* ───────── Badge ───────── */
type Tone = 'neutral' | 'gold' | 'electric' | 'violet' | 'success' | 'warning' | 'danger';
const tones: Record<Tone, string> = {
  neutral: 'bg-ink-800 text-fg-muted border-line',
  gold: 'bg-gold/10 text-gold-soft border-gold/30',
  electric: 'bg-electric/10 text-electric-soft border-electric/30',
  violet: 'bg-violet/10 text-violet-soft border-violet/30',
  success: 'bg-success/10 text-success-soft border-success/30',
  warning: 'bg-warning/10 text-warning border-warning/30',
  danger: 'bg-danger/10 text-danger-soft border-danger/30',
};
export function Badge({ tone = 'neutral', children, className, icon }: { tone?: Tone; children: ReactNode; className?: string; icon?: ReactNode }) {
  return <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4', tones[tone], className)}>{icon}{children}</span>;
}

/* ───────── Form fields ───────── */
export function Field({ label, hint, error, children, htmlFor, required }: { label: string; hint?: string; error?: string; children: ReactNode; htmlFor?: string; required?: boolean }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-xs font-medium text-fg-muted">{label}{required && <span className="text-gold"> *</span>}</label>
      {children}
      {error ? <p className="text-xs text-danger-soft" role="alert">{error}</p> : hint ? <p className="text-xs text-fg-subtle">{hint}</p> : null}
    </div>
  );
}
const inputCls = 'w-full rounded-xl border border-line bg-ink-950/60 px-3 text-sm text-fg placeholder:text-fg-subtle transition focus:border-electric focus:outline-none focus:shadow-focus disabled:opacity-60';
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...p }, ref) {
  return <input ref={ref} className={cn(inputCls, 'h-10', className)} {...p} />;
});
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...p }, ref) {
  return <textarea ref={ref} className={cn(inputCls, 'min-h-[96px] py-2.5', className)} {...p} />;
});
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...p }, ref) {
  return <select ref={ref} className={cn(inputCls, 'h-10 pr-8', className)} {...p}>{children}</select>;
});
export function Checkbox({ label, checked, onChange, id }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; id?: string }) {
  const gen = useId(); const cid = id ?? gen;
  return (
    <label htmlFor={cid} className="flex cursor-pointer items-start gap-2.5 text-sm text-fg-muted">
      <input id={cid} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-line bg-ink-950 accent-[rgb(var(--gold))]" />
      <span>{label}</span>
    </label>
  );
}
export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}
      className={cn('relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition disabled:opacity-50', checked ? 'border-gold/60 bg-gold/80' : 'border-line bg-ink-800')}>
      <span className={cn('inline-block h-4.5 w-[18px] h-[18px] rounded-full bg-white shadow transition', checked ? 'translate-x-[22px]' : 'translate-x-[3px]')} />
    </button>
  );
}

/* ───────── Tabs ───────── */
export function Tabs<T extends string>({ tabs, value, onChange, className }: { tabs: { value: T; label: ReactNode; count?: number }[]; value: T; onChange: (v: T) => void; className?: string }) {
  const lid = useId();
  const reduce = useReducedMotion();
  return (
    <div role="tablist" className={cn('flex gap-1 overflow-x-auto border-b border-line/70', className)}>
      {tabs.map((t) => {
        const on = value === t.value;
        return (
          <button key={t.value} role="tab" aria-selected={on} onClick={() => onChange(t.value)}
            className={cn('relative -mb-px whitespace-nowrap px-3.5 py-2.5 text-sm transition-colors', on ? 'text-fg' : 'text-fg-muted hover:text-fg')}>
            {t.label}{t.count !== undefined && <span className={cn('ml-1.5 rounded-full px-1.5 text-[10px] transition-colors', on ? 'bg-gold/15 text-gold-soft' : 'bg-ink-800 text-fg-muted')}>{t.count}</span>}
            {on && <motion.span layoutId={`tab-${lid}`} transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 500, damping: 38 }}
              className="absolute inset-x-2 -bottom-px h-0.5 rounded bg-gold shadow-[0_0_10px_rgb(var(--gold)/0.7)]" aria-hidden />}
          </button>
        );
      })}
    </div>
  );
}

/* ───────── Modal ───────── */
type ModalProps = { open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; children?: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl' };
export function Modal(props: ModalProps) {
  return <AnimatePresence>{props.open && <ModalInner key="modal" {...props} />}</AnimatePresence>;
}
function ModalInner({ onClose, title, description, children, footer, size = 'md' }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
    document.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('input,select,textarea,button')?.focus();
    return () => { document.removeEventListener('keydown', onKey); prev?.focus(); };
  }, []);
  const w = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' }[size];
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
      <motion.div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduce ? 0 : 0.2 }} />
      <motion.div ref={ref} className={cn('relative w-full rounded-t-2xl border border-line bg-ink-900 shadow-2xl sm:rounded-2xl', w)}
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: 24, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={reduce ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.98 }}
        transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 420, damping: 34 }}>
        <div className="pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-gold/50 to-transparent" aria-hidden />
        <div className="flex items-start justify-between gap-4 border-b border-line/60 px-5 py-4">
          <div><h2 className="text-base font-semibold">{title}</h2>{description && <p className="mt-1 text-sm text-fg-muted">{description}</p>}</div>
          <button onClick={onClose} aria-label="Close" className="rounded-lg p-1 text-fg-muted transition hover:rotate-90 hover:bg-ink-800 hover:text-fg"><X className="h-4 w-4" /></button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line/60 px-5 py-3">{footer}</div>}
      </motion.div>
    </div>
  );
}

/* ───────── Feedback states ───────── */
export const Spinner = ({ className }: { className?: string }) => <Loader2 className={cn('h-5 w-5 animate-spin text-fg-muted', className)} aria-label="Loading" />;
export const Skeleton = ({ className }: { className?: string }) => <div className={cn('ax-shimmer rounded-lg bg-ink-800/80', className)} />;

export function EmptyState({ icon, title, description, action, className }: { icon?: ReactNode; title: string; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('relative flex flex-col items-center justify-center overflow-hidden rounded-2xl border border-dashed border-line px-6 py-12 text-center', className)}>
      <div className="pointer-events-none absolute left-1/2 top-6 h-32 w-32 -translate-x-1/2 rounded-full bg-electric/10 blur-3xl" aria-hidden />
      {icon && <div className="ax-float relative mb-3 rounded-xl border border-line/70 bg-gradient-to-b from-ink-700 to-ink-800 p-3 text-fg-muted shadow-card">{icon}</div>}
      <p className="relative font-medium text-fg">{title}</p>
      {description && <p className="relative mt-1 max-w-md text-sm text-fg-muted">{description}</p>}
      {action && <div className="relative mt-5">{action}</div>}
    </div>
  );
}
export function ErrorState({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  const msg = error instanceof Error ? error.message : String(error ?? 'Something went wrong');
  return (
    <div role="alert" className={cn('flex items-start gap-3 rounded-2xl border border-danger/30 bg-danger/5 p-4 text-sm', className)}>
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger-soft" />
      <div className="flex-1"><p className="font-medium text-fg">Couldn&apos;t load this</p><p className="text-fg-muted">{msg}</p></div>
      {onRetry && <Button size="sm" variant="outline" onClick={onRetry}>Retry</Button>}
    </div>
  );
}
export function Alert({ tone = 'info', title, children }: { tone?: 'info' | 'success' | 'warning' | 'danger'; title?: ReactNode; children?: ReactNode }) {
  const map = { info: ['border-electric/30 bg-electric/5', Info, 'text-electric-soft'], success: ['border-success/30 bg-success/5', CheckCircle2, 'text-success-soft'], warning: ['border-warning/30 bg-warning/5', AlertTriangle, 'text-warning'], danger: ['border-danger/30 bg-danger/5', XCircle, 'text-danger-soft'] } as const;
  const [cls, Icon, ic] = map[tone];
  return <div className={cn('flex gap-3 rounded-xl border p-3.5 text-sm', cls)}><Icon className={cn('mt-0.5 h-4 w-4 shrink-0', ic)} /><div>{title && <p className="font-medium text-fg">{title}</p>}<div className="text-fg-muted">{children}</div></div></div>;
}

/* ───────── Data display ───────── */
export function Stat({ label, value, hint, icon, tone = 'neutral', loading }: { label: string; value: ReactNode; hint?: ReactNode; icon?: ReactNode; tone?: 'neutral' | 'gold' | 'success' | 'electric' | 'violet'; loading?: boolean }) {
  const ring = { neutral: 'text-fg-muted bg-ink-800', gold: 'text-gold bg-gold/10', success: 'text-success bg-success/10', electric: 'text-electric bg-electric/10', violet: 'text-violet bg-violet/10' }[tone];
  return (
    <div className="card ax-spot ax-lift p-4">
      <div className="flex items-center justify-between"><p className="text-xs font-medium text-fg-muted">{label}</p>{icon && <span className={cn('rounded-lg p-1.5', ring)}>{icon}</span>}</div>
      {loading ? <Skeleton className="mt-3 h-7 w-24" /> : <p className="mt-2 font-display text-2xl font-semibold tabular-nums">{typeof value === 'number' ? <AnimatedNumber value={value} format={(n) => fmtNumber(n, Number.isInteger(value) ? 0 : 2)} /> : value}</p>}
      {hint && <p className="mt-1 text-xs text-fg-subtle">{hint}</p>}
    </div>
  );
}

export function Progress({ value, max = 100, tone = 'gold', className, label }: { value: number; max?: number; tone?: 'gold' | 'electric' | 'success' | 'violet' | 'danger'; className?: string; label?: string }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const bar = { gold: 'bg-gold', electric: 'bg-electric', success: 'bg-success', violet: 'bg-violet', danger: 'bg-danger' }[tone];
  return <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-ink-800', className)} role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={label}><motion.div className={cn('h-full rounded-full', bar)} initial={{ width: 0 }} animate={{ width: `${pct}%` }} transition={{ duration: 0.9, ease: [0.2, 0.7, 0.2, 1] }} /></div>;
}

/** Circular score 0..100. `null` renders "Not assessed" — never invent a score. */
export function ScoreRing({ score, size = 64, label, verified }: { score: number | null | undefined; size?: number; label?: string; verified?: boolean }) {
  const reduce = useReducedMotion();
  const sw = size < 48 ? 3.5 : 5;
  const r = size / 2 - sw; const c = 2 * Math.PI * r;
  const has = typeof score === 'number';
  const pct = has ? Math.max(0, Math.min(100, score!)) : 0;
  const color = !has ? 'rgb(var(--ink-600))' : pct >= 85 ? 'rgb(var(--success))' : pct >= 65 ? 'rgb(var(--gold))' : pct >= 40 ? 'rgb(var(--warning))' : 'rgb(var(--danger))';
  const fs = Math.max(10, Math.round(size * (has && Math.round(pct) >= 100 ? 0.26 : 0.3)));
  return (
    <div className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }} role="img" aria-label={has ? `${label ?? 'Score'} ${pct.toFixed(1)} out of 100${verified ? ', verified' : ''}` : 'Not assessed'}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden><circle cx={size / 2} cy={size / 2} r={r} stroke="rgb(var(--ink-800))" strokeWidth={sw} fill="none" />
        {has && <motion.circle cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth={sw} fill="none" strokeLinecap="round" strokeDasharray={c}
          initial={reduce ? false : { strokeDashoffset: c }} whileInView={{ strokeDashoffset: c - (pct / 100) * c }} viewport={{ once: true }} transition={{ duration: 1.1, ease: [0.2, 0.7, 0.2, 1] }}
          style={{ filter: `drop-shadow(0 0 3px ${color})` }} />}</svg>
      <span className="absolute font-display font-semibold tabular-nums" style={{ fontSize: fs }}>{has ? Math.round(pct) : '—'}</span>
    </div>
  );
}

export function Avatar({ name, src, size = 36, className }: { name: string; src?: string | null; size?: number; className?: string }) {
  const initials = name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  let h = 0; for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  if (src) return <img src={src} alt="" width={size} height={size} className={cn('rounded-xl object-cover', className)} />;
  return <div aria-hidden className={cn('flex shrink-0 items-center justify-center rounded-xl font-semibold text-white', className)} style={{ width: size, height: size, fontSize: size * 0.36, background: `linear-gradient(135deg, hsl(${h} 70% 45%), hsl(${(h + 60) % 360} 70% 35%))` }}>{initials}</div>;
}

export function PageHeader({ title, description, actions, eyebrow }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">{eyebrow && <div className="mb-1.5 text-xs font-medium uppercase tracking-wider text-gold">{eyebrow}</div>}<h1 className="text-2xl font-semibold sm:text-[28px]">{title}</h1>{description && <p className="mt-1.5 max-w-2xl text-sm text-fg-muted">{description}</p>}</div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/** Responsive table: horizontal scroll inside the card on small screens (never the page). */
export function Table({ head, children, className }: { head: ReactNode[]; children: ReactNode; className?: string }) {
  return (
    <div className={cn('overflow-x-auto', className)}>
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead><tr className="border-b border-line/70 text-xs text-fg-subtle">{head.map((h, i) => <th key={i} className="px-4 py-2.5 font-medium">{h}</th>)}</tr></thead>
        <tbody className="divide-y divide-line/50">{children}</tbody>
      </table>
    </div>
  );
}
export const Td = ({ children, className }: { children?: ReactNode; className?: string }) => <td className={cn('px-4 py-3 align-middle', className)}>{children}</td>;

/* ───────── Toasts ───────── */
type ToastT = { id: number; tone: 'success' | 'danger' | 'info'; message: string };
const ToastCtx = createContext<(tone: ToastT['tone'], message: string) => void>(() => undefined);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastT[]>([]);
  const push = useCallback((tone: ToastT['tone'], message: string) => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, tone, message }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[calc(100%-2rem)] max-w-sm flex-col gap-2" aria-live="polite">
        <AnimatePresence initial={false}>
          {items.map((t) => (
            <motion.div key={t.id} layout initial={{ opacity: 0, y: 16, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, x: 40, transition: { duration: 0.2 } }}
              transition={{ type: 'spring', stiffness: 460, damping: 34 }}
              className={cn('pointer-events-auto relative flex items-start gap-2.5 overflow-hidden rounded-xl border bg-ink-850/95 px-4 py-3 text-sm shadow-2xl backdrop-blur', t.tone === 'success' ? 'border-success/40' : t.tone === 'danger' ? 'border-danger/40' : 'border-electric/40')}>
              {t.tone === 'success' ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" /> : t.tone === 'danger' ? <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" /> : <Info className="mt-0.5 h-4 w-4 shrink-0 text-electric" />}
              <span className="text-fg">{t.message}</span>
              <motion.span aria-hidden className={cn('absolute bottom-0 left-0 h-0.5', t.tone === 'success' ? 'bg-success/70' : t.tone === 'danger' ? 'bg-danger/70' : 'bg-electric/70')}
                initial={{ width: '100%' }} animate={{ width: 0 }} transition={{ duration: 4.5, ease: 'linear' }} />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

/* ───────── Formatting ───────── */
/** Token amounts: StringMind uses IDLE Tokens only (never fiat). Kept under the legacy name for call-site stability. */
export const fmtCredits = (n: number | null | undefined) => fmtIdle(n);
export const fmtNumber = (n: number | null | undefined, d = 0) => (n == null ? '—' : new Intl.NumberFormat('en-IN', { maximumFractionDigits: d }).format(n));
export const fmtPct = (n: number | null | undefined, d = 1) => (n == null ? '—' : `${n.toFixed(d)}%`);
export const fmtDate = (s: string | Date | null | undefined) => (s ? new Date(s).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
export const fmtDateTime = (s: string | Date | null | undefined) => (s ? new Date(s).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
export function fmtRelative(s: string | Date | null | undefined) {
  if (!s) return '—';
  const diff = (Date.now() - new Date(s).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return fmtDate(s);
}
