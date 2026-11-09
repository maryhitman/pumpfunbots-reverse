#!/usr/bin/env node
// PumpSwap seller process. Consumes a JSONL relay and marks paper sells only. No broadcast.

import fs from "node:fs";
import { readRelay } from "./relay.mjs";
import { createSeller } from "./seller.mjs";

const banned = ["--live", "--send", "--broadcast", "--wallet", "--keypair", "--sign"];
for (const flag of process.argv) {
  if (banned.includes(flag)) {
    console.error(`[PAPER SELLER] REFUSED: ${flag}`);
    process.exit(2);
  }
}
function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}
const jsonl = arg("--relay-jsonl");
const poolsPath = arg("--pools");
const policy = arg("--sell-policy") ?? "immediate";
if (!jsonl || !poolsPath) {
  console.error("Usage: node bots/graduation-sniper/paper/seller-bot.mjs --relay-jsonl <file> --pools <pools.json> [--sell-policy immediate|wait] [--wait-sec 120]");
  process.exit(2);
}
const seller = createSeller({
  policy,
  waitSec: Number(arg("--wait-sec") ?? 120),
  poolFindTimeoutSec: Number(arg("--pool-find-sec") ?? 180),
});
for (const record of readRelay(jsonl)) {
  if (record.type === "handoff") seller.accept(record, record.graduatedAtMs);
}
const pools = JSON.parse(fs.readFileSync(poolsPath, "utf8"));
let last = 0;
for (const event of pools.events ?? []) {
  last = event.atMs;
  seller.observePool(event.mint, event.view, event.atMs);
}
seller.settle(last);
const snap = seller.snapshot();
console.log(`[PAPER SELLER] sells=${snap.stats.sells} stuck=${snap.stats.stuck} feeAdjustedPnl=${snap.feeAdjustedPnl.sol}`);
