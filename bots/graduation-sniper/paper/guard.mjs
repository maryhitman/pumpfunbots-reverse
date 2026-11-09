import { MODIFIED_EARLY_EXIT_FILL_PCT, STRATEGY_DEFAULTS } from "./defaults.mjs";

// Fail-closed argument and environment gate. No network and no key files.

export const PUBLIC_ENDPOINTS = Object.freeze([
  Object.freeze({
    name: "solana-public-rpc",
    http: "https://api.mainnet-beta.solana.com",
    ws: "wss://api.mainnet-beta.solana.com",
  }),
  Object.freeze({
    name: "publicnode",
    http: "https://solana-rpc.publicnode.com",
    ws: "wss://solana-rpc.publicnode.com",
  }),
]);

const BANNED_FLAGS = new Set([
  "--live",
  "--send",
  "--broadcast",
  "--wallet",
  "--keypair",
  "--sign",
  "--dry-run",
  "--mainnet-send",
]);

const SECRET_ENV = [
  "PRIVATE_KEY",
  "SECRET_KEY",
  "SOLANA_PRIVATE_KEY",
  "WALLET_PRIVATE_KEY",
  "KEYPAIR",
  "KEYPAIR_JSON",
];

const IGNORED_IF_SET = [
  "HELIUS_API_KEY",
  "RPC_URL",
  "WS_URL",
  "GRAD_BUY_SOL",
  "GRAD_MIN_FILL_PCT",
  "GRAD_TAKE_PROFIT",
  "GRAD_STOP_LOSS",
  "GRAD_TIMEOUT_SEC",
  "GRAD_MAX_POSITIONS",
  "GRAD_COOLDOWN_SEC",
];

const FLAGS_WITH_VALUES = new Set([
  "--fixture",
  "--duration-sec",
  "--json-out",
  "--log-out",
  "--rpc-http",
  "--rpc-ws",
  "--strategy",
  "--early-exit-pct",
  "--wait-sec",
  "--pool-find-sec",
  "--relay-jsonl",
  "--sell-policy",
]);

export const MAX_PUBLIC_DURATION_SEC = 660;
export const MAX_RELAY_DURATION_SEC = 10_800;

function refuse(message, ignoredEnv) {
  return { ok: false, exitCode: 2, message, ignoredEnv };
}

export function evaluateInvocation(argv, env = process.env) {
  const ignoredEnv = IGNORED_IF_SET.filter((key) => env[key] != null && env[key] !== "");
  for (const key of SECRET_ENV) {
    if (env[key] != null && env[key] !== "") {
      return refuse(
        `${key} is set. Refusing to run with key material in the environment.`,
        ignoredEnv,
      );
    }
  }

  const args = argv.slice(2);
  for (const arg of args) {
    if (BANNED_FLAGS.has(arg)) {
      return refuse(
        `${arg} is not available. This entrypoint is paper-only and does not sign or send.`,
        ignoredEnv,
      );
    }
  }

  let fixture = null;
  let publicRead = false;
  let durationSec = 300;
  let durationPassed = false;
  let jsonOut = null;
  let logOut = null;
  let http = null;
  let ws = null;
  let strategy = "modified";
  let compare = false;
  let relayCompare = false;
  let earlyExitPassed = false;
  let waitSec = 120;
  let poolFindSec = 180;
  let relayJsonl = null;
  let sellPolicy = "immediate";
  let earlyExitFillPct = MODIFIED_EARLY_EXIT_FILL_PCT;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--public-readonly") {
      publicRead = true;
      continue;
    }
    if (arg === "--compare") {
      compare = true;
      continue;
    }
    if (arg === "--relay-compare") {
      relayCompare = true;
      continue;
    }
    if (!FLAGS_WITH_VALUES.has(arg)) {
      return refuse(`Unknown argument ${arg}. Paper entrypoint refuses unrecognized options.`, ignoredEnv);
    }
    const value = args[++i];
    if (value == null || value.startsWith("--")) {
      return refuse(`${arg} requires a value.`, ignoredEnv);
    }
    if (arg === "--fixture") fixture = value;
    else if (arg === "--duration-sec") {
      durationPassed = true;
      durationSec = Number(value);
    } else if (arg === "--json-out") jsonOut = value;
    else if (arg === "--log-out") logOut = value;
    else if (arg === "--rpc-http") http = value;
    else if (arg === "--rpc-ws") ws = value;
    else if (arg === "--strategy") strategy = value;
    else if (arg === "--early-exit-pct") {
      earlyExitPassed = true;
      earlyExitFillPct = Number(value);
    } else if (arg === "--wait-sec") waitSec = Number(value);
    else if (arg === "--pool-find-sec") poolFindSec = Number(value);
    else if (arg === "--relay-jsonl") relayJsonl = value;
    else if (arg === "--sell-policy") sellPolicy = value;
  }

  if (compare && relayCompare) return refuse("Choose either --compare or --relay-compare.", ignoredEnv);
  if (sellPolicy !== "immediate" && sellPolicy !== "wait") {
    return refuse("--sell-policy must be immediate or wait.", ignoredEnv);
  }
  if (!Number.isFinite(waitSec) || waitSec < 0 || waitSec > 3600) {
    return refuse("--wait-sec must be from 0 to 3600. Default is 120.", ignoredEnv);
  }
  if (!Number.isFinite(poolFindSec) || poolFindSec < 1 || poolFindSec > 3600) {
    return refuse("--pool-find-sec must be from 1 to 3600. Default is 180.", ignoredEnv);
  }

  if ((compare || relayCompare) && args.includes("--strategy")) {
    return refuse("--compare runs exit-at-97 and pumpswap-immediate together. Do not also pass --strategy.", ignoredEnv);
  }
  if (!compare && strategy !== "modified" && strategy !== "original") {
    return refuse("--strategy must be modified or original. Use --compare for the 97% exit versus immediate PumpSwap exit.", ignoredEnv);
  }
  if (!compare && strategy === "original" && earlyExitPassed) {
    return refuse("--early-exit-pct belongs to the modified paper strategy. original comparison mode does not take it.", ignoredEnv);
  }
  if (compare || strategy === "modified") {
    if (!Number.isFinite(earlyExitFillPct) || earlyExitFillPct <= STRATEGY_DEFAULTS.minFillPct || earlyExitFillPct >= 100) {
      return refuse(
        `--early-exit-pct must be above the ${STRATEGY_DEFAULTS.minFillPct}% entry and below 100. Default is ${MODIFIED_EARLY_EXIT_FILL_PCT}.`,
        ignoredEnv,
      );
    }
  } else {
    earlyExitFillPct = null;
  }

  const durationCap = relayCompare ? MAX_RELAY_DURATION_SEC : MAX_PUBLIC_DURATION_SEC;
  if ((publicRead || durationPassed) && (!Number.isInteger(durationSec) || durationSec < 1 || durationSec > durationCap)) {
    return refuse(
      `--duration-sec must be an integer from 1 to ${durationCap}. This entrypoint will not run as a daemon.`,
      ignoredEnv,
    );
  }
  if (fixture && publicRead) return refuse("Choose either --fixture or --public-readonly.", ignoredEnv);
  if (!fixture && !publicRead) {
    return refuse("Pass --fixture <file> or --public-readonly. There is no live mode.", ignoredEnv);
  }

  let endpoints = PUBLIC_ENDPOINTS;
  if (http || ws) {
    if (!publicRead) return refuse("RPC overrides are only valid with --public-readonly.", ignoredEnv);
    if (!http || !ws) return refuse("Pass both --rpc-http and --rpc-ws, or neither.", ignoredEnv);
    const match = PUBLIC_ENDPOINTS.find((endpoint) => endpoint.http === http && endpoint.ws === ws);
    if (!match) {
      return refuse(`RPC endpoint is not on the public allowlist. Refusing ${http} ${ws}.`, ignoredEnv);
    }
    endpoints = [match];
  }

  return {
    ok: true,
    exitCode: 0,
    message: null,
    ignoredEnv,
    mode: publicRead ? "public-readonly" : "fixture",
    fixture,
    durationSec,
    jsonOut,
    logOut,
    endpoints,
    strategy: compare ? "compare" : strategy,
    compare,
    relayCompare,
    waitSec,
    poolFindSec,
    relayJsonl,
    sellPolicy,
    earlyExitFillPct,
  };
}
