#!/usr/bin/env node
// Paper-only graduation sniper. Refuses wallets, signing, and broadcasts.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ASSUMPTION_LINES, LIMITATION_LINES, PAPER_ASSUMPTIONS, lamportsToSolString } from "./defaults.mjs";
import { assertLedgerConserved, createComparison, createPaperSession } from "./engine.mjs";
import { createRelayBook } from "./relay-book.mjs";
import { evaluateInvocation } from "./guard.mjs";
import { replayFixture } from "./replay.mjs";
import { analyzeGraduationSource, analyzePumpfunFormula } from "./review-source.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function readReview() {
  const graduationSrc = fs.readFileSync(path.join(here, "..", "graduation.mjs"), "utf8");
  const pumpSrc = fs.readFileSync(path.join(here, "..", "..", "..", "lib", "pumpfun.mjs"), "utf8");
  return {
    graduation: analyzeGraduationSource(graduationSrc),
    curveFormula: analyzePumpfunFormula(pumpSrc),
  };
}

function bannerLines(review, decision) {
  const lines = [
    "=== GRADUATION SNIPER — PAPER ONLY ===",
    `VIRTUAL STARTING BALANCE: ${decision.midCompare ? "3" : "10"} SOL each book. Simulated cash. Not a wallet, not withdrawable.`,
    "No key file is read. No transaction is signed or broadcast.",
    "Shared safeguards from graduation.mjs: entry fill>=92% of 85 virtual SOL, buy 0.1 SOL, TP 1.5x, SL 0.7x, timeout 300s, max 3 positions, cooldown 30s.",
    "Faithful curve ledger: original dry-run spot ratio, no fee, no impact.",
    "Improved curve ledger: repo calcBuyTokens/calcSellSol with truncating 1% fee.",
    "A PumpSwap mark uses the documented sellBaseInput quote only after the pool, vaults, mint, and fee schedule validate. It is not a spot fill.",
  ];
  if (decision.midCompare) {
    lines.push("MID COMPARE: E mid-curve 50->90, A exit-at-97, B relay PumpSwap immediate with a Jupiter quote fallback. Each book starts at 3 virtual SOL and bets 0.2 SOL.");
    lines.push("E buys the first time fill is inside 50-55% and does not chase a coin first seen above 55%. It sells on the curve at the first complete=false read at or above 90%, at a 0.7x fee-adjusted stop, or at the 30 minute mark using the current curve quote.");
    lines.push("E allows 10 positions, which is 2 SOL of open cost. A and B keep 3 positions. A new 0.2 SOL entry is skipped, and counted, when the book has less than 0.2 SOL free.");
    lines.push("No key is loaded. Jupiter, if B needs a quote, is GET /swap/v1/quote only.");
  } else if (decision.directCompare) {
    lines.push("DIRECT COMPARE: A exit-at-97, B PumpSwap-direct immediate, D Jupiter-direct immediate. Each starts at 10 virtual SOL.");
    lines.push("D quotes Jupiter as soon as the graduation handoff arrives, retries about every 0.5-1s with two keep-alive requests, and books the first route. No route within 60s is stuck and marked to zero.");
    lines.push("Paper quotes ignore landing delay and execution slippage. The swap endpoint is not called.");
  } else if (decision.relayCompare) {
    lines.push("RELAY COMPARE: three paper books, each starting at 10 virtual SOL. Entry is fill >= 92% and fill < 100%.");
    lines.push("A exit-at-97 sells on the curve only while complete=false and fill is in [97, 100).");
    lines.push("B and C are two-bot relays. The curve buyer keeps stop-loss, take-profit, and timeout before graduation and does not sell on graduation. It emits a handoff.");
    lines.push(`B seller policy: immediate paper sell on the first validated PumpSwap quote. Pool search gives up after ${decision.poolFindSec}s and marks the position stuck at zero proceeds.`);
    lines.push(`C seller policy: after the first quote, wait up to ${decision.waitSec}s for a 1.5x take-profit or 0.7x stop-loss on the fee-adjusted PumpSwap proceeds. Otherwise sell the last quote. No quote becomes a stuck mark-to-zero.`);
    lines.push("A mark-to-zero is a modeled write-off of the cost basis, not a pool fill and not a real sale.");
  } else if (decision.compare) {
    lines.push(`COMPARE: two modified books on the same events. Each starts at 10 virtual SOL. Entry band is the original >=92% and <100%.`);
    lines.push(`A exit-at-97: attempt a curve exit when a read shows complete=false and fill >= ${decision.earlyExitFillPct}% and fill < 100%. The mark uses that observed state, not a backfilled ${decision.earlyExitFillPct}% price. A read at or above 100% fill, or a graduated, missing, or unreadable read, is not a 97% sale. Missed exits keep cash reserved.`);
    lines.push("B pumpswap-immediate: hold through graduation. The primary rule is the first validated PumpSwap pool quote after that observation. Migration does not imply liquidity or a price. Missing, unverified, stale, zero-liquidity, or rate-limited reads stay pending or become a missed exit with no booked profit.");
    lines.push("Neither pre-graduation exit nor a post-graduation pool exit is guaranteed. original comparison mode remains --strategy original.");
  } else if (decision.strategy === "modified") {
    lines.push(`STRATEGY: modified, not the exact original. New entries stop at fill >= ${decision.earlyExitFillPct}%. An open position exits on a curve read with complete=false and fill >= ${decision.earlyExitFillPct}%, priced at the observed reserves.`);
  } else {
    lines.push("STRATEGY: original comparison mode. Entry is fill >= 92% and fill < 100%. No 97% exit and no PumpSwap quote.");
  }
  if (!review.graduation.allHold || !review.curveFormula.allHold) {
    lines.push("SOURCE REVIEW MISMATCH: the original files no longer match the recorded findings. See the JSON report.");
  } else {
    lines.push("Source review of graduation.mjs and lib/pumpfun.mjs matches the recorded findings.");
  }
  for (const finding of review.graduation.findings) {
    lines.push(`  [${finding.holds ? "holds" : "DOES NOT HOLD"}] ${finding.id}: ${finding.detail}`);
  }
  if (decision.ignoredEnv.length) {
    lines.push(`Ignored environment overrides: ${decision.ignoredEnv.join(", ")}`);
  }
  return lines;
}

function decisionLine(prefix, result) {
  if (result.reason === "unpriceable" || result.reason === "already_unpriceable" || result.reason === "missed_exit") {
    return `${prefix} UNPRICEABLE mint=${result.mint} reason=${result.unpriceableReason ?? result.reason} missedEarlyExit=${result.missedEarlyExit === true} modelPnl=none slotLocked=true onChainSell=false`;
  }
  if (result.reason === "pending_pool" || result.reason === "seeking_pool") {
    return `${prefix} PENDING POOL mint=${result.mint} status=${result.poolStatus ?? "waiting"} modelPnl=none`;
  }
  if (result.reason === "handoff") {
    return `${prefix} HANDOFF mint=${result.handoff.mint} tokens=${result.handoff.paperTokens} slot=${result.handoff.graduationSlot ?? "none"} curveSell=false`;
  }
  if (result.reason === "mark_to_zero") {
    return `${prefix} STUCK mark-to-zero pnl=${result.modelMark.pnlSol} SOL. This is a write-off, not a pool fill.`;
  }
  if (result.modelMark) {
    const mark = result.modelMark;
    return [
      `${prefix} COUNTERFACTUAL MODEL MARK trigger=${mark.trigger} mint=${result.mint}`,
      `  not an on-chain sell. faithful pnl=${mark.faithful.pnl.sol} SOL (optimistic spot). improved pnl=${mark.improved.pnl.sol} SOL (curve formula).`,
    ].join("\n");
  }
  if (result.accepted === true) {
    return `${prefix} OPEN counterfactual mint=${result.mint} fill=${Number(result.fillPct).toFixed(2)}% onChainFill=false`;
  }
  if (result.accepted === false && result.reason !== "below_fill" && result.reason !== "fill_at_or_above_100") {
    return `${prefix} REJECT mint=${result.mint} reason=${result.reason} originalWouldOpen=${result.originalWouldOpen}`;
  }
  return null;
}

function percentOnStart(pnlLamports, startLamports) {
  if (startLamports === 0n) return "0.00%";
  const scaled = (pnlLamports * 10000n) / startLamports;
  const neg = scaled < 0n;
  const abs = neg ? -scaled : scaled;
  return `${neg ? "-" : ""}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}%`;
}

function bookOutcome(snapshot, extraCloses = []) {
  const start = BigInt(snapshot.startingBalance.lamports);
  const cash = BigInt(snapshot.ledgers.improved.cash.lamports);
  const reserved = BigInt(snapshot.ledgers.improved.reservedOpen.lamports);
  const rows = [];
  const reasons = { target: 0, stop_loss: 0, timeout: 0, take_profit: 0, graduation: 0, other: 0 };
  let holdMs = 0;
  let holdN = 0;
  let wins = 0;
  for (const position of snapshot.closed) {
    const trigger = position.modelMark?.trigger;
    const pnl = BigInt(position.modelMark?.improved?.pnl?.lamports ?? position.modelMark?.pnlLamports ?? 0);
    if (trigger === "target" || trigger === "early_exit") reasons.target += 1;
    else if (trigger === "stop_loss") reasons.stop_loss += 1;
    else if (trigger === "timeout") reasons.timeout += 1;
    else if (trigger === "take_profit") reasons.take_profit += 1;
    else reasons.other += 1;
    rows.push(pnl);
    if (pnl > 0n) wins += 1;
    if (position.closedAtMs != null) {
      holdMs += position.closedAtMs - position.openedAtMs;
      holdN += 1;
    }
  }
  for (const close of extraCloses) {
    const pnl = BigInt(close.pnlLamports);
    reasons.graduation += 1;
    rows.push(pnl);
    if (pnl > 0n) wins += 1;
    if (close.holdMs != null) {
      holdMs += close.holdMs;
      holdN += 1;
    }
  }
  const pnl = rows.reduce((sum, value) => sum + value, 0n);
  const biggest = rows.length === 0 ? 0n : rows.reduce((best, value) => (value > best ? value : best));
  const open = snapshot.active.filter((position) => position.status === "open").length;
  const died = snapshot.stats.died ?? snapshot.active.filter((position) => position.status === "unpriceable").length;
  return {
    name: snapshot.strategy.name,
    startSol: snapshot.startingBalance.sol,
    cashSol: snapshot.ledgers.improved.cash.sol,
    reservedSol: snapshot.ledgers.improved.reservedOpen.sol,
    equityLamports: (cash + reserved + extraCloses.reduce((sum, close) => sum + BigInt(close.proceedsLamports ?? 0), 0n)).toString(),
    equitySol: lamportsToSolString(cash + reserved + extraCloses.reduce((sum, close) => sum + BigInt(close.proceedsLamports ?? 0), 0n)),
    opens: snapshot.stats.opened,
    reasons,
    stillOpen: open,
    died,
    skippedInsufficientCash: snapshot.stats.skippedInsufficientCash ?? 0,
    skippedAboveBand: snapshot.stats.skippedAboveBand ?? 0,
    pnlSol: lamportsToSolString(pnl),
    pnlExcludingBiggestSol: lamportsToSolString(pnl - biggest),
    returnPct: percentOnStart(pnl, start),
    wins,
    closed: rows.length,
    winRate: rows.length === 0 ? null : wins / rows.length,
    avgHoldSec: holdN === 0 ? null : holdMs / holdN / 1000,
  };
}

function summaryLines(snapshot) {
  const open = snapshot.active.filter((position) => position.status === "open").length;
  const pending = snapshot.active.filter((position) => position.status === "pending_pool").length;
  const lines = [
    `=== ${snapshot.strategy.name} ===`,
    `Virtual cash faithful: ${snapshot.ledgers.faithful.cash.sol} SOL. Improved/quote cash: ${snapshot.ledgers.improved.cash.sol} SOL. Start ${snapshot.startingBalance.sol}. Reserved open ${snapshot.ledgers.improved.reservedOpen.sol}.`,
    `Modeled mark PnL faithful: ${snapshot.ledgers.faithful.modelMarkPnl.sol} SOL. Fee-adjusted or curve-improved: ${snapshot.ledgers.improved.modelMarkPnl.sol} SOL.`,
    `Closed marks: ${snapshot.stats.curveMarks}. Early exits: ${snapshot.stats.earlyExits}. PumpSwap exits: ${snapshot.stats.pumpswapExits}. Open: ${open}. Pending pool: ${pending}. Unpriceable: ${snapshot.stats.unpriceable}. Missed early exits: ${snapshot.stats.missedEarlyExits}. Other missed exits: ${snapshot.stats.missedExits}.`,
    "These figures are counterfactual model marks, not realized profits and not proof of profitability.",
    `On-chain realized SOL: null. Successful on-chain sells: ${snapshot.successfulOnChainSells}. Orders placed: ${snapshot.ordersPlaced}.`,
  ];
  if (snapshot.performanceIncomplete) {
    lines.push("INCOMPLETE: at least one position is still open or unpriceable. Do not read the model PnL as a session result.");
  }
  for (const position of snapshot.active) {
    const flag = position.status === "unpriceable" ? position.unpriceableReason : "open_unmarked";
    lines.push(`  open mint=${position.mint} status=${position.status} flag=${flag} slotLocked=${position.slotLocked} modelMark=${position.modelMark ? "present" : "none"}`);
  }
  return lines;
}

function buildReport({ mode, decision, review, snapshot, books, data, comparisonVerdict, relayReports }) {
  return {
    comparisonVerdict,
    relayReports: (relayReports ?? []).filter(Boolean).map(({ buyer, seller, ...rest }) => rest),
    program: "graduation-sniper-paper",
    mode: "paper-only",
    failClosed: true,
    walletUsed: false,
    keypairLoaded: false,
    transactionsSigned: 0,
    transactionsBroadcast: 0,
    successfulOnChainSells: 0,
    onChainRealizedSol: null,
    ordersPlaced: 0,
    startingBalance: {
      kind: PAPER_ASSUMPTIONS.balanceKind,
      sol: snapshot.startingBalance.sol,
      label: snapshot.startingBalance.label,
    },
    runMode: mode,
    ignoredEnv: decision.ignoredEnv,
    assumptions: ASSUMPTION_LINES,
    limitations: LIMITATION_LINES,
    sourceReview: review,
    data,
    session: snapshot,
    books,
  };
}

function writeOutputs(decision, report, lines) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(here, "..", "..", "..", "paper-runs", stamp);
  const jsonOut = decision.jsonOut ? path.resolve(decision.jsonOut) : path.join(dir, "report.json");
  const logOut = decision.logOut ? path.resolve(decision.logOut) : path.join(dir, "paper.log");
  fs.mkdirSync(path.dirname(jsonOut), { recursive: true });
  fs.mkdirSync(path.dirname(logOut), { recursive: true });
  lines.push(`[PAPER] report ${jsonOut}`);
  lines.push(`[PAPER] log ${logOut}`);
  fs.writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(logOut, `${lines.join("\n")}\n`);
  console.log(`[PAPER] report ${jsonOut}`);
  console.log(`[PAPER] log ${logOut}`);
  return { jsonOut, logOut };
}

function relayAdapter(book, label) {
  return {
    config: { ...book.buyer.config, strategy: label },
    trySignal: book.trySignal,
    observe: book.observe,
    observePool: book.observePool,
    applyJupiter: book.applyJupiter,
    onGraduation: book.onGraduation,
    activeOpenMints: () => book.buyer.activeOpenMints(),
    pendingPoolMints: () => book.seller.snapshot().open.map((row) => row.mint),
    simulatedTokens(mint) {
      const row = book.seller.snapshot().open.find((item) => item.mint === mint);
      return row ? BigInt(row.paperTokens) : null;
    },
    snapshot: () => book.buyer.snapshot(),
  };
}

function fanOut(sessions, event) {
  if (event.type === "trade") return sessions.map((session) => session.trySignal(event, event.atMs));
  if (event.type === "curve") return sessions.map((session) => session.observe(event.mint, event.state, event.atMs));
  if (event.type === "pool") return sessions.map((session) => session.observePool(event.mint, event.view, event.atMs));
  throw new Error(`unknown fixture event ${event.type}`);
}

async function main() {
  const decision = evaluateInvocation(process.argv, process.env);
  if (!decision.ok) {
    console.error(`[PAPER] REFUSED: ${decision.message}`);
    process.exit(decision.exitCode);
  }

  const review = readReview();
  const lines = bannerLines(review, decision);
  const log = (line) => {
    lines.push(line);
    console.log(line);
  };
  for (const line of lines) console.log(line);

  const comparison = decision.compare
    ? createComparison({ earlyExitFillPct: decision.earlyExitFillPct })
    : null;
  const relayBooks = [];
  let sessions;
  const compareSize = { buySol: 0.2, startingVirtualSol: 3 };
  if (decision.midCompare) {
    const relayDir = path.resolve(decision.relayJsonl ? path.dirname(decision.relayJsonl) : path.join(here, "..", "..", "..", "paper-runs", "mid"));
    fs.mkdirSync(relayDir, { recursive: true });
    relayBooks.push(createRelayBook({
      policy: "immediate",
      poolFindTimeoutSec: decision.poolFindSec,
      jsonlPath: path.join(relayDir, "immediate.jsonl"),
      ...compareSize,
      maxPositions: 3,
    }));
    sessions = [
      createPaperSession({ strategy: "mid-curve-50-90", ...compareSize, maxPositions: 10 }),
      createPaperSession({ strategy: "exit-at-97", earlyExitFillPct: decision.earlyExitFillPct, ...compareSize, maxPositions: 3 }),
      relayAdapter(relayBooks[0], "relay-immediate"),
    ];
  } else if (decision.relayCompare) {
    const relayDir = path.resolve(decision.relayJsonl ? path.dirname(decision.relayJsonl) : path.join(here, "..", "..", "..", "paper-runs", "relay"));
    fs.mkdirSync(relayDir, { recursive: true });
    if (decision.directCompare) {
      relayBooks.push(
        createRelayBook({ policy: "pumpswap-direct", poolFindTimeoutSec: decision.poolFindSec, jsonlPath: path.join(relayDir, "pumpswap-direct.jsonl") }),
        createRelayBook({ policy: "jupiter-direct", jsonlPath: path.join(relayDir, "jupiter-direct.jsonl") }),
      );
      sessions = [
        createPaperSession({ strategy: "exit-at-97", earlyExitFillPct: decision.earlyExitFillPct }),
        relayAdapter(relayBooks[0], "pumpswap-direct"),
        relayAdapter(relayBooks[1], "jupiter-direct"),
      ];
    } else {
      relayBooks.push(
        createRelayBook({ policy: "immediate", poolFindTimeoutSec: decision.poolFindSec, jsonlPath: path.join(relayDir, "immediate.jsonl") }),
        createRelayBook({ policy: "wait", waitSec: decision.waitSec, poolFindTimeoutSec: decision.poolFindSec, jsonlPath: path.join(relayDir, "wait.jsonl") }),
      );
      sessions = [
        createPaperSession({ strategy: "exit-at-97", earlyExitFillPct: decision.earlyExitFillPct }),
        relayAdapter(relayBooks[0], "relay-immediate"),
        relayAdapter(relayBooks[1], "relay-wait"),
      ];
    }
  } else {
    sessions = comparison
      ? [comparison.pre, comparison.post]
      : [createPaperSession(decision.strategy === "original" ? { strategy: "original" } : { strategy: "modified", earlyExitFillPct: decision.earlyExitFillPct })];
  }
  let data;
  let exitCode = 0;

  if (decision.mode === "fixture") {
    const fixturePath = path.resolve(decision.fixture);
    const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
    if (decision.relayCompare) {
      let lastAt = 0;
      for (const event of fixture.events) {
        lastAt = event.atMs;
        fanOut(sessions, event).forEach((result, index) => {
          const row = decisionLine(`[PAPER ${sessions[index].config.strategy}]`, result);
          if (row) log(row);
        });
      }
      for (const book of relayBooks) book.settle(lastAt);
    } else if (comparison) {
      for (const event of fixture.events) {
        if (event.type === "trade") {
          const both = comparison.trySignal(event, event.atMs);
          for (const [name, result] of [["A", both.pre], ["B", both.post]]) {
            const row = decisionLine(`[PAPER ${name}]`, result);
            if (row) log(row);
          }
        } else if (event.type === "curve") {
          const both = comparison.observe(event.mint, event.state, event.atMs);
          for (const [name, result] of [["A", both.pre], ["B", both.post]]) {
            const row = decisionLine(`[PAPER ${name}]`, result);
            if (row) log(row);
          }
        } else if (event.type === "pool") {
          const result = comparison.observePool(event.mint, event.view, event.atMs);
          const row = decisionLine("[PAPER B]", result);
          if (row) log(row);
        } else {
          throw new Error(`unknown fixture event ${event.type}`);
        }
      }
    } else {
      const replayed = replayFixture(sessions[0], fixture);
      for (const step of replayed) {
        const row = decisionLine("[PAPER]", step.result);
        if (row) log(row);
      }
    }
    data = { kind: "fixture", path: fixturePath, ok: true, error: null, compare: decision.compare };
  } else {
    const { runReadOnlySession } = await import("./public-read.mjs");
    const live = await runReadOnlySession({
      endpoints: decision.endpoints,
      durationSec: decision.durationSec,
      sessions,
      log,
      pollMs: sessions[0].config.pollMs,
    });
    data = { kind: "public-readonly", durationSec: decision.durationSec, ...live };
    if (!live.ok) {
      exitCode = 3;
      const blocker = live.attempts.map((attempt) => `${attempt.name}: ${attempt.error}`).join(" | ");
      log(`[PAPER] PUBLIC DATA BLOCKER: ${blocker}`);
    } else if ((live.used?.notifications ?? 0) === 0) {
      log("[PAPER] PUBLIC DATA WARNING: subscription stayed up and delivered zero log notifications.");
    }
  }

  if ((decision.relayCompare || decision.midCompare) && decision.mode !== "fixture") {
    const { fetchJupiterQuote } = await import("./jupiter-quote.mjs");
    for (const book of relayBooks) {
      for (const row of book.seller.snapshot().open) {
        if (row.modelMark) continue;
        const quote = await fetchJupiterQuote({ inputMint: row.mint, amount: row.paperTokens });
        book.applyJupiter(row.mint, quote, Date.now());
        log(`[PAPER] ${book.policy} jupiter mint=${row.mint} ok=${quote.ok} reason=${quote.reason ?? "quoted"} latencyMs=${quote.latencyMs}`);
      }
      book.settle(Date.now());
    }
  }
  const books = sessions.map((session) => session.snapshot());
    const relayReports = decision.midCompare
    ? [null, null, relayBooks[0].report("B-relay-immediate")]
    : decision.relayCompare
    ? [
      null,
      relayBooks[0].report(decision.directCompare ? "B-pumpswap-direct" : "B-relay-immediate"),
      relayBooks[1].report(decision.directCompare ? "D-jupiter-direct" : "C-relay-wait"),
    ]
    : null;
  for (const snapshot of books) {
    for (const line of summaryLines(snapshot)) log(line);
    assertLedgerConserved(snapshot);
  }
  const graduatedOrClosed = books.some((snapshot) =>
    snapshot.stats.curveMarks > 0 || snapshot.stats.pendingPool > 0 || snapshot.stats.missedEarlyExits > 0 || snapshot.stats.missedExits > 0 || snapshot.stats.unpriceable > 0);
  let midOutcomes = null;
  if (decision.midCompare) {
    const openedAt = new Map((books[2].handoffs ?? []).map((row) => [row.mint, row.openedAtMs]));
    const sellerCloses = relayBooks[0].seller.snapshot().closed.map((row) => ({
      pnlLamports: row.modelMark.pnlLamports,
      proceedsLamports: row.modelMark.proceedsLamports,
      holdMs: row.modelMark.atMs != null && openedAt.has(row.mint) ? row.modelMark.atMs - openedAt.get(row.mint) : null,
    }));
    midOutcomes = books.map((snapshot, index) => bookOutcome(snapshot, index === 2 ? sellerCloses : []));
    const labels = ["E", "A", "B"];
    midOutcomes.forEach((outcome, index) => {
      log(`[PAPER] ${labels[index]} ${outcome.name} opens=${outcome.opens} target=${outcome.reasons.target} sl=${outcome.reasons.stop_loss} timeout=${outcome.reasons.timeout} tp=${outcome.reasons.take_profit} graduationSells=${outcome.reasons.graduation} died=${outcome.died} open=${outcome.stillOpen} skipped: insufficient paper cash=${outcome.skippedInsufficientCash} skippedAbove55=${outcome.skippedAboveBand} pnl=${outcome.pnlSol} pnlExBiggest=${outcome.pnlExcludingBiggestSol} returnOn3Sol=${outcome.returnPct} winRate=${outcome.winRate} avgHoldSec=${outcome.avgHoldSec} endCash=${outcome.cashSol} reserved=${outcome.reservedSol} endingBalance=${outcome.equitySol}`);
    });
    log("[PAPER] Mid-curve comparison is descriptive only. Marks are not landed trades. On-chain sells: 0.");
  } else if (decision.relayCompare) {
    for (const report of relayReports.slice(1)) {
      log(`[PAPER] ${report.strategy} opens=${report.opens} curveCloses=${report.curveCloses} graduations=${report.graduationsCaptured} handoffs=${report.handoffs} pumpswapSells=${report.pumpswapSells} stuck=${report.stuck} feeAdjustedPnl=${report.feeAdjustedPnlSol} winRate=${report.winRate}`);
    }
    const graduations = relayReports.slice(1).reduce((sum, report) => sum + report.graduationsCaptured, 0);
    log(graduations === 0
      ? "[PAPER] INSUFFICIENT SAMPLE for the PumpSwap handoff: no graduation was captured. No winner."
      : "[PAPER] Relay comparison is descriptive only. Mark-to-zero rows are write-offs, not fills. This is not proof of profitability.");
  } else if (decision.compare) {
    log(graduatedOrClosed
      ? "[PAPER] Comparison is descriptive only. It does not name a winner and it is not proof of profitability."
      : "[PAPER] INSUFFICIENT SAMPLE: neither book recorded a graduation, a pool exit, or a missed exit. No winner.");
  }
  const report = buildReport({
    mode: decision.mode,
    decision,
    review,
    snapshot: books[0],
    books,
    data,
    comparisonVerdict: decision.relayCompare
      ? (relayReports.slice(1).some((report) => report.graduationsCaptured > 0) ? "descriptive-only" : "insufficient-graduation-sample")
      : decision.compare ? (graduatedOrClosed ? "descriptive-only" : "insufficient-sample") : null,
    relayReports,
  });
  if (midOutcomes) report.midOutcomes = midOutcomes;
  writeOutputs(decision, report, lines);
  process.exit(exitCode);
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  main().catch((err) => {
    console.error(`[PAPER] FAILED: ${err.message}`);
    process.exit(1);
  });
}
