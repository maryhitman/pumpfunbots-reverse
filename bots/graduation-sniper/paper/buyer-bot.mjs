#!/usr/bin/env node
// Curve buyer process. Publishes graduation handoffs to a JSONL relay. Paper only.

import fs from "node:fs";
import { createPaperSession } from "./engine.mjs";
import { createRelay } from "./relay.mjs";
import { replayFixture } from "./replay.mjs";

const banned = ["--live", "--send", "--broadcast", "--wallet", "--keypair", "--sign"];
for (const flag of process.argv) {
  if (banned.includes(flag)) {
    console.error(`[PAPER BUYER] REFUSED: ${flag}`);
    process.exit(2);
  }
}
const fixtureFlag = process.argv.indexOf("--fixture");
const relayFlag = process.argv.indexOf("--relay-jsonl");
if (fixtureFlag < 0 || relayFlag < 0) {
  console.error("Usage: node bots/graduation-sniper/paper/buyer-bot.mjs --fixture <events.json> --relay-jsonl <handoff.jsonl>");
  process.exit(2);
}
const relay = createRelay({ jsonlPath: process.argv[relayFlag + 1] });
const buyer = createPaperSession({
  strategy: "curve-handoff",
  onHandoff: (signal) => relay.publish(signal),
});
const fixture = JSON.parse(fs.readFileSync(process.argv[fixtureFlag + 1], "utf8"));
replayFixture(buyer, fixture);
console.log(`[PAPER BUYER] handoffs=${buyer.snapshot().stats.handoffs} curveCloses=${buyer.snapshot().stats.curveMarks}`);
