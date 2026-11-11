// Read-only checks against the original graduation sniper and curve helpers.
// These describe the current source. They do not change it.

export function analyzeGraduationSource(src) {
  const findings = [];
  const add = (id, holds, detail) => findings.push({ id, holds: Boolean(holds), detail });

  const loadCalls = [...src.matchAll(/loadKeypair\s*\(/g)];
  add(
    "dry_run_requires_keypair",
    loadCalls.length === 1 && /^const wallet = loadKeypair\(\);/m.test(src),
    "The keypair loader runs at module scope, so --dry-run still requires a key file.",
  );

  const buy = src.slice(src.indexOf("async function buyToken"), src.indexOf("async function checkExit"));
  const dry = buy.indexOf("if (DRY_RUN)");
  const calc = buy.indexOf("calcBuyTokens");
  const entry = buy.indexOf("Number(virtualSolReserves) / Number(virtualTokenReserves)");
  add(
    "dry_run_entry_is_pretrade_spot",
    entry !== -1 && dry !== -1 && calc !== -1 && entry < dry && dry < calc && buy.slice(dry, calc).includes("return"),
    "The dry-run branch stores the pre-trade virtual-reserve ratio and returns before calcBuyTokens.",
  );

  const check = src.slice(src.indexOf("async function checkExit"), src.indexOf("async function sellPosition"));
  const missing = check.indexOf("if (!state)");
  const complete = check.indexOf("if (state.complete)");
  const sellCall = check.indexOf("sellPosition(");
  const priceLine = check.indexOf("const currentPrice");
  add(
    "graduation_sell_missing",
    missing !== -1 &&
      complete !== -1 &&
      sellCall !== -1 &&
      missing < complete &&
      complete < sellCall &&
      check.slice(missing, complete).includes("return") &&
      !check.slice(missing, complete).includes("positions.delete") &&
      !check.slice(complete, priceLine).includes("positions.delete") &&
      !check.slice(complete, priceLine).includes("sellPosition"),
    "checkExit returns when the bonding curve is missing or complete. It does not sell, book PnL, or delete the position.",
  );

  add(
    "open_graduated_positions_lock_slots",
    /if \(positions\.size >= MAX_POSITIONS\) return;/.test(src) &&
      complete !== -1 &&
      priceLine > complete &&
      !check.slice(complete, priceLine).includes("positions.delete"),
    "Buys stop once positions.size reaches the cap, and a graduated position stays in that map.",
  );

  const sell = src.slice(src.indexOf("async function sellPosition"), src.indexOf("async function monitorPositions"));
  const drySell = sell.indexOf("if (DRY_RUN)");
  const liveComplete = sell.indexOf("if (!state || state.complete)");
  const pnlHits = [];
  for (let from = 0; ; ) {
    const at = sell.indexOf("totalPnl +=", from);
    if (at === -1) break;
    pnlHits.push(at);
    from = at + 1;
  }
  const pnlAfterLiveGate = pnlHits.filter((at) => at > liveComplete);
  add(
    "dry_run_pnl_is_spot_multiple",
    /const pnlSol = BUY_SOL \* \(pnlMult - 1\);/.test(sell) &&
      /const pnlMult = currentPrice \/ pos\.entryPrice;/.test(check) &&
      /const currentPrice = getPrice\(state\);/.test(check),
    "Curve-exit dry-run PnL is buy size times the spot multiple. Fees, impact, and slippage are not applied.",
  );
  add(
    "live_complete_curve_deletes_without_pnl",
    drySell !== -1 &&
      liveComplete > drySell &&
      sell.slice(liveComplete, sell.indexOf("return;", liveComplete)).includes("positions.delete") &&
      pnlAfterLiveGate.length === 1 &&
      sell.indexOf("sellIx(") > liveComplete &&
      !sell.slice(liveComplete, pnlAfterLiveGate[0]).includes("totalPnl"),
    "If a live sell observes a complete or missing curve, it deletes the position and returns before PnL and before sellIx. No PumpSwap sell is built.",
  );

  return { findings, allHold: findings.every((finding) => finding.holds) };
}

export function analyzePumpfunFormula(src) {
  const findings = [];
  const add = (id, holds, detail) => findings.push({ id, holds: Boolean(holds), detail });
  add(
    "buy_fee_and_product",
    /const fee = solLamports \/ 100n;/.test(src) &&
      /const netSol = solLamports - fee;/.test(src) &&
      /state\.virtualTokenReserves \* netSol/.test(src),
    "calcBuyTokens subtracts amount/100 and then applies the constant-product quote.",
  );
  add(
    "sell_fee_and_product",
    /const sol =\s*\n?\s*\(state\.virtualSolReserves \* tokenAmount\)/.test(src) &&
      /const fee = sol \/ 100n;/.test(src) &&
      /return sol - fee;/.test(src),
    "calcSellSol applies the constant product and then subtracts amount/100.",
  );
  add(
    "price_is_reserve_ratio",
    /return Number\(state\.virtualSolReserves\) \/ Number\(state\.virtualTokenReserves\);/.test(src),
    "getPrice is the virtual-reserve spot ratio.",
  );
  return { findings, allHold: findings.every((finding) => finding.holds) };
}
