'use client';
import { useState } from 'react';
import { ArrowDownLeft, ArrowRight, ArrowUpRight, BookOpen, Gift, GraduationCap, Lock, Receipt, Sparkles, Store, Wallet as WalletIcon } from 'lucide-react';
import { Badge, Button, EmptyState, ErrorState, PageHeader, Select, Skeleton, cn, fmtDateTime } from '@/components/ui';
import { useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ListSkeleton, Pagination, SignedCredits, titleCase } from '@/components/app/primitives';
import { listOf, type Paged, type Transaction, type Wallet } from '@/components/app/types';
import { AnimatedNumber, StaggerLi, StaggerList } from '@/components/app/motion';
import { IdleToken } from '@/components/brand/IdleToken';
import { DEFAULT_COMMISSION_PCT, TOKEN_NAME, TOKEN_SYMBOL, WELCOME_BONUS_IDLE, fmtIdle, fmtIdleAmount, idleText } from '@/lib/tokens';

/** Ledger transaction types in the IDLE economy (legacy types may still appear in old data). */
const TX_LABELS: Record<string, string> = {
  welcome_bonus: 'Welcome bonus',
  training_escrow: 'Training escrow',
  training_settlement: 'Training settlement',
  training_refund: 'Training refund',
  knowledge_purchase: 'Knowledge licence',
  adjustment: 'Adjustment',
  dispute_refund: 'Dispute refund',
};
/** Pre-IDLE ledger rows (legacy types / "credits" wording) are shown in IDLE terms. */
const LEGACY_LABELS: Record<string, string> = { purchase: 'Legacy grant', earning: 'Earning', spend: 'Spend', escrow: 'Escrow', release: 'Release', refund: 'Refund', commission: 'Commission' };
const txLabel = (t: string) => TX_LABELS[t] ?? LEGACY_LABELS[t] ?? titleCase(t);
const txDescription = idleText;
const TX_TYPES = ['', ...Object.keys(TX_LABELS)];

export default function WalletPage() {
  const { me } = useSession();
  const { data: wallet, error, isLoading, mutate } = useApi<Wallet>('/wallet');
  const bonus = me?.welcomeBonus ?? null;
  const bonusTotal = wallet?.bonusTotal ?? (bonus?.granted ? bonus.amount : null);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader eyebrow={TOKEN_NAME} title="IDLE Wallet"
        description={`${TOKEN_NAME} power training sessions and knowledge licences on StringMind. Earn them by teaching and selling knowledge — they are platform tokens, not money, and cannot be bought or withdrawn.`} />

      {error ? <ErrorState error={error} onRetry={() => mutate()} /> : (
        <div className="grid gap-4 lg:grid-cols-3">
          <section aria-label="IDLE balance" className="ax-sheen relative overflow-hidden rounded-2xl border border-gold/50 bg-gradient-to-br from-gold/20 via-ink-900 to-ink-900 p-5 shadow-[0_20px_60px_-24px_rgb(var(--gold)/0.6)] sm:p-6 lg:col-span-2">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_85%_20%,rgb(var(--gold)/0.22),transparent_45%)]" aria-hidden />
            <div className="pointer-events-none absolute inset-0 opacity-[0.07] [background-image:repeating-linear-gradient(135deg,rgb(var(--gold-soft))_0_1px,transparent_1px_14px)]" aria-hidden />
            <div className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-gold-soft to-transparent" aria-hidden />
            <div className="ax-float pointer-events-none absolute right-6 top-6 hidden drop-shadow-[0_10px_30px_rgb(var(--gold)/0.45)] sm:block"><IdleToken size={128} /></div>
            <p className="relative flex items-center gap-2 text-sm text-fg-muted"><WalletIcon className="h-4 w-4 text-gold" aria-hidden />Available IDLE</p>
            {isLoading ? <Skeleton className="mt-3 h-12 w-56" /> : (
              <p className="relative mt-2 flex items-baseline gap-3 font-display text-5xl font-semibold tabular-nums sm:text-6xl">
                <IdleToken size={40} className="self-center" />
                <AnimatedNumber value={wallet?.available} format={(n) => fmtIdleAmount(Math.round(n))} className="ax-text-sheen" duration={1.4} />
                <span className="text-xl font-semibold tracking-wide text-gold-soft sm:text-2xl">{TOKEN_SYMBOL}</span>
              </p>
            )}
            <dl className="relative mt-5 grid max-w-md grid-cols-2 gap-4">
              <div className="rounded-xl border border-line/60 bg-ink-950/40 px-3 py-2 backdrop-blur">
                <dt className="flex items-center gap-1 text-xs text-fg-subtle"><Lock className="h-3 w-3" aria-hidden />In escrow</dt>
                <dd className="mt-0.5 font-semibold tabular-nums">{isLoading ? <Skeleton className="h-5 w-20" /> : <AnimatedNumber value={wallet?.locked} format={(n) => fmtIdle(Math.round(n))} />}</dd>
              </div>
              <div className="rounded-xl border border-line/60 bg-ink-950/40 px-3 py-2 backdrop-blur">
                <dt className="flex items-center gap-1 text-xs text-fg-subtle"><Gift className="h-3 w-3" aria-hidden />Welcome bonus</dt>
                <dd className="mt-0.5 font-semibold tabular-nums">{isLoading ? <Skeleton className="h-5 w-20" /> : bonusTotal != null ? <AnimatedNumber value={bonusTotal} format={(n) => fmtIdle(Math.round(n))} /> : <span className="text-fg-muted">Pending</span>}</dd>
              </div>
            </dl>
            <div className="relative mt-6 flex flex-wrap gap-2">
              <Button variant="primary" href="/app/marketplace" icon={<Store className="h-4 w-4" />}>Spend on training</Button>
              <Button variant="outline" href="/app/agents" icon={<GraduationCap className="h-4 w-4" />}>Earn by teaching</Button>
            </div>
            <p className="relative mt-3 text-xs text-fg-subtle">IDLE in escrow is reserved for training sessions in progress and is released or refunded when they settle.</p>
          </section>

          <section aria-label="Lifetime totals" className="card ax-spot grid grid-cols-2 gap-4 p-5">
            {([
              ['Earned', wallet?.earnedTotal, 'text-success-soft', 'bg-success'],
              ['Spent', wallet?.spentTotal, 'text-fg', 'bg-violet'],
              ['Welcome bonus', bonusTotal, 'text-gold-soft', 'bg-gold'],
              ['Refunded', wallet?.refundedTotal, 'text-fg', 'bg-fg-subtle'],
            ] as const).map(([k, v, c, dot]) => (
              <div key={k} className="rounded-xl border border-line/50 bg-ink-950/30 p-3">
                <p className="flex items-center gap-1.5 text-xs text-fg-subtle"><span className={cn('h-1.5 w-1.5 rounded-full', dot)} aria-hidden />{k}</p>
                {isLoading ? <Skeleton className="mt-1 h-6 w-16" /> : <p className={cn('mt-1 font-display text-lg font-semibold tabular-nums', c)}><AnimatedNumber value={v ?? 0} format={(n) => fmtIdleAmount(Math.round(n))} /></p>}
              </div>
            ))}
            <p className="col-span-2 text-[11px] text-fg-subtle">Lifetime totals in {TOKEN_SYMBOL} for this organisation&apos;s wallet. Listed training and knowledge prices are charged in {TOKEN_SYMBOL}.</p>
          </section>
        </div>
      )}

      <HowToEarn />

      <div className="mt-8"><TransactionsList /></div>
    </div>
  );
}

function HowToEarn() {
  const ways = [
    { icon: <Gift className="h-5 w-5" />, title: 'Welcome bonus', body: `Every account starts with ${fmtIdle(WELCOME_BONUS_IDLE)}, credited once on your first sign-in.`, href: '/app/marketplace', cta: 'Spend it on training' },
    { icon: <GraduationCap className="h-5 w-5" />, title: 'Teach as a trainer', body: `Publish a training listing for one of your agents. When a session completes you receive its price in IDLE, minus the platform commission (illustrative default ${DEFAULT_COMMISSION_PCT}%).`, href: '/app/agents', cta: 'Publish a listing' },
    { icon: <BookOpen className="h-5 w-5" />, title: 'Sell knowledge', body: 'License packaged knowledge on the Knowledge Exchange. Every licence pays IDLE straight into this wallet — spendable immediately.', href: '/app/knowledge', cta: 'Open Knowledge Exchange' },
  ];
  return (
    <section aria-labelledby="earn-idle" className="mt-8">
      <div className="mb-3 flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-gold" aria-hidden />
        <h2 id="earn-idle" className="font-display text-lg font-semibold">How to earn IDLE</h2>
        <Badge tone="gold">No purchases, no withdrawals</Badge>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        {ways.map((w) => (
          <div key={w.title} className="card ax-spot flex flex-col p-4">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gold/10 text-gold ring-1 ring-gold/30" aria-hidden>{w.icon}</span>
            <p className="mt-3 font-medium">{w.title}</p>
            <p className="mt-1 flex-1 text-sm text-fg-muted">{w.body}</p>
            <Button className="mt-3 self-start" size="sm" variant="ghost" href={w.href}>{w.cta}<ArrowRight className="h-3.5 w-3.5" aria-hidden /></Button>
          </div>
        ))}
      </div>
    </section>
  );
}

function TransactionsList() {
  const [type, setType] = useState('');
  const [page, setPage] = useState(1);
  const qs = new URLSearchParams({ page: String(page) }); if (type) qs.set('type', type);
  const { data, error, isLoading, mutate } = useApi<Paged<Transaction> | Transaction[]>(`/wallet/transactions?${qs}`);
  const items = listOf(data);
  const paged = data && !Array.isArray(data) ? data : null;
  return (
    <div className="card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line/60 px-4 py-3">
        <p className="text-sm font-medium">IDLE activity</p>
        <label className="flex items-center gap-2 text-xs text-fg-muted">Type
          <Select className="h-9 w-48" value={type} onChange={(e) => { setType(e.target.value); setPage(1); }} aria-label="Filter transactions by type">
            {TX_TYPES.map((t) => <option key={t} value={t}>{t ? txLabel(t) : 'All types'}</option>)}
          </Select>
        </label>
      </div>
      <div className="p-4">
        {error ? <ErrorState error={error} onRetry={() => mutate()} /> : isLoading ? <ListSkeleton rows={6} /> : items.length === 0 ? (
          <EmptyState icon={<Receipt className="h-5 w-5" />} title={type ? `No ${txLabel(type).toLowerCase()} transactions` : 'No IDLE activity yet'}
            description="Request a training session to spend IDLE, or publish a trainer listing to start earning it." />
        ) : (
          <>
            <StaggerList key={`${type}-${page}`} className="divide-y divide-line/50">
              {items.map((t) => {
                const pos = t.amount > 0;
                const isBonus = t.type === 'welcome_bonus';
                return (
                  <StaggerLi key={t.id} className="-mx-2 flex items-center gap-3 rounded-xl px-2 py-3 transition-colors hover:bg-ink-800/40">
                    <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full ring-1', isBonus ? 'bg-gold/10 ring-gold/30' : pos ? 'bg-success/10 text-success ring-success/25' : 'bg-danger/10 text-danger-soft ring-danger/25')} aria-hidden>
                      {isBonus ? <IdleToken size={20} /> : pos ? <ArrowDownLeft className="h-4 w-4" /> : <ArrowUpRight className="h-4 w-4" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{txDescription(t.description) || txLabel(t.type)}</p>
                      <p className="text-xs text-fg-subtle">{txLabel(t.type)} · {fmtDateTime(t.createdAt)}{t.status && t.status !== 'posted' && t.status !== 'completed' ? ` · ${titleCase(t.status)}` : ''}</p>
                    </div>
                    <SignedCredits amount={t.amount} className="text-sm" />
                  </StaggerLi>
                );
              })}
            </StaggerList>
            {paged && <Pagination page={paged.page} pageSize={paged.pageSize} total={paged.total} onChange={setPage} />}
          </>
        )}
      </div>
    </div>
  );
}
