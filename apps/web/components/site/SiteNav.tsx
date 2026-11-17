'use client';
/**
 * Sticky glass top navigation for the public site.
 * - Shrinks + deepens its blur on scroll, gold scroll-progress bar along the bottom edge.
 * - Desktop: animated mega-menu disclosures (click / hover / keyboard: ↓ opens, ↑↓ Home End move, Esc closes & restores focus).
 * - Mobile (< lg): hamburger → full-screen animated sheet with search, grouped links and CTAs (focus trapped, Esc closes).
 */
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { AnimatePresence, motion, useScroll, useSpring } from 'framer-motion';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ArrowRight, ChevronDown, LayoutDashboard, Menu, Search, X } from 'lucide-react';
import { Logo } from '@/components/brand/Logo';
import { useApi } from '@/lib/api';
import { CountUp, usePublicStats, usePrefersReducedMotion } from '@/components/fx';
import { NAV_GROUPS, type NavFeature, type NavGroup } from './nav-data';
import { cx } from './primitives';

function useSignedIn() {
  const { data, error } = useApi<{ user: { name: string } }>('/auth/me', { shouldRetryOnError: false, revalidateOnFocus: false });
  return { signedIn: !!data && !error, name: data?.user?.name };
}

function SearchPill({ className, autoFocus, onDone, compact }: { className?: string; autoFocus?: boolean; onDone?: () => void; compact?: boolean }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const id = useId();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const term = q.trim();
    router.push(term ? `/marketplace?q=${encodeURIComponent(term)}` : '/marketplace');
    onDone?.();
  };
  return (
    <form role="search" onSubmit={submit} className={cx('group relative', className)}>
      <label htmlFor={id} className="sr-only">Search agents, skills, or topics</label>
      <Search aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle transition group-focus-within:text-electric" />
      <input
        id={id} type="search" value={q} onChange={(e) => setQ(e.target.value)} autoFocus={autoFocus}
        placeholder="Search agents, skills, or topics..."
        className={cx(
          'w-full rounded-full border border-white/10 bg-white/[0.04] pl-10 pr-4 text-sm text-fg placeholder:text-fg-subtle transition-all focus:border-electric/70 focus:bg-ink-950/80 focus:outline-none focus:shadow-focus',
          compact ? 'h-9' : 'h-10',
        )}
      />
    </form>
  );
}

const TONE = {
  gold: { ring: 'from-gold/25 via-gold/5', text: 'text-gold-soft', dot: 'bg-gold' },
  electric: { ring: 'from-electric/25 via-electric/5', text: 'text-electric-soft', dot: 'bg-electric' },
  violet: { ring: 'from-violet/25 via-violet/5', text: 'text-violet-soft', dot: 'bg-violet' },
};

function FeatureCard({ f, onClose }: { f: NavFeature; onClose: () => void }) {
  const { data } = usePublicStats();
  const t = TONE[f.tone];
  return (
    <Link href={f.href} onClick={onClose}
      className={cx('group/f relative flex h-full flex-col overflow-hidden rounded-xl border border-white/[0.08] bg-gradient-to-br to-transparent p-4 transition hover:border-white/20', t.ring)}>
      <span className={cx('inline-flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.14em]', t.text)}>
        <span aria-hidden className={cx('h-1.5 w-1.5 rounded-full', t.dot, f.live && 'animate-pulse-dot')} />{f.eyebrow}
      </span>
      <span className="mt-2 font-display text-[15px] font-semibold text-fg">{f.title}</span>
      <span className="mt-1 text-xs leading-relaxed text-fg-muted">{f.body}</span>
      {f.live && (
        <span className="mt-3 grid grid-cols-2 gap-2">
          <span className="rounded-lg bg-ink-950/50 px-2.5 py-2">
            <span className="block font-display text-lg font-semibold text-fg"><CountUp value={data ? data.verifiedAgents : null} duration={0.8} /></span>
            <span className="block text-[10.5px] text-fg-subtle">verified agents</span>
          </span>
          <span className="rounded-lg bg-ink-950/50 px-2.5 py-2">
            <span className="block font-display text-lg font-semibold text-fg"><CountUp value={data ? data.completedSessions : null} duration={0.8} /></span>
            <span className="block text-[10.5px] text-fg-subtle">completed sessions</span>
          </span>
        </span>
      )}
      <span className="mt-auto inline-flex items-center gap-1 pt-3 text-xs font-medium text-gold-soft">
        {f.cta} <ArrowRight aria-hidden className="h-3.5 w-3.5 transition group-hover/f:translate-x-0.5" />
      </span>
    </Link>
  );
}

function NavDropdown({ group, open, onOpen, onClose }: { group: NavGroup; open: boolean; onOpen: () => void; onClose: () => void }) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusFirst = useRef(false);
  const panelId = useId();
  const pathname = usePathname();
  const reduced = usePrefersReducedMotion();
  const active = group.links.some((l) => l.href.split(/[?#]/)[0] === pathname);

  const links = () => Array.from(panelRef.current?.querySelectorAll<HTMLAnchorElement>('a[data-menu-item]') ?? []);
  const focusAt = (i: number) => { const ls = links(); if (ls.length) ls[(i + ls.length) % ls.length].focus(); };
  useEffect(() => { if (open && focusFirst.current) { focusFirst.current = false; requestAnimationFrame(() => focusAt(0)); } });

  const onButtonKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); focusFirst.current = true; if (open) focusAt(0); else onOpen(); }
    if (e.key === 'Escape' && open) { e.preventDefault(); onClose(); }
  };
  const onPanelKey = (e: KeyboardEvent) => {
    const ls = links(); const i = ls.indexOf(document.activeElement as HTMLAnchorElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); focusAt(i + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusAt(i - 1); }
    else if (e.key === 'Home') { e.preventDefault(); focusAt(0); }
    else if (e.key === 'End') { e.preventDefault(); focusAt(ls.length - 1); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); btnRef.current?.focus(); }
  };
  const enter = (e: React.PointerEvent) => { if (e.pointerType !== 'mouse') return; if (hoverTimer.current) clearTimeout(hoverTimer.current); onOpen(); };
  const leave = (e: React.PointerEvent) => { if (e.pointerType !== 'mouse') return; hoverTimer.current = setTimeout(onClose, 160); };
  const two = group.links.length > 3;

  return (
    <li
      onPointerEnter={enter} onPointerLeave={leave}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) onClose(); }}
    >
      <button
        ref={btnRef} type="button" aria-expanded={open} aria-controls={open ? panelId : undefined}
        onClick={() => (open ? onClose() : onOpen())} onKeyDown={onButtonKey}
        className={cx('relative inline-flex h-9 items-center gap-1 rounded-full px-3.5 text-sm transition', open ? 'bg-white/[0.06] text-fg' : active ? 'text-fg' : 'text-fg-muted hover:text-fg')}
      >
        {group.label}
        <ChevronDown aria-hidden className={cx('h-3.5 w-3.5 transition duration-300', open && 'rotate-180 text-gold')} />
        {active && <span aria-hidden className="absolute inset-x-3.5 -bottom-0.5 h-px bg-gradient-to-r from-transparent via-gold to-transparent" />}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            ref={panelRef} id={panelId} onKeyDown={onPanelKey}
            initial={reduced ? false : { opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: -4, scale: 0.98, transition: { duration: 0.12 } }}
            transition={{ duration: 0.22, ease: [0.2, 0.7, 0.2, 1] }}
            style={{ transformOrigin: 'top left' }}
            className="absolute left-0 top-full z-50 pt-3"
          >
            <div className={cx('relative overflow-hidden rounded-2xl border border-white/10 bg-ink-900/[0.98] p-2.5 shadow-[0_30px_80px_-20px_rgb(0_0_0/0.9)] backdrop-blur-2xl', two ? 'w-[720px]' : 'w-[560px]')}>
              <div aria-hidden className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-gold/50 to-transparent" />
              <div className="grid grid-cols-[1fr_200px] gap-2.5">
                <ul className={cx('grid gap-0.5', two && 'grid-cols-2')}>
                  {group.links.map((l, i) => {
                    const Icon = l.icon;
                    return (
                      <motion.li key={l.href + l.label} initial={reduced ? false : { opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.03 * i, duration: 0.2 }}>
                        <Link data-menu-item href={l.href} onClick={onClose} className="group flex gap-3 rounded-xl p-2.5 transition hover:bg-white/[0.05] focus-visible:bg-white/[0.05]">
                          {Icon && (
                            <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/[0.08] bg-ink-850 text-fg-muted transition group-hover:border-gold/40 group-hover:text-gold group-focus-visible:text-gold">
                              <Icon className="h-4 w-4" />
                            </span>
                          )}
                          <span className="min-w-0">
                            <span className="flex items-center gap-1.5 text-sm font-medium text-fg">
                              {l.label}
                              <ArrowRight aria-hidden className="h-3.5 w-3.5 -translate-x-1 text-gold opacity-0 transition group-hover:translate-x-0 group-hover:opacity-100" />
                            </span>
                            {l.description && <span className="mt-0.5 block text-xs leading-snug text-fg-subtle">{l.description}</span>}
                          </span>
                        </Link>
                      </motion.li>
                    );
                  })}
                </ul>
                {group.feature && <FeatureCard f={group.feature} onClose={onClose} />}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  );
}

function MobileSheet({ open, onClose, signedIn }: { open: boolean; onClose: () => void; signedIn: boolean }) {
  const [expanded, setExpanded] = useState<string | null>(NAV_GROUPS[0].label);
  const closeRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const reduced = usePrefersReducedMotion();
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => closeRef.current?.focus());
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab' && sheetRef.current) { // focus trap
        const f = Array.from(sheetRef.current.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input')).filter((el) => el.offsetParent !== null);
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = prev; document.removeEventListener('keydown', onKey); };
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={sheetRef}
          id="mobile-menu" role="dialog" aria-modal="true" aria-label="Site menu"
          initial={reduced ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.18 } }}
          className="fixed inset-0 z-[70] flex flex-col overflow-hidden bg-ink-950/95 backdrop-blur-2xl lg:hidden"
        >
          <div aria-hidden className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-electric/20 blur-3xl" />
          <div aria-hidden className="pointer-events-none absolute -bottom-24 -left-24 h-72 w-72 rounded-full bg-gold/15 blur-3xl" />
          <div className="container-x relative flex h-16 shrink-0 items-center justify-between border-b border-white/[0.06]">
            <Logo />
            <button ref={closeRef} type="button" onClick={onClose} aria-label="Close menu" className="rounded-full p-2 text-fg-muted transition hover:bg-white/[0.06] hover:text-fg">
              <X className="h-6 w-6" />
            </button>
          </div>
          <div className="relative flex-1 overflow-y-auto">
            <div className="container-x py-5">
              <SearchPill onDone={onClose} />
              <nav aria-label="Mobile" className="mt-4">
                <motion.ul
                  className="divide-y divide-white/[0.06]"
                  initial={reduced ? false : 'hidden'} animate="show"
                  variants={{ hidden: {}, show: { transition: { staggerChildren: 0.05, delayChildren: 0.05 } } }}
                >
                  {NAV_GROUPS.map((g) => {
                    const isOpen = expanded === g.label;
                    const pid = `m-${g.label}`;
                    return (
                      <motion.li key={g.label} variants={{ hidden: { opacity: 0, x: -16 }, show: { opacity: 1, x: 0 } }}>
                        <button type="button" aria-expanded={isOpen} aria-controls={pid} onClick={() => setExpanded(isOpen ? null : g.label)}
                          className="flex w-full items-center justify-between py-4 text-left font-display text-xl font-semibold text-fg">
                          {g.label}
                          <ChevronDown aria-hidden className={cx('h-5 w-5 text-fg-subtle transition duration-300', isOpen && 'rotate-180 text-gold')} />
                        </button>
                        <AnimatePresence initial={false}>
                          {isOpen && (
                            <motion.div id={pid} initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.25 }} className="overflow-hidden">
                              <ul className="pb-3">
                                {g.links.map((l) => {
                                  const Icon = l.icon;
                                  return (
                                    <li key={l.href + l.label}>
                                      <Link href={l.href} onClick={onClose} className="flex items-center gap-3 rounded-xl px-2 py-2.5 transition hover:bg-white/[0.04]">
                                        {Icon && <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/[0.08] bg-ink-850 text-gold"><Icon className="h-4 w-4" /></span>}
                                        <span className="min-w-0">
                                          <span className="block text-[15px] text-fg">{l.label}</span>
                                          {l.description && <span className="block text-xs text-fg-subtle">{l.description}</span>}
                                        </span>
                                      </Link>
                                    </li>
                                  );
                                })}
                              </ul>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </motion.li>
                    );
                  })}
                  <motion.li variants={{ hidden: { opacity: 0, x: -16 }, show: { opacity: 1, x: 0 } }}>
                    <Link href="/contact" onClick={onClose} className="block py-4 font-display text-xl font-semibold text-fg">Contact</Link>
                  </motion.li>
                </motion.ul>
              </nav>
            </div>
          </div>
          <div className="container-x relative shrink-0 border-t border-white/[0.06] py-4">
            {signedIn ? (
              <Link href="/app" onClick={onClose} className="flex h-12 items-center justify-center gap-2 rounded-full bg-gold-sheen font-semibold text-ink-950 shadow-gold">
                <LayoutDashboard aria-hidden className="h-4 w-4" /> Open the app
              </Link>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <Link href="/sign-in" onClick={onClose} className="flex h-12 items-center justify-center rounded-full border border-white/15 font-medium text-fg">Sign In</Link>
                <Link href="/register" onClick={onClose} className="flex h-12 items-center justify-center rounded-full bg-gold-sheen font-semibold text-ink-950 shadow-gold">Get Started</Link>
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function SiteNav() {
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const [mobile, setMobile] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const pathname = usePathname();
  const { signedIn } = useSignedIn();
  const closeMobile = useCallback(() => setMobile(false), []);
  const { scrollYProgress } = useScroll();
  const progress = useSpring(scrollYProgress, { stiffness: 140, damping: 26, mass: 0.3 });

  useEffect(() => { setOpenIdx(null); setMobile(false); }, [pathname]);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  useEffect(() => {
    if (openIdx === null) return;
    const onDown = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('[data-site-nav]')) setOpenIdx(null); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [openIdx]);

  return (
    <>
      <a href="#main" className="sr-only z-[80] rounded-lg bg-gold px-4 py-2 font-semibold text-ink-950 focus:not-sr-only focus:fixed focus:left-4 focus:top-4">Skip to content</a>
      <header
        data-site-nav
        className={cx(
          'sticky top-0 z-40 border-b transition-[background-color,border-color,backdrop-filter,box-shadow] duration-500',
          scrolled ? 'border-white/[0.07] bg-ink-950/70 shadow-[0_10px_40px_-20px_rgb(0_0_0/0.9)] backdrop-blur-2xl backdrop-saturate-150' : 'border-transparent bg-ink-950/30 backdrop-blur-md',
        )}
      >
        <div className={cx('container-x flex items-center gap-4 transition-[height] duration-500', scrolled ? 'h-14 lg:h-[60px]' : 'h-16 lg:h-[76px]')}>
          <Logo className={cx('shrink-0 origin-left transition-transform duration-500', scrolled && 'lg:scale-[0.92]')} />
          <nav aria-label="Main" className="relative ml-4 hidden lg:block">
            <ul className="flex items-center gap-0.5">
              {NAV_GROUPS.map((g, i) => (
                <NavDropdown key={g.label} group={g} open={openIdx === i} onOpen={() => setOpenIdx(i)} onClose={() => setOpenIdx((v) => (v === i ? null : v))} />
              ))}
            </ul>
          </nav>
          <div className="ml-auto flex items-center gap-2 sm:gap-3">
            <SearchPill compact={scrolled} className="hidden w-[250px] xl:block 2xl:w-[300px]" />
            <Link href="/marketplace" aria-label="Search the marketplace" className="hidden rounded-full p-2 text-fg-muted hover:bg-white/[0.06] hover:text-fg lg:inline-flex xl:hidden">
              <Search className="h-5 w-5" />
            </Link>
            {signedIn ? (
              <Link href="/app" className="group relative hidden h-10 items-center gap-2 overflow-hidden rounded-full bg-gold-sheen px-5 text-sm font-semibold text-ink-950 shadow-gold transition hover:brightness-110 sm:inline-flex">
                <LayoutDashboard aria-hidden className="h-4 w-4" /> Open App
              </Link>
            ) : (
              <>
                <Link href="/register" className="group relative hidden h-10 items-center overflow-hidden rounded-full bg-gold-sheen px-5 text-sm font-semibold text-ink-950 shadow-gold transition hover:brightness-110 sm:inline-flex">
                  <span aria-hidden className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/50 to-transparent transition-transform duration-700 group-hover:translate-x-full" />
                  <span className="relative">Get Started</span>
                </Link>
                <Link href="/sign-in" className="hidden px-1 text-sm font-medium text-fg-muted transition hover:text-fg sm:inline">Sign In</Link>
              </>
            )}
            <button
              type="button" onClick={() => setMobile(true)} aria-label="Open menu" aria-expanded={mobile} aria-controls="mobile-menu"
              className="rounded-full p-2 text-fg transition hover:bg-white/[0.06] lg:hidden"
            >
              <Menu className="h-6 w-6" />
            </button>
          </div>
        </div>
        {/* gold scroll progress */}
        <motion.div aria-hidden style={{ scaleX: progress }} className="absolute inset-x-0 bottom-[-1px] h-[2px] origin-left bg-gradient-to-r from-gold-deep via-gold to-gold-soft shadow-[0_0_12px_rgb(var(--gold)/0.7)]" />
      </header>
      <MobileSheet open={mobile} onClose={closeMobile} signedIn={signedIn} />
    </>
  );
}
