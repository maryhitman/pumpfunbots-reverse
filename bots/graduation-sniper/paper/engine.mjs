import { quoteBuy, quoteSell, spotRatioProceedsLamports } from "./curve.mjs";
import {
  ASSUMPTION_LINES,
  LIMITATION_LINES,
  MODIFIED_EARLY_EXIT_FILL_PCT,
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

export function virtualSolFillPct(virtualSolReserves, graduationLamports = STRATEGY_DEFAULTS.virtualSolAtGraduationLamports) {
  return (Number(virtualSolReserves) / Number(graduationLamports)) * 100;
}

function requireConfig(options) {
  const cfg = {
    ...STRATEGY_DEFAULTS,
    strategy: "modified",
    earlyExitFillPct: MODIFIED_EARLY_EXIT_FILL_PCT,
    startingVirtualSol: PAPER_ASSUMPTIONS.startingVirtualSol,
    ...options,
  };
  const known = new Set(["original", "modified", "exit-at-97", "pumpswap-immediate"]);
  if (!known.has(cfg.strategy)) throw new Error("unknown paper strategy");
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
  cfg.exactOriginal = cfg.strategy === "original";
  cfg.blockEntryAtExit = cfg.strategy === "modified";
  cfg.preGraduationExit = cfg.strategy === "modified" || cfg.strategy === "exit-at-97";
  cfg.postGraduation = cfg.strategy === "pumpswap-immediate" ? "pending-pool" : "unpriceable";
  if (cfg.strategy === "original" || cfg.strategy === "pumpswap-immediate") {
    if (Object.prototype.hasOwnProperty.call(options, "earlyExitFillPct")) {
      throw new Error(`${cfg.strategy} does not take an early-exit threshold`);
    }
    cfg.earlyExitFillPct = null;
  } else if (!Number.isFinite(cfg.earlyExitFillPct) || cfg.earlyExitFillPct <= cfg.minFillPct || cfg.earlyExitFillPct >= 100) {
    throw new Error("earlyExitFillPct must be above the entry fill and below 100");
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
    earlyExits: 0,
    missedEarlyExits: 0,
    rejectedAtOrAboveExit: 0,
    pendingPool: 0,
    poolChecks: 0,
    poolBlocked: 0,
    pumpswapExits: 0,
    missedExits: 0,
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
    const fill = virtualSolFillPct(vSol, cfg.virtualSolAtGraduationLamports);
    if (!(fill >= cfg.minFillPct && fill < 100)) {
      stats.outsideBand += 1;
      return reject(fill >= 100 ? "fill_at_or_above_100" : "below_fill", {
        mint: signal.mint,
        fillPct: fill,
        originalWouldOpen: false,
      });
    }
    if (cfg.blockEntryAtExit && fill >= cfg.earlyExitFillPct) {
      stats.rejectedAtOrAboveExit += 1;
      return reject("at_or_above_exit_threshold", {
        mint: signal.mint,
        fillPct: fill,
        originalWouldOpen: false,
        originalFillRuleWouldAllow: true,
        note: "Modified paper rule refuses a new position at or above the early-exit fill. A trade log does not close an existing position.",
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

  function observedFill(curveState) {
    if (curveState == null || curveState.unreadable || curveState.virtualSolReserves == null) return null;
    try {
      return virtualSolFillPct(asLamports(curveState.virtualSolReserves, "virtualSolReserves"), cfg.virtualSolAtGraduationLamports);
    } catch {
      return null;
    }
  }

  function markPendingPool(position, reason, curveState) {
    position.status = "pending_pool";
    position.pendingReason = reason;
    position.graduationSlot = Number.isInteger(curveState?.slot) ? curveState.slot : null;
    position.timingUnverified = position.graduationSlot == null;
    position.slotLocked = true;
    position.modelMark = null;
    position.discardedObservation = {
      reason,
      observedFillPct: observedFill(curveState),
      priced: false,
      backfilledToThreshold: false,
    };
    stats.pendingPool += 1;
    return {
      observed: true,
      mint: position.mint,
      reason: "pending_pool",
      poolStatus: reason,
      modelMark: null,
      modelPnlBooked: false,
      onChainSell: false,
      successfulSell: false,
      slotLocked: true,
    };
  }

  function missPending(position, reason, nowMs) {
    position.status = "unpriceable";
    position.unpriceableReason = reason;
    position.missedExit = true;
    position.missedEarlyExit = false;
    position.slotLocked = true;
    position.modelMark = null;
    position.closedAtMs = nowMs;
    stats.unpriceable += 1;
    stats.missedExits += 1;
    return {
      observed: true,
      mint: position.mint,
      reason: "missed_exit",
      unpriceableReason: reason,
      missedExit: true,
      modelMark: null,
      modelPnlBooked: false,
      onChainSell: false,
      successfulSell: false,
      slotLocked: true,
    };
  }

  function markUnpriceable(position, reason, curveState) {
    if (position.status !== "unpriceable") {
      const missedEarlyExit = cfg.preGraduationExit;
      position.status = "unpriceable";
      position.unpriceableReason = reason;
      position.missedEarlyExit = missedEarlyExit;
      position.slotLocked = true;
      position.modelMark = null;
      position.discardedObservation = {
        reason,
        observedFillPct: observedFill(curveState),
        priced: false,
        backfilledToThreshold: false,
      };
      stats.unpriceable += 1;
      if (missedEarlyExit) stats.missedEarlyExits += 1;
    }
    return {
      observed: true,
      mint: position.mint,
      reason: "unpriceable",
      unpriceableReason: position.unpriceableReason,
      missedEarlyExit: position.missedEarlyExit === true,
      modelMark: null,
      modelPnlBooked: false,
      onChainSell: false,
      successfulSell: false,
      slotLocked: true,
    };
  }

  function applyCurveMark(position, { vSol, vTok, multiple, observedFillPct, trigger, nowMs, elapsedSec }) {
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
      observedFillPct,
      earlyExitFillPct: cfg.earlyExitFillPct,
      pricedAt: "observed_reserves",
      backfilledToThreshold: false,
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
    if (trigger === "early_exit") stats.earlyExits += 1;
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
        missedEarlyExit: position.missedEarlyExit === true,
        modelMark: null,
        modelPnlBooked: false,
        onChainSell: false,
        successfulSell: false,
        slotLocked: true,
      };
    }
    if (position.status === "pending_pool") {
      return { observed: true, mint, reason: "already_pending", poolStatus: position.pendingReason, modelMark: null, modelPnlBooked: false, onChainSell: false, slotLocked: true };
    }
    if (curveState == null || curveState.missing === true) {
      return cfg.postGraduation === "pending-pool"
        ? markPendingPool(position, "curve_missing", curveState)
        : markUnpriceable(position, "curve_missing", curveState);
    }
    if (curveState.unreadable) {
      if (cfg.postGraduation === "pending-pool") {
        return { observed: true, mint, reason: "curve_unreadable_open", modelMark: null, modelPnlBooked: false, onChainSell: false, slotLocked: true };
      }
      return markUnpriceable(position, "curve_unreadable", curveState);
    }
    if (curveState.complete === true) {
      return cfg.postGraduation === "pending-pool"
        ? markPendingPool(position, "graduated", curveState)
        : markUnpriceable(position, "graduated", curveState);
    }
    if (curveState.complete !== false) throw new Error("curve state complete must be boolean");
    const vSol = asLamports(curveState.virtualSolReserves, "virtualSolReserves");
    const vTok = asLamports(curveState.virtualTokenReserves, "virtualTokenReserves");
    if (vSol <= 0n || vTok <= 0n) return markUnpriceable(position, "invalid_reserves", curveState);

    const observedFillPct = virtualSolFillPct(vSol, cfg.virtualSolAtGraduationLamports);
    const multiple = (Number(vSol) / Number(vTok)) / position.spotEntry;
    const elapsedSec = (nowMs - position.openedAtMs) / 1000;
    position.lastSpotMultiple = multiple;
    position.lastObservedFillPct = observedFillPct;
    position.lastObservedAtMs = nowMs;
    let trigger = null;
    if (cfg.preGraduationExit && observedFillPct >= cfg.earlyExitFillPct && observedFillPct < 100) trigger = "early_exit";
    else if (multiple >= cfg.takeProfitMultiple) trigger = "take_profit";
    else if (multiple <= cfg.stopLossMultiple) trigger = "stop_loss";
    else if (elapsedSec >= cfg.timeoutSec) trigger = "timeout";
    if (!trigger) {
      return {
        observed: true,
        mint,
        reason: "hold",
        spotMultiple: multiple,
        observedFillPct,
        elapsedSec,
        onChainSell: false,
      };
    }
    return applyCurveMark(position, { vSol, vTok, multiple, observedFillPct, trigger, nowMs, elapsedSec });
  }

  function observePool(mint, view, nowMs) {
    if (!Number.isFinite(nowMs)) throw new Error("nowMs is required");
    const position = active.get(mint);
    if (!position) return { observed: false, mint, reason: "no_position" };
    if (position.status !== "pending_pool") return { observed: false, mint, reason: "not_pending", status: position.status };
    stats.poolChecks += 1;
    const elapsedSec = (nowMs - position.openedAtMs) / 1000;
    const blocked = blockPool(position, view);
    if (blocked) {
      stats.poolBlocked += 1;
      position.lastPoolStatus = blocked;
      if (elapsedSec >= cfg.timeoutSec) return missPending(position, "timeout_without_executable_pool", nowMs);
      return {
        observed: true,
        mint,
        reason: "pending_pool",
        poolStatus: blocked,
        modelMark: null,
        modelPnlBooked: false,
        onChainSell: false,
        slotLocked: true,
      };
    }
    const userQuote = asLamports(view.userQuoteLamports, "userQuoteLamports");
    const mark = {
      kind: "simulated_pumpswap_mark",
      counterfactual: true,
      onChainSell: false,
      successfulSell: false,
      trigger: "pumpswap_immediate_exit",
      rule: "immediate_post_graduation_pool_exit",
      atMs: nowMs,
      elapsedSec,
      slot: view.slot,
      pricedAt: "validated_pool_quote",
      backfilledToThreshold: false,
      spotFormulaUsed: false,
      formula: view.formula ?? "pump-swap-sdk-2.2.0 sellBaseInput",
      fees: {
        lpFeeLamports: view.lpFeeLamports?.toString?.() ?? String(view.lpFeeLamports ?? ""),
        protocolFeeLamports: view.protocolFeeLamports?.toString?.() ?? String(view.protocolFeeLamports ?? ""),
        creatorFeeLamports: view.creatorFeeLamports?.toString?.() ?? String(view.creatorFeeLamports ?? ""),
      },
      faithful: {
        ...solFields(userQuote),
        pnl: solFields(userQuote - position.spentLamports),
        model: "not_a_spot_fill_same_validated_pumpswap_quote",
        optimistic: false,
      },
      improved: {
        ...solFields(userQuote),
        pnl: solFields(userQuote - position.spentLamports),
        model: "pumpswap_sellBaseInput_documented_fees",
        optimistic: false,
      },
    };
    position.status = "closed";
    position.slotLocked = false;
    position.modelMark = mark;
    position.closedAtMs = nowMs;
    state.cashFaithful += userQuote;
    state.cashImproved += userQuote;
    state.faithfulModelPnl += userQuote - position.spentLamports;
    state.improvedModelPnl += userQuote - position.spentLamports;
    active.delete(position.mint);
    closed.push(position);
    stats.pumpswapExits += 1;
    stats.curveMarks += 1;
    return { observed: true, mint, reason: "pumpswap_immediate_exit", modelMark: mark, onChainSell: false, successfulSell: false, slotLocked: false };
  }

  function blockPool(position, view) {
    if (!view || view.validated !== true || view.status !== "executable") return view?.status || "unread";
    if (position.timingUnverified || position.graduationSlot == null) return "graduation_slot_unverified";
    if (!Number.isInteger(view.slot)) return "pool_slot_unverified";
    if (view.slot < position.graduationSlot) return "stale_or_lookahead";
    if (view.userQuoteLamports == null) return "quote_missing";
    return null;
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
      missedEarlyExit: position.missedEarlyExit === true,
      missedExit: position.missedExit === true,
      pendingReason: position.pendingReason ?? null,
      graduationSlot: position.graduationSlot ?? null,
      lastSpotMultiple: position.lastSpotMultiple ?? null,
      lastObservedFillPct: position.lastObservedFillPct ?? null,
      discardedObservation: position.discardedObservation ?? null,
    };
  }

  function snapshot() {
    const openUnpriceable = [...active.values()].filter((p) => p.status === "unpriceable").length;
    const stillOpen = [...active.values()].filter((p) => p.status === "open").length;
    const pending = [...active.values()].filter((p) => p.status === "pending_pool").length;
    return {
      balanceKind: PAPER_ASSUMPTIONS.balanceKind,
      startingBalance: {
        kind: PAPER_ASSUMPTIONS.balanceKind,
        ...solFields(startingLamports),
        label: "Virtual paper balance. Not a wallet, not funded, not on-chain, and not withdrawable.",
      },
      strategy: {
        name: cfg.strategy,
        label: cfg.strategy,
        exactOriginal: cfg.exactOriginal,
        earlyExitFillPct: cfg.earlyExitFillPct,
        preGraduationExit: cfg.preGraduationExit,
        postGraduation: cfg.postGraduation,
        entryFillPctMin: cfg.minFillPct,
        entryFillPctExclusiveMax: cfg.blockEntryAtExit ? cfg.earlyExitFillPct : 100,
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
      performanceIncomplete: openUnpriceable > 0 || stillOpen > 0 || pending > 0,
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
          model: cfg.postGraduation === "pending-pool"
          ? "curve_1pct_before_migration_and_pumpswap_sellBaseInput_after"
          : "repo_calcBuyTokens_calcSellSol_1pct",
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
    observePool,
    activeOpenMints() {
      return [...active.values()].filter((p) => p.status === "open").map((p) => p.mint);
    },
    pendingPoolMints() {
      return [...active.values()].filter((p) => p.status === "pending_pool").map((p) => p.mint);
    },
    simulatedTokens(mint) {
      const position = active.get(mint);
      return position ? position.improvedEntry.tokens : null;
    },
  };
}

export function createComparison(options = {}) {
  const { earlyExitFillPct, ...rest } = options;
  const pre = createPaperSession({
    ...rest,
    strategy: "exit-at-97",
    earlyExitFillPct: earlyExitFillPct ?? MODIFIED_EARLY_EXIT_FILL_PCT,
  });
  const post = createPaperSession({ ...rest, strategy: "pumpswap-immediate" });
  return {
    pre,
    post,
    trySignal(signal, nowMs) {
      return { pre: pre.trySignal(signal, nowMs), post: post.trySignal(signal, nowMs) };
    },
    observe(mint, curveState, nowMs) {
      return { pre: pre.observe(mint, curveState, nowMs), post: post.observe(mint, curveState, nowMs) };
    },
    observePool(mint, view, nowMs) {
      return post.observePool(mint, view, nowMs);
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
