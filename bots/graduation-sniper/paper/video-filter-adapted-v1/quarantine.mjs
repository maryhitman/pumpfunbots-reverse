import { V1 } from "./config.mjs";

// A quote that disagrees with the vault, the token amount, or the slot is not booked.

function impactFraction(raw) {
  if (raw == null || raw === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return value > 1 ? value / 100 : value;
}

export function assessExecutableQuote({
  quote,
  vaultProceedsLamports,
  quotedInputRaw,
  positionRaw,
  observedSlot = null,
}) {
  if (!quote || quote.ok !== true || quote.outAmountLamports == null) {
    return { accept: false, quarantine: false, reason: "no_quote" };
  }
  if (String(quotedInputRaw) !== String(positionRaw)) {
    return { accept: false, quarantine: true, reason: "raw_amount_mismatch" };
  }
  let vault = null;
  try {
    vault = BigInt(vaultProceedsLamports);
  } catch {
    vault = null;
  }
  if (vault == null || vault <= 0n) {
    return { accept: false, quarantine: true, reason: "vault_depth_missing" };
  }
  const out = BigInt(quote.outAmountLamports);
  const ratio = Number(out) / Number(vault);
  if (!(ratio >= V1.quoteVaultRatioMin && ratio <= V1.quoteVaultRatioMax)) {
    return { accept: false, quarantine: true, reason: "quote_vault_disagreement", ratio };
  }
  const impact = impactFraction(quote.priceImpactPct);
  if (impact != null && impact > V1.maxPriceImpactFraction) {
    return { accept: false, quarantine: true, reason: "price_impact", impact };
  }
  if (observedSlot != null && quote.contextSlot != null && observedSlot - Number(quote.contextSlot) > V1.maxQuoteSlotLag) {
    return { accept: false, quarantine: false, reason: "stale_quote" };
  }
  return { accept: true, quarantine: false, reason: "accepted", proceedsLamports: out.toString() };
}
