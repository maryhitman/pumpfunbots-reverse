import { V1 } from "../video-filter-adapted-v1/config.mjs";

// Same frozen numbers as v1. The only change is that a missing lifetime fee does not veto.
export const STRATEGY_ID = "video-filter-adapted-v2-no-lifetime-fees";

export const V2 = Object.freeze({
  ...V1,
  id: STRATEGY_ID,
  requireLifetimeFees: false,
  lifetimeFees: "diagnostic-only-not-a-veto",
  reproducesVideoFeeFilter: false,
});
