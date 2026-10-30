// Test fixtures for the AI usage screens (AIP-05, AIP-16; BFF section 66): answers in the shape the routes send, at the figures the live estate shows
// (knowledge embeds outnumber replies about 3,000 to 1; a whole month costs about a tenth of a cent). Pure data, never imported by the app.
import type { CompanyUsage, MyUsage, UnitUsage, UsageFigures } from "./aiUsage";
import type { Allowances, CompanyBudgetLine, UnitBudgetLine } from "./aiBudget";

export const fig = (over: Partial<UsageFigures> = {}): UsageFigures => ({
  calls: 10, promptTokens: 1000, completionTokens: 200, costUsd: "0.00100000",
  estimatedTokenCalls: 0, noTokenCalls: 0, noCostCalls: 0, providerCostCalls: 10, tableCostCalls: 0, ...over,
});

const KNOWLEDGE = fig({ calls: 3180, promptTokens: 412000, completionTokens: 0, costUsd: "0.00004100", providerCostCalls: 3180 });
const ASSISTANT = fig({ calls: 14, promptTokens: 9200, completionTokens: 2100, costUsd: "0.00106000", estimatedTokenCalls: 2, noCostCalls: 3, providerCostCalls: 8, tableCostCalls: 3 });
const AGENT = fig({ calls: 5, promptTokens: null, completionTokens: null, costUsd: null, noTokenCalls: 5, noCostCalls: 5, providerCostCalls: 0 });

export const TOTALS = fig({
  calls: 3199, promptTokens: 421200, completionTokens: 2100, costUsd: "0.00110100",
  estimatedTokenCalls: 2, noTokenCalls: 5, noCostCalls: 8, providerCostCalls: 3188, tableCostCalls: 3,
});

export const CAPS = { canSeePeople: false, canManage: false, canLiftStop: false };

export const myUsage = (over: Partial<MyUsage> = {}): MyUsage => ({
  month: "2026-10",
  totals: TOTALS,
  bySurface: [{ surface: "knowledge", ...KNOWLEDGE }, { surface: "assistant", ...ASSISTANT }, { surface: "agent", ...AGENT }],
  byDay: [{ day: "2026-10-03", ...fig({ calls: 3000 }) }, { day: "2026-10-12", ...fig({ calls: 199, promptTokens: null }) }],
  capabilities: CAPS,
  ...over,
});

export const unitUsage = (over: Partial<UnitUsage> = {}): UnitUsage => ({
  month: "2026-10",
  unit: { unitNodeId: "d-web", name: "Web Dev" },
  totals: TOTALS,
  bySurface: [{ surface: "knowledge", ...KNOWLEDGE }, { surface: "assistant", ...ASSISTANT }],
  byModel: [{ provider: "openrouter", model: "z-ai/glm-5.3-flash", ...ASSISTANT }, { provider: null, model: null, ...AGENT }],
  byDay: [{ day: "2026-10-03", ...fig({ calls: 3000 }) }],
  people: [
    { userId: "u-2", name: "Made Putra", ...fig({ calls: 9, costUsd: "0.00020000" }) },
    { userId: "u-3", name: null, ...fig({ calls: 4, costUsd: "0.00000500" }) },
  ],
  budget: null,
  capabilities: { canSeePeople: true, canManage: false, canLiftStop: false },
  ...over,
});

export const companyUsage = (over: Partial<CompanyUsage> = {}): CompanyUsage => ({
  month: "2026-10",
  totals: TOTALS,
  byDepartment: [
    { unitNodeId: "d-web", name: "Web Dev", ...ASSISTANT },
    { unitNodeId: "d-seo", name: "SEO", ...fig({ calls: 7 }) },
    { unitNodeId: null, name: null, ...fig({ calls: 33, costUsd: null, noCostCalls: 33, providerCostCalls: 0 }) },
  ],
  noPerson: [{ surface: "knowledge", ...KNOWLEDGE }],
  bySurface: [{ surface: "knowledge", ...KNOWLEDGE }, { surface: "assistant", ...ASSISTANT }],
  byModel: [{ provider: "openrouter", model: "z-ai/glm-5.3-flash", ...ASSISTANT }],
  byDay: [{ day: "2026-10-03", ...fig({ calls: 3000 }) }],
  budgets: { company: null, units: [] },
  capabilities: CAPS,
  ...over,
});

/** §66.8: a department's budget line (the doc's example: 80 percent of $1, mode report). */
export const unitBudget = (over: Partial<UnitBudgetLine> = {}): UnitBudgetLine => ({
  unitNodeId: "d-web", name: "Web Dev", monthlyUsd: "1.0000", mode: "report", spentUsd: "0.80000000", noCostCalls: 0, percent: 80, state: "over_80", stopLifted: false, ...over,
});

/** §66.8: the company's alert figure. */
export const companyBudget = (over: Partial<CompanyBudgetLine> = {}): CompanyBudgetLine => ({
  monthlyUsd: "250.0000", spentUsd: "218.75000000", noCostCalls: 0, percent: 87.5, state: "over_80", ...over,
});

/** §66.9: the allowances answer. */
export const allowances = (over: Partial<Allowances> = {}): Allowances => ({
  defaultDailyReplies: 200,
  overrides: [{ userId: "u-2", name: "Made Putra", dailyReplies: 350, updatedAt: "2026-10-29T10:00:00.000Z" }],
  ...over,
});

/** An answer with nothing recorded in the month. */
export const EMPTY_TOTALS = fig({ calls: 0, promptTokens: null, completionTokens: null, costUsd: null, providerCostCalls: 0 });
