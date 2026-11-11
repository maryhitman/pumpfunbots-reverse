export function replayFixture(session, fixture) {
  if (!fixture || !Array.isArray(fixture.events)) {
    throw new Error("fixture events array is required");
  }
  const results = [];
  for (const event of fixture.events) {
    if (!event || !Number.isFinite(event.atMs)) throw new Error("fixture event atMs is required");
    if (event.type === "trade") {
      results.push({ atMs: event.atMs, type: "trade", result: session.trySignal(event, event.atMs) });
      continue;
    }
    if (event.type === "pool") {
      const result = session.observePool(event.mint, event.view, event.atMs);
      if (result.reason === "no_position" || result.reason === "not_pending") {
        throw new Error(`fixture pool for ${event.mint} is not pending at ${event.atMs}`);
      }
      results.push({ atMs: event.atMs, type: "pool", result });
      continue;
    }
    if (event.type === "curve") {
      const result = session.observe(event.mint, event.state, event.atMs);
      if (result.reason === "no_position") {
        throw new Error(`fixture observes ${event.mint} with no open position at ${event.atMs}`);
      }
      results.push({ atMs: event.atMs, type: "curve", result });
      continue;
    }
    throw new Error(`unknown fixture event type ${event.type}`);
  }
  return results;
}
