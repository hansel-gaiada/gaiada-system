// AIP-01 — the closed vocabularies of `ai_usage_events` (migration 202610271800_ai_usage_events.sql). Each list mirrors a CHECK in that
// file one for one; ai-usage-migration.test.ts reads the migration text and fails if the two drift.
//
// The table holds ids, counts, labels and money ONLY. There is deliberately no field anywhere in this module that could carry prompt,
// answer, tool or message text, and a label may not contain a space (see LABEL_PATTERN in writer.ts).

/** Where the call came from. */
export const AI_USAGE_SURFACES = ["assistant", "compaction", "title", "agent", "knowledge", "search", "bot", "other"] as const;
export type AiUsageSurface = (typeof AI_USAGE_SURFACES)[number];

/** What kind of gateway capability was used. */
export const AI_USAGE_CAPABILITIES = ["llm", "chat", "embed", "media"] as const;
export type AiUsageCapability = (typeof AI_USAGE_CAPABILITIES)[number];

/** Whether the token counts are the provider's own, a 4-characters-per-token estimate, or absent. */
export const AI_USAGE_TOKENS_SOURCES = ["provider", "estimate", "none"] as const;
export type AiUsageTokensSource = (typeof AI_USAGE_TOKENS_SOURCES)[number];

/** AIP-D11: the provider's own figure first, our price table fills the gap. */
export const AI_USAGE_COST_SOURCES = ["provider", "table"] as const;
export type AiUsageCostSource = (typeof AI_USAGE_COST_SOURCES)[number];

/** `incurred` = charged but nothing delivered (the search ledger's idea, migration 0053): the money counts, no output exists. */
export const AI_USAGE_OUTCOMES = ["ok", "blocked_dlp", "blocked_budget", "failed_over", "error", "incurred"] as const;
export type AiUsageOutcome = (typeof AI_USAGE_OUTCOMES)[number];
