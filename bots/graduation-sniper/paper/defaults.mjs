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

// Paper-only. graduation.mjs has no early-exit threshold.
// 97% of the same 85 virtual-SOL graduation constant is the conservative default.
export const MODIFIED_EARLY_EXIT_FILL_PCT = 97;

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
  "The default paper strategy is modified, not the exact original. Entry stays at 92% of 85 virtual SOL. A new position is refused at or above the paper early-exit fill (default 97%). Size 0.1 SOL, take-profit 1.5x, stop-loss 0.7x, timeout 300s, 3 positions, and 30s cooldown still apply.",
  "Fill is virtualSolReserves / 85 SOL, the same definition graduation.mjs uses for the 92% entry. The 97% level is a paper threshold on that definition. It is not a pump.fun account field.",
  "A modified early exit is marked only when a curve read has complete=false and fill at or above the threshold. The mark uses those observed reserves. It is not rewritten to a 97% price when the read is higher.",
  "If the next curve read is graduated, missing, or unreadable, the early exit is missed. The position stays unpriceable, virtual cash stays reserved, and neither ledger books a fill or a profit.",
  "--strategy original is the comparison mode: entry from 92% to under 100%, with no 97% early exit. That mode is the original trigger set. The modified mode is not called exact.",
  "The faithful ledger marks an in-curve exit at the pre-trade spot ratio with no fee and no price impact. That formula is optimistic versus a curve fill.",
  "The improved ledger uses the repository formulas in calcBuyTokens and calcSellSol, including their truncating 1% fee (amount/100). That is this repo's formula, not a claim about the live pump.fun fee schedule.",
  "The improved exit sells the simulated token amount into the observed reserves. It does not inject the paper buy into those reserves and it does not replay other traders onto a private curve.",
  "Public reads are Solana JSON-RPC getSlot, getAccountInfo, and logsSubscribe on the public endpoints in the report. They can be delayed, incomplete, or rate-limited. A trade log does not by itself prove the curve is still incomplete, so it does not close a position.",
  "The PumpSwap book quotes with the published sellBaseInput formula from @pump-fun/pump-swap-sdk 2.2.0: constant product on effective quote reserves, ceil fees from the on-chain fee tiers, and real quote reserves net of fee buckets. A graduation flag alone is not a price. The pool PDA, owner, canonical creator, mints, vaults, nonzero liquidity, and fee accounts must validate on that read.",
  "Priority fees, Jito tips, slippage, and landing failure are not modeled. The original live path attaches a tip and a compute budget; this package does not build those transactions.",
]);

export const LIMITATION_LINES = Object.freeze([
  "Model marks are not realized profits, not proof of profitability, and not evidence of a successful sell.",
  "Any unpriceable or still-open position means the model PnL is an incomplete picture. A missed early exit reserves cash and adds no profit.",
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
