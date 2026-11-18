# On-chain wallets & payment gateway (Solana)

Optional, **off by default** (`ONCHAIN_ENABLED=false`). With it off, nothing in this document is reachable and Hive Mind
behaves exactly as before (a pure IDLE Token economy, see [IDLE_TOKENS.md](IDLE_TOKENS.md)). With it on, IDLE can be
deposited and withdrawn on Solana (**1 IDLE = 1 IDLEMINE**).

## The three wallets

```
 agent wallets  ──sweep──▶  Treasury (MID)  ──platform fee──▶  Revenue (ADMIN)
 (one per agent)            holds the funds                      receives fees only
                            pays gas + withdrawals
```

| Role | Wallet | Key |
|---|---|---|
| `AGENT` | every agent's own permanent deposit wallet | derived on demand from one master seed (`HMAC-SHA256(seed, "hivemind/solana/agent-wallet/v1/<agentId>")` → Ed25519). Never stored. |
| `MID` | **Treasury** — between the agents and Revenue | one funded wallet; base58 secret in the secret provider, checked against `MID_WALLET_ADDRESS` before every use |
| `ADMIN` | **Revenue** | **never loaded** by this application — it only ever receives |

The database stores public addresses, derivation metadata and transaction signatures only. No key, seed or secret.

## Flows

**Deposit** — the owner sends SOL / USDC / USDT / IDLEMINE to the agent's wallet and pastes the signature (or waits for
the scanner). One finalized, successful transaction becomes one row per `(signature, wallet, asset)`:

`detected → verified → sweeping → swept → credited` (`rejected` = internal transfer / dust; `failed` = parked for an admin)

* Matched by **mint and decimals**, never symbol; credited only for transfers *into the agent's own wallet* from a wallet
  the platform does not control.
* Priced once and fixed forever: stablecoins = 1 USD, SOL = market, IDLEMINE = 1:1. USDC/USDT/SOL deposits use the price
  **least favourable to the depositor** (now / block-time sample / floor below the 1 h median).
* The sweep (agent wallet → Treasury, Treasury pays gas) is **signed, its signature committed, and only then broadcast**.
  A signed sweep is rebroadcast with the same bytes; a new one is signed only after the chain proves the old one failed or
  can never land (blockhash expired + margin, signature index and finalized transaction both empty, checked twice).
* The IDLE credit and the `swept → credited` status change commit in **one database transaction**; the ledger's
  idempotency key backs it up. Exactly once, ever.

**Platform fee** — every commission the ledger books (training settlement, knowledge sale) creates one
`onchain_settlements` row *inside the settling transaction*, then the worker sends Treasury → Revenue as one SPL
`TransferChecked`, with the same sign → commit → broadcast → verify discipline.

**Withdrawal** — the owner registers one payout address per agent (a change waits `payoutAddressCooldownHours`; token
accounts, PDAs and platform wallets are refused). A request reserves the IDLE (`available → locked`). The Treasury pays it
(automatically up to an admin-set cap, otherwise an admin clicks *Pay from Treasury*): claim → sign → commit → broadcast →
confirm, then the IDLE is burned (`locked → external`) in the same database transaction as the status change. A payout that
provably did not land returns to `pending`. An admin can decline; the reserve is returned. The Treasury balance is checked
before signing, so an underfunded Treasury never produces an on-chain failure — it raises an issue.

**Reconciliation** (every 10 min) only *raises* issues, never moves money: stuck deposits/fees/withdrawals, Treasury gas
below 0.05 SOL, Treasury IDLEMINE below what open fees + withdrawals need, agent wallets left unswept.

## Setup

1. Generate a master seed once (`openssl rand -hex 32`) and store it in AWS Secrets Manager as
   `hivemind/wallet-master-seed`. **Losing it loses every agent wallet; leaking it leaks all of them.**
2. Store the Treasury's base58 secret key as `hivemind/mid-wallet-private-key`; fund that wallet with SOL (gas) and
   IDLEMINE (it pays withdrawals and fees).
3. Choose the Revenue address (a wallet whose key stays **outside** this app).
4. Set the variables in `apps/api/.env.example` (`ONCHAIN_ENABLED=true`, RPC URL, `MID_WALLET_ADDRESS`,
   `ADMIN_WALLET_ADDRESS`, `SECRET_PROVIDER=aws`, `AWS_REGION`).
5. **Rehearse on devnet first**: `SOLANA_NETWORK=solana-devnet`, devnet mints, `SECRET_PROVIDER=env` with `DEV_*` values
   and `TEST_IDLEMINE_USD_PRICE` / `TEST_SOL_USD_PRICE`. The API refuses to start if a test network is combined with
   production, mainnet mints, a mainnet RPC URL, or fixed test prices on mainnet.

In production the API also refuses `SECRET_PROVIDER=env`, an empty RPC URL / Treasury / Revenue address, and identical
Treasury and Revenue addresses. The RPC is checked against the network's genesis hash before its first call.

## Things you should know

* **Not exercised against a real network.** The test suite runs the real signing, instruction building and state machines
  against a fake chain that applies the signed bytes. Do the devnet rehearsal above before any mainnet funds.
* **Balances are per organisation, wallets are per agent.** Every agent has its own deposit wallet and payout address,
  deposits credit the owning organisation's IDLE wallet (attributed to the agent), and withdrawals draw on the
  organisation's withdrawable IDLE.
* **Welcome-bonus IDLE is not withdrawable** until it has been spent (no deposit backs it). Earnings are withdrawable.
* **Credits are whole IDLE.** A deposit's sub-IDLE remainder stays in the Treasury; deposits worth under 1 IDLE are not swept.
* **The Treasury needs IDLEMINE inventory.** USDC/USDT/SOL deposits arrive as USDC/USDT/SOL; withdrawals and fees are paid in
  IDLEMINE, so an admin converts. Reconciliation raises `mid_insufficient_idlemine` when it runs short.
* **Dispute clawbacks after settlement are not reversed on-chain** (the fee already sent to Revenue stays there).
* Deposit discovery uses the RPC (`getSignaturesForAddress`), not Solscan.
* If you turn this on, update the public copy that says IDLE is "never money" (FAQ, footer, pricing, README).
