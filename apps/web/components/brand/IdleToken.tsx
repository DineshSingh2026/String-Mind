import { useId, type ReactNode } from 'react';
import { clsx as cn } from 'clsx';
import { TOKEN_SYMBOL, fmtIdleAmount } from '@/lib/tokens';
import { STRING_NODES, STRING_S_PATH } from './Logo';

/**
 * IDLE token mark — a gold coin engraved with the StringMind string-S (one string through three agent nodes).
 * Decorative by default (aria-hidden); pair it with visible "IDLE" text or pass `title`.
 */
export function IdleToken({ size = 16, className, title }: { size?: number; className?: string; title?: string }) {
  const uid = useId().replace(/:/g, '');
  const face = `idle-face-${uid}`;
  const rim = `idle-rim-${uid}`;
  const shine = `idle-shine-${uid}`;
  return (
    <svg
      width={size} height={size} viewBox="0 0 32 32" className={cn('inline-block shrink-0 align-[-0.125em]', className)}
      role={title ? 'img' : undefined} aria-hidden={title ? undefined : true} aria-label={title}
    >
      {title && <title>{title}</title>}
      <defs>
        <linearGradient id={rim} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="rgb(248 226 168)" />
          <stop offset="0.5" stopColor="rgb(214 175 85)" />
          <stop offset="1" stopColor="rgb(140 104 34)" />
        </linearGradient>
        <radialGradient id={face} cx="0.35" cy="0.3" r="0.85">
          <stop offset="0" stopColor="rgb(250 228 170)" />
          <stop offset="0.55" stopColor="rgb(222 184 96)" />
          <stop offset="1" stopColor="rgb(168 128 48)" />
        </radialGradient>
        <linearGradient id={shine} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="white" stopOpacity="0.55" />
          <stop offset="1" stopColor="white" stopOpacity="0" />
        </linearGradient>
      </defs>
      <circle cx="16" cy="16" r="15" fill={`url(#${rim})`} />
      <circle cx="16" cy="16" r="12.4" fill={`url(#${face})`} />
      <circle cx="16" cy="16" r="12.4" fill="none" stroke="rgb(120 88 26)" strokeOpacity="0.45" strokeWidth="0.8" />
      {/* engraved string-S with its three agent nodes, matching the StringMind mark */}
      <g transform="translate(16 16) scale(0.4) translate(-24 -24)" fill="rgb(92 64 14)" opacity="0.85">
        <path d={STRING_S_PATH} fill="none" stroke="rgb(92 64 14)" strokeWidth="5" strokeLinecap="round" />
        {STRING_NODES.map(([cx, cy], i) => <circle key={i} cx={cx} cy={cy} r={i === 1 ? 4.6 : 4.2} />)}
      </g>
      <ellipse cx="13" cy="9.5" rx="7.5" ry="3.6" fill={`url(#${shine})`} />
    </svg>
  );
}

/** Inline amount with the token mark: ◉ 1,000 IDLE. */
export function IdleAmount({ value, size = 14, className, symbol = true, children }: {
  value: number | null | undefined; size?: number; className?: string; symbol?: boolean; children?: ReactNode;
}) {
  return (
    <span className={cn('inline-flex items-center gap-1 whitespace-nowrap tabular-nums', className)}>
      <IdleToken size={size} />
      <span>{children ?? fmtIdleAmount(value)}{symbol && value != null && <span className="ml-1 text-[0.85em] font-semibold tracking-wide text-gold-soft">{TOKEN_SYMBOL}</span>}</span>
    </span>
  );
}
