// Unit test for the MCP tool-def aggregator (WS2 §6). No DB/guard needed — the controller just
// projects the module registry. Service-token auth is covered by the guard suite.
import { describe, it, expect, beforeEach } from "vitest";
import { McpToolsController } from "./mcp-tools.controller";
import { resetModules, registerModule } from "./registry";
import { agencyModule } from "./agency";

describe("McpToolsController (WS2 §6 aggregation)", () => {
  beforeEach(() => resetModules());

  it("returns the union of enabled-in-code modules' mcpTools with their HTTP mapping", () => {
    registerModule(agencyModule);
    const defs = new McpToolsController().toolDefs();
    const byName = Object.fromEntries(defs.map((d) => [d.name, d]));
    expect(Object.keys(byName)).toEqual(["agency.listCampaigns", "agency.pendingApprovals"]);
    expect(byName["agency.pendingApprovals"]).toMatchObject({
      method: "GET",
      pathTemplate: "/api/:tenantId/modules/agency/approvals/pending",
      minAssurance: "low",
    });
  });

  it("is empty when no modules are registered", () => {
    expect(new McpToolsController().toolDefs()).toEqual([]);
  });
});
