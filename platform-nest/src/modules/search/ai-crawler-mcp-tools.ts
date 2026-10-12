// M5-P5b — the MCP tools for the AI-crawler log and the SM-16 AI-visibility summary (ai-crawler.controller.ts).
// Cerbos resource_search_property · read / update. The ingest is a write of MEDIUM impact.
import type { McpToolDef } from "../contract";

const ids = { tenantId: { type: "string" }, propertyId: { type: "string" } };

export const AI_CRAWLER_MCP_TOOLS: McpToolDef[] = [
  {
    name: "search.aiCrawlers.ingest",
    description:
      "Ingest a chunk of a site's web-server access log (nginx/Apache combined, or Caddy JSON lines; at most 900000 characters) for a property. " +
      "Only requests from known AI crawlers (GPTBot, ClaudeBot, PerplexityBot, ...) are kept, as daily counts per bot, path (no query string), " +
      "status and verification; every other line is dropped, and no IP, User-Agent or raw line is ever stored. Re-sending the same chunk changes nothing (M5-P5b).",
    minAssurance: "verified",
    write: true,
    impact: "medium",
    method: "POST",
    pathTemplate: "/api/:tenantId/modules/search/properties/:propertyId/ai-crawlers/ingest",
    inputSchema: {
      type: "object",
      properties: { ...ids, log: { type: "string", description: "access-log lines, one request per line" } },
      required: ["tenantId", "propertyId", "log"],
    },
  },
  {
    name: "search.aiCrawlers.summary",
    description:
      "AI-crawler hits for a property over a date range: by day and bot, by bot (with verified / unverified / claimed split), top crawled paths and " +
      "the status-code mix. state is ok | no_data | no_data_in_range, with words for the last two; never zeros for missing data (M5-P5b).",
    minAssurance: "low",
    method: "GET",
    pathTemplate: "/api/:tenantId/modules/search/properties/:propertyId/ai-crawlers/summary/range/:from/:to",
    inputSchema: {
      type: "object",
      properties: {
        ...ids,
        from: { type: "string", description: "first day, YYYY-MM-DD (UTC, inclusive)" },
        to: { type: "string", description: "last day, YYYY-MM-DD (UTC, inclusive); at most 400 days after from" },
      },
      required: ["tenantId", "propertyId", "from", "to"],
    },
  },
  {
    name: "search.aiVisibility.summary",
    description:
      "The SM-16 AI-visibility summary for a property: the newest brand-mention / citation result per engine and query, and whether it changed " +
      "against the check before it. Rows from the simulated provider mode are flagged. state is ok | no_data (M5-P5b).",
    minAssurance: "low",
    method: "GET",
    pathTemplate: "/api/:tenantId/modules/search/properties/:propertyId/ai-visibility-summary",
    inputSchema: { type: "object", properties: { ...ids }, required: ["tenantId", "propertyId"] },
  },
];
