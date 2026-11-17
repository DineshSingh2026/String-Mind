'use client';
import { useState, type ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Check, Copy } from 'lucide-react';
import { cx } from './primitives';

const KW = /^(const|let|var|async|await|function|return|if|else|import|from|export|interface|type|new|throw|for|of|in|true|false|null|undefined|def|with|as|print|class|readonly)$/;

/** Tiny, dependency-free highlighter: comments, strings, keywords, numbers, flags. Enough for docs snippets. */
export function highlight(code: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\/\/[^\n]*|#[^\n!]*(?=\n|$)|`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b\d+(?:\.\d+)?\b|(?<=\s)--?[a-zA-Z][\w-]*|\$[A-Z_]+|\b[A-Za-z_]\w*\b)/g;
  let last = 0; let m: RegExpExecArray | null; let k = 0;
  while ((m = re.exec(code))) {
    if (m.index > last) out.push(code.slice(last, m.index));
    const t = m[0];
    let cls = '';
    if (t.startsWith('//') || (t.startsWith('#') && !t.startsWith('#!'))) cls = 'text-fg-subtle italic';
    else if (/^["'`]/.test(t)) cls = 'text-success-soft';
    else if (/^\d/.test(t)) cls = 'text-warning';
    else if (t.startsWith('-')) cls = 'text-violet-soft';
    else if (t.startsWith('$')) cls = 'text-gold-soft';
    else if (KW.test(t)) cls = 'text-violet-soft';
    else if (/^[A-Z]/.test(t)) cls = 'text-electric-soft';
    out.push(cls ? <span key={k++} className={cls}>{t}</span> : t);
    last = m.index + t.length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

export function CopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { /* clipboard unavailable */ }
  };
  return (
    <button type="button" onClick={copy} className={cx('relative inline-flex items-center gap-1 overflow-hidden rounded-md px-2 py-1 text-[11px] transition', copied ? 'text-success-soft' : 'text-fg-muted hover:bg-ink-800 hover:text-fg')} aria-label={copied ? 'Copied' : 'Copy code'}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.span key={copied ? 'c' : 'n'} initial={{ y: 8, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -8, opacity: 0 }} transition={{ duration: 0.15 }} className="inline-flex items-center gap-1">
          {copied ? <Check aria-hidden className="h-3.5 w-3.5" /> : <Copy aria-hidden className="h-3.5 w-3.5" />}{copied ? 'Copied' : 'Copy'}
        </motion.span>
      </AnimatePresence>
    </button>
  );
}

export function CodeBlock({ code, lang, title, className }: { code: string; lang?: string; title?: string; className?: string }) {
  return (
    <div className={cx('not-prose overflow-hidden rounded-xl border border-line bg-ink-950 shadow-[0_20px_50px_-30px_rgb(0_0_0/0.9)]', className)}>
      <div className="flex items-center justify-between gap-2 border-b border-line/70 bg-ink-900/70 px-4 py-2">
        <span className="flex items-center gap-2 text-[11px] font-medium text-fg-subtle">
          <span aria-hidden className="flex gap-1"><i className="h-2 w-2 rounded-full bg-danger/60" /><i className="h-2 w-2 rounded-full bg-warning/60" /><i className="h-2 w-2 rounded-full bg-success/60" /></span>
          {title ?? lang}
        </span>
        <CopyButton code={code} />
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-[12.5px] leading-relaxed text-fg"><code>{highlight(code)}</code></pre>
    </div>
  );
}

/** Code with language tabs (e.g. curl / TypeScript / Python). */
export function CodeTabs({ tabs, className, title }: { tabs: { label: string; code: string; file?: string }[]; className?: string; title?: string }) {
  const [i, setI] = useState(0);
  const t = tabs[i];
  return (
    <div className={cx('not-prose overflow-hidden rounded-xl border border-line bg-ink-950 shadow-[0_20px_50px_-30px_rgb(0_0_0/0.9)]', className)}>
      <div className="flex items-center justify-between gap-2 border-b border-line/70 bg-ink-900/70 pl-2 pr-3">
        <div role="tablist" aria-label={title ?? 'Language'} className="flex min-w-0 overflow-x-auto">
          {tabs.map((x, n) => (
            <button key={x.label} type="button" role="tab" aria-selected={n === i} onClick={() => setI(n)}
              className={cx('relative whitespace-nowrap px-3 py-2.5 text-[12px] font-medium transition', n === i ? 'text-fg' : 'text-fg-subtle hover:text-fg-muted')}>
              {x.label}
              {n === i && <motion.span layoutId={`codetab-${title ?? 'x'}`} className="absolute inset-x-2 -bottom-px h-0.5 rounded bg-gold" />}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">{t.file && <span className="hidden font-mono text-[11px] text-fg-subtle sm:inline">{t.file}</span>}<CopyButton code={t.code} /></div>
      </div>
      <AnimatePresence mode="wait" initial={false}>
        <motion.pre key={i} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}
          className="overflow-x-auto p-4 font-mono text-[12.5px] leading-relaxed text-fg"><code>{highlight(t.code)}</code></motion.pre>
      </AnimatePresence>
    </div>
  );
}
