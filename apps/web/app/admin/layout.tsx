'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import {
  LayoutDashboard, Users, Bot, Plug, FlaskConical, GraduationCap, ShieldAlert, Landmark, Percent, CreditCard, Siren, Gavel,
  ScrollText, Lock, Settings, Cog, HeartPulse, Menu, X, ArrowLeft, ShieldX, Sparkles, Scale,
} from 'lucide-react';
import { LibraryBig } from 'lucide-react';
import { LogoMark, Wordmark } from '@/components/brand/Logo';
import { Button, Spinner, cn } from '@/components/ui';
import { SessionProvider, useSession } from '@/lib/session';
import { useApi } from '@/lib/api';
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from 'framer-motion';
import { AmbientBackground, useSpotlightDelegation } from '@/components/shell/ambient';
import { PulseDot } from '@/components/app/motion';
import '@/components/shell/app-motion.css';

const NAV = [
  { href: '/admin', label: 'Overview', icon: LayoutDashboard },
  { href: '/admin/users', label: 'Users', icon: Users },
  { href: '/admin/agents', label: 'Agents', icon: Bot },
  { href: '/admin/providers', label: 'Providers', icon: Plug },
  { href: '/admin/benchmarks', label: 'Benchmarks & review', icon: FlaskConical },
  { href: '/admin/question-bank', label: 'Question bank', icon: LibraryBig },
  { href: '/admin/training', label: 'Training sessions', icon: GraduationCap },
  { href: '/admin/hive', label: 'Hive learning', icon: Sparkles },
  { href: '/admin/hive-judge', label: 'Hive Judge', icon: Scale },
  { href: '/admin/moderation', label: 'Moderation', icon: ShieldAlert },
  { href: '/admin/finance', label: 'Token economy', icon: Landmark },
  { href: '/admin/commissions', label: 'Commission', icon: Percent },
  { href: '/admin/subscriptions', label: 'Subscriptions', icon: CreditCard },
  { href: '/admin/fraud', label: 'Fraud flags', icon: Siren },
  { href: '/admin/disputes', label: 'Disputes', icon: Gavel },
  { href: '/admin/audit', label: 'Audit logs', icon: ScrollText },
  { href: '/admin/security', label: 'Security', icon: Lock },
  { href: '/admin/settings', label: 'System settings', icon: Settings },
  { href: '/admin/jobs', label: 'Jobs', icon: Cog },
  { href: '/admin/health', label: 'System health', icon: HeartPulse },
] as const;

const active = (path: string, href: string) => (href === '/admin' ? path === '/admin' : path === href || path.startsWith(href + '/'));

function Brand() {
  return (
    <Link href="/admin" className="flex items-center gap-2 px-2" aria-label="Hive Mind admin">
      <LogoMark size={32} />
      <Wordmark className="text-lg leading-none" />
      <span className="rounded-md border border-gold/50 bg-gold/15 px-1.5 py-0.5 text-[10px] font-bold tracking-[0.15em] text-gold">ADMIN</span>
    </Link>
  );
}

function Nav({ path, id }: { path: string; id: string }) {
  const reduce = useReducedMotion();
  return (
    <nav aria-label="Admin modules" className="space-y-0.5">
      <LayoutGroup id={id}>
        {NAV.map(({ href, label, icon: Icon }) => {
          const on = active(path, href);
          return (
            <Link key={href} href={href} aria-current={on ? 'page' : undefined}
              className={cn('group relative flex items-center gap-3 rounded-xl px-3 py-2 text-[13px] transition-colors', on ? 'font-medium text-gold-soft' : 'text-fg-muted hover:text-fg')}>
              {on && <motion.span layoutId="admin-pill" aria-hidden transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 520, damping: 40 }}
                className="absolute inset-0 rounded-xl border border-gold/25 bg-gradient-to-r from-gold/20 via-gold/10 to-transparent shadow-[inset_2px_0_0_rgb(var(--gold)),0_0_24px_-8px_rgb(var(--gold)/0.6)]" />}
              {!on && <span aria-hidden className="absolute inset-0 rounded-xl transition-colors group-hover:bg-ink-800/70" />}
              <Icon className={cn('relative h-4 w-4 transition-transform group-hover:scale-110', on ? 'text-gold' : 'text-fg-subtle')} /><span className="relative">{label}</span>
              {href === '/admin/health' && <span className="relative ml-auto"><HealthDot /></span>}
            </Link>
          );
        })}
      </LayoutGroup>
    </nav>
  );
}

type Health = { status?: string; db?: { ok?: boolean; latencyMs?: number }; jobs?: { failed?: number; queued?: number; running?: number } };
function useHealth() { return useApi<Health>('/admin/system-health', { refreshInterval: 30000 }); }
const healthTone = (h?: Health) => !h ? 'idle' as const : h.status === 'ok' && h.db?.ok !== false ? (h.jobs?.failed ? 'warning' as const : 'success' as const) : h.status === 'degraded' ? 'warning' as const : 'danger' as const;
function HealthDot() {
  const { data } = useHealth();
  return <PulseDot tone={healthTone(data)} label={data ? `System status ${data.status ?? 'unknown'}` : 'System status loading'} />;
}

/** Desktop ops status strip: live health pulse + DB latency + job queue (all real, from GET /admin/system-health). */
function OpsStrip() {
  const { data, error } = useHealth();
  const tone = error ? 'danger' : healthTone(data);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  return (
    <div className="sticky top-0 z-20 hidden h-11 items-center gap-5 border-b border-line/50 bg-ink-950/70 px-8 text-[11px] text-fg-muted backdrop-blur-xl lg:flex">
      <span className="flex items-center gap-2 font-mono uppercase tracking-[0.16em]"><PulseDot tone={tone} />{error ? 'API unreachable' : data ? `System ${data.status ?? 'unknown'}` : 'Checking…'}</span>
      {data?.db && <span className="font-mono">DB <span className={cn('font-semibold', data.db.ok === false ? 'text-danger-soft' : 'text-success-soft')}>{data.db.ok === false ? 'down' : `${(data.db.latencyMs ?? 0).toFixed(1)} ms`}</span></span>}
      {data?.jobs && <span className="font-mono">Jobs <span className="text-fg">{data.jobs.running ?? 0}</span> running · <span className="text-fg">{data.jobs.queued ?? 0}</span> queued · <span className={cn(data.jobs.failed ? 'text-danger-soft' : 'text-fg')}>{data.jobs.failed ?? 0}</span> failed</span>}
      <span className="ml-auto font-mono tabular-nums text-fg-subtle" suppressHydrationWarning>{now.toLocaleTimeString('en-IN', { hour12: false })} IST · refresh 30s</span>
    </div>
  );
}

function Guarded({ children }: { children: ReactNode }) {
  const { me, loading, unavailable, refresh } = useSession();
  const router = useRouter();
  const path = usePathname();
  const [drawer, setDrawer] = useState(false);
  useSpotlightDelegation();
  const reduce = useReducedMotion();
  useEffect(() => { if (!loading && !me && !unavailable) router.replace(`/sign-in?next=${encodeURIComponent(path)}`); }, [loading, me, unavailable, router, path]);
  useEffect(() => setDrawer(false), [path]);

  if (unavailable) return <div className="flex min-h-screen items-center justify-center bg-ink-950 p-4"><div className="card max-w-md p-6 text-center"><p className="font-display text-lg font-semibold">Can&apos;t reach the Hive Mind API</p><p className="mt-2 text-sm text-fg-muted">The service is restarting or temporarily unavailable.</p><button onClick={refresh} className="mt-5 rounded-xl bg-gold-sheen px-4 py-2 text-sm font-semibold text-ink-950">Try again</button></div></div>;
  if (loading || !me) return <div className="flex min-h-screen items-center justify-center bg-ink-950"><Spinner /></div>;
  if (me.user.platformRole !== 'admin' && me.user.platformRole !== 'super_admin') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-ink-950 p-6">
        <div className="card max-w-md p-8 text-center">
          <ShieldX className="mx-auto h-10 w-10 text-danger-soft" />
          <p className="mt-3 font-mono text-xs text-fg-subtle">403 · FORBIDDEN</p>
          <h1 className="mt-1 text-xl font-semibold">Administrator access required</h1>
          <p className="mt-2 text-sm text-fg-muted">Your account ({me.user.email}) does not have a platform admin role. This attempt may be recorded in the audit log.</p>
          <Button className="mt-6" variant="primary" href="/app">Back to the app</Button>
        </div>
      </div>
    );
  }

  const sidebar = (
    <>
      <Brand />
      <div className="mt-6 flex-1 overflow-y-auto pr-1"><Nav path={path} id={drawer ? 'admin-drawer' : 'admin-desk'} /></div>
      <div className="mt-4 border-t border-line/60 pt-3">
        <p className="truncate px-3 text-xs text-fg-muted">{me.user.name}</p>
        <p className="px-3 text-[11px] uppercase tracking-wider text-gold">{me.user.platformRole.replace('_', ' ')}</p>
        <Link href="/app" className="mt-2 flex items-center gap-2 rounded-xl px-3 py-2 text-xs text-fg-muted hover:bg-ink-800"><ArrowLeft className="h-3.5 w-3.5" />Exit admin</Link>
      </div>
    </>
  );

  return (
    <div className="relative min-h-screen bg-ink-950">
      <AmbientBackground ops />
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-line/60 bg-black/60 px-3 py-5 backdrop-blur-xl lg:flex">
        <div className="pointer-events-none absolute inset-y-0 right-0 w-px bg-gradient-to-b from-gold/30 via-line/0 to-electric/20" aria-hidden />
        {sidebar}
      </aside>
      <AnimatePresence>
        {drawer && (
          <div className="fixed inset-0 z-50 lg:hidden">
            <motion.div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setDrawer(false)} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
            <motion.aside initial={reduce ? { opacity: 0 } : { x: '-100%' }} animate={reduce ? { opacity: 1 } : { x: 0 }} exit={reduce ? { opacity: 0 } : { x: '-100%' }} transition={{ type: 'spring', stiffness: 420, damping: 40 }}
              className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-line bg-ink-950 px-3 py-5">
              <button onClick={() => setDrawer(false)} aria-label="Close menu" className="absolute right-3 top-4 rounded-lg p-1.5 hover:bg-ink-800"><X className="h-5 w-5" /></button>
              {sidebar}
            </motion.aside>
          </div>
        )}
      </AnimatePresence>
      <div className="relative z-10 lg:pl-60">
        <OpsStrip />
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line/50 bg-ink-950/85 px-4 backdrop-blur-md lg:hidden">
          <button onClick={() => setDrawer(true)} className="rounded-lg p-2 text-fg-muted hover:bg-ink-800" aria-label="Open admin menu"><Menu className="h-5 w-5" /></button>
          <Brand />
          <span className="ml-auto"><HealthDot /></span>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
          <motion.div key={path} className="ax-page" initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }}>{children}</motion.div>
        </main>
      </div>
    </div>
  );
}

export default function AdminLayout({ children }: { children: ReactNode }) {
  return <SessionProvider><Guarded>{children}</Guarded></SessionProvider>;
}
