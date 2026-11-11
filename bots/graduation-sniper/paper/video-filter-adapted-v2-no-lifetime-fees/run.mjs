#!/usr/bin/env node
// Bounded paper observation for v2. Lifetime fees are logged and do not veto.

import fs from "node:fs";
import path from "node:path";
import { PUBLIC_ENDPOINTS } from "../guard.mjs";
import { READ_ONLY_HTTP_METHODS, READ_ONLY_WS_METHODS, bondingCurveAddress, decodeBondingCurveAccount } from "../public-read.mjs";
import { parsePumpLogValue } from "../parse-log.mjs";
import { assertQuoteRequest, JUPITER_QUOTE_ORIGIN, JUPITER_QUOTE_PATH } from "../jupiter-quote.mjs";
import { PUMP_PROGRAM } from "../../../../lib/constants.mjs";
import { quoteBuy, quoteSell } from "../curve.mjs";
import { createCandleBook, momentumSignal } from "../video-filter-adapted-v1/candles.mjs";
import { createVideoBook } from "../video-filter-adapted-v1/book.mjs";
import { USDC_MINT, WSOL_MINT } from "../video-filter-adapted-v1/config.mjs";
import { V2 } from "./config.mjs";
import { RULE_MAP } from "./rules.mjs";

const HTTP_OK = new Set(READ_ONLY_HTTP_METHODS);
const WS_OK = new Set(READ_ONLY_WS_METHODS);
const MAX_RUN_SEC = 7200;
const HARD_DEADLINE_MS = Date.parse("2026-11-11T23:00:00Z");
const GRADUATION = 85_000_000_000n;

function kst(ms) {
  return new Date(ms + 9 * 60 * 60 * 1000).toISOString().replace("Z", "+09:00");
}

async function rpc(url, method, params) {
  if (!HTTP_OK.has(method)) throw new Error(`refusing RPC method ${method}`);
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await response.json();
  if (body.error) throw new Error(body.error.message || JSON.stringify(body.error));
  return body.result;
}

function wsSend(ws, method, params, id) {
  if (!WS_OK.has(method)) throw new Error(`refusing websocket method ${method}`);
  ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
}

async function solUsd(log) {
  const url = new URL(JUPITER_QUOTE_PATH, JUPITER_QUOTE_ORIGIN);
  url.searchParams.set("inputMint", WSOL_MINT);
  url.searchParams.set("outputMint", USDC_MINT);
  url.searchParams.set("amount", "1000000000");
  url.searchParams.set("slippageBps", "50");
  assertQuoteRequest(url, "GET");
  const started = Date.now();
  try {
    const response = await fetch(url, { method: "GET", signal: AbortSignal.timeout(8000) });
    const body = await response.json();
    const out = Number(body.outAmount);
    if (!response.ok || !Number.isFinite(out) || out <= 0) return null;
    log(`[V2] SOL/USD ${out / 1e6} latencyMs=${Date.now() - started}`);
    return { usd: out / 1e6, atMs: Date.now(), latencyMs: Date.now() - started };
  } catch (err) {
    log(`[V2] SOL/USD unavailable ${err.message}`);
    return null;
  }
}

function marketCapUsd(vSol, vTok, supply, usd) {
  if (!usd || vTok <= 0n || supply <= 0n) return null;
  const lamports = (vSol * supply) / vTok;
  return (Number(lamports) / 1e9) * usd;
}

function parseArgs(argv) {
  let duration = 7200;
  let outDir = path.resolve("paper-runs/video-filter-adapted-v2-no-lifetime-fees");
  let untilMs = null;
  let startingLamports = null;
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--duration-sec") duration = Number(argv[++i]);
    else if (argv[i] === "--out-dir") outDir = path.resolve(argv[++i]);
    else if (argv[i] === "--until-iso") untilMs = Date.parse(argv[++i]);
    else if (argv[i] === "--starting-cash-lamports") startingLamports = BigInt(argv[++i]);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (untilMs != null) {
    if (!Number.isFinite(untilMs)) throw new Error("--until-iso is not a time");
    if (untilMs > HARD_DEADLINE_MS) throw new Error("--until-iso is past 2026-11-12 08:00 KST");
    const remain = Math.floor((untilMs - Date.now()) / 1000);
    if (remain < 1) throw new Error("deadline is already past");
    duration = remain;
  } else if (!Number.isInteger(duration) || duration < 1 || duration > MAX_RUN_SEC) {
    throw new Error(`--duration-sec must be 1 to ${MAX_RUN_SEC}`);
  }
  return { duration, outDir, untilMs, startingLamports };
}

async function main() {
  const { duration, outDir, untilMs, startingLamports } = parseArgs(process.argv);
  const deadline = untilMs ?? (Date.now() + duration * 1000);
  fs.mkdirSync(outDir, { recursive: true });
  const started = Date.now();
  const lines = [];
  const log = (line) => {
    lines.push(line);
    console.log(line);
  };
  log(`[V2] ${V2.id} paper-only. Lifetime fees do not veto. This is not the video filter and not a rematch of v1.`);
  log(`[V2] start KST ${kst(started)} deadline KST ${kst(deadline)} carriedCashLamports=${startingLamports ?? 3_000_000_000n}`);
  log("[V2] Pause stays at 2.1 SOL against the original 3 SOL reference. Carried cash is not a new deposit.");
  fs.writeFileSync(path.join(outDir, "rules.json"), `${JSON.stringify(RULE_MAP, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, "config.json"), `${JSON.stringify(V2, (_, value) => (typeof value === "bigint" ? value.toString() : value), 2)}\n`);

  const book = createVideoBook({
    requireLifetimeFees: false,
    ...(startingLamports == null ? {} : { startingLamports }),
  });
  const candles = createCandleBook();
  const endpoint = PUBLIC_ENDPOINTS[0];
  let price = await solUsd(log);
  const gates = {
    trades: 0,
    mints: new Set(),
    stretchSeen: new Set(),
    curveConfirmed: new Set(),
    mcapPass: new Set(),
    momentumPass: new Set(),
    premiumPass: new Set(),
    entered: new Set(),
    evaluations: {},
  };
  const bump = (reason) => {
    gates.evaluations[reason] = (gates.evaluations[reason] ?? 0) + 1;
  };
  const curveCache = new Map();
  const armed = new Map();
  const lastTrade = new Map();
  const fills = [];
  const feed = { upMs: 0, downMs: 0, connectedAt: null, disconnectedAt: null, candleGaps: 0 };

  async function readCurve(mint, force = false) {
    const cached = curveCache.get(mint);
    const now = Date.now();
    if (!force && cached && now - cached.atMs < 30_000) return cached;
    const result = await rpc(endpoint.http, "getAccountInfo", [
      bondingCurveAddress(mint),
      { encoding: "base64", commitment: "confirmed" },
    ]);
    const decoded = decodeBondingCurveAccount(result?.value);
    if (!decoded || decoded.unreadable || decoded.complete == null) return null;
    const row = {
      atMs: now,
      complete: decoded.complete === true,
      vSol: decoded.virtualSolReserves,
      vTok: decoded.virtualTokenReserves,
      supply: decoded.tokenTotalSupply,
      fillPct: Number(decoded.virtualSolReserves) / Number(GRADUATION) * 100,
    };
    curveCache.set(mint, row);
    return row;
  }

  let acceptingEntries = true;
  function tryExecute(mint, nowMs) {
    if (!acceptingEntries || nowMs >= deadline) return;
    const signal = armed.get(mint);
    const trade = lastTrade.get(mint);
    const curve = curveCache.get(mint);
    if (!signal || !trade || !curve) return;
    if (trade.atMs < signal.candleEndMs || nowMs - curve.atMs > 60_000) return;
    if (!(curve.fillPct >= 90 && curve.fillPct < 100) || curve.complete !== false) {
      bump("curve_left_band");
      armed.delete(mint);
      return;
    }
    const mcap = marketCapUsd(curve.vSol, curve.vTok, curve.supply, price?.usd ?? null);
    if (mcap == null) {
      bump("market_cap_missing");
      return;
    }
    const screened = book.screen({
      protocol: "pump",
      stage: "final-stretch",
      fillPct: curve.fillPct,
      complete: false,
      marketCapUsd: mcap,
      asOfMs: nowMs,
      observedAtMs: Math.max(curve.atMs, trade.atMs),
      fees: { available: false, diagnostic: "lifetime fees not a public per-mint total" },
    });
    if (!screened.accepted) {
      bump(screened.reason);
      return;
    }
    const buy = quoteBuy(curve.vSol, curve.vTok, book.grossDebit);
    const ui = Number(buy.tokens) / 1e6;
    const executionPrice = ui > 0 ? (Number(book.grossDebit) / 1e9) / ui : Number.POSITIVE_INFINITY;
    const sell = quoteSell(curve.vSol, curve.vTok, buy.tokens);
    const opened = book.tryEnter({
      mint,
      signal,
      quote: {
        atMs: trade.atMs,
        price: executionPrice,
        decimals: 6,
        tokens: buy.tokens,
        executableValue: sell.proceedsLamports,
      },
      nowMs,
    });
    armed.delete(mint);
    bump(opened.reason);
    if (!opened.accepted) return;
    gates.premiumPass.add(mint);
    gates.entered.add(mint);
    fills.push({
      mint,
      atMs: nowMs,
      atKst: kst(nowMs),
      triggerPrice: signal.triggerPrice,
      executionPrice,
      tokens: buy.tokens.toString(),
      feeLamports: buy.feeLamports.toString(),
      debitLamports: opened.debitLamports,
      formula: "repo quoteBuy 1% then quoteSell",
      latencyMs: 0,
      curveFillPct: curve.fillPct,
      marketCapUsd: mcap,
    });
    log(`[V2] OPEN mint=${mint} fill=${curve.fillPct.toFixed(2)} mcapUsd=${mcap?.toFixed(0)} price=${executionPrice}`);
  }

  function onExitTrade(mint, vSol, vTok, nowMs) {
    const open = book.listOpen().find((row) => row.mint === mint);
    if (!open) return;
    const sell = quoteSell(vSol, vTok, BigInt(open.remaining));
    const result = book.exitOnQuote({
      mint,
      quote: { atMs: nowMs, proceedsForRemaining: sell.proceedsLamports },
      nowMs,
    });
    if (result.acted) log(`[V2] EXIT mint=${mint} reason=${result.reason} pnl=${result.pnl ?? "partial"}`);
  }

  function onTrade(event, nowMs) {
    gates.trades += 1;
    gates.mints.add(event.mint);
    const vSol = event.virtualSolReserves;
    const vTok = event.virtualTokenReserves;
    const fill = (Number(vSol) / Number(GRADUATION)) * 100;
    lastTrade.set(event.mint, { atMs: nowMs, vSol, vTok });
    if (price?.usd && event.tokenAmount > 0 && event.solAmount > 0) {
      const before = candles.closed(event.mint).length;
      const ingested = candles.ingest({
        mint: event.mint,
        atMs: nowMs,
        price: event.solAmount / event.tokenAmount,
        volumeUsd: event.solAmount * price.usd,
      });
      if (ingested.gap) feed.candleGaps += 1;
      candles.roll(event.mint, nowMs);
      if (candles.closed(event.mint).length > before) {
        const signal = momentumSignal(candles.closed(event.mint));
        if (signal.ok) {
          gates.momentumPass.add(event.mint);
          if (fill >= 90 && fill < 100) armed.set(event.mint, signal);
          else bump("momentum_outside_stage");
        } else bump(signal.reason);
      }
    } else bump("price_missing");
    if (fill >= 90 && fill < 100) gates.stretchSeen.add(event.mint);
    onExitTrade(event.mint, vSol, vTok, nowMs);
    tryExecute(event.mint, nowMs);
    if (fill >= 90 && fill < 100) {
      readCurve(event.mint).then((curve) => {
        if (!curve) {
          bump("curve_unreadable");
          return;
        }
        gates.curveConfirmed.add(event.mint);
        const mcap = marketCapUsd(curve.vSol, curve.vTok, curve.supply, price?.usd ?? null);
        if (mcap != null && mcap >= V2.marketCapUsdMin && curve.fillPct >= 90 && curve.fillPct < 100 && !curve.complete) {
          gates.mcapPass.add(event.mint);
        }
        const open = book.listOpen().find((row) => row.mint === event.mint);
        if (open && curve.complete) {
          const stuck = book.markStuck(event.mint, Date.now());
          log(`[V2] STUCK mint=${event.mint} reason=curve_complete_no_pool_quote pnl=${stuck.pnl}`);
        } else {
          tryExecute(event.mint, Date.now());
        }
      }).catch((err) => {
        bump("curve_read_failed");
        log(`[V2] curve read ${event.mint} ${err.message}`);
      });
    }
  }

  await new Promise((resolve) => {
    let ws;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      try { ws?.close(); } catch { /* already closed */ }
      resolve();
    };
    let reconnects = 0;
    const connect = () => {
      if (Date.now() >= deadline) return finish();
      ws = new WebSocket(endpoint.ws);
      ws.addEventListener("open", () => {
        const now = Date.now();
        if (feed.disconnectedAt != null) feed.downMs += now - feed.disconnectedAt;
        feed.disconnectedAt = null;
        feed.connectedAt = now;
        wsSend(ws, "logsSubscribe", [{ mentions: [PUMP_PROGRAM.toBase58()] }, { commitment: "confirmed" }], 1);
        log(`[V2] subscribed ${endpoint.name}`);
      });
      ws.addEventListener("message", (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.method !== "logsNotification") return;
        const event = parsePumpLogValue(msg.params?.result?.value);
        if (!event) return;
        onTrade(event, Date.now());
      });
      ws.addEventListener("close", () => {
        const now = Date.now();
        if (feed.connectedAt != null) {
          feed.upMs += now - feed.connectedAt;
          feed.connectedAt = null;
        }
        if (finished || now >= deadline) return finish();
        reconnects += 1;
        feed.disconnectedAt = now;
        gates.evaluations.reconnects = reconnects;
        log("[V2] socket closed, reconnecting before the KST deadline");
        setTimeout(connect, 2000);
      });
    };
    connect();
    const beat = setInterval(() => {
      if (Date.now() >= deadline) return;
      solUsd(log).then((next) => { if (next) price = next; }).catch(() => {});
      const snap = book.snapshot();
      log(`[V2] heartbeat stretch=${gates.stretchSeen.size} confirmed=${gates.curveConfirmed.size} mcap=${gates.mcapPass.size} momentum=${gates.momentumPass.size} entries=${gates.entered.size} open=${snap.open} cash=${snap.cash} pnl=${snap.realizedPnl}`);
      fs.writeFileSync(path.join(outDir, "checkpoint.json"), `${JSON.stringify({
        atKst: kst(Date.now()),
        deadlineKst: kst(deadline),
        stretch: gates.stretchSeen.size,
        mcap: gates.mcapPass.size,
        momentum: gates.momentumPass.size,
        entries: gates.entered.size,
        open: snap.open,
        cash: snap.cash,
        realizedPnl: snap.realizedPnl,
        reconnects,
        feedUpMs: feed.upMs + (feed.connectedAt ? Date.now() - feed.connectedAt : 0),
      }, null, 2)}\n`);
    }, 60_000);
    const stopAt = Math.max(0, deadline - Date.now());
    setTimeout(() => {
      acceptingEntries = false;
      clearInterval(beat);
      log("[V2] deadline reached. New entries stopped.");
      finish();
    }, stopAt);
  });

  if (feed.connectedAt != null) {
    feed.upMs += Date.now() - feed.connectedAt;
    feed.connectedAt = null;
  }
  const endMarks = [];
  for (const position of book.listOpen()) {
    try {
      const curve = await readCurve(position.mint, true);
      if (!curve || curve.complete || curve.vSol <= 0n || curve.vTok <= 0n) {
        endMarks.push({
          mint: position.mint,
          status: curve?.complete ? "stuck_curve_complete" : "unavailable",
          strategicExit: false,
          proceedsLamports: null,
        });
        continue;
      }
      const sell = quoteSell(curve.vSol, curve.vTok, BigInt(position.remaining));
      endMarks.push({
        mint: position.mint,
        status: "unrealized_executable",
        strategicExit: false,
        proceedsLamports: sell.proceedsLamports.toString(),
        feeLamports: sell.feeLamports.toString(),
        formula: "repo quoteSell 1%",
        atMs: Date.now(),
      });
    } catch (err) {
      endMarks.push({ mint: position.mint, status: "unavailable", strategicExit: false, error: err.message });
    }
  }
  const ended = Date.now();
  const snap = book.snapshot();
  const carried = startingLamports ?? 3_000_000_000n;
  const original = 3_000_000_000n;
  const parseSol = (text) => {
    const neg = text.startsWith("-");
    const [whole, frac = ""] = (neg ? text.slice(1) : text).split(".");
    const lamports = BigInt(`${whole}${frac.padEnd(9, "0").slice(0, 9)}`);
    return neg ? -lamports : lamports;
  };
  const realized = parseSol(snap.realizedPnl);
  const freeCash = parseSol(snap.cash);
  const unrealized = endMarks.reduce((sum, row) => sum + (row.proceedsLamports == null ? 0n : BigInt(row.proceedsLamports)), 0n);
  const openCost = book.listOpen().reduce((sum, row) => sum + BigInt(row.cost), 0n);
  const fmt = (lamports) => {
    const neg = lamports < 0n;
    const v = neg ? -lamports : lamports;
    return `${neg ? "-" : ""}${v / 1_000_000_000n}.${(v % 1_000_000_000n).toString().padStart(9, "0")}`;
  };
  const report = {
    strategy: V2.id,
    paperOnly: true,
    reproducesVideoFeeFilter: false,
    comparedWithV1: false,
    runLabel: untilMs ? "overnight-to-2026-11-12-0800-KST" : "corrected-rerun",
    invalid_for_strategy_evaluation: false,
    carriedCashLamports: carried.toString(),
    pauseEquitySol: V2.pauseEquitySol,
    pauseReference: "absolute 2.1 SOL from the original 3 SOL book, not recomputed from carried cash",
    incrementalRealizedVersusCarried: fmt(realized),
    cumulativeValidRealizedVersus3Sol: fmt((carried - original) + realized),
    unrealizedExecutable: fmt(unrealized),
    unrealizedVersusOpenCost: fmt(unrealized - openCost),
    conservativeEquity: fmt(freeCash + unrealized),
    endMarks,
    onChainSells: 0,
    startedMs: started,
    endedMs: ended,
    startedKst: kst(started),
    endedKst: kst(ended),
    elapsedMs: ended - started,
    solUsd: price,
    trades: gates.trades,
    uniqueMints: gates.mints.size,
    gates: {
      stretchMints: gates.stretchSeen.size,
      curveConfirmedMints: gates.curveConfirmed.size,
      marketCapPassMints: gates.mcapPass.size,
      momentumPassMints: gates.momentumPass.size,
      premiumPassMints: gates.premiumPass.size,
      enteredMints: gates.entered.size,
      evaluations: gates.evaluations,
    },
    reconnects: gates.evaluations.reconnects ?? 0,
    feed: {
      upMs: feed.upMs,
      downMs: feed.downMs,
      candleGaps: feed.candleGaps,
      uptimeNote: "Socket open time versus close gaps inside this process only. The unobserved interval before this process is not filled in.",
    },
    fills,
    exits: snap.trades,
    quarantined: snap.quarantinedRows,
    open: book.listOpen(),
    stuck: snap.trades.filter((row) => row.reason === "stuck"),
    cash: snap.cash,
    realizedPnl: snap.realizedPnl,
    equityCashOnly: snap.equity,
    maxDrawdown: snap.maxDrawdown,
    pause: snap.pause,
    provesProfitability: false,
    lifetimeFees: "logged as unavailable diagnostic; not a veto",
  };
  fs.writeFileSync(path.join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, "paper.log"), `${lines.join("\n")}\n`);
  log(`[V2] end KST ${kst(ended)} entries=${gates.entered.size} realized=${snap.realizedPnl}`);
  log(`[V2] report ${path.join(outDir, "report.json")}`);
}

main().catch((err) => {
  console.error(`[V2] FAILED ${err.message}`);
  process.exit(1);
});
