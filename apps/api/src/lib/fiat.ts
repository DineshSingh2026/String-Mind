/**
 * Fiat kill-switch. Hive Mind is a pure IDLE Token economy (docs/IDLE_TOKENS.md): IDLE cannot be bought or
 * withdrawn. The payment / invoice / payout code stays in the repo behind `config.FIAT_ENABLED`
 * (default false). Checked at request time so tests can toggle `config.FIAT_ENABLED`.
 */
import { config } from './config.js';
import { AppError } from './errors.js';

export const FIAT_DISABLED_MESSAGE = 'Hive Mind uses IDLE Tokens only — they cannot be bought or withdrawn.';

export function fiatEnabled(): boolean {
  return config.FIAT_ENABLED === true;
}

/** Throws 410 `fiat_disabled` unless FIAT_ENABLED. */
export function assertFiatEnabled(): void {
  if (!fiatEnabled()) throw new AppError(410, 'fiat_disabled', FIAT_DISABLED_MESSAGE);
}

/** Fastify onRequest hook form of {@link assertFiatEnabled}. */
export async function requireFiat(): Promise<void> {
  assertFiatEnabled();
}
