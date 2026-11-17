'use client';
/** Developer code panel that types itself out (with light syntax colouring) when scrolled into view. */
import { useInView } from 'framer-motion';
import { usePrefersReducedMotion } from '@/components/fx';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';

type Tok = { t: string; c: string };
const RULES: [RegExp, string][] = [
  [/^\/\/[^\n]*/, 'text-fg-subtle italic'],
  [/^(`(?:[^`\\]|\\.)*`|'[^'\n]*'|"[^"\n]*")/, 'text-success-soft'],
  [/^\b(const|await|async|return|import|from|export|new|let|if|else|true|false)\b/, 'text-violet-soft'],
  [/^\b(fetch|JSON|stringify|json|process)\b/, 'text-electric-soft'],
  [/^\b\d+\b/, 'text-gold'],
  [/^[A-Za-z_$][\w$]*(?=\s*:)/, 'text-gold-soft'],
  [/^[{}()[\],.;:]/, 'text-fg-subtle'],
];

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let s = src;
  while (s.length) {
    let hit = false;
    for (const [re, c] of RULES) {
      const m = re.exec(s);
      if (m && m[0].length) { out.push({ t: m[0], c }); s = s.slice(m[0].length); hit = true; break; }
    }
    if (!hit) {
      const last = out[out.length - 1];
      if (last && last.c === 'text-fg') last.t += s[0]; else out.push({ t: s[0], c: 'text-fg' });
      s = s.slice(1);
    }
  }
  return out;
}

export function CodeTypewriter({ code, title }: { code: string; title: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: '-15% 0px' });
  const reduced = usePrefersReducedMotion();
  const toks = useMemo(() => tokenize(code), [code]);
  const [n, setN] = useState(0);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!inView) return;
    if (reduced) { setN(code.length); return; }
    let raf = 0; const start = performance.now();
    const cps = 140; // characters per second
    const tick = (now: number) => {
      const k = Math.min(code.length, Math.floor(((now - start) / 1000) * cps));
      setN(k);
      if (k < code.length) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [inView, reduced, code]);

  const rendered: Tok[] = [];
  let left = n;
  for (const tk of toks) { if (left <= 0) break; rendered.push({ t: tk.t.slice(0, left), c: tk.c }); left -= tk.t.length; }
  const lines = code.split('\n').length;
  const done = n >= code.length;

  const copy = async () => { try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { /* unavailable */ } };

  return (
    <div ref={ref} className="relative">
      <div aria-hidden className="pointer-events-none absolute -inset-8 bg-[radial-gradient(50%_50%_at_60%_40%,rgb(var(--electric)/0.18),transparent_70%)] blur-2xl" />
      <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-ink-950/90 shadow-[0_40px_120px_-40px_rgb(var(--electric)/0.45)]">
        <div className="flex items-center justify-between gap-2 border-b border-line/70 bg-ink-900/80 px-4 py-2.5">
          <span className="flex items-center gap-2.5 text-[11.5px] font-medium text-fg-subtle">
            <span aria-hidden className="flex gap-1.5"><i className="h-2.5 w-2.5 rounded-full bg-danger/70" /><i className="h-2.5 w-2.5 rounded-full bg-warning/70" /><i className="h-2.5 w-2.5 rounded-full bg-success/70" /></span>
            {title}
          </span>
          <button type="button" onClick={copy} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-fg-muted transition hover:bg-ink-800 hover:text-fg" aria-label={copied ? 'Copied' : 'Copy code'}>
            {copied ? <Check aria-hidden className="h-3.5 w-3.5 text-success" /> : <Copy aria-hidden className="h-3.5 w-3.5" />}{copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <div className="flex overflow-x-auto">
          <ol aria-hidden className="select-none border-r border-line/40 py-4 pl-4 pr-3 text-right font-mono text-[12px] leading-[1.7] text-fg-subtle/60">
            {Array.from({ length: lines }, (_, i) => <li key={i}>{i + 1}</li>)}
          </ol>
          {/* full code for assistive tech; animated copy is aria-hidden */}
          <pre className="sr-only"><code>{code}</code></pre>
          <pre aria-hidden className="relative min-w-0 flex-1 p-4 font-mono text-[12px] leading-[1.7]">
            {/* invisible full copy reserves the final height so the page never jumps */}
            <code className="invisible block">{code}</code>
            <code className="absolute inset-0 block p-4">
              {rendered.map((r, i) => <span key={i} className={r.c}>{r.t}</span>)}
              {!done && <span className="fx-caret" />}
            </code>
          </pre>
        </div>
        <div className="flex items-center gap-2 border-t border-line/50 bg-ink-900/60 px-4 py-2 font-mono text-[11px] text-fg-subtle">
          <span className={done ? 'h-1.5 w-1.5 rounded-full bg-success' : 'h-1.5 w-1.5 animate-pulse-dot rounded-full bg-gold'} aria-hidden />
          {done ? 'Ready — REST · Bearer aix_sk_… · signed webhooks' : 'Typing…'}
        </div>
      </div>
    </div>
  );
}
