'use client';
/**
 * ⌘K / Ctrl+K command palette: page navigation, quick actions, your agents (GET /agents) and
 * live marketplace agent search (GET /marketplace/agents?q=). Fully keyboard operable (combobox + listbox pattern).
 */
import { useRouter } from 'next/navigation';
import { useEffect, useId, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Bot, CornerDownLeft, Plug, Search, Store, Gauge, Coins, Sparkles } from 'lucide-react';
import { Avatar, ScoreRing, Spinner, cn } from '@/components/ui';
import { useApi } from '@/lib/api';
import { listOf, type Agent, type MarketAgent, type Paged } from '@/components/app/types';

export interface PaletteNavItem { href: string; label: string; icon: ComponentType<{ className?: string }> }

type Item = { id: string; group: string; label: string; hint?: string; icon: ReactNode; href: string; keywords?: string };

function useDebounced<T>(v: T, ms: number) {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

export function useCommandPaletteHotkey(setOpen: (fn: (o: boolean) => boolean) => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen((o) => !o); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen]);
}

export function CommandPalette({ open, onClose, nav }: { open: boolean; onClose: () => void; nav: readonly PaletteNavItem[] }) {
  return <AnimatePresence>{open && <PaletteInner key="cmdk" onClose={onClose} nav={nav} />}</AnimatePresence>;
}

function PaletteInner({ onClose, nav }: { onClose: () => void; nav: readonly PaletteNavItem[] }) {
  const router = useRouter();
  const reduce = useReducedMotion();
  const lid = useId().replace(/:/g, '');
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dq = useDebounced(q.trim(), 220);

  const mine = useApi<Agent[] | Paged<Agent>>('/agents');
  const market = useApi<Paged<MarketAgent>>(dq.length >= 2 ? `/marketplace/agents?${new URLSearchParams({ q: dq, pageSize: '6' })}` : null, { keepPreviousData: true });

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    const ov = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ov; prev?.focus?.(); };
  }, []);

  const items = useMemo<Item[]>(() => {
    const ql = q.trim().toLowerCase();
    const match = (s: string) => !ql || s.toLowerCase().includes(ql);
    const out: Item[] = [];
    const actions: Item[] = [
      { id: 'a-connect', group: 'Quick actions', label: 'Connect a new agent', icon: <Plug className="h-4 w-4" />, href: '/app/agents/new', keywords: 'add create provider' },
      { id: 'a-assess', group: 'Quick actions', label: 'Run a capability assessment', icon: <Gauge className="h-4 w-4" />, href: '/app/assessments?new=1', keywords: 'benchmark score test' },
      { id: 'a-idle', group: 'Quick actions', label: 'Open IDLE wallet', icon: <Coins className="h-4 w-4" />, href: '/app/wallet', keywords: 'idle tokens balance wallet welcome bonus' },
      { id: 'a-earn', group: 'Quick actions', label: 'Earn IDLE by teaching', icon: <Coins className="h-4 w-4" />, href: '/app/agents', keywords: 'earn idle trainer listing teach' },
      { id: 'a-trainer', group: 'Quick actions', label: 'Find a trainer in the marketplace', icon: <Store className="h-4 w-4" />, href: '/app/marketplace', keywords: 'train learn hire' },
    ];
    out.push(...actions.filter((a) => match(a.label + ' ' + (a.keywords ?? ''))));
    out.push(...nav.filter((n) => match(n.label)).map((n) => ({ id: `n-${n.href}`, group: 'Go to', label: n.label, icon: <n.icon className="h-4 w-4" />, href: n.href })));
    const own = listOf(mine.data).filter((a) => match(`${a.name} ${a.description ?? ''} ${a.modelName ?? ''}`)).slice(0, ql ? 6 : 4);
    out.push(...own.map((a) => ({ id: `m-${a.id}`, group: 'Your agents', label: a.name, hint: a.modelName ?? a.status, icon: <Avatar name={a.name} size={22} className="rounded-md" />, href: `/app/agents/${a.id}` })));
    if (dq.length >= 2) {
      const ma = listOf(market.data).slice(0, 6);
      out.push(...ma.map((a) => ({
        id: `k-${a.id}`, group: 'Marketplace', label: a.name, hint: a.verifiedDomains?.find((d) => d.score != null)?.name ?? (a.description ?? undefined),
        icon: <Avatar name={a.name} src={a.avatar} size={22} className="rounded-md" />, href: `/app/marketplace/${encodeURIComponent(a.slug)}`,
        keywords: String(a.overallScore ?? ''),
      })));
    }
    if (ql) out.push({ id: 's-market', group: 'Search', label: `Search the marketplace for “${q.trim()}”`, icon: <Search className="h-4 w-4" />, href: `/app/marketplace?q=${encodeURIComponent(q.trim())}` });
    return out;
  }, [q, dq, nav, mine.data, market.data]);

  const scoreFor = useMemo(() => new Map(listOf(market.data).map((a) => [`k-${a.id}`, a.overallScore ?? null])), [market.data]);

  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const go = (it: Item | undefined) => { if (!it) return; onClose(); router.push(it.href); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(items.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); go(items[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'Tab') { e.preventDefault(); }
  };

  const groups: { name: string; items: (Item & { idx: number })[] }[] = [];
  items.forEach((it, idx) => {
    const g = groups.find((x) => x.name === it.group) ?? (groups.push({ name: it.group, items: [] }), groups[groups.length - 1]!);
    g.items.push({ ...it, idx });
  });

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center px-3 pt-[10vh] sm:pt-[14vh]" role="dialog" aria-modal="true" aria-label="Command palette">
      <motion.div className="absolute inset-0 bg-black/65 backdrop-blur-sm" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduce ? 0 : 0.18 }} />
      <motion.div className="relative w-full max-w-xl overflow-hidden rounded-2xl border border-line bg-ink-900/95 shadow-[0_30px_80px_-20px_rgb(0_0_0/0.9),0_0_0_1px_rgb(var(--gold)/0.08)] backdrop-blur-xl"
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: -12, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8, scale: 0.98 }}
        transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 520, damping: 36 }}>
        <div className="pointer-events-none absolute inset-x-10 top-0 h-px bg-gradient-to-r from-transparent via-gold/60 to-transparent" aria-hidden />
        <div className="flex items-center gap-3 border-b border-line/70 px-4">
          <Search className="h-4 w-4 shrink-0 text-gold" aria-hidden />
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey}
            role="combobox" aria-expanded="true" aria-controls={`${lid}-list`} aria-activedescendant={items[active] ? `${lid}-${active}` : undefined} aria-autocomplete="list"
            placeholder="Search agents, pages, or actions…" aria-label="Search agents, pages, or actions"
            className="h-14 min-w-0 flex-1 bg-transparent text-[15px] text-fg placeholder:text-fg-subtle focus:outline-none" style={{ boxShadow: 'none' }} />
          {market.isLoading && dq.length >= 2 && <Spinner className="h-4 w-4" />}
          <kbd className="kbd hidden sm:inline">Esc</kbd>
        </div>
        <div ref={listRef} id={`${lid}-list`} role="listbox" aria-label="Results" className="max-h-[min(60vh,440px)] overflow-y-auto p-2">
          {!items.length && (
            <div className="px-4 py-10 text-center text-sm text-fg-muted">
              <Sparkles className="mx-auto mb-2 h-5 w-5 text-fg-subtle" aria-hidden />
              {dq.length >= 2 && market.isLoading ? 'Searching the marketplace…' : 'No matches. Try an agent name, skill or page.'}
            </div>
          )}
          {groups.map((g) => (
            <div key={g.name} role="group" aria-label={g.name} className="mb-1">
              <p className="px-3 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-fg-subtle">{g.name}</p>
              {g.items.map((it) => {
                const on = it.idx === active;
                const score = scoreFor.get(it.id);
                return (
                  <div key={it.id} id={`${lid}-${it.idx}`} data-idx={it.idx} role="option" aria-selected={on}
                    onMouseMove={() => setActive(it.idx)} onClick={() => go(it)}
                    className={cn('relative flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors', on ? 'text-fg' : 'text-fg-muted')}>
                    {on && <motion.span layoutId={`${lid}-hl`} className="absolute inset-0 rounded-xl border border-gold/25 bg-gold/[0.08]" transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 600, damping: 40 }} aria-hidden />}
                    <span className={cn('relative flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border', on ? 'border-gold/30 bg-gold/10 text-gold' : 'border-line/70 bg-ink-800 text-fg-subtle')}>{it.icon}</span>
                    <span className="relative min-w-0 flex-1"><span className="block truncate">{it.label}</span>{it.hint && <span className="block truncate text-[11px] text-fg-subtle">{it.hint}</span>}</span>
                    {score !== undefined && <span className="relative"><ScoreRing score={score} size={28} label="Verified score" /></span>}
                    {on && <CornerDownLeft className="relative h-3.5 w-3.5 shrink-0 text-gold" aria-hidden />}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-line/70 px-4 py-2.5 text-[11px] text-fg-subtle">
          <span className="flex items-center gap-2"><kbd className="kbd">↑</kbd><kbd className="kbd">↓</kbd> navigate <kbd className="kbd">↵</kbd> open</span>
          <span className="flex items-center gap-1"><Bot className="h-3 w-3" aria-hidden />Marketplace results are live</span>
        </div>
      </motion.div>
    </div>
  );
}

/** Top-bar trigger styled like the reference search field. */
export function PaletteTrigger({ onOpen, className }: { onOpen: () => void; className?: string }) {
  const [mac, setMac] = useState(false);
  useEffect(() => { setMac(/Mac|iPhone|iPad/.test(navigator.platform)); }, []);
  return (
    <button type="button" onClick={onOpen} aria-label="Search agents, skills, or topics (command palette)" aria-keyshortcuts="Control+K Meta+K"
      className={cn('group relative flex h-10 items-center gap-2.5 rounded-xl border border-line/70 bg-ink-900/70 px-3 text-left text-sm text-fg-subtle backdrop-blur transition hover:border-ink-600 hover:bg-ink-900 hover:text-fg-muted', className)}>
      <Search className="h-4 w-4 shrink-0 transition group-hover:text-gold" aria-hidden />
      <span className="min-w-0 flex-1 truncate">Search agents, skills, or topics...</span>
      <span className="hidden items-center gap-1 md:flex"><kbd className="kbd">{mac ? '⌘' : 'Ctrl'}</kbd><kbd className="kbd">K</kbd></span>
    </button>
  );
}

