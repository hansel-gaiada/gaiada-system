// M5-A4 — the MCP read tools for the Umami analytics reads (search-analytics.controller.ts). Read-only:
// no `write`, no `impact` (impact classifies writes; see search.test.ts's impact pin).
import type { McpToolDef } from "../contract";
import type { AnalyticsKind } from "./umami-reads";

const TOOLS: Array<[AnalyticsKind, string, string]> = [
  ["summary", "analyticsSummary", "Visitors, visits, pageviews, bounce rate and average visit time"],
  ["pages", "analyticsPages", "Top pages by visits"],
  ["sources", "analyticsSources", "Referrers, with an AI-search grouping (chatgpt.com, perplexity.ai, gemini.google.com, copilot.microsoft.com, claude.ai)"],
  ["sections", "analyticsSections", "Section map: section_view events by section_id, with reach (share of pageviews)"],
  ["ctas", "analyticsCtas", "CTA clicks by link_location"],
  ["forms", "analyticsForms", "Form funnel by form_id: lead_form_start, lead_form_step, lead_form_send, generate_lead"],
  ["vitals", "analyticsVitals", "Core Web Vitals events by metric_name and by rating"],
];

export const ANALYTICS_MCP_TOOLS: McpToolDef[] = TOOLS.map(([kind, name, what]) => ({
  name: `search.${name}`,
  description:
    `${what} for a property's website, from Umami, over a date range (M5-A4). Returns {state, range, data}; state is ` +
    `ok | not_configured | not_bound | unreachable | rejected. Any count below 5 is returned as "<5".`,
  minAssurance: "low" as const,
  method: "GET" as const,
  pathTemplate: `/api/:tenantId/modules/search/properties/:propertyId/analytics/${kind}/range/:from/:to`,
  inputSchema: {
    type: "object",
    properties: {
      tenantId: { type: "string" }, propertyId: { type: "string" },
      from: { type: "string", description: "first day, YYYY-MM-DD (UTC, inclusive)" },
      to: { type: "string", description: "last day, YYYY-MM-DD (UTC, inclusive); at most 400 days after from" },
    },
    required: ["tenantId", "propertyId", "from", "to"],
  },
}));
