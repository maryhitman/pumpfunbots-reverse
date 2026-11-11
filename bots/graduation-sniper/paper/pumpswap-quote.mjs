// Read-only PumpSwap quote. Formulas follow the published SDK
// @pump-fun/pump-swap-sdk 2.2.0 (sellBaseInput, fee, computeFeesBps, poolMarketCap)
// and the account layouts in pump-fun/pump-public-docs idl/pump_amm.json.
// This module does not build, sign, or send transactions.

import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";

export const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMP_AMM_PROGRAM_ID = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
export const PUMP_FEE_PROGRAM_ID = "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const MAYHEM_SUPPLY = 1_000_000_000_000_000n;
const DEFAULT_PUBKEY = "11111111111111111111111111111111";

const disc = (name) => createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
export const POOL_DISC = disc("Pool");
export const GLOBAL_CONFIG_DISC = disc("GlobalConfig");
export const FEE_CONFIG_DISC = disc("FeeConfig");

export function pumpPoolAuthority(mint) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool-authority"), new PublicKey(mint).toBuffer()],
    new PublicKey(PUMP_PROGRAM_ID),
  )[0].toBase58();
}

export function canonicalPoolAddress(mint) {
  const authority = new PublicKey(pumpPoolAuthority(mint));
  const [pool, bump] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("pool"),
      Buffer.from([0, 0]),
      authority.toBuffer(),
      new PublicKey(mint).toBuffer(),
      new PublicKey(WSOL_MINT).toBuffer(),
    ],
    new PublicKey(PUMP_AMM_PROGRAM_ID),
  );
  return { address: pool.toBase58(), bump, authority: authority.toBase58() };
}

export function globalConfigAddress() {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("global_config")],
    new PublicKey(PUMP_AMM_PROGRAM_ID),
  )[0].toBase58();
}

export function feeConfigAddress() {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("fee_config"), new PublicKey(PUMP_AMM_PROGRAM_ID).toBuffer()],
    new PublicKey(PUMP_FEE_PROGRAM_ID),
  )[0].toBase58();
}

function readU128(buf, offset) {
  return buf.readBigUInt64LE(offset) + (buf.readBigUInt64LE(offset + 8) << 64n);
}

function readFees(buf, offset) {
  return {
    lpFeeBps: buf.readBigUInt64LE(offset),
    protocolFeeBps: buf.readBigUInt64LE(offset + 8),
    creatorFeeBps: buf.readBigUInt64LE(offset + 16),
  };
}

function ceilDiv(numerator, denominator) {
  if (denominator <= 0n) throw new Error("bad divisor");
  return (numerator + denominator - 1n) / denominator;
}

export function feeCeil(amount, bps) {
  return ceilDiv(amount * bps, 10_000n);
}

function pubkeyAt(buf, offset) {
  return new PublicKey(buf.subarray(offset, offset + 32)).toBase58();
}

export function decodeGlobalConfig(data) {
  if (data.length < 8 + 313 || !data.subarray(0, 8).equals(GLOBAL_CONFIG_DISC)) return null;
  const creatorFeeConfigurable = data.length >= 8 + 933 ? data[8 + 932] === 1 : false;
  return {
    lpFeeBasisPoints: data.readBigUInt64LE(8 + 32),
    protocolFeeBasisPoints: data.readBigUInt64LE(8 + 40),
    coinCreatorFeeBasisPoints: data.readBigUInt64LE(8 + 305),
    creatorFeeConfigurable,
  };
}

export function decodeFeeConfig(data) {
  if (data.length < 8 + 1 + 32 + 24 + 4 || !data.subarray(0, 8).equals(FEE_CONFIG_DISC)) return null;
  let offset = 8 + 1 + 32;
  const flatFees = readFees(data, offset);
  offset += 24;
  const tiers = readTiers(data, offset);
  if (!tiers) return null;
  offset = tiers.end;
  const stable = readTiers(data, offset);
  if (!stable) return null;
  offset = stable.end;
  if (offset + 24 > data.length) return null;
  return {
    flatFees,
    feeTiers: tiers.items,
    stableFeeTiers: stable.items,
    exoticFlatFees: readFees(data, offset),
  };
}

function readTiers(buf, offset) {
  if (offset + 4 > buf.length) return null;
  const count = buf.readUInt32LE(offset);
  offset += 4;
  if (count > 64) return null;
  const items = [];
  for (let i = 0; i < count; i++) {
    if (offset + 16 + 24 > buf.length) return null;
    const marketCapLamportsThreshold = readU128(buf, offset);
    offset += 16;
    items.push({ marketCapLamportsThreshold, fees: readFees(buf, offset) });
    offset += 24;
  }
  return { items, end: offset };
}

export function decodePool(data) {
  const min = 8 + 1 + 2 + 32 * 6 + 8 + 32;
  if (data.length < min || !data.subarray(0, 8).equals(POOL_DISC)) return null;
  let offset = 8;
  const poolBump = data[offset];
  offset += 1;
  const index = data.readUInt16LE(offset);
  offset += 2;
  const creator = pubkeyAt(data, offset);
  offset += 32;
  const baseMint = pubkeyAt(data, offset);
  offset += 32;
  const quoteMint = pubkeyAt(data, offset);
  offset += 32;
  const lpMint = pubkeyAt(data, offset);
  offset += 32;
  const poolBaseTokenAccount = pubkeyAt(data, offset);
  offset += 32;
  const poolQuoteTokenAccount = pubkeyAt(data, offset);
  offset += 32;
  const lpSupply = data.readBigUInt64LE(offset);
  offset += 8;
  const coinCreator = pubkeyAt(data, offset);
  offset += 32;
  const flag = (name, size) => {
    if (offset + size > data.length) return 0;
    const value = size === 1 ? data[offset] : null;
    offset += size;
    return value;
  };
  const isMayhemMode = offset < data.length ? data[offset] === 1 : false;
  offset += offset <= data.length ? 1 : 0;
  if (offset > data.length) {
    return {
      poolBump, index, creator, baseMint, quoteMint, lpMint,
      poolBaseTokenAccount, poolQuoteTokenAccount, lpSupply, coinCreator,
      isMayhemMode: false, isCashbackCoin: false, virtualQuoteReserves: 0n,
      creatorFeeBps: 0n, protocolFees: 0n, creatorFees: 0n,
    };
  }
  // The increment above already consumed is_mayhem_mode. Rewind if we overshot a short account.
  return finishPool(data, {
    poolBump, index, creator, baseMint, quoteMint, lpMint,
    poolBaseTokenAccount, poolQuoteTokenAccount, lpSupply, coinCreator,
  });
}

function finishPool(data, head) {
  // Re-read trailing fields from a fixed offset so short historical pools stay defined.
  const tail = 8 + 1 + 2 + 32 * 6 + 8 + 32;
  const readBool = (at) => (data.length > at ? data[at] === 1 : false);
  const readU64 = (at) => (data.length >= at + 8 ? data.readBigUInt64LE(at) : 0n);
  const readI128 = (at) => {
    if (data.length < at + 16) return 0n;
    const value = readU128(data, at);
    const sign = data[at + 15] & 0x80;
    if (sign) return null;
    return value;
  };
  return {
    ...head,
    isMayhemMode: readBool(tail),
    isCashbackCoin: readBool(tail + 1),
    virtualQuoteReserves: readI128(tail + 2),
    creatorFeeBps: readU64(tail + 18),
    protocolFees: readU64(tail + 18 + 8 + 1 + 1),
    creatorFees: readU64(tail + 18 + 8 + 1 + 1 + 8),
  };
}

export function tokenAmount(data) {
  if (!data || data.length < 72) return null;
  return {
    mint: pubkeyAt(data, 0),
    owner: pubkeyAt(data, 32),
    amount: data.readBigUInt64LE(64),
  };
}

export function mintSupply(data) {
  if (!data || data.length < 36 + 8) return null;
  return data.readBigUInt64LE(36);
}

const TRANSFER_FEE_CONFIG = 1;

export function baseTransferFeeBps(data) {
  if (!data || data.length <= 165) return 0n;
  if (data.length < 166 || data[165] !== 1) return null;
  let offset = 166;
  while (offset + 4 <= data.length) {
    const type = data.readUInt16LE(offset);
    const len = data.readUInt16LE(offset + 2);
    offset += 4;
    if (offset + len > data.length) return null;
    if (type === TRANSFER_FEE_CONFIG) {
      if (len < 32 + 32 + 8 + 8 + 8 + 2 + 8 + 8 + 2) return null;
      const older = data.readUInt16LE(offset + 32 + 32 + 8 + 8 + 8);
      const newer = data.readUInt16LE(offset + 32 + 32 + 8 + 8 + 8 + 2 + 8 + 8);
      return BigInt(Math.max(older, newer));
    }
    offset += len;
  }
  return 0n;
}

function feeTier(tiers, marketCap) {
  if (!tiers.length) return null;
  const first = tiers[0];
  if (marketCap < first.marketCapLamportsThreshold) return first.fees;
  for (let i = tiers.length - 1; i >= 0; i--) {
    if (marketCap >= tiers[i].marketCapLamportsThreshold) return tiers[i].fees;
  }
  return first.fees;
}

export function sellBaseQuote({
  baseIn,
  baseReserve,
  quoteReserve,
  virtualQuoteReserves = 0n,
  feeBuckets = 0n,
  lpFeeBps,
  protocolFeeBps,
  creatorFeeBps,
  coinCreatorIsDefault,
}) {
  if (baseReserve <= 0n || quoteReserve <= 0n || baseIn <= 0n) return null;
  if (virtualQuoteReserves < 0n || feeBuckets < 0n) return null;
  const effective = quoteReserve + virtualQuoteReserves;
  const quoteOut = (effective * baseIn) / (baseReserve + baseIn);
  const lpFee = feeCeil(quoteOut, lpFeeBps);
  const protocolFee = feeCeil(quoteOut, protocolFeeBps);
  const creatorFee = coinCreatorIsDefault ? 0n : feeCeil(quoteOut, creatorFeeBps);
  const withoutLp = quoteOut - lpFee;
  const real = quoteReserve - feeBuckets;
  if (withoutLp < 0n || real < withoutLp) return null;
  const userQuote = withoutLp - protocolFee - creatorFee;
  if (userQuote < 0n) return null;
  return { quoteOut, lpFee, protocolFee, creatorFee, userQuote, effectiveQuoteReserve: effective };
}

function refused(status) {
  return { status, validated: false, quote: null };
}

export function assessPoolAccounts(input) {
  const poolInfo = input.poolAccount;
  if (!poolInfo) return refused("missing_pool");
  if (poolInfo.owner !== PUMP_AMM_PROGRAM_ID) return refused("wrong_owner");
  const pool = decodePool(poolInfo.data);
  if (!pool || pool.virtualQuoteReserves == null) return refused("layout_short");
  const expected = canonicalPoolAddress(input.mint);
  if (poolInfo.address !== expected.address || pool.poolBump !== expected.bump) return refused("wrong_pool_pda");
  if (pool.index !== 0 || pool.creator !== expected.authority) return refused("not_canonical_migration_pool");
  if (pool.baseMint !== input.mint) return refused("wrong_mint");
  if (pool.quoteMint !== WSOL_MINT) return refused("wrong_quote_mint");
  const base = tokenAmount(input.baseVault?.data);
  const quote = tokenAmount(input.quoteVault?.data);
  if (!base || !quote) return refused("vault_unreadable");
  if (input.baseVault.owner !== TOKEN_PROGRAM_ID && input.baseVault.owner !== TOKEN_2022_PROGRAM_ID) {
    return refused("vault_owner");
  }
  if (input.quoteVault.owner !== TOKEN_PROGRAM_ID && input.quoteVault.owner !== TOKEN_2022_PROGRAM_ID) {
    return refused("vault_owner");
  }
  if (base.mint !== pool.baseMint || base.owner !== expected.address || input.baseVault.address !== pool.poolBaseTokenAccount) {
    return refused("base_vault_mismatch");
  }
  if (quote.mint !== pool.quoteMint || quote.owner !== expected.address || input.quoteVault.address !== pool.poolQuoteTokenAccount) {
    return refused("quote_vault_mismatch");
  }
  if (base.amount <= 0n || quote.amount <= 0n) return refused("zero_liquidity");
  const transferBps = input.baseMintAccount ? baseTransferFeeBps(input.baseMintAccount.data) : 0n;
  if (transferBps == null) return refused("transfer_fee_unverified");
  if (transferBps > 0n) return refused("transfer_fee_unverified");
  const global = input.globalConfigAccount ? decodeGlobalConfig(input.globalConfigAccount.data) : null;
  const feeConfig = input.feeConfigAccount ? decodeFeeConfig(input.feeConfigAccount.data) : null;
  if (!global || !feeConfig || input.globalConfigAccount.owner !== PUMP_AMM_PROGRAM_ID) return refused("fee_unverified");
  if (input.feeConfigAccount.owner !== PUMP_FEE_PROGRAM_ID) return refused("fee_unverified");
  const supply = pool.isMayhemMode ? MAYHEM_SUPPLY : mintSupply(input.baseMintAccount?.data);
  if (supply == null || supply <= 0n) return refused("fee_unverified");
  const effectiveQuote = quote.amount + pool.virtualQuoteReserves;
  const marketCap = (effectiveQuote * supply) / base.amount;
  const tier = feeTier(feeConfig.feeTiers, marketCap);
  if (!tier) return refused("fee_unverified");
  let creatorFeeBps = tier.creatorFeeBps;
  if (global.creatorFeeConfigurable && pool.creatorFeeBps > 0n) creatorFeeBps = pool.creatorFeeBps;
  const quoteMath = sellBaseQuote({
    baseIn: input.baseIn,
    baseReserve: base.amount,
    quoteReserve: quote.amount,
    virtualQuoteReserves: pool.virtualQuoteReserves,
    feeBuckets: pool.protocolFees + pool.creatorFees,
    lpFeeBps: tier.lpFeeBps,
    protocolFeeBps: tier.protocolFeeBps,
    creatorFeeBps,
    coinCreatorIsDefault: pool.coinCreator === DEFAULT_PUBKEY,
  });
  if (!quoteMath) return refused("insufficient_real_reserves");
  return {
    status: "executable",
    validated: true,
    quote: {
      ...quoteMath,
      userQuoteLamports: quoteMath.userQuote,
      lpFeeBps: tier.lpFeeBps,
      protocolFeeBps: tier.protocolFeeBps,
      creatorFeeBps,
      marketCapLamports: marketCap,
      rule: "immediate_post_graduation_pool_exit",
      formula: "pump-swap-sdk-2.2.0 sellBaseInput",
    },
  };
}
