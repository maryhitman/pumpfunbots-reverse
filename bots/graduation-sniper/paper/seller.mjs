// Paper PumpSwap seller. Consumes relay handoffs. Never signs or broadcasts.

import { STRATEGY_DEFAULTS, lamportsToSolString } from "./defaults.mjs";

function asLamports(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)) return BigInt(value);
  throw new Error("invalid lamports");
}

function sol(lamports) {
  return lamportsToSolString(lamports);
}

export function createSeller({
  policy = "immediate",
  waitSec = 120,
  poolFindTimeoutSec = 180,
  takeProfit = STRATEGY_DEFAULTS.takeProfitMultiple,
  stopLoss = STRATEGY_DEFAULTS.stopLossMultiple,
  relay = null,
} = {}) {
  if (policy !== "immediate" && policy !== "wait") throw new Error("sell policy must be immediate or wait");
  const positions = new Map();
  const closed = [];
  const stats = { accepted: 0, sells: 0, stuck: 0, wins: 0, acks: 0 };

  function ack(signal, nowMs, status) {
    stats.acks += 1;
    relay?.ack(signal.id, { atMs: nowMs, status, mint: signal.mint });
  }

  function accept(signal, nowMs) {
    if (!signal?.mint || !signal.id) throw new Error("handoff id and mint are required");
    if (positions.has(signal.id) || closed.some((row) => row.id === signal.id)) {
      ack(signal, nowMs, "duplicate");
      return { accepted: false, reason: "duplicate", id: signal.id };
    }
    const spent = asLamports(signal.spentLamports);
    positions.set(signal.id, {
      ...signal,
      spentLamports: spent,
      paperTokens: asLamports(signal.paperTokens),
      acceptedAtMs: nowMs,
      handoffLatencyMs: nowMs - signal.graduatedAtMs,
      lastQuote: null,
      firstQuoteAtMs: null,
      status: "seeking_pool",
    });
    stats.accepted += 1;
    ack(signal, nowMs, "accepted");
    return { accepted: true, reason: "accepted", id: signal.id, handoffLatencyMs: nowMs - signal.graduatedAtMs };
  }

  function terminal(position, mark) {
    position.status = mark.trigger === "mark_to_zero" ? "stuck" : "closed";
    position.modelMark = mark;
    positions.delete(position.id);
    closed.push(position);
    const pnl = mark.pnlLamports;
    if (pnl > 0n) stats.wins += 1;
    if (mark.trigger === "mark_to_zero") stats.stuck += 1;
    else stats.sells += 1;
    relay?.logResult({
      id: position.id,
      mint: position.mint,
      trigger: mark.trigger,
      pnlLamports: pnl.toString(),
      atMs: mark.atMs,
    });
    return {
      reason: mark.trigger,
      modelMark: publicMark(mark),
      modelPnlBooked: true,
      stuck: mark.trigger === "mark_to_zero",
      onChainSell: false,
      successfulSell: false,
    };
  }

  function quoteMark(position, view, nowMs, trigger) {
    const proceeds = asLamports(view.userQuoteLamports);
    return terminal(position, {
      trigger,
      atMs: nowMs,
      proceedsLamports: proceeds,
      pnlLamports: proceeds - position.spentLamports,
      fees: {
        lpFeeLamports: view.lpFeeLamports?.toString?.() ?? null,
        protocolFeeLamports: view.protocolFeeLamports?.toString?.() ?? null,
        creatorFeeLamports: view.creatorFeeLamports?.toString?.() ?? null,
      },
      formula: view.formula ?? "pump-swap-sdk-2.2.0 sellBaseInput",
      poolFoundLatencyMs: position.firstQuoteAtMs - position.graduatedAtMs,
      handoffLatencyMs: position.handoffLatencyMs,
      slot: view.slot ?? null,
      priced: true,
      markToZero: false,
    });
  }

  function zeroMark(position, nowMs, why) {
    return terminal(position, {
      trigger: "mark_to_zero",
      atMs: nowMs,
      proceedsLamports: 0n,
      pnlLamports: -position.spentLamports,
      reason: why,
      poolFoundLatencyMs: null,
      handoffLatencyMs: position.handoffLatencyMs,
      priced: false,
      markToZero: true,
      formula: null,
    });
  }

  function poolUsable(position, view) {
    if (!view || view.validated !== true || view.status !== "executable" || view.userQuoteLamports == null) {
      return view?.status || "unread";
    }
    if (position.graduationSlot != null && Number.isInteger(view.slot) && view.slot < position.graduationSlot) {
      return "stale_or_lookahead";
    }
    return null;
  }

  function observePool(mint, view, nowMs) {
    const owned = [...positions.values()].filter((position) => position.mint === mint);
    if (owned.length === 0) return { reason: "no_position", mint };
    const results = [];
    for (const position of owned) {
      const ageSec = (nowMs - position.graduatedAtMs) / 1000;
      const blocked = poolUsable(position, view);
      if (blocked) {
        position.lastPoolStatus = blocked;
        if (ageSec >= poolFindTimeoutSec && position.firstQuoteAtMs == null) {
          results.push(zeroMark(position, nowMs, blocked));
        } else {
          results.push({ reason: "seeking_pool", poolStatus: blocked, modelMark: null, modelPnlBooked: false, onChainSell: false });
        }
        continue;
      }
      if (position.firstQuoteAtMs == null) position.firstQuoteAtMs = nowMs;
      position.lastQuote = view;
      const multiple = Number(asLamports(view.userQuoteLamports)) / Number(position.spentLamports);
      if (policy === "immediate") {
        results.push(quoteMark(position, view, nowMs, "pumpswap_immediate_exit"));
        continue;
      }
      if (multiple >= takeProfit) {
        results.push(quoteMark(position, view, nowMs, "pumpswap_take_profit"));
        continue;
      }
      if (multiple <= stopLoss) {
        results.push(quoteMark(position, view, nowMs, "pumpswap_stop_loss"));
        continue;
      }
      if ((nowMs - position.firstQuoteAtMs) / 1000 >= waitSec) {
        results.push(quoteMark(position, view, nowMs, "pumpswap_wait_timeout"));
        continue;
      }
      results.push({ reason: "waiting_tp_sl", multiple, modelMark: null, modelPnlBooked: false, onChainSell: false });
    }
    return results.length === 1 ? results[0] : { reason: "batch", results };
  }

  function settle(nowMs) {
    const left = [...positions.values()];
    const results = [];
    for (const position of left) {
      if (position.lastQuote && policy === "wait") {
        results.push(quoteMark(position, position.lastQuote, nowMs, "pumpswap_wait_timeout"));
      } else if (position.lastQuote && policy === "immediate") {
        results.push(quoteMark(position, position.lastQuote, nowMs, "pumpswap_immediate_exit"));
      } else {
        results.push(zeroMark(position, nowMs, "session_ended_without_executable_pool"));
      }
    }
    return results;
  }

  function snapshot() {
    const pnl = closed.reduce((sum, position) => sum + position.modelMark.pnlLamports, 0n);
    const terminal = closed.length;
    return {
      policy,
      waitSec: policy === "wait" ? waitSec : null,
      poolFindTimeoutSec,
      stats: { ...stats },
      open: [...positions.values()].map(publicPosition),
      closed: closed.map(publicPosition),
      feeAdjustedPnl: { lamports: pnl.toString(), sol: sol(pnl) },
      winRate: terminal === 0 ? null : stats.wins / terminal,
      terminal,
    };
  }

  return { accept, observePool, settle, snapshot, policy };
}

function publicMark(mark) {
  return {
    ...mark,
    proceedsLamports: mark.proceedsLamports.toString(),
    pnlLamports: mark.pnlLamports.toString(),
    pnlSol: sol(mark.pnlLamports),
    onChainSell: false,
  };
}

function publicPosition(position) {
  return {
    id: position.id,
    mint: position.mint,
    status: position.status,
    spentLamports: position.spentLamports.toString(),
    paperTokens: position.paperTokens.toString(),
    handoffLatencyMs: position.handoffLatencyMs,
    modelMark: position.modelMark ? publicMark(position.modelMark) : null,
  };
}
