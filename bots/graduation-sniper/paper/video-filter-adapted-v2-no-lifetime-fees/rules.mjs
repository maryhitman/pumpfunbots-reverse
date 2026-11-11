import { RULE_MAP as V1_RULES } from "../video-filter-adapted-v1/rules.mjs";

export const RULE_MAP = Object.freeze(V1_RULES.map((rule) => {
  if (rule.id !== "cumulative-fees") return rule;
  return {
    ...rule,
    ours: "v2 does not veto on lifetime fees. The metric is still unavailable and is logged only. This does not reproduce the video filter. Every other gate stays.",
    status: "removed-in-v2-only",
  };
}));
