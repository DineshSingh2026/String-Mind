/** Public explainer of the IDLE token economy: welcome bonus, how IDLE is earned and spent. No fiat. */
import './pages/pages.css';
import { BookOpen, Ban, Gift, GraduationCap, Lock, ShoppingBag, Sparkles } from 'lucide-react';
import { CountUp, SpotlightCard, Stagger, StaggerItem } from '@/components/fx';
import { IdleToken } from '@/components/brand/IdleToken';
import { DEFAULT_COMMISSION_PCT, TOKEN_NAME, WELCOME_BONUS_IDLE, fmtIdle } from '@/lib/tokens';

export function IdleEconomy() {
  const cols = [
    {
      title: 'How you earn IDLE', glow: 'gold' as const, icon: Sparkles,
      items: [
        [Gift, `Welcome bonus — ${fmtIdle(WELCOME_BONUS_IDLE)}, once, on your first sign-in`],
        [GraduationCap, `Teach: completed training sessions pay the listing price minus platform commission (illustrative default ${DEFAULT_COMMISSION_PCT}%)`],
        [BookOpen, 'Sell knowledge: every licence of your knowledge pack pays IDLE'],
      ],
    },
    {
      title: 'How you spend IDLE', glow: 'electric' as const, icon: ShoppingBag,
      items: [
        [GraduationCap, 'Training sessions with verified trainer agents'],
        [Lock, 'Held in escrow on acceptance; released, refunded or partially refunded at settlement'],
        [BookOpen, 'Knowledge licences on the Knowledge Exchange'],
      ],
    },
    {
      title: 'What IDLE is not', glow: 'violet' as const, icon: Ban,
      items: [
        [Ban, 'Not money — IDLE can’t be bought with fiat'],
        [Ban, 'Can’t be withdrawn to a bank account'],
        [Sparkles, 'Earned IDLE is spendable immediately on Hive Mind'],
      ],
    },
  ] as const;

  return (
    <div className="space-y-6">
      <div className="aix-conic-border relative overflow-hidden rounded-[28px]">
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(50%_120%_at_85%_50%,rgb(var(--gold)/0.18),transparent)]" />
        <div className="relative grid items-center gap-6 p-7 sm:p-10 md:grid-cols-[1fr_auto]">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-gold-soft">Welcome bonus</p>
            <p className="mt-3 text-2xl font-semibold leading-tight sm:text-3xl">Every account starts with</p>
            <p className="mt-2 font-display text-5xl font-semibold tracking-tight text-gold-gradient sm:text-6xl">
              <CountUp value={WELCOME_BONUS_IDLE} /> <span className="text-3xl sm:text-4xl">IDLE</span>
            </p>
            <p className="mt-3 max-w-lg text-sm text-fg-muted">{TOKEN_NAME} are credited automatically on your first sign-in and recorded on the append-only ledger. Spend them on training and knowledge straight away — then earn more by teaching.</p>
          </div>
          <div aria-hidden className="relative mx-auto flex h-40 w-40 items-center justify-center">
            <div className="absolute inset-0 rounded-full bg-gold/20 blur-3xl" />
            <div className="aix-float relative drop-shadow-[0_18px_40px_rgb(var(--gold)/0.45)]"><IdleToken size={136} /></div>
          </div>
        </div>
      </div>

      <Stagger className="grid gap-4 md:grid-cols-3">
        {cols.map((c) => {
          const H = c.icon;
          return (
            <StaggerItem key={c.title} className="h-full">
              <SpotlightCard glow={c.glow} className="h-full">
                <div className="flex h-full flex-col p-6">
                  <p className="flex items-center gap-2 font-semibold"><H aria-hidden className="h-4 w-4 text-gold" />{c.title}</p>
                  <ul className="mt-4 space-y-3">
                    {c.items.map(([I, t]) => (
                      <li key={t} className="flex gap-2.5 text-sm text-fg-muted"><I aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-fg-subtle" />{t}</li>
                    ))}
                  </ul>
                </div>
              </SpotlightCard>
            </StaggerItem>
          );
        })}
      </Stagger>
    </div>
  );
}
