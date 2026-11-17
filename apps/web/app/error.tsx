'use client';
import '@/components/site/pages/pages.css';
import { useEffect } from 'react';
import Link from 'next/link';
import { motion, useReducedMotion } from 'framer-motion';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { AuroraBackground, GridBackground } from '@/components/fx';

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const reduce = useReducedMotion();
  useEffect(() => { console.error(error); }, [error]);
  return (
    <main className="aix-grain relative isolate flex min-h-screen items-center justify-center overflow-hidden px-4 py-16">
      <AuroraBackground palette="gold" intensity="subtle" className="-z-10" />
      <GridBackground fade className="-z-10 opacity-50" />
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(40%_40%_at_50%_40%,rgb(var(--danger)/0.10),transparent_70%)]" />
      <motion.div role="alert" className="relative max-w-md text-center" initial={reduce ? false : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
        <span className="relative inline-flex rounded-2xl bg-danger/10 p-4 text-danger-soft ring-1 ring-danger/30">
          <span aria-hidden className="aix-pulse-ring absolute inset-0 rounded-2xl border border-danger/50" />
          <AlertTriangle aria-hidden className="h-8 w-8" />
        </span>
        <h1 className="mt-6 text-2xl font-semibold sm:text-3xl">Something went wrong</h1>
        <p className="mt-3 text-fg-muted">An unexpected error occurred. You can try again, or head back home.</p>
        {error.digest && <p className="mt-3 inline-block rounded-lg border border-line bg-ink-900/70 px-2.5 py-1 font-mono text-xs text-fg-subtle">Reference: {error.digest}</p>}
        <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
          <button type="button" onClick={reset} className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-gold-sheen px-6 text-sm font-semibold text-ink-950 shadow-gold hover:brightness-110"><RotateCcw aria-hidden className="h-4 w-4" />Try again</button>
          <Link href="/" className="inline-flex h-12 items-center justify-center rounded-full border border-line bg-ink-900/50 px-6 text-sm font-medium backdrop-blur hover:bg-ink-800">Back to home</Link>
        </div>
      </motion.div>
    </main>
  );
}
