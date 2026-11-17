/**
 * IDLE Token constants + formatting for the web app.
 * Hive Mind is a pure token economy (see docs/IDLE_TOKENS.md): rewards are IDLE Tokens, never money.
 *
 * Constants come from `@aix/shared`; this module is the single web-side entry point so every
 * screen formats amounts identically.
 */
import { DEFAULT_COMMISSION_BPS, TOKEN_NAME, TOKEN_SYMBOL, WELCOME_BONUS_IDLE } from '@aix/shared';

export { TOKEN_NAME, TOKEN_SYMBOL, WELCOME_BONUS_IDLE };
/** Illustrative default platform commission in % (live rates are configured by admins). */
export const DEFAULT_COMMISSION_PCT = DEFAULT_COMMISSION_BPS / 100;

const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

/** `1000` → `1,000 IDLE`. Null-safe (renders an em dash). */
export function fmtIdle(n: number | null | undefined, opts: { symbol?: boolean; signed?: boolean } = {}) {
  if (n == null || Number.isNaN(n)) return '—';
  const { symbol = true, signed = false } = opts;
  const sign = signed && n > 0 ? '+' : '';
  const body = `${sign}${nf.format(n)}`;
  return symbol ? `${body} ${TOKEN_SYMBOL}` : body;
}

/** Plain grouped number without the symbol (for use next to the <IdleToken/> mark). */
export const fmtIdleAmount = (n: number | null | undefined) => fmtIdle(n, { symbol: false });

/** Key used to hand the welcome-bonus celebration from the auth forms to the app shell. */
export const WELCOME_BONUS_FLAG = 'aix:welcome-bonus';

export type WelcomeBonusGrant = { amount: number; transactionId?: string | null };

/** Called by sign-in / register / MFA forms with the auth response's `welcomeBonus` field. */
export function stashWelcomeBonus(bonus: WelcomeBonusGrant | null | undefined) {
  if (!bonus || typeof bonus.amount !== 'number' || bonus.amount <= 0) return;
  try { sessionStorage.setItem(WELCOME_BONUS_FLAG, JSON.stringify({ amount: bonus.amount, transactionId: bonus.transactionId ?? null })); } catch { /* storage unavailable */ }
}

/** Reads and clears the flag (one-shot). */
export function takeWelcomeBonus(): WelcomeBonusGrant | null {
  try {
    const raw = sessionStorage.getItem(WELCOME_BONUS_FLAG);
    if (!raw) return null;
    sessionStorage.removeItem(WELCOME_BONUS_FLAG);
    const v = JSON.parse(raw) as WelcomeBonusGrant;
    return typeof v?.amount === 'number' ? v : null;
  } catch { return null; }
}

/**
 * Legacy ledger/notification text from before the IDLE switch said "credits" / "Purchased".
 * Present it in IDLE terms (display only; stored data is untouched).
 */
export function idleText(s: string | null | undefined): string | null {
  if (!s) return s ?? null;
  return s.replace(/^Purchased(?=\s)/i, 'Granted').replace(/(^|[^A-Za-z])credits?(?![A-Za-z])/gi, '$1IDLE');
}
