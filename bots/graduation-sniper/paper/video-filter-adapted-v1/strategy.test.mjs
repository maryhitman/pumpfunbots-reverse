import assert from "node:assert/strict";
import test from "node:test";
import { createCandleBook, momentumSignal } from "./candles.mjs";
import { grossDebitForNominal, nominalEntryLamports } from "./config.mjs";
import { createVideoBook } from "./book.mjs";
import { assessExecutableQuote } from "./quarantine.mjs";
import { RULE_MAP } from "./rules.mjs";

const NOMINAL = nominalEntryLamports();
const GROSS = grossDebitForNominal();

function candle(startMs, close, volume, high = close) {
  return { startMs, endMs: startMs + 60_000, open: close - 1, high, low: close - 2, close, volumeUsd: volume, partial: false, trades: 1 };
}

function sevenGreen() {
  const bars = [];
  for (let i = 0; i < 7; i += 1) {
    bars.push(candle(i * 60_000, 100 + i, i === 6 ? 500 : 100, 100 + i));
  }
  bars[6].close = 120;
  bars[6].high = 120;
  bars[6].open = 110;
  return bars;
}

function passCandidate(over = {}) {
  return {
    protocol: "pump",
    stage: "final-stretch",
    fillPct: 92,
    complete: false,
    marketCapUsd: 20_000,
    fees: { available: true, lifetimeSol: 0.2, asOfMs: 1_000 },
    asOfMs: 1_000,
    observedAtMs: 1_000,
    ...over,
  };
}

test("fee reserve is extra SOL and is not spent twice", () => {
  assert.ok(GROSS > NOMINAL);
  assert.ok(GROSS - GROSS / 100n >= NOMINAL);
  const book = createVideoBook();
  assert.equal(book.grossDebit, GROSS);
  const signal = { ok: true, triggerPrice: 10, candleEndMs: 60_000 };
  const opened = book.tryEnter({
    mint: "A",
    signal,
    quote: { atMs: 61_000, price: 10, tokens: 1_000n, executableValue: GROSS },
    nowMs: 61_000,
  });
  assert.equal(opened.accepted, true);
  const again = book.tryEnter({
    mint: "A",
    signal,
    quote: { atMs: 61_000, price: 10, tokens: 1_000n },
    nowMs: 62_000,
  });
  assert.equal(again.reason, "one_mint");
  assert.equal(book.snapshot().cash, sol(3n * 1_000_000_000n - GROSS));
});

test("missing fees, lookahead, gaps, and a late quote do not enter", () => {
  const book = createVideoBook();
  assert.equal(book.screen(passCandidate({ fees: { available: false } })).reason, "cumulative_fees_unavailable");
  assert.equal(book.screen(passCandidate({ fees: { available: true, lifetimeSol: 1, asOfMs: 5_000 }, asOfMs: 1_000 })).reason, "cumulative_fees_unavailable");
  assert.equal(book.screen(passCandidate({ observedAtMs: 9_000, asOfMs: 1_000 })).reason, "lookahead");
  assert.equal(book.screen(passCandidate({ stage: "migrated", poolConfirmed: false })).reason, "pool_unconfirmed");
  assert.equal(book.screen(passCandidate({ stage: "migrated", poolConfirmed: true, volumeWindow: "rolling_1h", volumeUsd: 10, liquidityUsd: 50_000 })).reason, "volume");
  const candles = createCandleBook();
  candles.ingest({ mint: "G", atMs: 1_000, price: 1, volumeUsd: 1 });
  candles.ingest({ mint: "G", atMs: 180_000, price: 2, volumeUsd: 1 });
  assert.equal(candles.gapped("G"), true);
  assert.equal(momentumSignal(candles.closed("G")).reason, "coverage");
  const signal = momentumSignal(sevenGreen());
  assert.equal(signal.ok, true);
  const late = book.tryEnter({
    mint: "B",
    signal,
    quote: { atMs: signal.candleEndMs, price: signal.triggerPrice * 1.06, tokens: 1_000n },
    nowMs: signal.candleEndMs,
  });
  book.screen(passCandidate());
  assert.equal(late.reason, "entry_premium");
});

test("stop, half take-profit, trail, stale, and six-hour cap use executable proceeds", () => {
  const book = createVideoBook();
  const signal = { ok: true, triggerPrice: 10, candleEndMs: 1_000 };
  const open = (mint, now) => book.tryEnter({
    mint,
    signal,
    quote: { atMs: now, price: 10, tokens: 1_000n, executableValue: GROSS },
    nowMs: now,
  });
  assert.equal(open("stop", 2_000).accepted, true);
  const stopped = book.exitOnQuote({
    mint: "stop",
    quote: { atMs: 3_000, proceedsForRemaining: GROSS * 80n / 100n },
    nowMs: 3_000,
  });
  assert.equal(stopped.reason, "stop");
  assert.ok(BigInt(stopped.pnl) < 0n);

  assert.equal(open("tp", 4_000).accepted, true);
  const half = book.exitOnQuote({
    mint: "tp",
    quote: { atMs: 5_000, proceedsForRemaining: GROSS * 14n / 10n },
    nowMs: 5_000,
  });
  assert.equal(half.reason, "take_profit");
  assert.equal(half.partial, true);
  const raised = book.exitOnQuote({
    mint: "tp",
    quote: { atMs: 6_000, proceedsForRemaining: GROSS },
    nowMs: 6_000,
  });
  assert.equal(raised.reason, "hold");
  const trailed = book.exitOnQuote({
    mint: "tp",
    quote: { atMs: 7_000, proceedsForRemaining: GROSS * 80n / 100n },
    nowMs: 7_000,
  });
  assert.equal(trailed.reason, "trail");

  assert.equal(open("stale", 10_000).accepted, true);
  const stale = book.exitOnQuote({
    mint: "stale",
    quote: { atMs: 10_000 + 5 * 60 * 60 * 1000, proceedsForRemaining: GROSS },
    nowMs: 10_000 + 5 * 60 * 60 * 1000,
  });
  assert.equal(stale.reason, "stale-5h");

  assert.equal(open("cap", 20_000).accepted, true);
  const cap = book.exitOnQuote({
    mint: "cap",
    quote: { atMs: 20_000 + 6 * 60 * 60 * 1000, proceedsForRemaining: GROSS * 11n / 10n },
    nowMs: 20_000 + 6 * 60 * 60 * 1000,
  });
  assert.equal(cap.reason, "cap-6h");
});

test("drawdown pauses new entries and an extreme quote is not booked", () => {
  const book = createVideoBook();
  const signal = { ok: true, triggerPrice: 1, candleEndMs: 1 };
  for (let i = 0; i < 5; i += 1) {
    assert.equal(book.tryEnter({
      mint: `L${i}`,
      signal,
      quote: { atMs: 10 + i, price: 1, tokens: 100n, executableValue: GROSS },
      nowMs: 10 + i,
    }).accepted, true);
    book.exitOnQuote({ mint: `L${i}`, quote: { atMs: 20 + i, proceedsForRemaining: 0n }, nowMs: 20 + i });
  }
  const paused = book.tryEnter({
    mint: "after",
    signal,
    quote: { atMs: 100, price: 1, tokens: 100n },
    nowMs: 100,
  });
  assert.equal(paused.reason, "drawdown_pause");
  const bad = assessExecutableQuote({
    quote: { ok: true, outAmountLamports: "1000000000000", priceImpactPct: "0.01", contextSlot: 10 },
    vaultProceedsLamports: 200_000_000n,
    quotedInputRaw: 100n,
    positionRaw: 100n,
    observedSlot: 10,
  });
  assert.equal(bad.quarantine, true);
  assert.equal(bad.accept, false);
  const book2 = createVideoBook();
  book2.tryEnter({
    mint: "Q",
    signal,
    quote: { atMs: 2, price: 1, tokens: 100n, executableValue: GROSS },
    nowMs: 2,
  });
  const ignored = book2.exitOnQuote({
    mint: "Q",
    quote: { atMs: 3, quarantine: true, reason: bad.reason, proceedsForRemaining: 1_000_000_000_000n },
    nowMs: 3,
  });
  assert.equal(ignored.reason, "quarantine");
  assert.equal(book2.snapshot().closed, 0);
  assert.equal(book2.snapshot().quarantined, 1);
  assert.equal(RULE_MAP.find((row) => row.id === "cumulative-fees").status, "unavailable");
});

function sol(lamports) {
  return `${lamports / 1_000_000_000n}.${(lamports % 1_000_000_000n).toString().padStart(9, "0")}`;
}
