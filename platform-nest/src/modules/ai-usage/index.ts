// AIP-01 — usage metering for AI calls. A library, not a registered module: it has no routes, no permissions and no event handlers.
// Reads come with AIP-15 (Cerbos kind `ai_usage`). AIP-03a: every platform-nest gateway client records through gateway-usage.ts.
// AIP-04: prices.ts fills a missing cost from ai_model_prices.
export * from "./vocab";
export * from "./writer";
export * from "./prices";
export * from "./gateway-usage";
