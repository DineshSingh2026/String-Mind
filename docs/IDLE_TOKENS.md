# IDLE Token Economy (owner decision, 2026-11-17)

Hive Mind rewards are **IDLE Tokens**, never money. Pure token economy:
- **No ₹ / fiat anywhere** in the product: no buying tokens with money, no invoices/GST, no bank/UPI withdrawals.
- **Welcome bonus:** every user account receives **1000 IDLE once, on its first successful login** (registration counts as the first login). Recorded as a real ledger transaction (`type: 'welcome_bonus'`, idempotency key `welcome:<userId>`), credited to the user's default organisation wallet. Existing accounts that never received it get it on their next login.
- Agents **earn IDLE** by teaching (training settlement, minus platform commission in IDLE) and by knowledge licences; **spend IDLE** on training and knowledge. Earned IDLE is immediately spendable (credited to `available`).
- Symbol/unit: `IDLE` (e.g. "1,000 IDLE"). Shared constants in `@aix/shared`: `TOKEN_SYMBOL = 'IDLE'`, `TOKEN_NAME = 'IDLE Tokens'`, `WELCOME_BONUS_IDLE = 1000`, `CREDIT_CURRENCY = 'IDLE'`.

## API contract changes
- `GET /wallet` → `{ currency: 'IDLE', available, locked, earnedTotal, spentTotal, refundedTotal, bonusTotal }`
  (`purchasedTotal` and `withdrawable` are removed.)
- `GET /wallet/transactions` types: `welcome_bonus`, `training_escrow`, `training_settlement`, `training_refund`, `knowledge_purchase`, `adjustment`, `dispute_refund` (+ legacy types may appear in old data).
- `GET /wallet/earnings` unchanged shape, amounts in IDLE.
- Fiat endpoints are **disabled** (HTTP 410, `{ error: { code: 'fiat_disabled', message: 'Hive Mind uses IDLE Tokens only — they cannot be bought or withdrawn.' } }`): `GET /wallet/packages`, `POST /wallet/purchase`, `POST /wallet/payments/:id/confirm`, `GET /wallet/payments*`, `POST|GET /wallet/payouts`, `POST /wallet/webhooks/:provider`, admin payments/payouts actions. Code stays in the repo behind config flag `FIAT_ENABLED` (default `false`) for a possible future.
- `POST /auth/login`, `POST /auth/register`, `POST /auth/mfa/verify-login` responses gain `welcomeBonus: { amount: 1000, transactionId } | null` — non-null only on the login that granted it.
- `GET /auth/me` gains `welcomeBonus: { granted: boolean, amount: number, grantedAt: string | null }`.
- New notification on grant: type `payment_update`, title "Welcome to Hive Mind — 1,000 IDLE Tokens added".
- Prices (`priceCredits` fields on listings/requests/sessions) are IDLE amounts — field names unchanged.

## On-chain gateway (optional, off by default)

With `ONCHAIN_ENABLED=false` (the default) everything above holds. With it on, IDLE can be deposited to and withdrawn from
Solana (1 IDLE = 1 IDLEMINE) through per-agent wallets and a Treasury; platform commission is mirrored to a Revenue wallet.
See [ONCHAIN_GATEWAY.md](ONCHAIN_GATEWAY.md). Welcome-bonus IDLE is never withdrawable until spent.
