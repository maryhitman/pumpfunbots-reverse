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
  --compare \
  --public-readonly \
  --duration-sec 600 \
  --json-out paper-runs/compare-report.json \
  --log-out paper-runs/compare.log
```

The process exits when the window ends. It is not a daemon.

Public reads try only these endpoints, in order:

- `https://api.mainnet-beta.solana.com` with `wss://api.mainnet-beta.solana.com`
- `https://solana-rpc.publicnode.com` with `wss://solana-rpc.publicnode.com`

Methods used: `getSlot`, `getAccountInfo`, `logsSubscribe`, `logsUnsubscribe`. Any other RPC method throws. Helius URLs, private URLs, and local proxies are refused. `HELIUS_API_KEY`, `RPC_URL`, and `GRAD_*` overrides are ignored. `PRIVATE_KEY` and the other key environment names refuse the process. `--live`, `--send`, `--wallet`, `--keypair`, `--sign`, and `--dry-run` are refused. Exit code 2 is a refusal. Exit code 3 means every public endpoint failed; the report's `data.attempts[].error` strings are the blocker.

## Strategy defaults

Entry, size, and risk limits stay on the original `graduation.mjs` numbers. The runnable comparison does not turn those into live orders.

| Knob | Value |
| --- | --- |
| Entry | virtual SOL reserves at least 92% of 85 SOL |
| Buy size | 0.1 simulated SOL |
| Take profit | 1.5x pre-trade spot, while the curve is still open |
| Stop loss | 0.7x pre-trade spot, while the curve is still open |
| Timeout | 300 seconds |
| Positions | 3 |
| Cooldown | 30 seconds |
| Virtual cash | 10 SOL per book |

`--compare` runs two modified books on the same events. Each starts at 10 virtual SOL. Both use the original entry band, `fill >= 92%` and `fill < 100%`.

- **A `exit-at-97`.** Attempts a bonding-curve exit only when a curve read has `complete=false` and fill is at least 97% and still under 100% (configurable with `--early-exit-pct`, default 97). The mark uses that observed reserve state. It is not rewritten to a 97% price. A read at or above 100% fill, or a graduated, missing, or unreadable read, does not receive a backfilled 97% sale. Graduated, missing, and unreadable reads are missed exits: cash stays reserved and no profit is booked. A pre-graduation exit is not guaranteed.
- **B `pumpswap-immediate`.** Holds through graduation. The labeled rule is the first validated PumpSwap quote after that observation. Migration does not imply liquidity. A missing, unverified, stale, zero-liquidity, or rate-limited pool stays pending or becomes a missed exit. No post-graduation price is taken from the `complete` flag.

`--strategy modified` is the single book that also refuses new entries at or above 97%. `--strategy original` is the comparison baseline: entry under 100%, no 97% exit, and no PumpSwap quote. `--duration-sec` is an integer from 1 to 660.

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
