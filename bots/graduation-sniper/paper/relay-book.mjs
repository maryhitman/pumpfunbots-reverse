// One virtual 10 SOL book: curve buyer plus PumpSwap seller joined by the local relay.

import { startJupiterChase } from "./jupiter-quote.mjs";
import { createPaperSession } from "./engine.mjs";
import { createRelay } from "./relay.mjs";
import { createSeller } from "./seller.mjs";
import { PAPER_ASSUMPTIONS, lamportsToSolString } from "./defaults.mjs";

export function createRelayBook({
  policy,
  waitSec = 120,
  poolFindTimeoutSec = 180,
  jsonlPath,
  startingVirtualSol = PAPER_ASSUMPTIONS.startingVirtualSol,
} = {}) {
  const relay = createRelay({ jsonlPath });
  const seller = createSeller({ policy, waitSec, poolFindTimeoutSec, relay });
  const buyer = createPaperSession({
    strategy: "curve-handoff",
    startingVirtualSol,
    onHandoff(signal) {
      const record = relay.publish(signal);
      seller.accept(record, signal.graduatedAtMs);
      return record;
    },
  });
  return {
    policy,
    buyer,
    seller,
    relay,
    trySignal: (signal, nowMs) => buyer.trySignal(signal, nowMs),
    observe: (mint, state, nowMs) => buyer.observe(mint, state, nowMs),
    observePool: (mint, view, nowMs) => seller.observePool(mint, view, nowMs),
    applyJupiter: (mint, quote, nowMs) => seller.applyJupiter(mint, quote, nowMs),
    onGraduation(signal, log) {
      if (policy !== "jupiter-direct") return;
      log?.(`[PAPER] jupiter-direct signal mint=${signal.mint} graduationDetectedAtMs=${signal.graduatedAtMs} signalAtMs=${signal.graduatedAtMs} slot=${signal.graduationSlot ?? "none"}`);
      startJupiterChase({
        inputMint: signal.mint,
        amount: signal.paperTokens,
        timeoutMs: 60_000,
        onResult: (quote) => {
          const outcome = seller.offerJupiter(signal.mint, quote, Date.now());
          if (outcome.reason !== "awaiting_route") {
            const venues = (outcome.modelMark?.routeVenues ?? []).join(",") || "none";
            log?.(`[PAPER] jupiter-direct mint=${signal.mint} venue=${outcome.modelMark?.venue ?? "stuck"} reason=${outcome.reason} firstRouteDelayMs=${outcome.modelMark?.firstRouteDelayMs ?? "none"} quoteLatencyMs=${quote.latencyMs} routes=${venues} outAmount=${quote.outAmountLamports ?? "none"} impact=${quote.priceImpactPct ?? "none"}`);
          }
          return outcome.reason === "awaiting_route" ? undefined : { stop: true };
        },
      });
    },
    settle: (nowMs) => seller.settle(nowMs),
    report(label) {
      const buyerSnap = buyer.snapshot();
      const sellerSnap = seller.snapshot();
      const curvePnl = BigInt(buyerSnap.ledgers.improved.modelMarkPnl.lamports);
      const poolPnl = BigInt(sellerSnap.feeAdjustedPnl.lamports);
      const pnl = curvePnl + poolPnl;
      const curveWins = buyerSnap.closed.filter((position) => BigInt(position.modelMark.improved.pnl.lamports) > 0n).length;
      const wins = curveWins + sellerSnap.stats.wins;
      const terminal = buyerSnap.closed.length + sellerSnap.terminal;
      return {
        strategy: label,
        policy,
        waitSec: policy === "wait" ? waitSec : null,
        startingBalanceSol: buyerSnap.startingBalance.sol,
        opens: buyerSnap.stats.opened,
        curveCloses: buyerSnap.stats.curveMarks,
        graduationsCaptured: buyerSnap.stats.handoffs,
        handoffs: sellerSnap.stats.accepted,
        pumpswapSells: sellerSnap.stats.pumpswapSells,
        jupiterSells: sellerSnap.stats.jupiterSells,
        stuck: sellerSnap.stats.stuck,
        openOnCurve: buyerSnap.active.filter((position) => position.status === "open").length,
        seekingPool: sellerSnap.open.length,
        feeAdjustedPnlSol: lamportsToSolString(pnl),
        curveFeeAdjustedPnlSol: buyerSnap.ledgers.improved.modelMarkPnl.sol,
        poolFeeAdjustedPnlSol: sellerSnap.feeAdjustedPnl.sol,
        curveSpotPnlSol: buyerSnap.ledgers.faithful.modelMarkPnl.sol,
        winRate: terminal === 0 ? null : wins / terminal,
        terminal,
        onChainSells: 0,
        curveRows: buyerSnap.closed.map((position) => ({
          mint: position.mint,
          venue: "curve",
          trigger: position.modelMark?.trigger ?? null,
          pnlLamports: position.modelMark?.improved?.pnl?.lamports ?? "0",
        })),
        sells: sellerSnap.closed.map((row) => ({
          mint: row.mint,
          venue: row.modelMark?.venue ?? null,
          trigger: row.modelMark?.trigger ?? null,
          pnlLamports: row.modelMark?.pnlLamports ?? "0",
          graduationToSignalMs: row.handoffLatencyMs,
          graduationToFirstRouteMs: row.modelMark?.firstRouteDelayMs ?? row.modelMark?.poolFoundLatencyMs ?? null,
          quoteLatencyMs: row.modelMark?.quoteLatencyMs ?? null,
        })),
        buyer: buyerSnap,
        seller: sellerSnap,
      };
    },
  };
}
