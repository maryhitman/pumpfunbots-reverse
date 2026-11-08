// Integer bonding-curve quotes.
// Arithmetic mirrors lib/pumpfun.mjs calcBuyTokens and calcSellSol:
//   fee = amount / 100n, then constant product.
// This module does not import the chain client or build instructions.

export function quoteBuy(virtualSolReserves, virtualTokenReserves, solLamports) {
  if (virtualSolReserves <= 0n || virtualTokenReserves <= 0n) {
    throw new Error("invalid reserves");
  }
  if (solLamports <= 0n) throw new Error("invalid spend");
  const feeLamports = solLamports / 100n;
  const netLamports = solLamports - feeLamports;
  const tokens =
    (virtualTokenReserves * netLamports) / (virtualSolReserves + netLamports);
  return {
    grossLamports: solLamports,
    feeLamports,
    netLamports,
    tokens,
  };
}

export function quoteSell(virtualSolReserves, virtualTokenReserves, tokenAmount) {
  if (virtualSolReserves <= 0n || virtualTokenReserves <= 0n) {
    throw new Error("invalid reserves");
  }
  if (tokenAmount <= 0n) {
    return { grossLamports: 0n, feeLamports: 0n, proceedsLamports: 0n };
  }
  const grossLamports =
    (virtualSolReserves * tokenAmount) / (virtualTokenReserves + tokenAmount);
  const feeLamports = grossLamports / 100n;
  return {
    grossLamports,
    feeLamports,
    proceedsLamports: grossLamports - feeLamports,
  };
}

// Original dry-run PnL is size * spotMultiple, with spot = virtualSol / virtualToken.
// Integer form of that ratio, truncating toward zero. No fee and no impact.
export function spotRatioProceedsLamports(spentLamports, entrySol, entryTok, exitSol, exitTok) {
  if (entrySol <= 0n || entryTok <= 0n || exitSol < 0n || exitTok <= 0n) {
    throw new Error("invalid reserves for spot ratio");
  }
  return (spentLamports * exitSol * entryTok) / (exitTok * entrySol);
}
