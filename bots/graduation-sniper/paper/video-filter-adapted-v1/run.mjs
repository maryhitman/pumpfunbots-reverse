#!/usr/bin/env node
// Two-hour paper observation for video-filter-adapted-v1. Quote and account reads only.

import fs from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import { PUBLIC_ENDPOINTS } from "../guard.mjs";
import { READ_ONLY_HTTP_METHODS, READ_ONLY_WS_METHODS, bondingCurveAddress, decodeBondingCurveAccount } from "../public-read.mjs";
import { parsePumpLogValue } from "../parse-log.mjs";
import { canonicalPoolAddress } from "../pumpswap-quote.mjs";
import { assertQuoteRequest, JUPITER_QUOTE_ORIGIN, JUPITER_QUOTE_PATH } from "../jupiter-quote.mjs";
import { PUMP_PROGRAM } from "../../../../lib/constants.mjs";
import { createCandleBook, momentumSignal } from "./candles.mjs";
import { createVideoBook } from "./book.mjs";
import { RULE_MAP } from "./rules.mjs";
import { USDC_MINT, V1, WSOL_MINT } from "./config.mjs";

const HTTP_OK = new Set(READ_ONLY_HTTP_METHODS);
const WS_OK = new Set(READ_ONLY_WS_METHODS);
const MAX_RUN_SEC = 7200;

function kst(ms) {
  const shifted = new Date(ms + 9 * 60 * 60 * 1000);
  return shifted.toISOString().replace("Z", "+09:00");
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
    if (!response.ok || !Number.isFinite(out) || out <= 0) {
      log(`[V1] SOL/USD quote unavailable http=${response.status}`);
      return null;
    }
    log(`[V1] SOL/USD probe ${out / 1e6} latencyMs=${Date.now() - started} path=${JUPITER_QUOTE_PATH}`);
    return out / 1e6;
  } catch (err) {
    log(`[V1] SOL/USD probe failed ${err.message}`);
    return null;
  }
}

async function feeProbe(http, mint, log) {
  const curve = bondingCurveAddress(mint);
  const result = await rpc(http, "getAccountInfo", [curve, { encoding: "base64", commitment: "confirmed" }]);
  const decoded = decodeBondingCurveAccount(result?.value);
  const raw = result?.value?.data?.[0] ? Buffer.from(result.value.data[0], "base64") : null;
  const unswept = raw && raw.length >= 152 ? raw.readBigUInt64LE(144).toString() : null;
  return {
    curve,
    len: raw?.length ?? null,
    complete: decoded?.complete ?? null,
    fillPct: decoded && !decoded.unreadable && decoded.virtualSolReserves
      ? (Number(decoded.virtualSolReserves) / 85_000_000_000) * 100
      : null,
    unsweptLamportsAtOffset144: unswept,
    lifetimeGlobalFees: { available: false, reason: "no_lifetime_global_fee_account" },
  };
}

function parseArgs(argv) {
  let duration = 7200;
  let outDir = path.resolve("paper-runs/video-filter-adapted-v1");
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--duration-sec") duration = Number(argv[++i]);
    else if (argv[i] === "--out-dir") outDir = path.resolve(argv[++i]);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!Number.isInteger(duration) || duration < 1 || duration > MAX_RUN_SEC) {
    throw new Error(`--duration-sec must be 1 to ${MAX_RUN_SEC}`);
  }
  return { duration, outDir };
}

async function main() {
  const { duration, outDir } = parseArgs(process.argv);
  fs.mkdirSync(outDir, { recursive: true });
  const started = Date.now();
  const deadline = started + duration * 1000;
  const lines = [];
  const log = (line) => {
    lines.push(line);
    console.log(line);
  };
  log(`[V1] ${V1.id} paper-only. No wallet, no signature, no broadcast.`);
  log(`[V1] start KST ${kst(started)} durationSec=${duration}`);
  log("[V1] Momentum, liquidity, and the 1h volume window are our rules. Cumulative lifetime fees are unavailable, so the strict book cannot open.");
  fs.writeFileSync(path.join(outDir, "rules.json"), `${JSON.stringify(RULE_MAP, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, "config.json"), `${JSON.stringify(V1, null, 2)}\n`);

  const book = createVideoBook();
  const candles = createCandleBook();
  const stats = {
    notifications: 0,
    trades: 0,
    reconnects: 0,
    gaps: 0,
    mints: new Set(),
    finalStretch: 0,
    migrated: 0,
    momentumBlocked: 0,
    screened: 0,
    entries: 0,
    solUsd: null,
    feeProbes: [],
  };
  const lastCurveRead = new Map();
  const endpoint = PUBLIC_ENDPOINTS[0];
  stats.solUsd = await solUsd(log);

  async function consider(mint, fillPct, nowMs) {
    if (fillPct < 90 || fillPct >= 100) return;
    const prev = lastCurveRead.get(mint) ?? 0;
    if (nowMs - prev < 60_000) return;
    lastCurveRead.set(mint, nowMs);
    let probe;
    try {
      probe = await feeProbe(endpoint.http, mint, log);
    } catch (err) {
      stats.gaps += 1;
      log(`[V1] curve read failed mint=${mint} ${err.message}`);
      return;
    }
    if (stats.feeProbes.length < 20) stats.feeProbes.push({ mint, ...probe, atMs: nowMs });
    if (probe.complete == null) {
      stats.screened += 1;
      book.screen({ protocol: "pump", stage: "unknown", asOfMs: nowMs, observedAtMs: nowMs, fees: probe.lifetimeGlobalFees });
      log(`[V1] screen mint=${mint} stage=unread reason=curve_unreadable`);
      return;
    }
    const stage = probe.complete ? "migrated" : "final-stretch";
    if (stage === "final-stretch") stats.finalStretch += 1;
    else stats.migrated += 1;
    let poolConfirmed = false;
    let liquidityUsd = null;
    if (stage === "migrated") {
      try {
        const pool = canonicalPoolAddress(mint);
        const poolInfo = await rpc(endpoint.http, "getAccountInfo", [pool.address, { encoding: "base64", commitment: "confirmed" }]);
        poolConfirmed = Boolean(poolInfo?.value);
      } catch {
        poolConfirmed = false;
      }
    }
    stats.screened += 1;
    const decision = book.screen({
      protocol: "pump",
      stage,
      fillPct: probe.fillPct ?? fillPct,
      complete: probe.complete === true ? true : false,
      marketCapUsd: null,
      fees: probe.lifetimeGlobalFees,
      asOfMs: nowMs,
      observedAtMs: nowMs,
      poolConfirmed,
      volumeWindow: V1.migratedVolumeWindow,
      volumeUsd: null,
      liquidityUsd,
    });
    log(`[V1] screen mint=${mint} stage=${stage} fill=${Number(fillPct).toFixed(2)} reason=${decision.reason} entries=${stats.entries}`);
  }

  function onTrade(event, nowMs) {
    stats.trades += 1;
    stats.mints.add(event.mint);
    const fill = (Number(event.virtualSolReserves) / 85_000_000_000) * 100;
    if (stats.solUsd && event.tokenAmount > 0 && event.solAmount > 0) {
      candles.ingest({
        mint: event.mint,
        atMs: nowMs,
        price: event.solAmount / event.tokenAmount,
        volumeUsd: event.solAmount * stats.solUsd,
      });
      candles.roll(event.mint, nowMs);
      const signal = momentumSignal(candles.closed(event.mint));
      if (signal.ok) {
        stats.momentumBlocked += 1;
        log(`[V1] momentum blocked mint=${event.mint} reason=cumulative_fees_unavailable`);
      }
    }
    if (fill >= 90 && fill < 100) consider(event.mint, fill, nowMs).catch((err) => log(`[V1] consider ${err.message}`));
  }

  await new Promise((resolve) => {
    let ws;
    let finished = false;
    const finish = (why) => {
      if (finished) return;
      finished = true;
      try { ws?.close(); } catch { /* already closed */ }
      resolve(why);
    };
    const connect = () => {
      if (Date.now() >= deadline) return finish("complete");
      ws = new WebSocket(endpoint.ws);
      ws.addEventListener("open", () => {
        wsSend(ws, "logsSubscribe", [{ mentions: [PUMP_PROGRAM.toBase58()] }, { commitment: "confirmed" }], 1);
        log(`[V1] subscribed ${endpoint.name}`);
      });
      ws.addEventListener("message", (ev) => {
        stats.notifications += 1;
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.method !== "logsNotification") return;
        const event = parsePumpLogValue(msg.params?.result?.value);
        if (!event) return;
        onTrade(event, Date.now());
      });
      ws.addEventListener("close", () => {
        if (finished || Date.now() >= deadline) return finish("complete");
        stats.reconnects += 1;
        stats.gaps += 1;
        log("[V1] socket closed, reconnecting inside the two-hour bound");
        setTimeout(connect, 2000);
      });
      ws.addEventListener("error", () => {
        stats.gaps += 1;
      });
    };
    connect();
    setTimeout(() => finish("complete"), duration * 1000);
  });

  const ended = Date.now();
  const snap = book.snapshot();
  const report = {
    strategy: V1.id,
    paperOnly: true,
    onChainSells: 0,
    startedMs: started,
    endedMs: ended,
    startedKst: kst(started),
    endedKst: kst(ended),
    elapsedMs: ended - started,
    notifications: stats.notifications,
    trades: stats.trades,
    uniqueMints: stats.mints.size,
    reconnects: stats.reconnects,
    gaps: stats.gaps,
    solUsd: stats.solUsd,
    finalStretchObservations: stats.finalStretch,
    migratedObservations: stats.migrated,
    screened: stats.screened,
    momentumPatternsBlocked: stats.momentumBlocked,
    entries: stats.entries,
    skipReasons: snap.skips,
    realizedPnl: snap.realizedPnl,
    equity: snap.equity,
    maxDrawdown: snap.maxDrawdown,
    open: snap.open,
    quarantined: snap.quarantined,
    feeProbeNote: "Offset 144 on the bonding-curve account is an unswept bucket, not lifetime global fees. The strict book does not use it.",
    feeProbes: stats.feeProbes,
    rules: RULE_MAP,
    blockedReason: "cumulative lifetime fees are not a public per-mint account field",
    provesProfitability: false,
  };
  fs.writeFileSync(path.join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, "paper.log"), `${lines.join("\n")}\n`);
  log(`[V1] end KST ${kst(ended)} screened=${stats.screened} entries=${stats.entries} momentumBlocked=${stats.momentumBlocked}`);
  log(`[V1] report ${path.join(outDir, "report.json")}`);
}

main().catch((err) => {
  console.error(`[V1] FAILED ${err.message}`);
  process.exit(1);
});
