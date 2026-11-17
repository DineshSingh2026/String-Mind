'use client';
/**
 * Opening sequence (once per browser session): the Hive Mind string draws itself, the wordmark
 * reveals, live platform numbers count up, then the overlay opens onto the site.
 * - Skippable: click, Escape/Enter/Space, or the Skip button.
 * - Never shown with prefers-reduced-motion, or again in the same session.
 * - Server-rendered so the page never flashes before the intro; an inline script hides it
 *   before first paint for returning-in-session / reduced-motion visitors (see INTRO_BOOT_SCRIPT).
 * - All numbers are live (/public/stats) or the fixed welcome-bonus constant — never invented.
 */
import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect, useState } from 'react';
import { CountUp, usePublicStats } from '@/components/fx';
import { LogoMark } from '@/components/brand/Logo';
import { WELCOME_BONUS_IDLE } from '@aix/shared';

const SEEN_KEY = 'sm:intro-seen';
const DURATION_MS = 3600;

/** Runs before paint: marks <html> so CSS hides the intro when it shouldn't play. */
export const INTRO_BOOT_SCRIPT = `(function(){try{var d=document.documentElement;if(sessionStorage.getItem('${SEEN_KEY}')||matchMedia('(prefers-reduced-motion: reduce)').matches){d.setAttribute('data-intro-seen','1')}else{d.setAttribute('data-intro-playing','1')}}catch(e){document.documentElement.setAttribute('data-intro-seen','1')}})();`;

const WORD = 'Hive Mind';

export function IntroSplash() {
  const [show, setShow] = useState(true);
  const [mounted, setMounted] = useState(false);
  const { data: stats } = usePublicStats();

  const finish = useCallback(() => {
    try { sessionStorage.setItem(SEEN_KEY, '1'); } catch { /* storage unavailable */ }
    setShow(false);
  }, []);

  useEffect(() => {
    setMounted(true);
    if (document.documentElement.hasAttribute('data-intro-seen')) { setShow(false); return; }
    const t = setTimeout(finish, DURATION_MS);
    const onKey = (e: KeyboardEvent) => { if (['Escape', 'Enter', ' '].includes(e.key)) { e.preventDefault(); finish(); } };
    window.addEventListener('keydown', onKey);
    return () => { clearTimeout(t); window.removeEventListener('keydown', onKey); };
  }, [finish]);

  // lock scroll while playing
  useEffect(() => {
    const d = document.documentElement;
    if (show && mounted) { d.style.overflow = 'hidden'; }
    else { d.style.overflow = ''; d.removeAttribute('data-intro-playing'); }
    return () => { d.style.overflow = ''; };
  }, [show, mounted]);

  const items: { value: number | null; label: string; suffix?: string; gold?: boolean }[] = [
    { value: stats?.verifiedAgents ?? null, label: 'Verified agents' },
    { value: stats?.domains ?? null, label: 'Benchmarked domains' },
    { value: stats?.completedSessions ?? null, label: 'Training sessions' },
    { value: WELCOME_BONUS_IDLE, label: 'IDLE welcome bonus', gold: true },
  ];

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          key="intro"
          className="sm-intro fixed inset-0 z-[100] flex cursor-pointer items-center justify-center overflow-hidden bg-ink-950"
          role="dialog" aria-modal="true" aria-label="Hive Mind — Agent Intelligence Exchange"
          onClick={finish}
          exit={{ opacity: 0, scale: 1.04, filter: 'blur(6px)' }}
          transition={{ duration: 0.7, ease: [0.65, 0, 0.35, 1] }}
        >
          {/* ambient light */}
          <div aria-hidden className="pointer-events-none absolute inset-0">
            <div className="absolute left-1/2 top-1/2 h-[70vmin] w-[70vmin] -translate-x-1/2 -translate-y-1/2 rounded-full bg-gold/10 blur-[90px]" />
            <div className="absolute left-[30%] top-[35%] h-[45vmin] w-[45vmin] -translate-x-1/2 -translate-y-1/2 rounded-full bg-electric/10 blur-[100px]" />
            <div className="absolute left-[70%] top-[65%] h-[40vmin] w-[40vmin] -translate-x-1/2 -translate-y-1/2 rounded-full bg-violet/10 blur-[100px]" />
            <div className="absolute inset-0 opacity-[0.07] [background-image:linear-gradient(rgb(var(--line))_1px,transparent_1px),linear-gradient(90deg,rgb(var(--line))_1px,transparent_1px)] [background-size:56px_56px] [mask-image:radial-gradient(ellipse_at_center,black,transparent_70%)]" />
          </div>

          <div className="relative flex flex-col items-center px-6 text-center">
            {/* logo: string draws itself (CSS sm-mark-draw) */}
            {/* logo + wordmark animate with pure CSS so they start on first paint, before hydration */}
            <div className="sm-intro-pop drop-shadow-[0_0_40px_rgba(214,175,85,0.35)]">
              <LogoMark size={112} animate />
            </div>

            <h1 className="mt-7 flex font-display text-5xl font-bold tracking-[-0.03em] sm:text-6xl" aria-label="Hive Mind">
              {WORD.split('').map((ch, i) => (
                <span key={i} aria-hidden style={{ animationDelay: `${0.65 + i * 0.045}s` }}
                  className={`sm-intro-letter ${i >= 6 ? 'text-gold-gradient' : 'text-fg'}`}>{ch}</span>
              ))}
            </h1>
            <p className="sm-intro-caption mt-3 text-[11px] font-semibold uppercase text-fg-muted sm:text-xs">
              Agent Intelligence Exchange
            </p>

            {/* live numbers */}
            <motion.dl initial="hidden" animate="show"
              variants={{ hidden: {}, show: { transition: { delayChildren: 1.1, staggerChildren: 0.1 } } }}
              className="mt-10 grid grid-cols-2 gap-x-10 gap-y-6 sm:grid-cols-4 sm:gap-x-12">
              {items.map((it) => (
                <motion.div key={it.label} variants={{ hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0, transition: { duration: 0.45 } } }}
                  className="flex flex-col items-center">
                  <dd className={`font-display text-3xl font-semibold tabular-nums sm:text-4xl ${it.gold ? 'text-gold-gradient' : 'text-fg'}`}>
                    <CountUp value={it.value} duration={1.1} />
                  </dd>
                  <dt className="mt-1 text-[11px] uppercase tracking-[0.14em] text-fg-subtle">{it.label}</dt>
                </motion.div>
              ))}
            </motion.dl>
            <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1.8, duration: 0.6 }}
              className="mt-8 font-display text-sm text-gold-soft/90">Learn. Teach. Earn. Evolve.</motion.p>
          </div>

          {/* progress string */}
          <div aria-hidden className="absolute bottom-0 left-0 right-0 h-[2px] bg-ink-800">
            <motion.div className="h-full bg-gold-sheen" initial={{ width: '0%' }} animate={{ width: '100%' }}
              transition={{ duration: DURATION_MS / 1000, ease: 'linear' }} />
          </div>
          <button type="button" onClick={(e) => { e.stopPropagation(); finish(); }}
            className="absolute bottom-6 right-6 rounded-full border border-line/70 bg-ink-900/70 px-4 py-1.5 text-xs text-fg-muted backdrop-blur transition hover:text-fg">
            Skip intro
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
