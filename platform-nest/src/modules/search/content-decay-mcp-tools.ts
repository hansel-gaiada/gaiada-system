// M5-V4 — the MCP tools for content-decay findings (content-decay.controller.ts). One read, two LOW-impact
// writes; Cerbos resource_search_property · read / update. Writes are `verified` like every search write.
import type { McpToolDef } from "../contract";

const ids = { tenantId: { type: "string" }, propertyId: { type: "string" } };

export const DECAY_MCP_TOOLS: McpToolDef[] = [
  {
    name: "search.listDecayFindings",
    description:
      "List a property's live content-decay findings (pages losing Search Console clicks/impressions/position or Umami views; " +
      "open, acknowledged or with a refresh brief filed), each with its reason in words (M5-V4). View counts below 5 are \"<5\".",
    minAssurance: "low",
    method: "GET",
    pathTemplate: "/api/:tenantId/modules/search/properties/:propertyId/decay",
    inputSchema: { type: "object", properties: { ...ids }, required: ["tenantId", "propertyId"] },
  },
  {
    name: "search.acknowledgeDecayFinding",
    description: "Mark an open content-decay finding as acknowledged (a human has seen it). Idempotent (M5-V4).",
    minAssurance: "verified",
    write: true,
    impact: "low",
    method: "POST",
    pathTemplate: "/api/:tenantId/modules/search/properties/:propertyId/decay/:findingId/acknowledge",
    inputSchema: { type: "object", properties: { ...ids, findingId: { type: "string" } }, required: ["tenantId", "propertyId", "findingId"] },
  },
  {
    name: "search.fileRefreshBrief",
    description:
      "File a refresh brief for a decaying page: creates a draft search_content_briefs row from the finding (template, no AI call) " +
      "and moves the finding to refresh_brief_filed. Idempotent: a second call returns the same brief (M5-V4).",
    minAssurance: "verified",
    write: true,
    impact: "low",
    method: "POST",
    pathTemplate: "/api/:tenantId/modules/search/properties/:propertyId/decay/:findingId/refresh-brief",
    inputSchema: { type: "object", properties: { ...ids, findingId: { type: "string" } }, required: ["tenantId", "propertyId", "findingId"] },
  },
];
