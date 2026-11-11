import assert from "node:assert/strict";
import test from "node:test";
import {
  createVideoBook,
  entryPremiumReached,
  staleReached,
  stopReached,
  takeProfitReached,
  trailReached,
} from "../video-filter-adapted-v1/book.mjs";
import { V2 } from "./config.mjs";
import { RULE_MAP } from "./rules.mjs";

function candidate(over = {}) {
  return {
    protocol: "pump",
    stage: "final-stretch",
    fillPct: 92,
    complete: false,
    marketCapUsd: 20_000,
    asOfMs: 1_000,
    observedAtMs: 1_000,
    ...over,
  };
}

test("v2 keeps every gate except the lifetime-fee veto", () => {
  assert.equal(V2.requireLifetimeFees, false);
  assert.equal(V2.reproducesVideoFeeFilter, false);
  assert.equal(V2.finalStretchFillMinPct, 90);
  assert.equal(V2.poolLiquidityUsdMin, 40_000);
  assert.equal(V2.migratedVolumeWindow, "rolling_1h");
  assert.equal(RULE_MAP.find((rule) => rule.id === "cumulative-fees").status, "removed-in-v2-only");
  assert.equal(RULE_MAP.find((rule) => rule.id === "market-cap" || rule.id === "final-stretch-mcap").status, "adapted");

  const v2 = createVideoBook({ requireLifetimeFees: false });
  assert.equal(v2.screen(candidate()).accepted, true);
  assert.equal(v2.screen(candidate({ marketCapUsd: 9_000 })).reason, "market_cap");
  assert.equal(v2.screen(candidate({ fillPct: 89 })).reason, "not_final_stretch_proxy");
  assert.equal(v2.screen(candidate({ complete: true })).reason, "curve_not_open");
  assert.equal(v2.screen(candidate({ observedAtMs: 5_000 })).reason, "lookahead");
  assert.equal(v2.screen(candidate({
    stage: "migrated",
    poolConfirmed: true,
    volumeWindow: "unspecified",
    volumeUsd: 40_000,
    liquidityUsd: 50_000,
  })).reason, "volume_window");
  assert.equal(v2.screen(candidate({
    stage: "migrated",
    poolConfirmed: true,
    volumeWindow: "rolling_1h",
    volumeUsd: 29_000,
    liquidityUsd: 50_000,
  })).reason, "volume");
  assert.equal(v2.screen(candidate({
    stage: "migrated",
    poolConfirmed: true,
    volumeWindow: "rolling_1h",
    volumeUsd: 40_000,
    liquidityUsd: 1_000,
  })).reason, "liquidity_missing_or_low");
  assert.equal(v2.screen(candidate({ fees: { asOfMs: 9_000 } })).reason, "lookahead");

  const v1 = createVideoBook();
  assert.equal(v1.screen(candidate()).reason, "cumulative_fees_unavailable");
});

test("exact 15, 30, and 10 percent boundaries do not depend on raw token scale", () => {
  const cost = 202_020_203n;
  const tokens = 982_312_202_183n;
  const at85 = cost * 85n / 100n;
  assert.equal(stopReached(at85, cost, tokens, tokens), true);
  assert.equal(stopReached(at85 + 1n, cost, tokens, tokens), false);
  const at130 = (cost * 130n + 99n) / 100n;
  assert.equal(takeProfitReached(at130 - 1n, cost), false);
  assert.equal(takeProfitReached(at130, cost), true);
  const high = cost * 2n;
  const at90 = high * 90n / 100n;
  assert.equal(trailReached(at90, high), true);
  assert.equal(trailReached(at90 + 1n, high), false);
  assert.equal(staleReached(cost * 110n / 100n, cost, tokens, tokens), true);
  assert.equal(staleReached(cost * 110n / 100n + 1n, cost, tokens, tokens), false);
  assert.equal(entryPremiumReached(0n, 0n, 1e-7), true);
});

test("the two invalidated v2 quotes stay open instead of stopping", () => {
  const book = createVideoBook({ requireLifetimeFees: false });
  const signal = { ok: true, triggerPrice: 2.2e-7, candleEndMs: 1 };
  const cases = [
    { mint: "HSAxB1NPnmnwCwPTAregMzmVGZUGndAAHjVSG59tpump", tokens: 982_312_202_183n, proceeds: 224_673_087n },
    { mint: "8bLo7wMpM86zAY1eME7SSrqvzsUQ529RYxo5uRsnpump", tokens: 1_017_009_159_435n, proceeds: 221_376_500n },
  ];
  for (const row of cases) {
    assert.equal(book.tryEnter({
      mint: row.mint,
      signal,
      quote: { atMs: 2, price: 2e-7, decimals: 6, tokens: row.tokens, executableValue: book.grossDebit },
      nowMs: 2,
    }).accepted, true);
    const held = book.exitOnQuote({
      mint: row.mint,
      quote: { atMs: 5_000, proceedsForRemaining: row.proceeds },
      nowMs: 5_000,
    });
    assert.equal(held.reason, "hold");
    assert.ok(row.proceeds > book.grossDebit);
  }
  assert.equal(book.snapshot().closed, 0);
  assert.equal(book.snapshot().open, 2);
});

test("carried cash does not move the 2.1 SOL pause or the 0.2 nominal", () => {
  const carried = 3_099_570_464n;
  const book = createVideoBook({ requireLifetimeFees: false, startingLamports: carried });
  assert.equal(book.snapshot().cash, "3.099570464");
  assert.equal(book.grossDebit > 200_000_000n, true);
  assert.equal(V2.pauseEquitySol, 2.1);
  assert.equal(V2.nominalEntrySol, 0.2);
});
