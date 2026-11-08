# Graduation sniper, paper only

Wallet-free counterfactual runner for the strategy in `bots/graduation-sniper/graduation.mjs`. It does not read `keys/`, sign, or broadcast. It does not add a live-execution path to the original bot.

Virtual starting balance: **10 SOL**. That figure is simulated cash. It is not a wallet, not a funded account, not on-chain, and not withdrawable.

## Commands

From the repository root, after `npm ci`:

```bash
npm run test:paper
```

```bash
node bots/graduation-sniper/paper/run.mjs \
  --fixture bots/graduation-sniper/paper/fixtures/mixed-outcome.json \
  --json-out paper-runs/fixture-report.json \
  --log-out paper-runs/fixture.log
```

```bash
node bots/graduation-sniper/paper/run.mjs \
  --public-readonly \
  --duration-sec 300 \
  --json-out paper-runs/public-report.json \
  --log-out paper-runs/public.log
```

`--duration-sec` must be an integer from 1 to 330. The process exits when that window ends. It is not a daemon.

Public reads try only these endpoints, in order:

- `https://api.mainnet-beta.solana.com` with `wss://api.mainnet-beta.solana.com`
- `https://solana-rpc.publicnode.com` with `wss://solana-rpc.publicnode.com`

Methods used: `getSlot`, `getAccountInfo`, `logsSubscribe`, `logsUnsubscribe`. Any other RPC method throws. Helius URLs, private URLs, and local proxies are refused. `HELIUS_API_KEY`, `RPC_URL`, and `GRAD_*` overrides are ignored. `PRIVATE_KEY` and the other key environment names refuse the process. `--live`, `--send`, `--wallet`, `--keypair`, `--sign`, and `--dry-run` are refused. Exit code 2 is a refusal. Exit code 3 means every public endpoint failed; the report's `data.attempts[].error` strings are the blocker.

## Strategy defaults

These are the original `graduation.mjs` defaults. The runnable entrypoint does not expose overrides.

| Knob | Value |
| --- | --- |
| Trigger | virtual SOL reserves at least 92% of 85 SOL, and under 100% |
| Buy size | 0.1 simulated SOL |
| Take profit | 1.5x pre-trade spot |
| Stop loss | 0.7x pre-trade spot |
| Timeout | 300 seconds |
| Positions | 3 |
| Cooldown | 30 seconds |
| Virtual cash | 10 SOL |

A buy also needs both ledgers to still hold 0.1 SOL. The original dry-run does not check cash. When this runner refuses for cash, the decision is `insufficient_virtual_cash` and `originalWouldOpen` is true.

## Two ledgers

Both ledgers see the same triggers. Triggers use the pre-trade spot ratio `virtualSol / virtualToken`, which is what the original dry-run stores.

- **Faithful.** An in-curve exit is marked at that spot ratio with no fee and no price impact. That is the original dry-run formula (`BUY_SOL * (spotMultiple - 1)`). It is optimistic relative to a curve fill.
- **Improved.** The buy and the in-curve exit use the integer formulas in `lib/pumpfun.mjs` `calcBuyTokens` and `calcSellSol`: constant product and a truncating 1% fee (`amount / 100`). The exit sells the simulated token amount into reserves observed later. It does not inject the paper buy into those reserves. The 1% fee is this repository's formula, not a claim about the current pump.fun fee schedule.

Model marks are counterfactual. `onChainRealizedSol` is null and `successfulOnChainSells` is 0 on every report. Positive model PnL is not a realized profit and not a successful sell.

## What the original source does

Checked directly against `graduation.mjs` and `lib/pumpfun.mjs` in this fork:

- `--dry-run` still calls `loadKeypair()` at module scope, so the original dry-run requires `keys/default.json`.
- The dry-run branch stores the pre-trade spot and returns before `calcBuyTokens`.
- Dry-run curve-exit PnL is the spot multiple times the buy size, with no fee and no impact.
- `checkExit` returns when the bonding-curve account is missing or `complete`. It does not sell, book PnL, or delete the position. There is no PumpSwap sell.
- Those positions stay in the map, and buys stop at `MAX_POSITIONS`, so open graduated positions can lock all three slots.
- The live `sellPosition` path, if it later observes a complete curve, deletes the position and returns before the PnL update and before `sellIx`. That still is not an AMM sell. Normal graduation handling never reaches it, because `checkExit` returns first.

This runner copies the slot lock. A missing curve, a completed curve, or unreadable reserves becomes `unpriceable`. Virtual cash stays reserved. Neither ledger books a mark. No PumpSwap price is invented. `performanceIncomplete` is true while any position is open or unpriceable.

## Limits

- Nothing here predicts what a funded wallet would have earned.
- Priority fees, Jito tips, slippage, and failed landing are not modeled. The original live path builds those transactions. This package does not.
- Public `logsSubscribe` can be rejected, empty, or cut off. A failed window is a data-access result.
- The original bot file is unchanged. Do not point a funded key at `graduation.mjs` as part of this test.
