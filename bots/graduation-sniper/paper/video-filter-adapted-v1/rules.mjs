// Machine-readable map. Video text is not an entry or exit system.

export const RULE_MAP = Object.freeze([
  {
    id: "avoid-new-pairs",
    video: "Do not trade the New Pairs column.",
    ours: "No entries below 90% curve fill, and no entries without a confirmed curve or pool stage.",
    status: "adapted",
  },
  {
    id: "final-stretch-stage",
    video: "Final Stretch column. Axiom's own stage label. No numeric definition in the video.",
    ours: "Proxy only: bonding-curve fill >= 90% and < 100% with complete=false. Not an Axiom equivalence.",
    status: "our-proxy",
  },
  {
    id: "final-stretch-mcap",
    video: "Final Stretch market cap at least 10,000 USD.",
    ours: "Same 10,000 USD floor, from as-of reserves times an as-of SOL/USD quote. Missing price skips.",
    status: "adapted",
  },
  {
    id: "cumulative-fees",
    video: "Cumulative global fees paid at least 0.1 SOL, for both Final Stretch and Migrated.",
    ours: "Required. No public per-mint lifetime total was found. Unswept creator_fee and protocol_fees buckets are not that total and are not substituted. Missing metric skips the strict book.",
    status: "unavailable",
  },
  {
    id: "migrated-volume",
    video: "Migrated volume at least 30,000 USD. The window was not specified.",
    ours: "Rolling 1 hour quote-side volume >= 30,000 USD. This window is ours and is not the video's window.",
    status: "our-window",
  },
  {
    id: "migrated-stage",
    video: "Migrated column.",
    ours: "A canonical PumpSwap pool account must be present. A complete flag alone is not a pool.",
    status: "adapted",
  },
  {
    id: "protocols",
    video: "Pump, with optional other protocols.",
    ours: "Solana Pump curve and PumpSwap only. Narrower than the video.",
    status: "narrowed",
  },
  {
    id: "graduation-usd-cap",
    video: "No fixed graduation USD cap. The on-screen 30,900 figure moved.",
    ours: "No USD graduation cap.",
    status: "followed",
  },
  {
    id: "discretion",
    video: "Creator also picks meta, virality, celebrity catalysts, and a private wallet list.",
    ours: "Not available. Not fabricated. Replaced by the frozen candle rules below, which the video does not state.",
    status: "unavailable",
  },
  {
    id: "momentum-entry",
    video: "No fixed entry rule.",
    ours: "After 7 completed 1-minute candles with no gaps: two consecutive green candles, close above the prior 5 highs, and latest volume >= 2x the mean of those 5. Next quote only, skipped if more than 5% above the trigger close.",
    status: "our-rule",
  },
  {
    id: "pool-liquidity",
    video: "Not stated.",
    ours: "Migrated entries also need pool liquidity >= 40,000 USD from vault balances. Missing vaults skip.",
    status: "our-rule",
  },
  {
    id: "exits",
    video: "No fixed exit rule.",
    ours: "Stop 15% under entry cost, sell half at +30%, trail the rest 10% from the high, 6 hour cap, 5 hour stale exit when price is within 10% of entry. Executable net proceeds only.",
    status: "our-rule",
  },
  {
    id: "risk",
    video: "Not stated.",
    ours: "3 virtual SOL, 0.2 SOL nominal plus the 1% fee reserve, one position per mint, no count cap, pause new entries at or under 2.1 SOL equity. No redeposit.",
    status: "our-rule",
  },
]);

export function ruleById(id) {
  const row = RULE_MAP.find((rule) => rule.id === id);
  if (!row) throw new Error(`unknown rule ${id}`);
  return row;
}
