import assert from "node:assert/strict";
import test from "node:test";
import { createVideoBook } from "../video-filter-adapted-v1/book.mjs";
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

  const sized = createVideoBook({ requireLifetimeFees: false });
  const signal = { ok: true, triggerPrice: 1, candleEndMs: 1 };
  const tokens = 982_312_202_183n;
  assert.equal(sized.tryEnter({
    mint: "big",
    signal,
    quote: { atMs: 2, price: 1, tokens, executableValue: sized.grossDebit },
    nowMs: 2,
  }).accepted, true);
  const held = sized.exitOnQuote({
    mint: "big",
    quote: { atMs: 3_000, proceedsForRemaining: sized.grossDebit + 20_000_000n },
    nowMs: 3_000,
  });
  assert.equal(held.reason, "hold");
  assert.equal(sized.snapshot().closed, 0);
});
