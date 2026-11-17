'use client';
/**
 * One-shot celebration for the 1,000 IDLE welcome bonus.
 * The sign-in / register / MFA forms stash `welcomeBonus` from the auth response in sessionStorage
 * (see lib/tokens.ts); the app shell reads it once after redirect and shows this dialog.
 * Fully reduced-motion aware: no particle burst, no coin flight, just a fade.
 */
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ArrowRight, X } from 'lucide-react';
import { mutate } from 'swr';
import { Button } from '@/components/ui';
import { AnimatedNumber, Celebrate } from '@/components/app/motion';
import { IdleToken } from '@/components/brand/IdleToken';
import { TOKEN_NAME, TOKEN_SYMBOL, fmtIdle, fmtIdleAmount, takeWelcomeBonus, type WelcomeBonusGrant } from '@/lib/tokens';

export function WelcomeBonusCelebration() {
  const [grant, setGrant] = useState<WelcomeBonusGrant | null>(null);
  useEffect(() => {
    const g = takeWelcomeBonus();
    if (g) { setGrant(g); void mutate('/wallet'); }
  }, []);
  return <AnimatePresence>{grant && <WelcomeDialog key="welcome" amount={grant.amount} onClose={() => setGrant(null)} />}</AnimatePresence>;
}

function WelcomeDialog({ amount, onClose }: { amount: number; onClose: () => void }) {
  const reduce = useReducedMotion();
  const router = useRouter();
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
    document.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => { document.removeEventListener('keydown', onKey); prev?.focus(); };
  }, []);
  const explore = () => { onClose(); router.push('/app/marketplace'); };
  const orbit = [0, 1, 2, 3, 4, 5];

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="welcome-bonus-title" aria-describedby="welcome-bonus-desc">
      <motion.div className="absolute inset-0 bg-black/75 backdrop-blur-md" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduce ? 0 : 0.25 }} />
      <motion.div ref={ref}
        className="relative w-full max-w-md overflow-hidden rounded-3xl border border-gold/40 bg-gradient-to-b from-ink-850 via-ink-900 to-ink-950 px-6 pb-6 pt-8 text-center shadow-[0_30px_120px_-30px_rgb(var(--gold)/0.65)]"
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: 30, scale: 0.94 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={reduce ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.97 }}
        transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 300, damping: 28 }}>
        <Celebrate fire />
        <div className="pointer-events-none absolute inset-x-10 top-0 h-px bg-gradient-to-r from-transparent via-gold-soft to-transparent" aria-hidden />
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_18%,rgb(var(--gold)/0.28),transparent_55%)]" aria-hidden />
        <button onClick={onClose} aria-label="Close" className="absolute right-3 top-3 rounded-lg p-1.5 text-fg-muted transition hover:bg-ink-800 hover:text-fg"><X className="h-4 w-4" /></button>

        {/* Token animation: main coin drops in and gently floats; small coins orbit in. */}
        <div className="relative mx-auto h-36 w-36" aria-hidden>
          {!reduce && orbit.map((i) => {
            const a = (i / orbit.length) * Math.PI * 2;
            return (
              <motion.span key={i} className="absolute left-1/2 top-1/2"
                initial={{ x: Math.cos(a) * 120 - 10, y: Math.sin(a) * 120 - 10, opacity: 0, scale: 0.4 }}
                animate={{ x: Math.cos(a) * 62 - 10, y: Math.sin(a) * 62 - 10, opacity: [0, 1, 0.85], scale: 1 }}
                transition={{ delay: 0.25 + i * 0.07, duration: 0.9, ease: [0.2, 0.7, 0.2, 1] }}>
                <IdleToken size={20} />
              </motion.span>
            );
          })}
          <motion.div className="absolute inset-0 flex items-center justify-center"
            initial={reduce ? false : { y: -40, rotateY: 180, opacity: 0 }} animate={{ y: 0, rotateY: 0, opacity: 1 }}
            transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 160, damping: 14, delay: 0.1 }}>
            <motion.div animate={reduce ? undefined : { y: [0, -6, 0] }} transition={{ duration: 3.2, repeat: Infinity, ease: 'easeInOut', delay: 1.2 }}
              className="rounded-full drop-shadow-[0_14px_40px_rgb(var(--gold)/0.55)]">
              <IdleToken size={96} />
            </motion.div>
          </motion.div>
        </div>

        <p className="relative mt-3 text-xs font-semibold uppercase tracking-[0.2em] text-gold-soft">Welcome bonus</p>
        <h2 id="welcome-bonus-title" className="relative mt-2 font-display text-2xl font-semibold leading-tight">Welcome to Hive Mind</h2>
        <p className="relative mt-3 font-display text-4xl font-semibold tabular-nums">
          <AnimatedNumber value={amount} format={(n) => fmtIdleAmount(Math.round(n))} className="ax-text-sheen" duration={1.6} />
          <span className="ml-2 text-xl text-gold-soft">{TOKEN_SYMBOL}</span>
        </p>
        <p id="welcome-bonus-desc" className="relative mx-auto mt-3 max-w-xs text-sm text-fg-muted">
          {fmtIdle(amount).replace(TOKEN_SYMBOL, TOKEN_NAME)} have been added to your wallet. Spend them on training and knowledge — and earn more by teaching.
        </p>
        <div className="relative mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
          <Button variant="primary" data-autofocus onClick={explore}>Explore the marketplace<ArrowRight className="h-4 w-4" aria-hidden /></Button>
          <Button variant="ghost" onClick={() => { onClose(); router.push('/app/wallet'); }}>View wallet</Button>
        </div>
      </motion.div>
    </div>
  );
}
