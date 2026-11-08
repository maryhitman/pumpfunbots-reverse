// Paper-only constants. Strategy numbers match graduation.mjs defaults.
// The virtual balance is not a wallet and is not spendable on-chain.

export const LAMPORTS_PER_SOL = 1_000_000_000n;

export const STRATEGY_DEFAULTS = Object.freeze({
  buySol: 0.1,
  minFillPct: 92,
  virtualSolAtGraduationLamports: 85_000_000_000n,
  takeProfitMultiple: 1.5,
  stopLossMultiple: 0.7,
  timeoutSec: 300,
  maxPositions: 3,
  cooldownSec: 30,
  pollMs: 3000,
});

export const PAPER_ASSUMPTIONS = Object.freeze({
  startingVirtualSol: 10,
  balanceKind: "VIRTUAL_PAPER_SOL",
  notAWallet: true,
  notOnChain: true,
  withdrawable: false,
  repoCurveFeeDenominator: 100n,
});

export const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

export const ASSUMPTION_LINES = Object.freeze([
  "Starting cash is a virtual 10 SOL paper balance. It is not a wallet, not a funded account, not on-chain, and not withdrawable.",
  "No order is placed. Opens and exits are counterfactual model marks. on-chain realized PnL is always null and successful on-chain sells are always zero.",
  "Triggers follow graduation.mjs defaults: buy at 92% to under 100% of 85 virtual SOL, size 0.1 SOL, take-profit 1.5x, stop-loss 0.7x, timeout 300s, 3 positions, 30s cooldown. The multiple is the pre-trade spot ratio.",
  "The faithful ledger marks an in-curve exit at that spot ratio with no fee and no price impact. That is the original dry-run formula, and it is optimistic versus a curve fill.",
  "The improved ledger uses the repository formulas in calcBuyTokens and calcSellSol, including their truncating 1% fee (amount/100). That is this repo's formula, not a claim about the live pump.fun fee schedule.",
  "The improved exit sells the simulated token amount into reserves observed later. It does not inject the paper buy into those reserves and it does not replay other traders onto a private curve.",
  "A missing curve, a completed curve, or unreadable reserves is unpriceable. The slot stays locked, virtual cash stays reserved, and neither ledger books a mark. No PumpSwap price is invented.",
  "Public reads are Solana JSON-RPC getSlot, getAccountInfo, and logsSubscribe on the public endpoints in the report. They can be delayed, incomplete, or rate-limited.",
  "Priority fees, Jito tips, slippage, and landing failure are not modeled. The original live path attaches a tip and a compute budget; this package does not build those transactions.",
]);

export const LIMITATION_LINES = Object.freeze([
  "Model marks are not realized profits and are not evidence of a successful sell.",
  "Any unpriceable or still-open position means the model PnL is an incomplete picture.",
  "The 1% fee is copied from this repository's bonding-curve helpers.",
  "The public run is bounded and is not a daemon. A failed socket is reported and not retried forever.",
  "A public logsSubscribe can be rejected or silent. That is a data-access result, not a trading result.",
  "Environment strategy overrides are ignored. Key material refuses the process. Neither one enables live execution.",
]);

export function solToLamports(sol) {
  if (typeof sol === "bigint") {
    if (sol < 0n) throw new Error(`invalid SOL amount: ${sol}`);
    return sol;
  }
  if (typeof sol !== "number" || !Number.isFinite(sol) || sol < 0) {
    throw new Error(`invalid SOL amount: ${sol}`);
  }
  const [whole, frac = ""] = sol.toFixed(9).split(".");
  return BigInt(`${whole}${frac.padEnd(9, "0").slice(0, 9)}`);
}

export function lamportsToSolString(lamports) {
  if (typeof lamports !== "bigint") throw new Error("lamports must be bigint");
  const neg = lamports < 0n;
  const v = neg ? -lamports : lamports;
  const whole = v / LAMPORTS_PER_SOL;
  const frac = (v % LAMPORTS_PER_SOL).toString().padStart(9, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}
