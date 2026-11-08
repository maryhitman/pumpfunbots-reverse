import { PublicKey } from "@solana/web3.js";
import { BUY_INSTRUCTIONS, TRADE_EVENT_PREFIX } from "../../../lib/constants.mjs";

// Same buy-log selection as graduation.mjs: success, a buy instruction name,
// then the first V3 trade event. Sells and failed transactions are ignored.

export function parsePumpLogValue(value) {
  if (!value?.logs) return null;
  const lastLog = value.logs[value.logs.length - 1] || "";
  if (!lastLog.includes("success")) return null;

  let isBuy = false;
  for (const line of value.logs) {
    const match = line.match(/Instruction: (\w+)/);
    if (match && BUY_INSTRUCTIONS.has(match[1])) {
      isBuy = true;
      break;
    }
  }
  if (!isBuy) return null;

  for (const line of value.logs) {
    if (!line.startsWith("Program data: ")) continue;
    const data = Buffer.from(line.slice(14), "base64");
    if (data.length < 129 || !data.subarray(0, 8).equals(TRADE_EVENT_PREFIX)) continue;
    try {
      return decodeTradeEvent(data);
    } catch {
      return null;
    }
  }
  return null;
}

export function decodeTradeEvent(data) {
  if (data.length < 129) return null;
  return {
    mint: new PublicKey(data.subarray(8, 40)).toBase58(),
    solAmount: Number(data.readBigUInt64LE(40)) / 1e9,
    tokenAmount: Number(data.readBigUInt64LE(48)) / 1e6,
    user: new PublicKey(data.subarray(57, 89)).toBase58(),
    virtualSolReserves: data.readBigUInt64LE(97),
    virtualTokenReserves: data.readBigUInt64LE(105),
    realSolReserves: data.readBigUInt64LE(113),
    realTokenReserves: data.readBigUInt64LE(121),
  };
}
