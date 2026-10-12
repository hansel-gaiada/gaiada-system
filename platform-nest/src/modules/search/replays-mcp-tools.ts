// M5-V6-b — the ONE MCP tool for session recordings (replays.controller.ts). A read, METADATA ONLY (design §4.8, open question O7: in v1 no MCP
// tool returns recording content, until counsel rules on AI processing of recordings). Cerbos resource_search_property · view_replay.
// There is deliberately NO tool for the chunk route and none will be added here: replays.test.ts pins that no tool's path reaches content.
import type { McpToolDef } from "../contract";

export const REPLAY_MCP_TOOLS: McpToolDef[] = [
  {
    name: "search.replays.list",
    description:
      "List one consented visitor's session recordings on a property: recording id, start, last chunk, length in seconds, pages (paths) and chunk count. METADATA ONLY: " +
      "no tool returns what was recorded (a person watches it in the ERP player). Needs the view_replay permission (search manager or company admin). 404 when the visitor has no live " +
      "consented profile; a collector that cannot answer is a 503 in words, never an empty list (M5-V6-b).",
    minAssurance: "low",
    method: "GET",
    pathTemplate: "/api/:tenantId/modules/search/properties/:propertyId/visitors/:visitorId/recordings",
    inputSchema: {
      type: "object",
      properties: { tenantId: { type: "string" }, propertyId: { type: "string" }, visitorId: { type: "string" } },
      required: ["tenantId", "propertyId", "visitorId"],
    },
  },
];
