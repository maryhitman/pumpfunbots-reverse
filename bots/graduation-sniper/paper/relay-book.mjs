// One virtual 10 SOL book: curve buyer plus PumpSwap seller joined by the local relay.

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
        buyer: buyerSnap,
        seller: sellerSnap,
      };
    },
  };
}
