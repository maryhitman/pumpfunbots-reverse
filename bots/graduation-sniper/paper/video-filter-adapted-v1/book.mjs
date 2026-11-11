import { V1, grossDebitForNominal, nominalEntryLamports } from "./config.mjs";
import { momentumSignal } from "./candles.mjs";

const SOL = 1_000_000_000n;

function solString(lamports) {
  const neg = lamports < 0n;
  const v = neg ? -lamports : lamports;
  return `${neg ? "-" : ""}${v / SOL}.${(v % SOL).toString().padStart(9, "0")}`;
}

function bps(numerator, denominator) {
  if (denominator <= 0n) return 0n;
  return (numerator * 10000n) / denominator;
}

// a/b <= c/d, without dividing. All values are bigint and denominators stay in the product.
export function ratioAtMost(numerator, denominator, limitNumerator, limitDenominator) {
  return numerator * limitDenominator <= limitNumerator * denominator;
}

export function ratioAtLeast(numerator, denominator, limitNumerator, limitDenominator) {
  return numerator * limitDenominator >= limitNumerator * denominator;
}

export function stopReached(value, cost, tokens, remaining) {
  return ratioAtMost(value, remaining, cost * 85n, tokens * 100n);
}

export function takeProfitReached(value, costRemaining) {
  return ratioAtLeast(value, 1n, costRemaining * 130n, 100n);
}

export function trailReached(value, high) {
  return ratioAtMost(value, 1n, high * 90n, 100n);
}

export function staleReached(value, cost, tokens, remaining) {
  const basis = cost * remaining;
  const marked = value * tokens;
  const gap = marked > basis ? marked - basis : basis - marked;
  return ratioAtMost(gap, basis, 10n, 100n);
}

export function entryPremiumReached(debitLamports, tokens, triggerSolPerUi) {
  if (typeof tokens !== "bigint" || tokens <= 0n) return true;
  if (!(triggerSolPerUi > 0)) return true;
  const maxLamportsPerUi = BigInt(Math.round(triggerSolPerUi * 1e9 * 1.05));
  if (maxLamportsPerUi <= 0n) return true;
  return debitLamports * 1_000_000n > tokens * maxLamportsPerUi;
}

export function createVideoBook({ requireLifetimeFees = true, startingLamports = 3n * SOL } = {}) {
  const gross = grossDebitForNominal();
  const nominal = nominalEntryLamports();
  let cash = startingLamports;
  let pause = false;
  const positions = new Map();
  const closed = [];
  const quarantined = [];
  const skips = [];
  let peakEquity = cash;
  let maxDrawdown = 0n;

  function equity(markRemaining) {
    let marked = cash;
    for (const position of positions.values()) {
      const value = markRemaining?.(position) ?? position.costRemaining;
      marked += value;
    }
    return marked;
  }

  function noteEquity(marked) {
    if (marked > peakEquity) peakEquity = marked;
    const dd = peakEquity - marked;
    if (dd > maxDrawdown) maxDrawdown = dd;
    if (marked <= solToLamports(V1.pauseEquitySol)) pause = true;
  }

  function skip(reason, detail) {
    skips.push({ reason, ...detail });
    return { accepted: false, reason };
  }

  function screen(candidate) {
    if (!candidate || candidate.asOfMs == null) return skip("missing_asof", {});
    if (candidate.protocol !== "pump" && candidate.protocol !== "pumpswap") return skip("protocol", candidate);
    if (candidate.stage === "final-stretch") {
      if (!(candidate.fillPct >= V1.finalStretchFillMinPct && candidate.fillPct < V1.finalStretchFillExclusiveMaxPct)) {
        return skip("not_final_stretch_proxy", candidate);
      }
      if (candidate.complete !== false) return skip("curve_not_open", candidate);
    } else if (candidate.stage === "migrated") {
      if (candidate.poolConfirmed !== true) return skip("pool_unconfirmed", candidate);
      if (candidate.volumeWindow !== V1.migratedVolumeWindow) return skip("volume_window", candidate);
      if (!(candidate.volumeUsd >= V1.migratedVolumeUsdMin)) return skip("volume", candidate);
      if (!(candidate.liquidityUsd >= V1.poolLiquidityUsdMin)) return skip("liquidity_missing_or_low", candidate);
    } else {
      return skip("stage", candidate);
    }
    if (candidate.observedAtMs > candidate.asOfMs) return skip("lookahead", candidate);
    if (requireLifetimeFees) {
      if (candidate.fees?.available !== true || candidate.fees.asOfMs == null || candidate.fees.asOfMs > candidate.asOfMs) {
        return skip("cumulative_fees_unavailable", candidate);
      }
      if (!(candidate.fees.lifetimeSol >= V1.cumulativeFeesSolMin)) return skip("cumulative_fees_low", candidate);
    } else if (candidate.fees?.asOfMs != null && candidate.fees.asOfMs > candidate.asOfMs) {
      return skip("lookahead", candidate);
    }
    if (!(candidate.marketCapUsd >= V1.marketCapUsdMin)) return skip("market_cap", candidate);
    return { accepted: true, reason: "screen_pass" };
  }

  function tryEnter({ mint, signal, quote, nowMs, markRemaining }) {
    if (positions.has(mint) || closed.some((row) => row.mint === mint)) return skip("one_mint", { mint });
    if (pause) return skip("drawdown_pause", { mint });
    if (!signal?.ok) return skip(signal?.reason ?? "no_signal", { mint });
    if (quote?.atMs == null || quote.atMs < signal.candleEndMs) return skip("quote_before_close", { mint });
    if (typeof quote.tokens !== "bigint" || quote.tokens <= 0n) return skip("zero_quantity", { mint });
    if (quote.decimals === 6) {
      if (entryPremiumReached(gross, quote.tokens, signal.triggerPrice)) return skip("entry_premium", { mint });
    } else if (!(quote.price > 0) || quote.price > signal.triggerPrice * (1 + V1.maxEntryPremium)) {
      return skip("entry_premium", { mint });
    }
    if (quote.quarantine) {
      quarantined.push({ mint, atMs: nowMs, reason: quote.reason, kind: "entry" });
      return skip("quarantine", { mint });
    }
    if (cash < gross) return skip("cash_reserve", { mint });
    const marked = equity(markRemaining);
    noteEquity(marked);
    if (pause) return skip("drawdown_pause", { mint });
    cash -= gross;
    const tokens = quote.tokens;
    const position = {
      mint,
      openedAtMs: nowMs,
      triggerPrice: signal.triggerPrice,
      entryPrice: quote.price,
      tokens,
      remaining: tokens,
      cost: gross,
      costRemaining: gross,
      tookProfit: false,
      highValue: quote.executableValue ?? gross,
      proceeds: 0n,
    };
    positions.set(mint, position);
    noteEquity(equity(markRemaining));
    return { accepted: true, reason: "opened", debitLamports: gross.toString(), nominalLamports: nominal.toString() };
  }

  function exitOnQuote({ mint, quote, nowMs }) {
    const position = positions.get(mint);
    if (!position) return { acted: false, reason: "no_position" };
    if (quote?.quarantine) {
      quarantined.push({ mint, atMs: nowMs, reason: quote.reason, kind: "exit" });
      return { acted: false, reason: "quarantine" };
    }
    if (typeof quote?.proceedsForRemaining !== "bigint" || quote.atMs == null) return { acted: false, reason: "no_executable" };
    const value = quote.proceedsForRemaining;
    const previousHigh = position.highValue;
    const held = nowMs - position.openedAtMs;
    let reason = null;
    let sellTokens = position.remaining;
    if (stopReached(value, position.cost, position.tokens, position.remaining)) reason = "stop";
    else if (!position.tookProfit && takeProfitReached(value, position.costRemaining)) {
      reason = "take_profit";
      sellTokens = position.remaining / 2n;
      if (sellTokens <= 0n) sellTokens = position.remaining;
    } else if (position.tookProfit && trailReached(value, previousHigh)) reason = "trail";
    else if (held >= V1.maxHoldMs) reason = "cap-6h";
    else if (held >= V1.staleHoldMs && staleReached(value, position.cost, position.tokens, position.remaining)) {
      reason = "stale-5h";
    }
    if (value > position.highValue) position.highValue = value;
    if (!reason) return { acted: false, reason: "hold", value: value.toString() };
    const proceeds = (value * sellTokens) / position.remaining;
    position.proceeds += proceeds;
    cash += proceeds;
    position.remaining -= sellTokens;
    if (reason === "take_profit") {
      position.tookProfit = true;
      position.costRemaining = position.costRemaining / 2n;
      position.highValue = (value * position.remaining) / (sellTokens + position.remaining);
    }
    if (position.remaining <= 0n || reason !== "take_profit") {
      const pnl = position.proceeds - position.cost;
      positions.delete(mint);
      closed.push({ mint, reason, pnl, proceeds: position.proceeds, cost: position.cost, openedAtMs: position.openedAtMs, closedAtMs: nowMs });
      noteEquity(equity());
      return { acted: true, reason, pnl: pnl.toString() };
    }
    noteEquity(equity());
    return { acted: true, reason, partial: true, remaining: position.remaining.toString() };
  }

  return {
    grossDebit: gross,
    screen,
    tryEnter,
    exitOnQuote,
    signal: momentumSignal,
    markStuck(mint, nowMs) {
      const position = positions.get(mint);
      if (!position) return { acted: false, reason: "no_position" };
      const pnl = position.proceeds - position.cost;
      positions.delete(mint);
      closed.push({
        mint,
        reason: "stuck",
        pnl,
        proceeds: position.proceeds,
        cost: position.cost,
        openedAtMs: position.openedAtMs,
        closedAtMs: nowMs,
      });
      noteEquity(equity());
      return { acted: true, reason: "stuck", pnl: pnl.toString() };
    },
    listOpen() {
      return [...positions.values()].map((position) => ({
        mint: position.mint,
        remaining: position.remaining.toString(),
        cost: position.cost.toString(),
        openedAtMs: position.openedAtMs,
      }));
    },
    snapshot() {
      const marked = equity();
      return {
        id: V1.id,
        cash: solString(cash),
        pause,
        open: positions.size,
        closed: closed.length,
        quarantined: quarantined.length,
        skips: skips.reduce((acc, row) => {
          acc[row.reason] = (acc[row.reason] ?? 0) + 1;
          return acc;
        }, {}),
        realizedPnl: solString(closed.reduce((sum, row) => sum + row.pnl, 0n)),
        maxDrawdown: solString(maxDrawdown),
        equity: solString(marked),
        trades: closed.map((row) => ({ ...row, pnl: row.pnl.toString(), proceeds: row.proceeds.toString(), cost: row.cost.toString() })),
        quarantinedRows: quarantined,
      };
    },
  };
}

function solToLamports(sol) {
  return BigInt(Math.round(sol * 1_000_000_000));
}

export { bps };
