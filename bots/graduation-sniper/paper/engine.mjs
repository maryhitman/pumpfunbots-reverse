import { quoteBuy, quoteSell, spotRatioProceedsLamports } from "./curve.mjs";
import {
  ASSUMPTION_LINES,
  LIMITATION_LINES,
  PAPER_ASSUMPTIONS,
  STRATEGY_DEFAULTS,
  lamportsToSolString,
  solToLamports,
} from "./defaults.mjs";

const DECISION_CAP = 200;

function asLamports(value, label) {
  if (typeof value === "bigint") {
    if (value < 0n) throw new Error(`invalid ${label}`);
    return value;
  }
  if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw new Error(`invalid ${label}`);
}

function fillPct(virtualSolReserves, graduationLamports) {
  return (Number(virtualSolReserves) / Number(graduationLamports)) * 100;
}

function requireConfig(options) {
  const cfg = {
    ...STRATEGY_DEFAULTS,
    startingVirtualSol: PAPER_ASSUMPTIONS.startingVirtualSol,
    ...options,
  };
  if (!Number.isFinite(cfg.buySol) || cfg.buySol <= 0) throw new Error("buySol must be positive");
  if (!Number.isFinite(cfg.startingVirtualSol) || cfg.startingVirtualSol < 0) {
    throw new Error("startingVirtualSol must be non-negative");
  }
  if (!Number.isFinite(cfg.minFillPct) || cfg.minFillPct <= 0 || cfg.minFillPct >= 100) {
    throw new Error("minFillPct must be between 0 and 100");
  }
  if (!Number.isFinite(cfg.takeProfitMultiple) || !Number.isFinite(cfg.stopLossMultiple)) {
    throw new Error("exit multiples must be finite");
  }
  if (cfg.stopLossMultiple <= 0 || cfg.takeProfitMultiple <= cfg.stopLossMultiple) {
    throw new Error("take-profit must be above stop-loss and stop-loss must be positive");
  }
  if (!Number.isInteger(cfg.maxPositions) || cfg.maxPositions < 1) throw new Error("maxPositions must be >= 1");
  if (!Number.isFinite(cfg.cooldownSec) || cfg.cooldownSec < 0) throw new Error("cooldownSec must be >= 0");
  if (!Number.isFinite(cfg.timeoutSec) || cfg.timeoutSec < 0) throw new Error("timeoutSec must be >= 0");
  if (typeof cfg.virtualSolAtGraduationLamports !== "bigint" || cfg.virtualSolAtGraduationLamports <= 0n) {
    throw new Error("virtualSolAtGraduationLamports must be a positive bigint");
  }
  return cfg;
}

function solFields(lamports) {
  return {
    lamports: lamports.toString(),
    sol: lamportsToSolString(lamports),
  };
}

export function createPaperSession(options = {}) {
  const cfg = requireConfig(options);
  const buyLamports = solToLamports(cfg.buySol);
  const startingLamports = solToLamports(cfg.startingVirtualSol);
  const active = new Map();
  const closed = [];
  const watchlist = new Map();
  const decisions = [];
  const state = {
    lastBuyAtMs: null,
    cashFaithful: startingLamports,
    cashImproved: startingLamports,
    faithfulModelPnl: 0n,
    improvedModelPnl: 0n,
  };
  const stats = {
    tradeEvents: 0,
    outsideBand: 0,
    inBand: 0,
    opened: 0,
    blockedByCash: 0,
    unpriceable: 0,
    curveMarks: 0,
    decisions: 0,
  };

  function remember(entry) {
    stats.decisions += 1;
    decisions.push(entry);
    if (decisions.length > DECISION_CAP) decisions.shift();
  }

  function reject(reason, extra) {
    const entry = { accepted: false, reason, ...extra };
    remember(entry);
    return entry;
  }

  function trySignal(signal, nowMs) {
    if (!signal || typeof signal.mint !== "string" || signal.mint.length === 0) {
      throw new Error("signal mint is required");
    }
    if (!Number.isFinite(nowMs)) throw new Error("nowMs is required");
    const vSol = asLamports(signal.virtualSolReserves, "virtualSolReserves");
    const vTok = asLamports(signal.virtualTokenReserves, "virtualTokenReserves");
    stats.tradeEvents += 1;
    const fill = fillPct(vSol, cfg.virtualSolAtGraduationLamports);
    if (!(fill >= cfg.minFillPct && fill < 100)) {
      stats.outsideBand += 1;
      return reject(fill >= 100 ? "fill_at_or_above_100" : "below_fill", {
        mint: signal.mint,
        fillPct: fill,
        originalWouldOpen: false,
      });
    }
    stats.inBand += 1;
    const prev = watchlist.get(signal.mint);
    if (!prev || fill > prev.fillPct) watchlist.set(signal.mint, { fillPct: fill, atMs: nowMs });
    return openPosition({ mint: signal.mint, vSol, vTok, fill, nowMs });
  }

  function openPosition({ mint, vSol, vTok, fill, nowMs }) {
    if (active.size >= cfg.maxPositions) {
      return reject("max_positions", { mint, fillPct: fill, originalWouldOpen: false, slotLocked: true });
    }
    if (active.has(mint)) {
      return reject("duplicate_mint", { mint, fillPct: fill, originalWouldOpen: false });
    }
    if (state.lastBuyAtMs !== null && nowMs - state.lastBuyAtMs < cfg.cooldownSec * 1000) {
      return reject("cooldown", {
        mint,
        fillPct: fill,
        originalWouldOpen: false,
        cooldownRemainingMs: cfg.cooldownSec * 1000 - (nowMs - state.lastBuyAtMs),
      });
    }
    if (vSol <= 0n || vTok <= 0n) {
      return reject("invalid_reserves", { mint, fillPct: fill, originalWouldOpen: false });
    }
    if (state.cashFaithful < buyLamports || state.cashImproved < buyLamports) {
      stats.blockedByCash += 1;
      return reject("insufficient_virtual_cash", {
        mint,
        fillPct: fill,
        originalWouldOpen: true,
        note: "Original dry-run does not check cash and would still track a position. This paper ledger refuses.",
      });
    }

    const improvedEntry = quoteBuy(vSol, vTok, buyLamports);
    state.cashFaithful -= buyLamports;
    state.cashImproved -= buyLamports;
    state.lastBuyAtMs = nowMs;
    const position = {
      mint,
      status: "open",
      unpriceableReason: null,
      openedAtMs: nowMs,
      fillAtEntry: fill,
      entryVirtualSolReserves: vSol,
      entryVirtualTokenReserves: vTok,
      spotEntry: Number(vSol) / Number(vTok),
      spentLamports: buyLamports,
      improvedEntry,
      slotLocked: true,
      counterfactual: true,
      onChainFill: false,
      modelMark: null,
    };
    active.set(mint, position);
    stats.opened += 1;
    const entry = {
      accepted: true,
      reason: "opened",
      mint,
      fillPct: fill,
      originalWouldOpen: true,
      counterfactual: true,
      onChainFill: false,
    };
    remember(entry);
    return entry;
  }

  function markUnpriceable(position, reason) {
    if (position.status !== "unpriceable") {
      position.status = "unpriceable";
      position.unpriceableReason = reason;
      position.slotLocked = true;
      position.modelMark = null;
      stats.unpriceable += 1;
    }
    return {
      observed: true,
      mint: position.mint,
      reason: "unpriceable",
      unpriceableReason: position.unpriceableReason,
      modelMark: null,
      modelPnlBooked: false,
      onChainSell: false,
      successfulSell: false,
      slotLocked: true,
    };
  }

  function applyCurveMark(position, { vSol, vTok, multiple, trigger, nowMs, elapsedSec }) {
    const faithfulProceeds = spotRatioProceedsLamports(
      position.spentLamports,
      position.entryVirtualSolReserves,
      position.entryVirtualTokenReserves,
      vSol,
      vTok,
    );
    const improved = quoteSell(vSol, vTok, position.improvedEntry.tokens);
    const mark = {
      kind: "simulated_curve_mark",
      counterfactual: true,
      onChainSell: false,
      successfulSell: false,
      trigger,
      atMs: nowMs,
      elapsedSec,
      spotMultiple: multiple,
      faithful: {
        ...solFields(faithfulProceeds),
        pnl: solFields(faithfulProceeds - position.spentLamports),
        model: "original_dry_run_spot_ratio_no_fee_no_impact",
        optimistic: true,
      },
      improved: {
        ...solFields(improved.proceedsLamports),
        pnl: solFields(improved.proceedsLamports - position.spentLamports),
        fee: solFields(improved.feeLamports),
        model: "repo_calcSellSol_1pct_constant_product",
        optimistic: false,
      },
    };
    position.status = "closed";
    position.slotLocked = false;
    position.modelMark = mark;
    position.closedAtMs = nowMs;
    state.cashFaithful += faithfulProceeds;
    state.cashImproved += improved.proceedsLamports;
    state.faithfulModelPnl += faithfulProceeds - position.spentLamports;
    state.improvedModelPnl += improved.proceedsLamports - position.spentLamports;
    active.delete(position.mint);
    closed.push(position);
    stats.curveMarks += 1;
    return {
      observed: true,
      mint: position.mint,
      reason: trigger,
      modelMark: mark,
      onChainSell: false,
      successfulSell: false,
      slotLocked: false,
    };
  }

  function observe(mint, curveState, nowMs) {
    if (typeof mint !== "string" || mint.length === 0) throw new Error("mint is required");
    if (!Number.isFinite(nowMs)) throw new Error("nowMs is required");
    const position = active.get(mint);
    if (!position) return { observed: false, mint, reason: "no_position" };
    if (position.status === "unpriceable") {
      return {
        observed: true,
        mint,
        reason: "already_unpriceable",
        unpriceableReason: position.unpriceableReason,
        modelMark: null,
        modelPnlBooked: false,
        onChainSell: false,
        successfulSell: false,
        slotLocked: true,
      };
    }
    if (curveState == null) return markUnpriceable(position, "curve_missing");
    if (curveState.unreadable) return markUnpriceable(position, "curve_unreadable");
    if (curveState.complete === true) return markUnpriceable(position, "graduated");
    if (curveState.complete !== false) throw new Error("curve state complete must be boolean");
    const vSol = asLamports(curveState.virtualSolReserves, "virtualSolReserves");
    const vTok = asLamports(curveState.virtualTokenReserves, "virtualTokenReserves");
    if (vSol <= 0n || vTok <= 0n) return markUnpriceable(position, "invalid_reserves");

    const multiple = (Number(vSol) / Number(vTok)) / position.spotEntry;
    const elapsedSec = (nowMs - position.openedAtMs) / 1000;
    position.lastSpotMultiple = multiple;
    position.lastObservedAtMs = nowMs;
    let trigger = null;
    if (multiple >= cfg.takeProfitMultiple) trigger = "take_profit";
    else if (multiple <= cfg.stopLossMultiple) trigger = "stop_loss";
    else if (elapsedSec >= cfg.timeoutSec) trigger = "timeout";
    if (!trigger) {
      return { observed: true, mint, reason: "hold", spotMultiple: multiple, elapsedSec, onChainSell: false };
    }
    return applyCurveMark(position, { vSol, vTok, multiple, trigger, nowMs, elapsedSec });
  }

  function reservedLamports() {
    let sum = 0n;
    for (const position of active.values()) sum += position.spentLamports;
    return sum;
  }

  function serializePosition(position) {
    return {
      mint: position.mint,
      status: position.status,
      unpriceableReason: position.unpriceableReason,
      slotLocked: position.slotLocked,
      counterfactual: true,
      onChainFill: false,
      openedAtMs: position.openedAtMs,
      closedAtMs: position.closedAtMs ?? null,
      fillAtEntry: position.fillAtEntry,
      spent: solFields(position.spentLamports),
      simulatedTokens: position.improvedEntry.tokens.toString(),
      entryFee: solFields(position.improvedEntry.feeLamports),
      modelMark: position.modelMark,
      lastSpotMultiple: position.lastSpotMultiple ?? null,
    };
  }

  function snapshot() {
    const openUnpriceable = [...active.values()].filter((p) => p.status === "unpriceable").length;
    const stillOpen = [...active.values()].filter((p) => p.status === "open").length;
    return {
      balanceKind: PAPER_ASSUMPTIONS.balanceKind,
      startingBalance: {
        kind: PAPER_ASSUMPTIONS.balanceKind,
        ...solFields(startingLamports),
        label: "Virtual paper balance. Not a wallet, not funded, not on-chain, and not withdrawable.",
      },
      strategy: {
        buySol: cfg.buySol,
        minFillPct: cfg.minFillPct,
        virtualSolAtGraduationLamports: cfg.virtualSolAtGraduationLamports.toString(),
        takeProfitMultiple: cfg.takeProfitMultiple,
        stopLossMultiple: cfg.stopLossMultiple,
        timeoutSec: cfg.timeoutSec,
        maxPositions: cfg.maxPositions,
        cooldownSec: cfg.cooldownSec,
        pollMs: cfg.pollMs,
      },
      ordersPlaced: 0,
      transactionsSigned: 0,
      transactionsBroadcast: 0,
      successfulOnChainSells: 0,
      onChainRealizedSol: null,
      performanceIncomplete: openUnpriceable > 0 || stillOpen > 0,
      doNotReadModelMarksAsRealizedProfit: true,
      ledgers: {
        faithful: {
          model: "original_dry_run_spot_ratio_no_fee_no_impact",
          optimistic: true,
          cash: solFields(state.cashFaithful),
          modelMarkPnl: solFields(state.faithfulModelPnl),
          reservedOpen: solFields(reservedLamports()),
        },
        improved: {
          model: "repo_calcBuyTokens_calcSellSol_1pct",
          optimistic: false,
          cash: solFields(state.cashImproved),
          modelMarkPnl: solFields(state.improvedModelPnl),
          reservedOpen: solFields(reservedLamports()),
        },
      },
      stats: { ...stats },
      active: [...active.values()].map(serializePosition),
      closed: closed.map(serializePosition),
      recentDecisions: decisions,
      assumptions: ASSUMPTION_LINES,
      limitations: LIMITATION_LINES,
    };
  }

  return {
    config: cfg,
    buyLamports,
    startingLamports,
    trySignal,
    observe,
    snapshot,
    activeOpenMints() {
      return [...active.values()].filter((p) => p.status === "open").map((p) => p.mint);
    },
  };
}

export function assertLedgerConserved(snapshot) {
  const start = BigInt(snapshot.startingBalance.lamports);
  for (const name of ["faithful", "improved"]) {
    const cash = BigInt(snapshot.ledgers[name].cash.lamports);
    const reserved = [...snapshot.active].reduce((sum, p) => sum + BigInt(p.spent.lamports), 0n);
    const paidOut = snapshot.closed.reduce((sum, p) => {
      const proceeds = name === "faithful" ? p.modelMark.faithful.lamports : p.modelMark.improved.lamports;
      return sum + BigInt(proceeds);
    }, 0n);
    const spentClosed = snapshot.closed.reduce((sum, p) => sum + BigInt(p.spent.lamports), 0n);
    if (cash + reserved !== start - spentClosed + paidOut) {
      throw new Error(`${name} ledger does not balance`);
    }
    if (cash + reserved > start + paidOut) {
      throw new Error(`${name} cash exceeded funding`);
    }
  }
  if (snapshot.successfulOnChainSells !== 0 || snapshot.onChainRealizedSol !== null) {
    throw new Error("on-chain results must stay empty");
  }
  if (snapshot.ordersPlaced !== 0 || snapshot.transactionsSigned !== 0 || snapshot.transactionsBroadcast !== 0) {
    throw new Error("paper session recorded an order");
  }
}
