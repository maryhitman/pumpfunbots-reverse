// Read-only Jupiter quote. GET /swap/v1/quote only. Never calls /swap.

import https from "node:https";

const agent = new https.Agent({ keepAlive: true, maxSockets: 8, keepAliveMsecs: 1_000 });

export const JUPITER_QUOTE_ORIGIN = "https://lite-api.jup.ag";
export const JUPITER_QUOTE_PATH = "/swap/v1/quote";
export const SOL_OUTPUT_MINT = "So11111111111111111111111111111111111111112";
export const DEFAULT_SLIPPAGE_BPS = 50;

const ALLOWED_HOSTS = new Set(["lite-api.jup.ag"]);

export function buildJupiterQuoteUrl({ inputMint, amount, slippageBps = DEFAULT_SLIPPAGE_BPS }) {
  if (!inputMint || typeof inputMint !== "string") throw new Error("inputMint is required");
  if (!/^(0|[1-9]\d*)$/.test(String(amount))) throw new Error("amount must be a positive integer string");
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 1000) {
    throw new Error("slippageBps must be an integer from 0 to 1000");
  }
  const url = new URL(JUPITER_QUOTE_PATH, JUPITER_QUOTE_ORIGIN);
  url.searchParams.set("inputMint", inputMint);
  url.searchParams.set("outputMint", SOL_OUTPUT_MINT);
  url.searchParams.set("amount", String(amount));
  url.searchParams.set("slippageBps", String(slippageBps));
  assertQuoteRequest(url, "GET");
  return url;
}

export function assertQuoteRequest(url, method) {
  const parsed = typeof url === "string" ? new URL(url) : url;
  if (method !== "GET") throw new Error(`refusing Jupiter method ${method}`);
  if (!ALLOWED_HOSTS.has(parsed.host)) throw new Error(`refusing Jupiter host ${parsed.host}`);
  if (parsed.pathname !== JUPITER_QUOTE_PATH) throw new Error(`refusing Jupiter path ${parsed.pathname}`);
  if (parsed.pathname.endsWith("/swap")) throw new Error("refusing Jupiter swap endpoint");
  return parsed;
}

export function parseJupiterQuote(body, latencyMs, httpStatus = 200) {
  const errorCode = body?.errorCode || body?.code || "";
  const errorText = typeof body?.error === "string" ? body.error : body?.message || "";
  const noRoute = httpStatus === 400
    || httpStatus === 404
    || /NO_ROUTES/i.test(String(errorCode))
    || /no route/i.test(errorText)
    || body?.outAmount == null;
  if (noRoute || !body || typeof body !== "object") {
    return {
      ok: false,
      venue: "stuck",
      reason: "no_route",
      latencyMs,
      error: errorText || errorCode || `http ${httpStatus}`,
    };
  }
  const routeFees = (body.routePlan ?? []).map((step) => ({
    label: step.swapInfo?.label ?? null,
    feeAmount: step.swapInfo?.feeAmount ?? null,
    feeMint: step.swapInfo?.feeMint ?? null,
    percent: step.percent ?? null,
  }));
  return {
    ok: true,
    venue: "jupiter",
    outAmountLamports: String(body.outAmount),
    otherAmountThreshold: body.otherAmountThreshold == null ? null : String(body.otherAmountThreshold),
    priceImpactPct: body.priceImpactPct ?? null,
    slippageBps: body.slippageBps ?? null,
    platformFee: body.platformFee ?? null,
    routeFees,
    contextSlot: body.contextSlot ?? null,
    latencyMs,
    formula: "jupiter-lite-quote-v1-outAmount",
  };
}

function requestQuote(url) {
  assertQuoteRequest(url, "GET");
  const started = Date.now();
  return new Promise((resolve) => {
    const req = https.request(url, { method: "GET", agent, timeout: 4_000 }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const latencyMs = Date.now() - started;
        let body = null;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
        } catch {
          body = null;
        }
        const status = res.statusCode || 0;
        if (status !== 200 && status !== 400) {
          resolve({ ok: false, venue: "stuck", reason: "jupiter_unreachable", latencyMs, error: `http ${status}` });
          return;
        }
        resolve(parseJupiterQuote(body, latencyMs, status));
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (err) => {
      resolve({ ok: false, venue: "stuck", reason: "jupiter_unreachable", latencyMs: Date.now() - started, error: err.message });
    });
    req.end();
  });
}

export async function fetchJupiterQuote({ inputMint, amount, slippageBps = DEFAULT_SLIPPAGE_BPS }) {
  const url = buildJupiterQuoteUrl({ inputMint, amount: String(amount), slippageBps });
  return requestQuote(url);
}

export function hedgedJupiterQuote(args) {
  const url = buildJupiterQuoteUrl(args);
  return new Promise((resolve) => {
    let pending = 2;
    let fallback = null;
    const finish = (quote) => {
      if (quote.ok) {
        pending = 0;
        resolve(quote);
        return;
      }
      fallback = quote;
      pending -= 1;
      if (pending === 0) resolve(fallback);
    };
    requestQuote(url).then(finish);
    requestQuote(url).then(finish);
  });
}

export function startJupiterChase({ inputMint, amount, onResult, timeoutMs = 60_000 }) {
  let stopped = false;
  const started = Date.now();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  (async () => {
    let delay = 500;
    while (!stopped && Date.now() - started < timeoutMs) {
      const quote = await hedgedJupiterQuote({ inputMint, amount: String(amount) });
      if (stopped) return;
      const done = onResult(quote);
      if (quote.ok || done?.stop) return;
      await sleep(delay);
      delay = Math.min(1_000, delay + 250);
    }
  })();
  return () => {
    stopped = true;
  };
}
