// Frozen v1. These numbers are our rules, not claims from the video.

export const STRATEGY_ID = "video-filter-adapted-v1";

export const LAMPORTS_PER_SOL = 1_000_000_000n;
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

export const V1 = Object.freeze({
  id: STRATEGY_ID,
  startingSol: 3,
  nominalEntrySol: 0.2,
  pauseEquitySol: 2.1,
  finalStretchFillMinPct: 90,
  finalStretchFillExclusiveMaxPct: 100,
  marketCapUsdMin: 10_000,
  cumulativeFeesSolMin: 0.1,
  migratedVolumeUsdMin: 30_000,
  migratedVolumeWindow: "rolling_1h",
  migratedVolumeWindowIsVideoSpecified: false,
  poolLiquidityUsdMin: 40_000,
  minClosedCandles: 7,
  priorCandleCount: 5,
  candleMs: 60_000,
  maxEntryPremium: 0.05,
  stopBelowCost: 0.15,
  takeProfitAboveCost: 0.30,
  takeProfitFraction: 0.5,
  trailFromHigh: 0.10,
  maxHoldMs: 6 * 60 * 60 * 1000,
  staleHoldMs: 5 * 60 * 60 * 1000,
  staleAbsMove: 0.10,
  quoteVaultRatioMin: 0.5,
  quoteVaultRatioMax: 2,
  maxQuoteSlotLag: 150,
  maxPriceImpactFraction: 0.2,
  curveFeeDenominator: 100n,
});

export function nominalEntryLamports() {
  return 200_000_000n;
}

// Smallest gross debit whose truncating 1% fee still leaves the 0.2 SOL nominal.
export function grossDebitForNominal(nominal = nominalEntryLamports()) {
  let gross = (nominal * 100n + 98n) / 99n;
  while (gross - gross / 100n < nominal) gross += 1n;
  return gross;
}
