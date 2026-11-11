import { V1 } from "./config.mjs";

// Closed 1-minute bars from observed trades. Missing minutes stay missing.

export function createCandleBook() {
  const mints = new Map();

  function state(mint) {
    let row = mints.get(mint);
    if (!row) {
      row = { building: null, closed: [], gap: false };
      mints.set(mint, row);
    }
    return row;
  }

  function closeBuilding(row) {
    if (!row.building || row.building.trades === 0) return;
    row.closed.push({ ...row.building, partial: false });
    row.building = null;
  }

  return {
    ingest({ mint, atMs, price, volumeUsd }) {
      if (!mint || !Number.isFinite(atMs) || !(price > 0) || !(volumeUsd >= 0)) {
        throw new Error("candle trade needs mint, time, price, and volume");
      }
      const row = state(mint);
      const bucket = Math.floor(atMs / V1.candleMs) * V1.candleMs;
      if (!row.building) {
        row.building = { startMs: bucket, endMs: bucket + V1.candleMs, open: price, high: price, low: price, close: price, volumeUsd, trades: 1 };
        return { closed: false };
      }
      if (bucket < row.building.startMs) return { closed: false, ignored: "late" };
      if (bucket > row.building.startMs) {
        const gapMinutes = (bucket - row.building.startMs) / V1.candleMs;
        closeBuilding(row);
        if (gapMinutes > 1) row.gap = true;
        row.building = { startMs: bucket, endMs: bucket + V1.candleMs, open: price, high: price, low: price, close: price, volumeUsd, trades: 1 };
        return { closed: true, gap: gapMinutes > 1 };
      }
      const bar = row.building;
      bar.high = Math.max(bar.high, price);
      bar.low = Math.min(bar.low, price);
      bar.close = price;
      bar.volumeUsd += volumeUsd;
      bar.trades += 1;
      return { closed: false };
    },
    // A bar is closed only after time moves past it. This does not invent the missing prints.
    roll(mint, nowMs) {
      const row = mints.get(mint);
      if (!row?.building) return;
      if (nowMs >= row.building.endMs) closeBuilding(row);
    },
    closed(mint) {
      return mints.get(mint)?.closed ?? [];
    },
    gapped(mint) {
      return mints.get(mint)?.gap === true;
    },
  };
}

export function freshWindow(candles) {
  if (!Array.isArray(candles) || candles.length < V1.minClosedCandles) return null;
  const window = candles.slice(-V1.minClosedCandles);
  for (let i = 1; i < window.length; i += 1) {
    if (window[i].startMs - window[i - 1].startMs !== V1.candleMs) return null;
    if (window[i].partial || window[i - 1].partial) return null;
  }
  return window;
}

export function momentumSignal(candles) {
  const window = freshWindow(candles);
  if (!window) return { ok: false, reason: "coverage" };
  const latest = window[window.length - 1];
  const previous = window[window.length - 2];
  const prior = window.slice(-1 - V1.priorCandleCount, -1);
  if (prior.length !== V1.priorCandleCount) return { ok: false, reason: "coverage" };
  if (!(latest.close > latest.open) || !(previous.close > previous.open)) {
    return { ok: false, reason: "not_two_green" };
  }
  const priorHigh = Math.max(...prior.map((bar) => bar.high));
  if (!(latest.close > priorHigh)) return { ok: false, reason: "no_breakout" };
  const meanVolume = prior.reduce((sum, bar) => sum + bar.volumeUsd, 0) / prior.length;
  if (!(meanVolume > 0) || latest.volumeUsd < meanVolume * 2) return { ok: false, reason: "volume" };
  return {
    ok: true,
    reason: "momentum",
    triggerPrice: latest.close,
    candleEndMs: latest.endMs,
    volumeUsd: latest.volumeUsd,
  };
}
