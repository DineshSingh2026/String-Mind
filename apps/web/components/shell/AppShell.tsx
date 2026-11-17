'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from 'framer-motion';
import {
  LayoutDashboard, Store, Bot, Gauge, GraduationCap, MessagesSquare, Library, Wallet, Coins, BarChart3, Trophy,
  Code2, Building2, Bell, Settings, LifeBuoy, Hexagon, Swords, Radio, Award, Menu, X, Crown, LogOut, ChevronDown, ShieldCheck, ArrowRight, PanelLeftClose, PanelLeftOpen, Search,
} from 'lucide-react';
import { Logo, LogoMark } from '@/components/brand/Logo';
import { Avatar, Spinner, cn } from '@/components/ui';
import { api, useApi } from '@/lib/api';
import { SessionProvider, switchOrg, useSession } from '@/lib/session';
import { useRealtime } from '@/lib/realtime';
import { listOf, type Agent, type Paged } from '@/components/app/types';
import { AmbientBackground, useSpotlightDelegation } from './ambient';
import { CommandPalette, PaletteTrigger, useCommandPaletteHotkey } from './CommandPalette';
import { WelcomeBonusCelebration } from './WelcomeBonus';
import './app-motion.css';

export const APP_NAV = [
  { href: '/app', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/app/marketplace', label: 'Agent Marketplace', icon: Store },
  { href: '/app/agents', label: 'My Agents', icon: Bot },
  { href: '/app/assessments', label: 'Capability Assessment', icon: Gauge },
  { href: '/app/evaluation', label: 'Professional Evaluation', icon: Award },
  { href: '/app/training', label: 'Training Hub', icon: GraduationCap },
  { href: '/app/conversations', label: 'Live Conversations', icon: MessagesSquare },
  { href: '/app/knowledge', label: 'Knowledge Bank', icon: Library },
  { href: '/app/hive', label: 'The Hive', icon: Hexagon },
  { href: '/app/debates', label: 'Debates & Challenges', icon: Swords },
  { href: '/app/rooms', label: 'Public Rooms', icon: Radio },
  { href: '/app/wallet', label: 'IDLE Wallet', icon: Wallet },
  { href: '/app/earnings', label: 'Earnings & Rewards', icon: Coins },
  { href: '/app/analytics', label: 'Analytics', icon: BarChart3 },
  { href: '/app/leaderboard', label: 'Leaderboard', icon: Trophy },
  { href: '/app/developer', label: 'Developer Console', icon: Code2 },
  { href: '/app/organisation', label: 'Organisation', icon: Building2 },
  { href: '/app/notifications', label: 'Notifications', icon: Bell },
  { href: '/app/settings', label: 'Settings', icon: Settings },
  { href: '/app/support', label: 'Support', icon: LifeBuoy },
] as const;

/** Visual grouping of APP_NAV (indices), rendered with small section labels. */
const NAV_GROUPS: { label: string; items: number[] }[] = [
  { label: 'Workspace', items: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
  { label: 'Economy', items: [11, 12, 13, 14] },
  { label: 'Build & manage', items: [15, 16, 17, 18, 19] },
];

const navItem = (href: string) => APP_NAV.find((n) => n.href === href)!;
const MOBILE_TABS = [
  { ...navItem('/app'), short: 'Home' },
  { ...navItem('/app/marketplace'), short: 'Market' },
  { ...navItem('/app/training'), short: 'Training' },
  { ...navItem('/app/hive'), short: 'Hive' },
  { ...navItem('/app/wallet'), short: 'Wallet' },
];

const COLLAPSE_KEY = 'aix.sidebar.collapsed';

function isActive(path: string, href: string) {
  return href === '/app' ? path === '/app' : path === href || path.startsWith(href + '/');
}

function NavList({ path, onNavigate, collapsed, idPrefix }: { path: string; onNavigate?: () => void; collapsed?: boolean; idPrefix: string }) {
  const reduce = useReducedMotion();
  return (
    <nav aria-label="Application">
      <LayoutGroup id={idPrefix}>
        {NAV_GROUPS.map((g, gi) => (
          <div key={g.label} className={cn(gi > 0 && 'mt-4')}>
            {collapsed ? (gi > 0 && <div className="mx-3 mb-3 h-px bg-line/60" aria-hidden />)
              : <p className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-fg-subtle/80">{g.label}</p>}
            <ul className="space-y-0.5">
              {g.items.map((i) => {
                const { href, label, icon: Icon } = APP_NAV[i]!;
                const active = isActive(path, href);
                return (
                  <li key={href}>
                    <Link href={href} onClick={onNavigate} aria-current={active ? 'page' : undefined} title={collapsed ? label : undefined} aria-label={collapsed ? label : undefined}
                      className={cn('group relative flex items-center gap-3 rounded-xl py-2 text-[13.5px] transition-colors', collapsed ? 'justify-center px-0' : 'px-3',
                        active ? 'font-medium text-gold-soft' : 'text-fg-muted hover:text-fg')}>
                      {active && (
                        <motion.span layoutId="nav-pill" aria-hidden transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 520, damping: 40 }}
                          className="absolute inset-0 rounded-xl border border-gold/25 bg-gradient-to-r from-gold/20 via-gold/10 to-transparent shadow-[inset_2px_0_0_rgb(var(--gold)),0_0_24px_-8px_rgb(var(--gold)/0.6)]" />
                      )}
                      {!active && <span aria-hidden className="absolute inset-0 rounded-xl bg-ink-800/0 transition-colors group-hover:bg-ink-800/70" />}
                      <Icon className={cn('relative h-[18px] w-[18px] shrink-0 transition-transform duration-200 group-hover:scale-110', active ? 'text-gold drop-shadow-[0_0_6px_rgb(var(--gold)/0.6)]' : 'text-fg-subtle group-hover:text-fg-muted')} />
                      {!collapsed && <span className="relative truncate">{label}</span>}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </LayoutGroup>
    </nav>
  );
}

function UpgradeCard({ collapsed }: { collapsed?: boolean }) {
  const { me } = useSession();
  if (!me?.org || me.org.plan !== 'free') return null;
  if (collapsed) {
    return <Link href="/pricing" title="Upgrade to Pro Plan" aria-label="Upgrade to Pro Plan" className="mx-auto mt-5 flex h-10 w-10 items-center justify-center rounded-xl border border-gold/30 bg-gold/10 text-gold hover:bg-gold/20"><Crown className="h-5 w-5" /></Link>;
  }
  return (
    <div className="ax-sheen relative mt-6 overflow-hidden rounded-2xl border border-gold/30 bg-gradient-to-b from-gold/12 to-transparent p-4 text-center">
      <Crown className="ax-float mx-auto h-7 w-7 text-gold drop-shadow-[0_0_10px_rgb(var(--gold)/0.6)]" />
      <p className="mt-2 font-display text-sm font-semibold">Upgrade to Pro Plan</p>
      <p className="mt-1 text-xs text-fg-muted">Unlock unlimited training &amp; higher rewards</p>
      <Link href="/pricing" className="ax-btn ax-btn--shine mt-3 inline-flex items-center gap-1 rounded-lg bg-gold-sheen px-3 py-1.5 text-xs font-semibold text-ink-950">Upgrade Now <ArrowRight className="h-3 w-3" /></Link>
    </div>
  );
}

function NotificationBell() {
  const { me } = useSession();
  const { data, mutate } = useApi<{ unread: number }>('/notifications/unread-count', { refreshInterval: 30000 });
  useRealtime(me ? `user:${me.user.id}` : null, (event) => { if (event === 'notification') void mutate(); });
  const n = data?.unread ?? 0;
  const prev = useRef<number | null>(null);
  const [ring, setRing] = useState(0);
  useEffect(() => {
    if (data == null) return;
    // ring once on first load with unread items, and whenever the count increases
    if ((prev.current == null && n > 0) || (prev.current != null && n > prev.current)) setRing((r) => r + 1);
    prev.current = n;
  }, [n, data]);
  return (
    <Link href="/app/notifications" className="group relative rounded-xl p-2 text-fg-muted transition hover:bg-ink-800 hover:text-fg" aria-label={`Notifications${n ? `, ${n} unread` : ''}`}>
      <Bell key={ring} className={cn('h-5 w-5', ring > 0 && 'ax-bell-ring')} />
      <AnimatePresence>
        {n > 0 && (
          <motion.span key={n} initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.4, opacity: 0 }} transition={{ type: 'spring', stiffness: 600, damping: 20 }}
            className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold text-white shadow-[0_0_10px_rgb(var(--danger)/0.7)]">
            {n > 99 ? '99+' : n}
          </motion.span>
        )}
      </AnimatePresence>
    </Link>
  );
}

function UserMenu() {
  const { me } = useSession();
  const router = useRouter();
  const reduce = useReducedMotion();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', h); document.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k); };
  }, []);
  if (!me) return null;
  const planLabel = me.org ? `${me.org.plan[0]!.toUpperCase()}${me.org.plan.slice(1)} ${me.org.type === 'enterprise' ? 'Enterprise' : 'Member'}` : '';
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2.5 rounded-xl p-1 pr-2 transition hover:bg-ink-800" aria-haspopup="menu" aria-expanded={open}>
        <span className="relative rounded-full bg-gradient-to-br from-gold/70 via-gold/20 to-electric/60 p-[1.5px]"><Avatar name={me.user.name} size={32} className="rounded-full" /></span>
        <span className="hidden text-left leading-tight md:block"><span className="block text-sm font-medium">{me.user.name}</span><span className="block text-[11px] text-gold-soft/80">{planLabel}</span></span>
        <ChevronDown className={cn('hidden h-4 w-4 text-fg-subtle transition-transform md:block', open && 'rotate-180')} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div role="menu" initial={reduce ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.97 }}
            transition={{ duration: 0.16 }} style={{ transformOrigin: 'top right' }}
            className="absolute right-0 top-12 z-40 w-64 rounded-2xl border border-line bg-ink-850/95 p-2 shadow-2xl backdrop-blur-xl">
            <div className="px-3 py-2"><p className="truncate text-sm font-medium">{me.user.email}</p><p className="text-xs text-fg-subtle">{me.org?.name} · {me.role}</p></div>
            {me.orgs.length > 1 && (
              <div className="border-t border-line/60 py-1">
                <p className="px-3 py-1 text-[11px] uppercase tracking-wider text-fg-subtle">Switch organisation</p>
                {me.orgs.map((o) => (
                  <button key={o.id} role="menuitem" onClick={() => switchOrg(o.id)} className={cn('w-full rounded-lg px-3 py-1.5 text-left text-sm hover:bg-ink-800', o.id === me.org?.id ? 'text-gold-soft' : 'text-fg-muted')}>{o.name}</button>
                ))}
              </div>
            )}
            <div className="border-t border-line/60 pt-1">
              <Link role="menuitem" href="/app/settings" className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-fg-muted hover:bg-ink-800 hover:text-fg"><Settings className="h-4 w-4" />Settings</Link>
              {(me.user.platformRole === 'admin' || me.user.platformRole === 'super_admin') && (
                <Link role="menuitem" href="/admin" className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-fg-muted hover:bg-ink-800 hover:text-fg"><ShieldCheck className="h-4 w-4" />Admin panel</Link>
              )}
              <button role="menuitem" onClick={async () => { await api.post('/auth/logout').catch(() => undefined); router.push('/sign-in'); }} className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-fg-muted hover:bg-ink-800 hover:text-fg"><LogOut className="h-4 w-4" />Sign out</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Guard({ children }: { children: ReactNode }) {
  const { me, loading, unavailable, refresh } = useSession();
  const router = useRouter();
  const path = usePathname();
  useEffect(() => { if (!loading && !me && !unavailable) router.replace(`/sign-in?next=${encodeURIComponent(path)}`); }, [loading, me, unavailable, router, path]);
  if (unavailable) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="card max-w-md p-6 text-center">
          <p className="font-display text-lg font-semibold">Can&apos;t reach the Hive Mind API</p>
          <p className="mt-2 text-sm text-fg-muted">The service is restarting or temporarily unavailable. You are still signed in.</p>
          <button onClick={refresh} className="mt-5 rounded-xl bg-gold-sheen px-4 py-2 text-sm font-semibold text-ink-950">Try again</button>
        </div>
      </div>
    );
  }
  if (loading || !me) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4">
        <LogoMark size={44} className="ax-glow-pulse" />
        <Spinner />
      </div>
    );
  }
  return <>{children}</>;
}

/** Data-aware ambient: particle drift density scales with the org's real agents (gold when any is verified). */
function AppAmbient() {
  const { data } = useApi<Agent[] | Paged<Agent>>('/agents');
  const list = listOf(data);
  const verified = list.filter((a) => a.overallScore != null).length;
  const density = data ? Math.min(0.32, list.length * 0.035 + verified * 0.02) : 0;
  return <AmbientBackground particles={density} particleColor={verified ? '240,214,150' : '140,190,255'} />;
}

function PageTransition({ path, children }: { path: string; children: ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <motion.div key={path} className="ax-page" initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }}>
      {children}
    </motion.div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const reduce = useReducedMotion();
  const [drawer, setDrawer] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [palette, setPalette] = useState(false);
  useEffect(() => setDrawer(false), [path]);
  useEffect(() => { try { setCollapsed(localStorage.getItem(COLLAPSE_KEY) === '1'); } catch { /* storage unavailable */ } }, []);
  const toggleCollapsed = () => setCollapsed((c) => { const n = !c; try { localStorage.setItem(COLLAPSE_KEY, n ? '1' : '0'); } catch { /* ignore */ } return n; });
  const setPaletteFn = useCallback((fn: (o: boolean) => boolean) => setPalette(fn), []);
  useCommandPaletteHotkey(setPaletteFn);
  useSpotlightDelegation();
  const w = collapsed ? 76 : 240;

  return (
    <SessionProvider>
      <Guard>
        <div className="relative min-h-screen bg-ink-950">
          <AppAmbient />
          {/* Desktop sidebar */}
          <motion.aside initial={false} animate={{ width: w }} transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 380, damping: 38 }}
            className="fixed inset-y-0 left-0 z-30 hidden flex-col border-r border-line/60 bg-ink-900/75 py-5 backdrop-blur-xl lg:flex" style={{ width: w }}>
            <div className="pointer-events-none absolute inset-y-0 right-0 w-px bg-gradient-to-b from-gold/30 via-line/0 to-electric/20" aria-hidden />
            <div className={cn('flex items-center', collapsed ? 'justify-center px-2' : 'px-5')}>
              {collapsed ? <Link href="/app" aria-label="Hive Mind dashboard"><LogoMark size={34} /></Link> : <Logo href="/app" />}
            </div>
            <div className={cn('mt-7 flex-1 overflow-y-auto overflow-x-hidden', collapsed ? 'px-2' : 'px-3')}>
              <NavList path={path} collapsed={collapsed} idPrefix="desk" />
              <UpgradeCard collapsed={collapsed} />
            </div>
            <div className={cn('mt-3 border-t border-line/50 pt-3', collapsed ? 'px-2' : 'px-3')}>
              <button onClick={toggleCollapsed} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-expanded={!collapsed}
                className={cn('flex w-full items-center gap-3 rounded-xl py-2 text-xs text-fg-subtle transition hover:bg-ink-800 hover:text-fg', collapsed ? 'justify-center' : 'px-3')}>
                {collapsed ? <PanelLeftOpen className="h-[18px] w-[18px]" /> : <><PanelLeftClose className="h-[18px] w-[18px]" />Collapse</>}
              </button>
            </div>
          </motion.aside>
          {/* Mobile drawer */}
          <AnimatePresence>
            {drawer && (
              <div className="fixed inset-0 z-50 lg:hidden">
                <motion.div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setDrawer(false)} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
                <motion.aside initial={reduce ? { opacity: 0 } : { x: '-100%' }} animate={reduce ? { opacity: 1 } : { x: 0 }} exit={reduce ? { opacity: 0 } : { x: '-100%' }}
                  transition={{ type: 'spring', stiffness: 420, damping: 40 }}
                  className="absolute inset-y-0 left-0 w-72 max-w-[85vw] overflow-y-auto border-r border-line bg-ink-900 px-3 py-5">
                  <div className="mb-6 flex items-center justify-between px-2"><Logo href="/app" /><button onClick={() => setDrawer(false)} aria-label="Close menu" className="rounded-lg p-1.5 hover:bg-ink-800"><X className="h-5 w-5" /></button></div>
                  <NavList path={path} onNavigate={() => setDrawer(false)} idPrefix="drawer" /><UpgradeCard />
                </motion.aside>
              </div>
            )}
          </AnimatePresence>
          <div className="relative z-10 transition-[padding] duration-300 lg:pl-[var(--sbw)]" style={{ ["--sbw" as string]: `${w}px` }}>
            <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-line/50 bg-ink-950/70 px-4 backdrop-blur-xl sm:px-6">
              <div className="ax-hairline pointer-events-none absolute inset-x-0 bottom-[-1px] opacity-40" aria-hidden />
              <button onClick={() => setDrawer(true)} className="rounded-lg p-2 text-fg-muted hover:bg-ink-800 lg:hidden" aria-label="Open menu"><Menu className="h-5 w-5" /></button>
              <Logo href="/app" compact className="lg:hidden" />
              <PaletteTrigger onOpen={() => setPalette(true)} className="hidden max-w-xl flex-1 sm:flex" />
              <div className="ml-auto flex items-center gap-1.5">
                <button onClick={() => setPalette(true)} className="rounded-xl p-2 text-fg-muted hover:bg-ink-800 hover:text-fg sm:hidden" aria-label="Search"><Search className="h-5 w-5" /></button>
                <NotificationBell /><UserMenu />
              </div>
            </header>
            <main className="px-4 pb-24 pt-6 sm:px-6 lg:px-8 lg:pb-10">
              <PageTransition path={path}>{children}</PageTransition>
            </main>
          </div>
          {/* Mobile bottom tabs */}
          <nav aria-label="Primary" className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-line/60 bg-ink-900/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl lg:hidden">
            {MOBILE_TABS.map(({ href, label, short, icon: Icon }) => {
              const active = isActive(path, href);
              return (
                <Link key={href} href={href} aria-label={label} aria-current={active ? 'page' : undefined} className={cn('relative flex flex-col items-center gap-1 py-2.5 text-[10.5px] transition-colors', active ? 'text-gold' : 'text-fg-subtle')}>
                  {active && <motion.span layoutId="mtab" aria-hidden transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 500, damping: 38 }} className="absolute inset-x-5 top-0 h-0.5 rounded-full bg-gold shadow-[0_0_12px_rgb(var(--gold))]" />}
                  <Icon className={cn('h-5 w-5 transition-transform', active && 'scale-110 drop-shadow-[0_0_6px_rgb(var(--gold)/0.6)]')} />{short}
                </Link>
              );
            })}
          </nav>
          <CommandPalette open={palette} onClose={() => setPalette(false)} nav={APP_NAV} />
          <WelcomeBonusCelebration />
        </div>
      </Guard>
    </SessionProvider>
  );
}
