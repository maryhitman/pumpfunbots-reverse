import { PublicKey } from "@solana/web3.js";
import { PUMP_PROGRAM } from "../../../lib/constants.mjs";
import { parsePumpLogValue } from "./parse-log.mjs";
import {
  assessPoolAccounts,
  canonicalPoolAddress,
  decodePool,
  feeConfigAddress,
  globalConfigAddress,
} from "./pumpswap-quote.mjs";

export const READ_ONLY_HTTP_METHODS = Object.freeze(["getAccountInfo", "getSlot"]);
export const READ_ONLY_WS_METHODS = Object.freeze(["logsSubscribe", "logsUnsubscribe"]);

const HTTP_OK = new Set(READ_ONLY_HTTP_METHODS);
const WS_OK = new Set(READ_ONLY_WS_METHODS);

export function bondingCurveAddress(mint) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()],
    PUMP_PROGRAM,
  )[0].toBase58();
}

export function decodeBondingCurveAccount(accountValue) {
  if (accountValue == null) return null;
  const data = accountValue.data;
  if (!Array.isArray(data) || typeof data[0] !== "string") return { unreadable: true };
  const buf = Buffer.from(data[0], "base64");
  if (buf.length < 73) return { unreadable: true };
  return {
    unreadable: false,
    complete: buf[48] === 1,
    virtualTokenReserves: buf.readBigUInt64LE(8),
    virtualSolReserves: buf.readBigUInt64LE(16),
    realTokenReserves: buf.readBigUInt64LE(24),
    realSolReserves: buf.readBigUInt64LE(32),
    tokenTotalSupply: buf.readBigUInt64LE(40),
  };
}

async function rpc(url, method, params) {
  if (!HTTP_OK.has(method)) throw new Error(`refusing RPC method ${method}`);
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new Error(`${method} ${url} failed: ${err.message}`);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${method} ${url}: ${text.slice(0, 300)}`);
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`non-JSON ${method} ${url}: ${text.slice(0, 300)}`);
  }
  if (body.error) {
    const code = body.error.code ?? "";
    const message = body.error.message ?? JSON.stringify(body.error);
    throw new Error(`RPC ${method} ${url}: ${code} ${message}`);
  }
  return body.result;
}

function asText(data) {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  if (data && typeof data.text === "function") return data.text();
  return String(data);
}

function wsSend(ws, method, params, id) {
  if (!WS_OK.has(method)) throw new Error(`refusing websocket method ${method}`);
  ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
}

function attachParser(ws) {
  const waiters = new Map();
  const taps = [];
  ws.addEventListener("message", async (event) => {
    let msg;
    try {
      msg = JSON.parse(await asText(event.data));
    } catch {
      for (const tap of taps) tap(null);
      return;
    }
    if (msg && msg.id != null && waiters.has(msg.id)) {
      waiters.get(msg.id)(msg);
      waiters.delete(msg.id);
      return;
    }
    for (const tap of taps) tap(msg);
  });
  return {
    waitFor(id, timeoutMs) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(id);
          reject(new Error(`websocket response timeout for id ${id}`));
        }, timeoutMs);
        waiters.set(id, (msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
      });
    },
    tap(fn) {
      taps.push(fn);
    },
  };
}

function waitOpen(ws, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`websocket open timeout ${ws.url}`)), timeoutMs);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`websocket error before open ${ws.url}`));
    }, { once: true });
  });
}

async function accountAt(http, address) {
  const result = await rpc(http, "getAccountInfo", [address, { encoding: "base64", commitment: "confirmed" }]);
  const value = result?.value;
  const slot = result?.context?.slot ?? null;
  if (!value || !Array.isArray(value.data)) return { info: null, slot };
  return { info: { address, owner: value.owner, data: Buffer.from(value.data[0], "base64") }, slot };
}

const sharedFeeAccounts = { at: 0, global: null, fees: null, slot: null };

async function feeAccounts(http) {
  if (sharedFeeAccounts.global && Date.now() - sharedFeeAccounts.at < 30_000) return sharedFeeAccounts;
  const global = await accountAt(http, globalConfigAddress());
  const fees = await accountAt(http, feeConfigAddress());
  sharedFeeAccounts.at = Date.now();
  sharedFeeAccounts.global = global.info;
  sharedFeeAccounts.fees = fees.info;
  sharedFeeAccounts.slot = global.slot;
  return sharedFeeAccounts;
}

async function loadPoolView(http, mint, baseIn) {
  try {
    const derived = canonicalPoolAddress(mint);
    const poolRead = await accountAt(http, derived.address);
    if (!poolRead.info) return { status: "missing_pool", validated: false, slot: poolRead.slot };
    const decoded = decodePool(poolRead.info.data);
    if (!decoded) return { status: "layout_short", validated: false, slot: poolRead.slot };
    const [baseVault, quoteVault, baseMint] = await Promise.all([
      accountAt(http, decoded.poolBaseTokenAccount),
      accountAt(http, decoded.poolQuoteTokenAccount),
      accountAt(http, mint),
    ]);
    const fees = await feeAccounts(http);
    const slots = [poolRead.slot, baseVault.slot, quoteVault.slot, baseMint.slot, fees.slot];
    if (slots.some((slot) => !Number.isInteger(slot)) || slots.some((slot) => slot !== slots[0])) {
      return { status: "stale", validated: false, slot: poolRead.slot };
    }
    const assessed = assessPoolAccounts({
      mint,
      baseIn,
      poolAccount: poolRead.info,
      baseVault: baseVault.info,
      quoteVault: quoteVault.info,
      baseMintAccount: baseMint.info,
      globalConfigAccount: fees.global,
      feeConfigAccount: fees.fees,
    });
    return {
      status: assessed.status,
      validated: assessed.validated,
      slot: slots[0],
      userQuoteLamports: assessed.quote?.userQuoteLamports ?? null,
      lpFeeLamports: assessed.quote?.lpFee ?? null,
      protocolFeeLamports: assessed.quote?.protocolFee ?? null,
      creatorFeeLamports: assessed.quote?.creatorFee ?? null,
      formula: assessed.quote?.formula,
    };
  } catch (err) {
    const message = err.message || String(err);
    return { status: /429|rate|timeout/i.test(message) ? "rate_limited" : "unread", validated: false, error: message };
  }
}

function curveStateFromRpc(result) {
  const state = decodeBondingCurveAccount(result?.value);
  if (state == null) return { missing: true, slot: result?.context?.slot };
  state.slot = result?.context?.slot;
  return state;
}

async function pollSessions(http, sessions, pollErrors, log) {
  const open = [...new Set(sessions.flatMap((session) => session.activeOpenMints()))];
  for (const mint of open) {
    try {
      const result = await rpc(http, "getAccountInfo", [
        bondingCurveAddress(mint),
        { encoding: "base64", commitment: "confirmed" },
      ]);
      const state = curveStateFromRpc(result);
      const now = Date.now();
      for (const session of sessions) {
        const outcome = session.observe(mint, state, now);
        if (outcome.reason === "unpriceable" || outcome.reason === "pending_pool" || outcome.modelMark) {
          log(`[PAPER] ${session.config.strategy} curve mint=${mint} reason=${outcome.reason} missedEarlyExit=${outcome.missedEarlyExit === true} onChainSell=false`);
        }
      }
    } catch (err) {
      pollErrors.push({ mint, message: err.message });
    }
  }
  const pending = [...new Set(sessions.flatMap((session) => session.pendingPoolMints()))];
  for (const mint of pending) {
    for (const session of sessions) {
      const baseIn = session.simulatedTokens(mint);
      if (baseIn == null) continue;
      const view = await loadPoolView(http, mint, baseIn);
      const outcome = session.observePool(mint, view, Date.now());
      if (outcome.reason !== "not_pending" && outcome.reason !== "no_position") {
        log(`[PAPER] ${session.config.strategy} pool mint=${mint} reason=${outcome.reason} poolStatus=${outcome.poolStatus ?? "executable"} modelPnl=${outcome.modelMark ? outcome.modelMark.improved.pnl.sol : "none"}`);
      }
    }
  }
}

function runStream({ ws, parser, subId, http, sessions, log, durationSec, pollMs }) {
  const started = Date.now();
  const deadline = started + durationSec * 1000;
  const counters = { notifications: 0, tradeEvents: 0, parseErrors: 0, pollErrors: [] };
  let lastBeat = started;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearInterval(pollTimer);
      clearInterval(deadlineTimer);
      try {
        wsSend(ws, "logsUnsubscribe", [subId], 2);
      } catch {
        // The socket may already be closed. Unsubscribe is optional.
      }
      try {
        ws.close();
      } catch {
        // Already closed.
      }
      resolve({ counters, elapsedMs: Date.now() - started, ...extra });
    };

    const pollTimer = setInterval(() => {
      pollSessions(http, sessions, counters.pollErrors, log).catch((err) => {
        counters.pollErrors.push({ mint: null, message: err.message });
      });
      if (Date.now() - lastBeat >= 30_000) {
        lastBeat = Date.now();
        const parts = sessions.map((session) => {
          const snap = session.snapshot();
          return `${snap.strategy.name} open=${snap.active.filter((p) => p.status === "open").length} pending=${snap.stats.pendingPool} closed=${snap.stats.curveMarks} missed=${snap.stats.missedEarlyExits + snap.stats.missedExits} unpriceable=${snap.stats.unpriceable}`;
        });
        log(`[PAPER] heartbeat notifications=${counters.notifications} ${parts.join(" | ")}`);
      }
    }, pollMs);

    const deadlineTimer = setInterval(() => {
      if (Date.now() >= deadline) finish({ completed: true, disconnect: null });
    }, 250);

    parser.tap((msg) => {
      if (!msg || msg.method !== "logsNotification") return;
      counters.notifications += 1;
      try {
        const event = parsePumpLogValue(msg.params?.result?.value);
        if (!event) return;
        counters.tradeEvents += 1;
        for (const session of sessions) {
        const decision = session.trySignal(
          {
            mint: event.mint,
            virtualSolReserves: event.virtualSolReserves,
            virtualTokenReserves: event.virtualTokenReserves,
          },
          Date.now(),
        );
        if (decision.reason !== "below_fill" && decision.reason !== "fill_at_or_above_100") {
          log(
            `[PAPER] ${session.config.strategy} signal mint=${event.mint} fill=${Number(decision.fillPct).toFixed(2)} accepted=${decision.accepted} reason=${decision.reason}`,
          );
        }
        }
      } catch (err) {
        counters.parseErrors += 1;
        log(`[PAPER] parse error: ${err.message}`);
      }
    });

    ws.addEventListener("close", () => finish({ completed: false, disconnect: "websocket closed" }));
    ws.addEventListener("error", () => {
      counters.socketError = "websocket error";
    });
  });
}

async function streamEndpoint({ endpoint, sessions, log, durationSec, pollMs }) {
  if (typeof WebSocket !== "function") throw new Error("global WebSocket is unavailable");
  const slotResult = await rpc(endpoint.http, "getSlot", [{ commitment: "confirmed" }]);
  const slot = typeof slotResult === "number" ? slotResult : slotResult?.slot ?? slotResult;
  const ws = new WebSocket(endpoint.ws);
  const parser = attachParser(ws);
  try {
    await waitOpen(ws, 15000);
    const pending = parser.waitFor(1, 15000);
    wsSend(ws, "logsSubscribe", [
      { mentions: [PUMP_PROGRAM.toBase58()] },
      { commitment: "confirmed" },
    ], 1);
    const ack = await pending;
    if (ack.error) {
      const message = ack.error.message || JSON.stringify(ack.error);
      throw new Error(`logsSubscribe rejected by ${endpoint.ws}: ${ack.error.code ?? ""} ${message}`.trim());
    }
    if (typeof ack.result !== "number") {
      throw new Error(`logsSubscribe ack from ${endpoint.ws} had no subscription id`);
    }
    log(`[PAPER] subscribed ${endpoint.name} slot=${slot} subscription=${ack.result}`);
    const streamed = await runStream({
      ws,
      parser,
      subId: ack.result,
      http: endpoint.http,
      sessions,
      log,
      durationSec,
      pollMs,
    });
    if (!streamed.completed && streamed.counters.notifications === 0 && streamed.elapsedMs < 15_000) {
      throw new Error(streamed.disconnect || `socket closed before any logs on ${endpoint.ws}`);
    }
    return {
      name: endpoint.name,
      http: endpoint.http,
      ws: endpoint.ws,
      slot,
      subscription: ack.result,
      ...streamed,
    };
  } finally {
    try {
      ws.close();
    } catch {
      // The stream already closes the socket.
    }
  }
}

function publicAttempt(attempt) {
  return {
    name: attempt.name,
    http: attempt.http,
    ws: attempt.ws,
    ok: Boolean(attempt.ok),
    error: attempt.error ?? null,
    slot: attempt.slot ?? null,
    subscription: attempt.subscription ?? null,
    completed: attempt.completed ?? false,
    disconnect: attempt.disconnect ?? null,
    elapsedMs: attempt.elapsedMs ?? null,
    notifications: attempt.counters?.notifications ?? 0,
    tradeEvents: attempt.counters?.tradeEvents ?? 0,
    parseErrors: attempt.counters?.parseErrors ?? 0,
    pollErrorCount: attempt.counters?.pollErrors?.length ?? 0,
    pollErrors: (attempt.counters?.pollErrors ?? []).slice(0, 20),
    socketError: attempt.counters?.socketError ?? null,
  };
}

export async function runReadOnlySession({ endpoints, durationSec, session, sessions, log, pollMs }) {
  const attempts = [];
  for (const endpoint of endpoints) {
    log(`[PAPER] probing ${endpoint.name} http=${endpoint.http} ws=${endpoint.ws}`);
    try {
      const used = await streamEndpoint({
        endpoint,
        sessions: sessions ?? [session],
        log,
        durationSec,
        pollMs,
      });
      const attempt = publicAttempt({ ...used, ok: true, error: null });
      attempts.push(attempt);
      return { ok: true, attempts, used: attempt };
    } catch (err) {
      const message = err?.message || String(err);
      log(`[PAPER] DATA ACCESS FAILED ${endpoint.name}: ${message}`);
      attempts.push({
        name: endpoint.name,
        http: endpoint.http,
        ws: endpoint.ws,
        ok: false,
        error: message,
      });
    }
  }
  return { ok: false, attempts, used: null };
}
