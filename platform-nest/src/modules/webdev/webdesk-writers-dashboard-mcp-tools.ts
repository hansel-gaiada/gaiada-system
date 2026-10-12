// M5-W8 — the MCP read tool for the writer dashboard (webdesk-writers-dashboard.service.ts). The same BFF route as the UI. A read
// (no `write`, no `impact`): counts only, never a lead's identity. The hub forwards only PATH arguments on a GET, so the tool returns
// the default view (28 days, the first page, everything the caller may see); the UI passes the filters.
import type { McpToolDef } from "../contract";

export const WEBDESK_WRITERS_DASHBOARD_TOOLS: McpToolDef[] = [
  {
    name: "webdesk.writers.dashboard",
    description:
      "The writer dashboard for a site: each published article the caller may read (a writer sees their own; an editor or staff everything in scope) with the page path it is served at, "
      + "its views and average time per visit (Umami), Search Console clicks, impressions and top 3 queries, a COUNT of web leads that landed on or submitted from the page, and any open "
      + "content-decay finding. Counts only: never a visitor, a lead's name, address or id. A figure that could not be read is null with a reason (never 0); view counts under 5 are \"<5\". "
      + "An item with no public page address says so.",
    minAssurance: "low", method: "GET",
    pathTemplate: "/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/writers/dashboard",
    inputSchema: {
      type: "object",
      properties: { tenantId: { type: "string" }, tenantSlug: { type: "string" }, siteId: { type: "string" } },
      required: ["tenantId", "tenantSlug", "siteId"],
    },
  },
];
