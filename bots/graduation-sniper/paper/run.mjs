#!/usr/bin/env node
// Paper-only graduation sniper. Refuses wallets, signing, and broadcasts.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ASSUMPTION_LINES, LIMITATION_LINES, PAPER_ASSUMPTIONS } from "./defaults.mjs";
import { assertLedgerConserved, createPaperSession } from "./engine.mjs";
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

function bannerLines(review, ignoredEnv) {
  const lines = [
    "=== GRADUATION SNIPER — PAPER ONLY ===",
    "VIRTUAL STARTING BALANCE: 10 SOL",
    "This balance is simulated. It is not a wallet, not an account, and not withdrawable.",
    "No key file is read. No transaction is signed or broadcast.",
    "Strategy defaults from graduation.mjs: fill>=92% of 85 virtual SOL and fill<100, buy 0.1 SOL, TP 1.5x, SL 0.7x, timeout 300s, max 3 positions, cooldown 30s.",
    "Two ledgers run on the same triggers.",
    "  faithful: original dry-run spot ratio, no fee, no price impact (optimistic).",
    "  improved: repo calcBuyTokens/calcSellSol with truncating 1% fee and constant product.",
    "Graduated, missing, and unreadable curves are unpriceable. Slots stay locked. No model sell is booked.",
  ];
  if (!review.graduation.allHold || !review.curveFormula.allHold) {
    lines.push("SOURCE REVIEW MISMATCH: the original files no longer match the recorded findings. See the JSON report.");
  } else {
    lines.push("Source review of graduation.mjs and lib/pumpfun.mjs matches the recorded findings.");
  }
  for (const finding of review.graduation.findings) {
    lines.push(`  [${finding.holds ? "holds" : "DOES NOT HOLD"}] ${finding.id}: ${finding.detail}`);
  }
  if (ignoredEnv.length) {
    lines.push(`Ignored environment overrides: ${ignoredEnv.join(", ")}`);
  }
  return lines;
}

function decisionLine(prefix, result) {
  if (result.reason === "unpriceable" || result.reason === "already_unpriceable") {
    return `${prefix} UNPRICEABLE mint=${result.mint} reason=${result.unpriceableReason} modelPnl=none slotLocked=true onChainSell=false`;
  }
  if (result.modelMark) {
    const mark = result.modelMark;
    return [
      `${prefix} COUNTERFACTUAL MODEL MARK trigger=${mark.trigger} mint=${result.mint}`,
      `  not an on-chain sell. faithful pnl=${mark.faithful.pnl.sol} SOL (optimistic spot). improved pnl=${mark.improved.pnl.sol} SOL (curve formula).`,
    ].join("\n");
  }
  if (result.accepted === true) {
    return `${prefix} OPEN counterfactual mint=${result.mint} fill=${Number(result.fillPct).toFixed(2)}% virtual debit=0.1 SOL onChainFill=false`;
  }
  if (result.accepted === false && result.reason !== "below_fill" && result.reason !== "fill_at_or_above_100") {
    return `${prefix} REJECT mint=${result.mint} reason=${result.reason} originalWouldOpen=${result.originalWouldOpen}`;
  }
  return null;
}

function summaryLines(snapshot) {
  const lines = [
    "=== PAPER SUMMARY ===",
    `Virtual cash faithful: ${snapshot.ledgers.faithful.cash.sol} SOL (start ${snapshot.startingBalance.sol})`,
    `Virtual cash improved: ${snapshot.ledgers.improved.cash.sol} SOL (start ${snapshot.startingBalance.sol})`,
    `Counterfactual model mark PnL faithful: ${snapshot.ledgers.faithful.modelMarkPnl.sol} SOL`,
    `Counterfactual model mark PnL improved: ${snapshot.ledgers.improved.modelMarkPnl.sol} SOL`,
    "These model marks are not realized profits and not successful sells.",
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

function buildReport({ mode, decision, review, snapshot, data }) {
  return {
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

async function main() {
  const decision = evaluateInvocation(process.argv, process.env);
  if (!decision.ok) {
    console.error(`[PAPER] REFUSED: ${decision.message}`);
    process.exit(decision.exitCode);
  }

  const review = readReview();
  const lines = bannerLines(review, decision.ignoredEnv);
  const log = (line) => {
    lines.push(line);
    console.log(line);
  };
  for (const line of lines) console.log(line);

  const session = createPaperSession();
  let data;
  let exitCode = 0;

  if (decision.mode === "fixture") {
    const fixturePath = path.resolve(decision.fixture);
    const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
    const replayed = replayFixture(session, fixture);
    for (const step of replayed) {
      const row = decisionLine("[PAPER]", step.result);
      if (row) log(row);
    }
    data = { kind: "fixture", path: fixturePath, ok: true, error: null };
  } else {
    const { runReadOnlySession } = await import("./public-read.mjs");
    const live = await runReadOnlySession({
      endpoints: decision.endpoints,
      durationSec: decision.durationSec,
      session,
      log,
      pollMs: session.config.pollMs,
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

  const snapshot = session.snapshot();
  for (const line of summaryLines(snapshot)) log(line);
  const report = buildReport({ mode: decision.mode, decision, review, snapshot, data });
  writeOutputs(decision, report, lines);
  try {
    assertLedgerConserved(snapshot);
  } catch (err) {
    console.error(`[PAPER] LEDGER CHECK FAILED: ${err.message}`);
    process.exit(1);
  }
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
