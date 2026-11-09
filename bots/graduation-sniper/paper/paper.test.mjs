import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { PublicKey } from "@solana/web3.js";
import { BUY_INSTRUCTIONS, PUMP_PROGRAM, TRADE_EVENT_PREFIX } from "../../../lib/constants.mjs";
import { quoteBuy, quoteSell, spotRatioProceedsLamports } from "./curve.mjs";
import { PAPER_ASSUMPTIONS, PUMP_PROGRAM_ID, STRATEGY_DEFAULTS, solToLamports } from "./defaults.mjs";
import { assertLedgerConserved, createComparison, createPaperSession, virtualSolFillPct } from "./engine.mjs";
import { createRelayBook } from "./relay-book.mjs";
import { readRelay } from "./relay.mjs";
import { assertQuoteRequest, parseJupiterQuote, JUPITER_QUOTE_ORIGIN } from "./jupiter-quote.mjs";
import {
  FEE_CONFIG_DISC,
  GLOBAL_CONFIG_DISC,
  POOL_DISC,
  PUMP_AMM_PROGRAM_ID,
  PUMP_FEE_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  WSOL_MINT,
  assessPoolAccounts,
  canonicalPoolAddress,
  feeCeil,
  sellBaseQuote,
} from "./pumpswap-quote.mjs";
import { evaluateInvocation, PUBLIC_ENDPOINTS } from "./guard.mjs";
import { decodeTradeEvent, parsePumpLogValue } from "./parse-log.mjs";
import { READ_ONLY_HTTP_METHODS, READ_ONLY_WS_METHODS, bondingCurveAddress, decodeBondingCurveAccount } from "./public-read.mjs";
import { replayFixture } from "./replay.mjs";
import { analyzeGraduationSource, analyzePumpfunFormula } from "./review-source.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..", "..");
const paperDir = here;
const VSOL = 78_200_000_000n;
const VTOK = 1_000_000_000_000_000n;
const BUY = 100_000_000n;

function reserves(virtualSolReserves = VSOL, virtualTokenReserves = VTOK) {
  return { virtualSolReserves, virtualTokenReserves };
}

function productionSources() {
  return fs.readdirSync(paperDir)
    .filter((name) => name.endsWith(".mjs") && name !== "paper.test.mjs")
    .map((name) => ({ name, src: fs.readFileSync(path.join(paperDir, name), "utf8") }));
}

test("strategy defaults match the original graduation sniper literals", () => {
  const src = fs.readFileSync(path.join(paperDir, "..", "graduation.mjs"), "utf8");
  assert.match(src, /GRAD_BUY_SOL \|\| 0\.1\)/);
  assert.match(src, /GRAD_MIN_FILL_PCT \|\| 92\)/);
  assert.match(src, /GRAD_TAKE_PROFIT \|\| 1\.5\)/);
  assert.match(src, /GRAD_STOP_LOSS \|\| 0\.7\)/);
  assert.match(src, /GRAD_TIMEOUT_SEC \|\| 300\)/);
  assert.match(src, /GRAD_MAX_POSITIONS \|\| 3\)/);
  assert.match(src, /GRAD_COOLDOWN_SEC \|\| 30\)/);
  assert.match(src, /VIRTUAL_SOL_AT_GRADUATION = 85_000_000_000n/);
  assert.equal(STRATEGY_DEFAULTS.buySol, 0.1);
  assert.equal(STRATEGY_DEFAULTS.minFillPct, 92);
  assert.equal(STRATEGY_DEFAULTS.takeProfitMultiple, 1.5);
  assert.equal(STRATEGY_DEFAULTS.stopLossMultiple, 0.7);
  assert.equal(STRATEGY_DEFAULTS.timeoutSec, 300);
  assert.equal(STRATEGY_DEFAULTS.maxPositions, 3);
  assert.equal(STRATEGY_DEFAULTS.cooldownSec, 30);
  assert.equal(STRATEGY_DEFAULTS.virtualSolAtGraduationLamports, 85_000_000_000n);
  assert.equal(PAPER_ASSUMPTIONS.startingVirtualSol, 10);
  assert.equal(PAPER_ASSUMPTIONS.balanceKind, "VIRTUAL_PAPER_SOL");
  assert.equal(solToLamports(10), 10_000_000_000n);
  assert.equal(solToLamports(0.1), BUY);
});

test("upstream review findings still hold in this fork's original files", () => {
  const graduation = analyzeGraduationSource(fs.readFileSync(path.join(paperDir, "..", "graduation.mjs"), "utf8"));
  const formula = analyzePumpfunFormula(fs.readFileSync(path.join(repo, "lib", "pumpfun.mjs"), "utf8"));
  assert.equal(graduation.allHold, true, JSON.stringify(graduation.findings, null, 2));
  assert.equal(formula.allHold, true, JSON.stringify(formula.findings, null, 2));
  assert.equal(PUMP_PROGRAM.toBase58(), PUMP_PROGRAM_ID);
});

test("paper sources have no wallet, sign, or send path", () => {
  const bannedCalls = [
    /loadKeypair\s*\(/,
    /generateKeypair\s*\(/,
    /fromSecretKey\s*\(/,
    /sendTransaction\s*\(/,
    /sendRawTransaction\s*\(/,
    /simulateTransaction\s*\(/,
    /requestAirdrop\s*\(/,
    /partialSign\s*\(/,
    /\.sign\s*\(/,
    /new\s+Keypair\b/,
    /new\s+Connection\b/,
    /secretKey/,
  ];
  const web3Files = new Set(["parse-log.mjs", "public-read.mjs", "pumpswap-quote.mjs"]);
  for (const file of productionSources()) {
    for (const pattern of bannedCalls) {
      assert.equal(pattern.test(file.src), false, `${file.name} matched ${pattern}`);
    }
    const imports = [
      ...file.src.matchAll(/from\s+["']([^"']+)["']/g),
      ...file.src.matchAll(/import\s*\(\s*["']([^"']+)["']/g),
    ].map((match) => match[1]);
    for (const specifier of imports) {
      const allowed = specifier.startsWith("node:")
        || specifier.startsWith("./")
        || specifier === "../../../lib/constants.mjs"
        || (specifier === "@solana/web3.js" && web3Files.has(file.name));
      assert.equal(allowed, true, `${file.name} imports ${specifier}`);
      assert.equal(/wallet|tx\.mjs|rpc\.mjs|pumpfun|config\.mjs|\/ws\.mjs/.test(specifier), false, specifier);
    }
  }
  assert.deepEqual([...READ_ONLY_HTTP_METHODS], ["getAccountInfo", "getSlot"]);
  assert.deepEqual([...READ_ONLY_WS_METHODS], ["logsSubscribe", "logsUnsubscribe", "accountSubscribe", "accountUnsubscribe"]);
  const reader = fs.readFileSync(path.join(paperDir, "public-read.mjs"), "utf8");
  assert.match(reader, /refusing RPC method/);
  assert.match(reader, /refusing websocket method/);
});

test("curve quotes match the repository integer formula and the spot ledger omits fees", () => {
  const fee = BUY / 100n;
  const net = BUY - fee;
  const tokens = (VTOK * net) / (VSOL + net);
  const buy = quoteBuy(VSOL, VTOK, BUY);
  assert.equal(buy.tokens, tokens);
  assert.equal(buy.feeLamports, fee);
  const sell = quoteSell(VSOL, VTOK, tokens);
  const gross = (VSOL * tokens) / (VTOK + tokens);
  assert.equal(sell.grossLamports, gross);
  assert.equal(sell.proceedsLamports, gross - gross / 100n);
  assert.ok(sell.proceedsLamports < BUY);
  assert.equal(spotRatioProceedsLamports(BUY, VSOL, VTOK, VSOL, VTOK), BUY);
  assert.equal(spotRatioProceedsLamports(BUY, VSOL, VTOK, 117_300_000_000n, VTOK), 150_000_000n);
  assert.equal(spotRatioProceedsLamports(BUY, VSOL, VTOK, 54_740_000_000n, VTOK), 70_000_000n);
});

test("fill band, cooldown, size, and virtual cash constraints", () => {
  const session = createPaperSession();
  assert.equal(session.trySignal({ mint: "low", ...reserves(77_350_000_000n) }, 0).reason, "below_fill");
  assert.equal(session.trySignal({ mint: "full", ...reserves(85_000_000_000n) }, 0).reason, "fill_at_or_above_100");
  assert.equal(session.trySignal({ mint: "just-under", ...reserves(VSOL - 1n) }, 0).reason, "below_fill");
  const opened = session.trySignal({ mint: "A", ...reserves() }, 0);
  assert.equal(opened.accepted, true);
  assert.equal(session.snapshot().ledgers.faithful.cash.sol, "9.900000000");
  assert.equal(session.snapshot().active[0].spent.sol, "0.100000000");
  assert.equal(session.trySignal({ mint: "B", ...reserves() }, 29_999).reason, "cooldown");
  assert.equal(session.trySignal({ mint: "A", ...reserves() }, 30_000).reason, "duplicate_mint");
  assert.equal(session.trySignal({ mint: "B", ...reserves() }, 30_000).accepted, true);

  const poor = createPaperSession({ startingVirtualSol: 0.15 });
  assert.equal(poor.trySignal({ mint: "C", ...reserves() }, 0).accepted, true);
  const blocked = poor.trySignal({ mint: "D", ...reserves() }, 30_000);
  assert.equal(blocked.reason, "insufficient_virtual_cash");
  assert.equal(blocked.originalWouldOpen, true);
  assert.equal(poor.snapshot().stats.opened, 1);
  assert.equal(poor.snapshot().ledgers.faithful.cash.lamports, "50000000");
  assert.equal(createPaperSession({ startingVirtualSol: 0 }).trySignal({ mint: "E", ...reserves() }, 0).reason, "insufficient_virtual_cash");
});

test("graduated and missing curves lock slots and book no model sell", () => {
  const session = createPaperSession();
  for (let i = 0; i < 3; i++) {
    const at = i * 30_000;
    assert.equal(session.trySignal({ mint: `M${i}`, ...reserves() }, at).accepted, true);
    const marked = session.observe(`M${i}`, {
      complete: true,
      virtualSolReserves: VSOL * 5n,
      virtualTokenReserves: VTOK,
    }, at + 1_000);
    assert.equal(marked.reason, "unpriceable");
    assert.equal(marked.unpriceableReason, "graduated");
    assert.equal(marked.modelMark, null);
    assert.equal(marked.onChainSell, false);
    assert.equal(marked.successfulSell, false);
  }
  const blocked = session.trySignal({ mint: "M3", ...reserves() }, 90_000);
  assert.equal(blocked.reason, "max_positions");
  assert.equal(blocked.originalWouldOpen, false);
  const snap = session.snapshot();
  assert.equal(snap.stats.curveMarks, 0);
  assert.equal(snap.stats.unpriceable, 3);
  assert.equal(snap.ledgers.faithful.modelMarkPnl.sol, "0.000000000");
  assert.equal(snap.ledgers.improved.modelMarkPnl.sol, "0.000000000");
  assert.equal(snap.ledgers.faithful.cash.sol, "9.700000000");
  assert.equal(snap.successfulOnChainSells, 0);
  assert.equal(snap.onChainRealizedSol, null);
  assert.equal(snap.performanceIncomplete, true);
  assert.equal(session.observe("M0", null, 120_000).reason, "already_unpriceable");

  const missing = createPaperSession();
  missing.trySignal({ mint: "gone", ...reserves() }, 0);
  const result = missing.observe("gone", null, 1_000);
  assert.equal(result.unpriceableReason, "curve_missing");
  assert.equal(result.modelMark, null);
  assert.equal(missing.snapshot().ledgers.improved.modelMarkPnl.sol, "0.000000000");
  assertLedgerConserved(missing.snapshot());
  assertLedgerConserved(snap);
});

test("faithful and improved ledgers diverge on curve exits without inventing a sell", () => {
  const timeout = createPaperSession();
  timeout.trySignal({ mint: "T", ...reserves() }, 0);
  assert.equal(timeout.observe("T", { complete: false, ...reserves() }, 3_000).reason, "hold");
  const timed = timeout.observe("T", { complete: false, ...reserves() }, 300_000);
  assert.equal(timed.reason, "timeout");
  assert.equal(timed.modelMark.onChainSell, false);
  assert.equal(timed.modelMark.kind, "simulated_curve_mark");
  assert.equal(timed.modelMark.faithful.pnl.sol, "0.000000000");
  assert.ok(timed.modelMark.improved.pnl.sol.startsWith("-"));
  assert.equal(timed.modelMark.improved.pnl.lamports, (quoteSell(VSOL, VTOK, quoteBuy(VSOL, VTOK, BUY).tokens).proceedsLamports - BUY).toString());
  assert.equal(timeout.snapshot().active.length, 0);

  const tp = createPaperSession();
  tp.trySignal({ mint: "P", virtualSolReserves: VSOL, virtualTokenReserves: 1_500_000_000_000_000n }, 0);
  const took = tp.observe("P", { complete: false, virtualSolReserves: VSOL, virtualTokenReserves: VTOK }, 10_000);
  assert.equal(took.reason, "take_profit");
  assert.equal(took.modelMark.faithful.pnl.sol, "0.050000000");
  assert.notEqual(took.modelMark.improved.pnl.lamports, took.modelMark.faithful.pnl.lamports);
  assert.equal(tp.snapshot().ledgers.faithful.cash.sol, "10.050000000");
  assert.equal(took.successfulSell, false);

  const sl = createPaperSession();
  sl.trySignal({ mint: "S", ...reserves() }, 0);
  const stopped = sl.observe("S", { complete: false, virtualSolReserves: 54_740_000_000n, virtualTokenReserves: VTOK }, 10_000);
  assert.equal(stopped.reason, "stop_loss");
  assert.equal(stopped.modelMark.faithful.pnl.sol, "-0.030000000");
  assert.ok(BigInt(stopped.modelMark.improved.pnl.lamports) < BigInt(stopped.modelMark.faithful.pnl.lamports));

  const priority = createPaperSession();
  priority.trySignal({ mint: "both", virtualSolReserves: VSOL, virtualTokenReserves: 1_500_000_000_000_000n }, 0);
  const both = priority.observe("both", {
    complete: false,
    virtualSolReserves: VSOL,
    virtualTokenReserves: VTOK,
  }, 400_000);
  assert.equal(both.reason, "take_profit");
  assertLedgerConserved(timeout.snapshot());
  assertLedgerConserved(tp.snapshot());
  assertLedgerConserved(sl.snapshot());
});

test("the same events produce the same snapshot", () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(paperDir, "fixtures", "mixed-outcome.json"), "utf8"));
  const run = () => {
    const session = createPaperSession();
    replayFixture(session, fixture);
    return session.snapshot();
  };
  const first = run();
  const second = run();
  assert.deepEqual(first, second);
  assert.equal(first.startingBalance.kind, "VIRTUAL_PAPER_SOL");
  assert.equal(first.startingBalance.sol, "10.000000000");
  assert.equal(first.stats.opened, 4);
  assert.equal(first.stats.curveMarks, 1);
  assert.equal(first.stats.unpriceable, 2);
  assert.equal(first.active.length, 3);
  assert.equal(first.closed.length, 1);
  assert.equal(first.closed[0].modelMark.faithful.pnl.sol, "0.000000000");
  assert.ok(first.closed[0].modelMark.improved.pnl.sol.startsWith("-"));
  assert.equal(first.closed[0].modelMark.onChainSell, false);
  const reasons = Object.fromEntries(first.active.map((position) => [position.mint, position.unpriceableReason]));
  assert.equal(reasons["mint-grad"], "graduated");
  assert.equal(reasons["mint-missing"], "curve_missing");
  assert.equal(reasons["mint-open"], null);
  assert.equal(first.active.every((position) => position.modelMark == null), true);
  assert.equal(first.ledgers.faithful.modelMarkPnl.sol, "0.000000000");
  assert.equal(first.ledgers.faithful.cash.sol, "9.700000000");
  assert.equal(first.recentDecisions.at(-1).reason, "max_positions");
  assert.equal(first.ordersPlaced, 0);
  assertLedgerConserved(first);
});

test("log parser follows the original buy-event gate", () => {
  assert.deepEqual([...BUY_INSTRUCTIONS], ["Buy", "BuyV2", "BuyV3", "BuyExactQuoteInV2", "BuyExactQuoteInV3", "BuyExactSolIn"]);
  const mint = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
  const user = new PublicKey("11111111111111111111111111111111");
  const data = Buffer.alloc(129);
  TRADE_EVENT_PREFIX.copy(data, 0);
  mint.toBuffer().copy(data, 8);
  data.writeBigUInt64LE(1_000_000_000n, 40);
  data.writeBigUInt64LE(2_000_000n, 48);
  user.toBuffer().copy(data, 57);
  data.writeBigUInt64LE(VSOL, 97);
  data.writeBigUInt64LE(VTOK, 105);
  data.writeBigUInt64LE(3n, 113);
  data.writeBigUInt64LE(4n, 121);
  const encoded = data.toString("base64");
  const parsed = parsePumpLogValue({
    logs: [
      "Program log: Instruction: BuyV3",
      `Program data: ${encoded}`,
      "Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P success",
    ],
  });
  assert.equal(parsed.mint, mint.toBase58());
  assert.equal(parsed.virtualSolReserves, VSOL);
  assert.equal(parsed.virtualTokenReserves, VTOK);
  assert.equal(decodeTradeEvent(data).realTokenReserves, 4n);
  assert.equal(parsePumpLogValue({
    logs: ["Program log: Instruction: SellV3", `Program data: ${encoded}`, "Program success"],
  }), null);
  assert.equal(parsePumpLogValue({
    logs: ["Program log: Instruction: Buy", `Program data: ${encoded}`, "Program failed"],
  }), null);
  const account = Buffer.alloc(80);
  account.writeBigUInt64LE(VTOK, 8);
  account.writeBigUInt64LE(VSOL, 16);
  account[48] = 1;
  const decoded = decodeBondingCurveAccount({ data: [account.toString("base64"), "base64"] });
  assert.equal(decoded.complete, true);
  assert.equal(decoded.virtualSolReserves, VSOL);
  assert.equal(decodeBondingCurveAccount(null), null);
  assert.equal(decodeBondingCurveAccount({ data: [Buffer.alloc(10).toString("base64"), "base64"] }).unreadable, true);
  const derived = bondingCurveAddress(mint.toBase58());
  const again = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.toBuffer()],
    PUMP_PROGRAM,
  )[0].toBase58();
  assert.equal(derived, again);
  assert.match(fs.readFileSync(path.join(repo, "lib", "pumpfun.mjs"), "utf8"), /Buffer\.from\("bonding-curve"\)/);
});

test("the entrypoint refuses live flags, key material, and non-public RPCs", () => {
  const refused = evaluateInvocation(["node", "run.mjs", "--live"], {});
  assert.equal(refused.ok, false);
  assert.equal(refused.exitCode, 2);
  assert.equal(evaluateInvocation(["node", "run.mjs", "--send"], {}).ok, false);
  assert.equal(evaluateInvocation(["node", "run.mjs", "--wallet"], {}).ok, false);
  assert.equal(evaluateInvocation(["node", "run.mjs", "--dry-run"], {}).ok, false);
  assert.match(evaluateInvocation(["node", "run.mjs", "--fixture", "x"], { PRIVATE_KEY: "nope" }).message, /PRIVATE_KEY/);
  assert.match(
    evaluateInvocation(["node", "run.mjs", "--public-readonly", "--rpc-http", "https://mainnet.helius-rpc.com/?api-key=abc", "--rpc-ws", "wss://mainnet.helius-rpc.com"], {}).message,
    /allowlist/,
  );
  assert.equal(evaluateInvocation(["node", "run.mjs", "--public-readonly", "--duration-sec", "661"], {}).ok, false);
  assert.equal(evaluateInvocation(["node", "run.mjs", "--public-readonly", "--duration-sec", "600"], {}).ok, true);
  assert.equal(evaluateInvocation(["node", "run.mjs", "--relay-compare", "--public-readonly", "--duration-sec", "7200"], {}).ok, true);
  assert.equal(evaluateInvocation(["node", "run.mjs", "--relay-compare", "--public-readonly", "--duration-sec", "10801"], {}).ok, false);
  assert.equal(evaluateInvocation(["node", "run.mjs", "--compare", "--strategy", "original", "--fixture", "x"], {}).ok, false);
  assert.equal(evaluateInvocation(["node", "run.mjs"], {}).ok, false);
  const ok = evaluateInvocation(["node", "run.mjs", "--public-readonly"], { HELIUS_API_KEY: "ignored", GRAD_BUY_SOL: "5" });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.endpoints, PUBLIC_ENDPOINTS);
  assert.deepEqual(ok.ignoredEnv, ["HELIUS_API_KEY", "GRAD_BUY_SOL"]);
  assert.equal(ok.durationSec, 300);
});

function spawnPaper(args, envPatch = {}) {
  const env = { ...process.env };
  for (const key of ["PRIVATE_KEY", "SECRET_KEY", "SOLANA_PRIVATE_KEY", "WALLET_PRIVATE_KEY", "KEYPAIR", "KEYPAIR_JSON"]) {
    delete env[key];
  }
  Object.assign(env, envPatch);
  return spawnSync(process.execPath, [path.join(paperDir, "run.mjs"), ...args], {
    cwd: repo,
    env,
    encoding: "utf8",
  });
}

test("fixture command stays paper-only and ignores strategy overrides", () => {
  const outDir = fs.mkdtempSync(path.join("/tmp", "grad-paper-"));
  const jsonOut = path.join(outDir, "report.json");
  const logOut = path.join(outDir, "paper.log");
  const result = spawnPaper([
    "--fixture",
    path.join(paperDir, "fixtures", "mixed-outcome.json"),
    "--json-out",
    jsonOut,
    "--log-out",
    logOut,
  ], { GRAD_BUY_SOL: "5", HELIUS_API_KEY: "not-used" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /VIRTUAL STARTING BALANCE: 10 SOL/);
  assert.match(result.stdout, /not a wallet/i);
  assert.doesNotMatch(result.stdout, /tx sent/);
  assert.equal(fs.existsSync(path.join(repo, "keys")), false);
  const report = JSON.parse(fs.readFileSync(jsonOut, "utf8"));
  assert.equal(report.walletUsed, false);
  assert.equal(report.keypairLoaded, false);
  assert.equal(report.transactionsSigned, 0);
  assert.equal(report.transactionsBroadcast, 0);
  assert.equal(report.successfulOnChainSells, 0);
  assert.equal(report.onChainRealizedSol, null);
  assert.equal(report.startingBalance.sol, "10.000000000");
  assert.equal(report.startingBalance.kind, "VIRTUAL_PAPER_SOL");
  assert.equal(report.session.strategy.buySol, 0.1);
  assert.equal(report.session.stats.unpriceable, 2);
  assert.equal(report.session.ledgers.faithful.modelMarkPnl.sol, "0.000000000");
  assert.ok(report.session.ledgers.improved.modelMarkPnl.sol.startsWith("-"));
  assert.equal(report.sourceReview.graduation.allHold, true);
  assert.equal(report.data.kind, "fixture");
  assert.match(fs.readFileSync(logOut, "utf8"), /UNPRICEABLE/);
  const live = spawnPaper(["--live"]);
  assert.equal(live.status, 2);
  assert.match(live.stderr, /REFUSED/);
  assert.equal(fs.existsSync(path.join(repo, "keys")), false);
  const keyed = spawnPaper(["--fixture", path.join(paperDir, "fixtures", "mixed-outcome.json")], { PRIVATE_KEY: "not-a-real-key" });
  assert.equal(keyed.status, 2);
  assert.match(keyed.stderr, /PRIVATE_KEY/);
});

const FILL_97 = 82_450_000_000n;

test("97% and PumpSwap books share entries and do not invent a missed fill", () => {
  assert.equal(virtualSolFillPct(FILL_97), 97);
  assert.equal(virtualSolFillPct(VSOL), 92);
  assert.doesNotMatch(fs.readFileSync(path.join(paperDir, "..", "graduation.mjs"), "utf8"), /earlyExit|pumpswap-immediate/);

  const modified = createPaperSession();
  assert.equal(modified.trySignal({ mint: "high", ...reserves(FILL_97) }, 0).reason, "at_or_above_exit_threshold");

  const books = createComparison();
  assert.equal(books.pre.config.strategy, "exit-at-97");
  assert.equal(books.pre.config.exactOriginal, false);
  assert.equal(books.post.config.strategy, "pumpswap-immediate");
  assert.equal(books.pre.snapshot().startingBalance.sol, "10.000000000");
  assert.equal(books.post.snapshot().startingBalance.sol, "10.000000000");

  const opened = books.trySignal({ mint: "same", ...reserves() }, 0);
  assert.equal(opened.pre.accepted, true);
  assert.equal(opened.post.accepted, true);

  const crossed = books.observe("same", { complete: false, ...reserves(FILL_97), slot: 10 }, 1_000);
  assert.equal(crossed.pre.reason, "early_exit");
  assert.equal(crossed.pre.modelMark.backfilledToThreshold, false);
  assert.equal(crossed.pre.modelMark.observedFillPct, 97);
  assert.equal(crossed.pre.modelMark.onChainSell, false);
  assert.notEqual(crossed.pre.modelMark.faithful.pnl.lamports, crossed.pre.modelMark.improved.pnl.lamports);
  assert.equal(crossed.post.reason, "hold");
  const past = createComparison();
  past.trySignal({ mint: "past", ...reserves() }, 0);
  const overFill = past.observe("past", { complete: false, virtualSolReserves: 85_000_000_000n, virtualTokenReserves: VTOK, slot: 3 }, 1_000);
  assert.equal(overFill.pre.reason, "hold");
  assert.equal(past.pre.snapshot().ledgers.improved.modelMarkPnl.sol, "0.000000000");
  assert.equal(books.post.snapshot().ledgers.improved.modelMarkPnl.sol, "0.000000000");

  const jumped = createComparison();
  jumped.trySignal({ mint: "gap", ...reserves() }, 0);
  const overshot = jumped.observe("gap", {
    complete: true,
    virtualSolReserves: VSOL * 5n,
    virtualTokenReserves: VTOK,
    slot: 20,
  }, 2_000);
  assert.equal(overshot.pre.reason, "unpriceable");
  assert.equal(overshot.pre.missedEarlyExit, true);
  assert.equal(overshot.pre.modelMark, null);
  assert.equal(jumped.pre.snapshot().ledgers.faithful.modelMarkPnl.sol, "0.000000000");
  assert.equal(jumped.pre.snapshot().ledgers.faithful.cash.sol, "9.900000000");
  assert.equal(overshot.post.reason, "pending_pool");
  assert.equal(overshot.post.modelPnlBooked, false);
  assert.equal(jumped.observePool("gap", { status: "executable", validated: true, slot: 19, userQuoteLamports: 200_000_000n }, 3_000).poolStatus, "stale_or_lookahead");
  assert.equal(jumped.post.snapshot().ledgers.improved.modelMarkPnl.sol, "0.000000000");
  const unread = jumped.observePool("gap", { status: "missing_pool", validated: false, slot: 21 }, 4_000);
  assert.equal(unread.reason, "pending_pool");
  assert.equal(unread.modelMark, null);
  const sold = jumped.observePool("gap", {
    status: "executable",
    validated: true,
    slot: 21,
    userQuoteLamports: 90_000_000n,
    lpFeeLamports: 1n,
    protocolFeeLamports: 1n,
    creatorFeeLamports: 1n,
    formula: "pump-swap-sdk-2.2.0 sellBaseInput",
  }, 5_000);
  assert.equal(sold.reason, "pumpswap_immediate_exit");
  assert.equal(sold.modelMark.spotFormulaUsed, false);
  assert.equal(sold.modelMark.improved.pnl.lamports, "-10000000");
  assert.equal(sold.onChainSell, false);
  assert.equal(jumped.pre.snapshot().stats.pumpswapExits, 0);
  assert.equal(jumped.observePool("gap", { status: "executable", validated: true, slot: 5, userQuoteLamports: 1n }, 6_000).reason, "no_position");

  const timed = createComparison();
  timed.trySignal({ mint: "slow", ...reserves() }, 0);
  timed.observe("slow", { complete: true, ...reserves(), slot: 4 }, 1_000);
  const missed = timed.observePool("slow", { status: "rate_limited", validated: false, slot: 4 }, 301_000);
  assert.equal(missed.reason, "missed_exit");
  assert.equal(missed.modelPnlBooked, false);
  assert.equal(timed.post.snapshot().ledgers.improved.cash.sol, "9.900000000");
  assert.equal(timed.post.snapshot().active[0].slotLocked, true);

  const raw = (50_000n * 100n) / 1_100n;
  const quoted = sellBaseQuote({
    baseIn: 100n,
    baseReserve: 1_000n,
    quoteReserve: 50_000n,
    lpFeeBps: 20n,
    protocolFeeBps: 5n,
    creatorFeeBps: 5n,
    coinCreatorIsDefault: false,
  });
  assert.equal(quoted.quoteOut, raw);
  assert.equal(quoted.lpFee, feeCeil(raw, 20n));
  assert.equal(quoted.userQuote, raw - feeCeil(raw, 20n) - feeCeil(raw, 5n) - feeCeil(raw, 5n));
  assert.equal(sellBaseQuote({ baseIn: 1n, baseReserve: 0n, quoteReserve: 1n, lpFeeBps: 1n, protocolFeeBps: 1n, creatorFeeBps: 1n, coinCreatorIsDefault: true }), null);

  const mint = new PublicKey("7LSsEoJGhLeZzGvDofTdNg7M3JttxQqGWNLo6vWMpump");
  const derived = canonicalPoolAddress(mint.toBase58());
  const baseVault = new PublicKey("5jMpkf4JF4noHftLgNKyPNh6roVfPSGSjuEk3U4eLKRa").toBase58();
  const quoteVault = new PublicKey("43DVcZR4kQFjh4Xm2i3DcneRxNjZp7HMud8yDrJWrDr8").toBase58();
  const poolData = Buffer.alloc(8 + 1 + 2 + 32 * 6 + 8 + 32);
  POOL_DISC.copy(poolData, 0);
  poolData[8] = derived.bump;
  poolData.writeUInt16LE(0, 9);
  let cursor = 11;
  for (const key of [derived.authority, mint.toBase58(), WSOL_MINT, mint.toBase58(), baseVault, quoteVault]) {
    new PublicKey(key).toBuffer().copy(poolData, cursor);
    cursor += 32;
  }
  poolData.writeBigUInt64LE(1n, cursor);
  cursor += 8;
  new PublicKey(derived.authority).toBuffer().copy(poolData, cursor);
  const vault = (which, amount) => {
    const data = Buffer.alloc(165);
    new PublicKey(which === "base" ? mint : WSOL_MINT).toBuffer().copy(data, 0);
    new PublicKey(derived.address).toBuffer().copy(data, 32);
    data.writeBigUInt64LE(amount, 64);
    return { address: which === "base" ? baseVault : quoteVault, owner: TOKEN_PROGRAM_ID, data };
  };
  const mintData = Buffer.alloc(82);
  mintData.writeBigUInt64LE(1_000_000_000_000_000n, 36);
  const global = Buffer.alloc(8 + 313);
  GLOBAL_CONFIG_DISC.copy(global, 0);
  global.writeBigUInt64LE(20n, 40);
  global.writeBigUInt64LE(5n, 48);
  global.writeBigUInt64LE(5n, 8 + 305);
  const fees = Buffer.alloc(8 + 1 + 32 + 24 + 4 + 16 + 24 + 4 + 24);
  FEE_CONFIG_DISC.copy(fees, 0);
  let feeCursor = 8 + 1 + 32 + 24;
  fees.writeUInt32LE(1, feeCursor);
  feeCursor += 4 + 16;
  fees.writeBigUInt64LE(20n, feeCursor);
  fees.writeBigUInt64LE(5n, feeCursor + 8);
  fees.writeBigUInt64LE(5n, feeCursor + 16);
  feeCursor += 24;
  fees.writeUInt32LE(0, feeCursor);
  const accounts = {
    mint: mint.toBase58(),
    baseIn: 1_000_000n,
    poolAccount: { address: derived.address, owner: PUMP_AMM_PROGRAM_ID, data: poolData },
    baseVault: vault("base", 2_000_000_000_000n),
    quoteVault: vault("quote", 5_000_000_000n),
    baseMintAccount: { address: mint.toBase58(), owner: TOKEN_PROGRAM_ID, data: mintData },
    globalConfigAccount: { address: "global", owner: PUMP_AMM_PROGRAM_ID, data: global },
    feeConfigAccount: { address: "fees", owner: PUMP_FEE_PROGRAM_ID, data: fees },
  };
  const ok = assessPoolAccounts(accounts);
  assert.equal(ok.status, "executable", ok.status);
  assert.equal(ok.validated, true);
  assert.equal(ok.quote.userQuote > 0n, true);
  assert.equal(assessPoolAccounts({ ...accounts, baseVault: vault("base", 0n), quoteVault: vault("quote", 5n) }).status, "zero_liquidity");
  const wrong = Buffer.from(poolData);
  wrong.writeUInt16LE(1, 9);
  assert.equal(assessPoolAccounts({ ...accounts, poolAccount: { ...accounts.poolAccount, data: wrong } }).status, "not_canonical_migration_pool");
  assert.equal(assessPoolAccounts({ ...accounts, poolAccount: null }).status, "missing_pool");

  const full = createComparison();
  for (let i = 0; i < 3; i++) {
    const at = i * 30_000;
    const decision = full.trySignal({ mint: `C${i}`, ...reserves() }, at);
    assert.equal(decision.pre.accepted, true);
    assert.equal(decision.post.accepted, true);
  }
  assert.equal(full.trySignal({ mint: "C3", ...reserves() }, 90_000).pre.reason, "max_positions");
  full.observe("C0", { complete: false, ...reserves(FILL_97), slot: 1 }, 91_000);
  assert.equal(full.pre.snapshot().active.length, 2);
  assert.equal(full.post.snapshot().active.length, 3);
  assert.equal(full.trySignal({ mint: "C3", ...reserves() }, 121_000).pre.accepted, true);
  assert.equal(full.trySignal({ mint: "C4", ...reserves() }, 121_000).post.reason, "max_positions");
  assertLedgerConserved(full.pre.snapshot());
  assertLedgerConserved(full.post.snapshot());
});

test("relay handoff, missing pool, and delayed pool stay paper-only", () => {
  const dir = fs.mkdtempSync(path.join("/tmp", "grad-relay-"));
  const jsonl = path.join(dir, "handoff.jsonl");
  const book = createRelayBook({ policy: "immediate", poolFindTimeoutSec: 180, jsonlPath: jsonl });
  assert.equal(book.trySignal({ mint: "grad", ...reserves() }, 1_000).accepted, true);
  const sl = book.observe("grad", { complete: false, ...reserves(50_000_000_000n) }, 2_000);
  assert.equal(sl.reason, "stop_loss");
  assert.equal(sl.modelMark.onChainSell, false);
  assert.equal(book.buyer.snapshot().stats.handoffs, 0);

  book.trySignal({ mint: "late", ...reserves() }, 40_000);
  const hand = book.observe("late", { complete: true, ...reserves(90_000_000_000n), slot: 50 }, 41_000);
  assert.equal(hand.reason, "handoff");
  assert.equal(hand.modelPnlBooked, false);
  assert.equal(hand.handoff.mint, "late");
  assert.equal(hand.handoff.graduationSlot, 50);
  assert.equal(book.buyer.snapshot().stats.handoffs, 1);
  const lines = readRelay(jsonl);
  assert.equal(lines.some((line) => line.type === "handoff" && line.mint === "late"), true);
  assert.equal(lines.some((line) => line.type === "ack" && line.status === "accepted"), true);

  const missing = book.observePool("late", { status: "missing_pool", validated: false, slot: 51 }, 50_000);
  assert.equal(missing.reason, "seeking_pool");
  assert.equal(missing.modelPnlBooked, false);
  const needs = book.observePool("late", { status: "missing_pool", validated: false, slot: 80 }, 41_000 + 180_000);
  assert.equal(needs.reason, "needs_jupiter");
  const stuck = book.applyJupiter("late", { ok: false, reason: "no_route", latencyMs: 25 }, 41_000 + 180_000);
  assert.equal(stuck.modelMark.markToZero, true);
  assert.equal(stuck.modelMark.venue, "stuck");
  assert.equal(stuck.modelMark.pnlSol, "-0.100000000");
  assert.equal(stuck.onChainSell, false);
  assert.equal(book.report("B").stuck, 1);
  assert.equal(book.report("B").pumpswapSells, 0);

  const delayed = createRelayBook({ policy: "immediate", poolFindTimeoutSec: 180 });
  delayed.trySignal({ mint: "soon", ...reserves() }, 0);
  delayed.observe("soon", { complete: true, slot: 10, ...reserves() }, 5_000);
  assert.equal(delayed.observePool("soon", { status: "missing_pool", validated: false, slot: 11 }, 6_000).reason, "seeking_pool");
  const stale = delayed.observePool("soon", quoteView(1_000_000_000n, 9), 7_000);
  assert.equal(stale.reason, "seeking_pool");
  assert.equal(stale.poolStatus, "stale_or_lookahead");
  const sold = delayed.observePool("soon", {
    status: "executable",
    validated: true,
    slot: 12,
    userQuoteLamports: 130_000_000n,
    lpFeeLamports: 100n,
    protocolFeeLamports: 50n,
    creatorFeeLamports: 50n,
    formula: "pump-swap-sdk-2.2.0 sellBaseInput",
  }, 9_000);
  assert.equal(sold.reason, "pumpswap_immediate_exit");
  assert.equal(sold.modelMark.poolFoundLatencyMs, 4_000);
  assert.equal(sold.modelMark.pnlSol, "0.030000000");
  assert.equal(delayed.report("B").winRate, 1);
  assert.equal(delayed.observePool("soon", quoteView(1n, 13), 10_000).reason, "no_position");

  const wait = createRelayBook({ policy: "wait", waitSec: 120, poolFindTimeoutSec: 180 });
  wait.trySignal({ mint: "w", ...reserves() }, 0);
  wait.observe("w", { complete: true, slot: 3, ...reserves() }, 1_000);
  const held = wait.observePool("w", quoteView(110_000_000n, 4), 2_000);
  assert.equal(held.reason, "waiting_tp_sl");
  const tp = wait.observePool("w", quoteView(160_000_000n, 5), 30_000);
  assert.equal(tp.reason, "pumpswap_take_profit");
  assert.equal(tp.onChainSell, false);
  assertLedgerConserved(book.buyer.snapshot());
  assertLedgerConserved(delayed.buyer.snapshot());

  const fallback = createRelayBook({ policy: "immediate", poolFindTimeoutSec: 30 });
  fallback.trySignal({ mint: "Fb1111111111111111111111111111111111111111", ...reserves() }, 0);
  fallback.observe("Fb1111111111111111111111111111111111111111", { complete: true, slot: 2, ...reserves() }, 1_000);
  assert.equal(fallback.observePool("Fb1111111111111111111111111111111111111111", { status: "missing_pool", validated: false, slot: 3 }, 40_000).reason, "needs_jupiter");
  const viaJupiter = fallback.applyJupiter("Fb1111111111111111111111111111111111111111", {
    ok: true,
    outAmountLamports: "125000000",
    priceImpactPct: "0.12",
    platformFee: { amount: "1000", feeBps: 1 },
    routeFees: [{ label: "Pump", feeAmount: "20", feeMint: "So11111111111111111111111111111111111111112" }],
    latencyMs: 80,
    slippageBps: 50,
    formula: "jupiter-lite-quote-v1-outAmount",
  }, 41_000);
  assert.equal(viaJupiter.reason, "jupiter_immediate_exit");
  assert.equal(viaJupiter.modelMark.venue, "jupiter");
  assert.equal(viaJupiter.modelMark.quoteLatencyMs, 80);
  assert.equal(viaJupiter.modelMark.priceImpactPct, "0.12");
  assert.equal(viaJupiter.modelMark.pnlSol, "0.025000000");
  assert.equal(viaJupiter.onChainSell, false);
  assert.equal(fallback.report("B").jupiterSells, 1);
  assert.equal(fallback.report("B").pumpswapSells, 0);

  const none = createRelayBook({ policy: "immediate", poolFindTimeoutSec: 30 });
  none.trySignal({ mint: "none", ...reserves() }, 0);
  none.observe("none", { complete: true, slot: 4, ...reserves() }, 1_000);
  none.observePool("none", { status: "zero_liquidity", validated: false, slot: 5 }, 2_000);
  const noRoute = none.applyJupiter("none", parseJupiterQuote({ error: "No routes found", errorCode: "NO_ROUTES_FOUND" }, 15, 400), 2_100);
  assert.equal(noRoute.reason, "mark_to_zero");
  assert.equal(noRoute.modelMark.venue, "stuck");
  assert.equal(noRoute.modelMark.reason, "jupiter_no_route");
  assert.throws(() => assertQuoteRequest(new URL("/swap/v1/swap", JUPITER_QUOTE_ORIGIN), "GET"));
  assert.throws(() => assertQuoteRequest(new URL("https://quote-api.jup.ag/swap/v1/quote"), "GET"));
  assert.throws(() => assertQuoteRequest(new URL("/swap/v1/quote", JUPITER_QUOTE_ORIGIN), "POST"));
});

test("jupiter-direct books the first route, waits through a delay, and zeroes a no-route", () => {
  const found = createRelayBook({ policy: "jupiter-direct" });
  found.trySignal({ mint: "jd", ...reserves() }, 0);
  const hand = found.observe("jd", { complete: true, slot: 8, ...reserves() }, 1_000);
  assert.equal(hand.reason, "handoff");
  assert.equal(hand.modelPnlBooked, false);
  const sold = found.seller.offerJupiter("jd", {
    ok: true,
    outAmountLamports: "110000000",
    priceImpactPct: "1.5",
    platformFee: { amount: "10", feeBps: 1 },
    routeFees: [{ label: "Pump.fun Amm", feeAmount: "5", feeMint: "So11111111111111111111111111111111111111112" }],
    latencyMs: 40,
    slippageBps: 50,
    formula: "jupiter-lite-quote-v1-outAmount",
  }, 1_400);
  assert.equal(sold.reason, "jupiter_direct_exit");
  assert.equal(sold.modelMark.venue, "jupiter");
  assert.equal(sold.modelMark.quoteLatencyMs, 40);
  assert.equal(sold.modelMark.firstRouteDelayMs, 400);
  assert.deepEqual(sold.modelMark.routeVenues, ["Pump.fun Amm"]);
  assert.equal(sold.modelMark.pnlSol, "0.010000000");
  assert.equal(sold.onChainSell, false);
  assert.equal(found.report("D").jupiterSells, 1);
  assert.equal(found.report("D").pumpswapSells, 0);

  const delayed = createRelayBook({ policy: "jupiter-direct" });
  delayed.trySignal({ mint: "slow", ...reserves() }, 0);
  delayed.observe("slow", { complete: true, slot: 3, ...reserves() }, 2_000);
  const waiting = delayed.seller.offerJupiter("slow", { ok: false, reason: "no_route", latencyMs: 20 }, 2_500);
  assert.equal(waiting.reason, "awaiting_route");
  assert.equal(waiting.modelPnlBooked, false);
  const later = delayed.seller.offerJupiter("slow", {
    ok: true,
    outAmountLamports: "90000000",
    priceImpactPct: "0.2",
    routeFees: [{ label: "Pump.fun Amm", feeAmount: null, feeMint: null }],
    latencyMs: 55,
    formula: "jupiter-lite-quote-v1-outAmount",
  }, 3_200);
  assert.equal(later.reason, "jupiter_direct_exit");
  assert.equal(later.modelMark.quoteAttempts, 2);
  assert.equal(later.modelMark.firstRouteDelayMs, 1_200);
  assert.equal(later.modelMark.pnlSol, "-0.010000000");

  const none = createRelayBook({ policy: "jupiter-direct" });
  none.trySignal({ mint: "gone", ...reserves() }, 0);
  none.observe("gone", { complete: true, slot: 1, ...reserves() }, 10_000);
  const still = none.seller.offerJupiter("gone", { ok: false, reason: "no_route", latencyMs: 10 }, 20_000);
  assert.equal(still.reason, "awaiting_route");
  const stuck = none.seller.offerJupiter("gone", { ok: false, reason: "no_route", latencyMs: 12 }, 70_000);
  assert.equal(stuck.reason, "mark_to_zero");
  assert.equal(stuck.modelMark.venue, "stuck");
  assert.equal(stuck.modelMark.pnlSol, "-0.100000000");
  assert.equal(none.report("D").stuck, 1);
  assert.equal(none.report("D").jupiterSells, 0);
});

function quoteView(userQuoteLamports, slot) {
  return {
    status: "executable",
    validated: true,
    slot,
    userQuoteLamports,
    lpFeeLamports: 1n,
    protocolFeeLamports: 1n,
    creatorFeeLamports: 1n,
    formula: "pump-swap-sdk-2.2.0 sellBaseInput",
  };
}
