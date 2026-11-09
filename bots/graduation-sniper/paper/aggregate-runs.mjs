// Sums saved paper reports. Read-only. Does not trade.

import fs from "node:fs";
import { lamportsToSolString } from "./defaults.mjs";

function rowsFromBook(book) {
  return (book?.closed ?? []).map((position) => ({
    mint: position.mint,
    venue: "curve",
    trigger: position.modelMark?.trigger ?? null,
    pnlLamports: position.modelMark?.improved?.pnl?.lamports ?? "0",
  }));
}

function rowsFromJsonl(file) {
  if (!file || !fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    const row = JSON.parse(line);
    if (row.type !== "result" || !Number.isInteger(row.atMs) || row.atMs < 1_000_000_000_000) continue;
    out.push({
      mint: row.mint,
      venue: row.venue,
      trigger: row.trigger,
      pnlLamports: row.pnlLamports,
      graduationToFirstRouteMs: null,
      quoteLatencyMs: null,
      graduationToSignalMs: 0,
    });
  }
  return out;
}

function strategyOf(report, index) {
  const relay = (report.relayReports ?? []).filter(Boolean);
  if (index === 0) return { id: "A-exit-at-97", source: report.books?.[0], relay: null };
  return { id: relay[index - 1]?.strategy ?? `book-${index}`, source: report.books?.[index], relay: relay[index - 1] };
}

export function loadRun(spec) {
  const report = JSON.parse(fs.readFileSync(spec.report, "utf8"));
  const relay = (report.relayReports ?? []).filter(Boolean);
  const strategies = [];
  const count = Math.max(report.books?.length ?? 0, relay.length + 1);
  for (let i = 0; i < count; i += 1) {
    const item = strategyOf(report, i);
    const curveRows = i === 0
      ? rowsFromBook(item.source)
      : (item.relay?.curveRows ?? rowsFromBook(item.source));
    const sells = i === 0 ? [] : (item.relay?.sells ?? rowsFromJsonl(spec.sellJsonl?.[i - 1]));
    const rows = [...curveRows, ...sells];
    const pnl = rows.reduce((sum, row) => sum + BigInt(row.pnlLamports || 0), 0n);
    const wins = rows.filter((row) => BigInt(row.pnlLamports || 0) > 0n).length;
    const biggest = rows.reduce((best, row) => {
      const pnlLamports = BigInt(row.pnlLamports || 0);
      if (!best || pnlLamports > best.pnlLamports) return { ...row, pnlLamports };
      return best;
    }, null);
    strategies.push({
      id: item.id,
      run: spec.id,
      test: spec.test,
      elapsedMs: report.data?.elapsedMs ?? null,
      completed: report.data?.completed ?? null,
      opens: i === 0 ? item.source?.stats?.opened ?? null : item.relay?.opens ?? null,
      curveCloses: i === 0 ? item.source?.stats?.curveMarks ?? rows.length : item.relay?.curveCloses ?? curveRows.length,
      graduations: item.relay?.graduationsCaptured ?? 0,
      handoffs: item.relay?.handoffs ?? 0,
      pumpswapSells: item.relay?.pumpswapSells ?? 0,
      jupiterSells: item.relay?.jupiterSells ?? 0,
      stuck: item.relay?.stuck ?? 0,
      openLeft: i === 0 ? (item.source?.active?.length ?? null) : item.relay?.openOnCurve ?? null,
      seeking: item.relay?.seekingPool ?? 0,
      terminal: rows.length,
      wins,
      pnlLamports: pnl.toString(),
      pnlSol: lamportsToSolString(pnl),
      biggest: biggest ? { mint: biggest.mint, venue: biggest.venue, pnlLamports: biggest.pnlLamports.toString(), pnlSol: lamportsToSolString(biggest.pnlLamports) } : null,
      pnlExcludingBiggestLamports: (pnl - (biggest?.pnlLamports ?? 0n)).toString(),
      latencies: sells.map((row) => ({
        mint: row.mint,
        venue: row.venue,
        graduationToSignalMs: row.graduationToSignalMs ?? null,
        graduationToFirstRouteMs: row.graduationToFirstRouteMs ?? null,
        quoteLatencyMs: row.quoteLatencyMs ?? null,
      })),
    });
  }
  return { id: spec.id, test: spec.test, strategies };
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function aggregate(runs) {
  const byStrategy = new Map();
  for (const run of runs) {
    for (const strategy of run.strategies) {
      const bucket = byStrategy.get(strategy.id) ?? [];
      bucket.push(strategy);
      byStrategy.set(strategy.id, bucket);
    }
  }
  const strategies = [];
  for (const [id, samples] of byStrategy) {
    const total = samples.reduce((sum, sample) => sum + BigInt(sample.pnlLamports), 0n);
    const allBiggest = samples.map((sample) => sample.biggest).filter(Boolean).sort((a, b) => (BigInt(a.pnlLamports) > BigInt(b.pnlLamports) ? -1 : 1))[0] ?? null;
    const latencies = samples.flatMap((sample) => sample.latencies).filter((row) => row.graduationToFirstRouteMs != null);
    const routeMs = latencies.map((row) => row.graduationToFirstRouteMs);
    const quoteMs = latencies.map((row) => row.quoteLatencyMs).filter((value) => value != null);
    const wins = samples.reduce((sum, sample) => sum + sample.wins, 0);
    const terminal = samples.reduce((sum, sample) => sum + sample.terminal, 0);
    strategies.push({
      id,
      runs: samples.length,
      opens: samples.reduce((sum, sample) => sum + (sample.opens ?? 0), 0),
      curveCloses: samples.reduce((sum, sample) => sum + (sample.curveCloses ?? 0), 0),
      graduations: samples.reduce((sum, sample) => sum + sample.graduations, 0),
      handoffs: samples.reduce((sum, sample) => sum + sample.handoffs, 0),
      pumpswapSells: samples.reduce((sum, sample) => sum + sample.pumpswapSells, 0),
      jupiterSells: samples.reduce((sum, sample) => sum + sample.jupiterSells, 0),
      stuck: samples.reduce((sum, sample) => sum + sample.stuck, 0),
      terminal,
      wins,
      winRate: terminal === 0 ? null : wins / terminal,
      pnlSol: lamportsToSolString(total),
      pnlExcludingBiggestSol: lamportsToSolString(total - BigInt(allBiggest?.pnlLamports ?? 0)),
      biggest: allBiggest,
      perRun: samples.map((sample) => ({
        run: sample.run,
        test: sample.test,
        opens: sample.opens,
        curveCloses: sample.curveCloses,
        graduations: sample.graduations,
        handoffs: sample.handoffs,
        pumpswapSells: sample.pumpswapSells,
        jupiterSells: sample.jupiterSells,
        stuck: sample.stuck,
        wins: sample.wins,
        terminal: sample.terminal,
        winRate: sample.terminal === 0 ? null : sample.wins / sample.terminal,
        pnlSol: sample.pnlSol,
        pnlExcludingBiggestSol: lamportsToSolString(BigInt(sample.pnlExcludingBiggestLamports)),
        biggest: sample.biggest,
      })),
      latency: {
        handoffsWithRoute: latencies.length,
        graduationToSignalMs: "0 in-process; the seller accepts on the graduation observation",
        graduationToFirstRouteMs: { n: routeMs.length, median: median(routeMs), min: routeMs.length ? Math.min(...routeMs) : null, max: routeMs.length ? Math.max(...routeMs) : null },
        quoteLatencyMs: { n: quoteMs.length, median: median(quoteMs), min: quoteMs.length ? Math.min(...quoteMs) : null, max: quoteMs.length ? Math.max(...quoteMs) : null },
      },
    });
  }
  return {
    generatedAt: new Date().toISOString(),
    paperOnly: true,
    note: "Modeled fee-adjusted marks. Not realized profit. One public hour is a small sample.",
    strategies,
  };
}

function main() {
  const specPath = process.argv[2];
  const specs = JSON.parse(fs.readFileSync(specPath, "utf8"));
  const result = aggregate(specs.map(loadRun));
  const out = process.argv[3];
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (out) fs.writeFileSync(out, text);
  console.log(text);
}

if (process.argv[1]?.endsWith("aggregate-runs.mjs")) main();
