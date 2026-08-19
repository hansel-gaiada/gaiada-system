// Unit test for the MCP tool-def aggregator (WS2 §6). No DB/guard needed — the controller just
// projects the two registries. Service-token auth is covered by the guard suite.
//
// P2-07: the aggregate is now CORE tools + module tools. The two tests that changed shape did so
// because the fact they asserted changed — "no modules registered ⇒ empty" is no longer true, and
// saying so is the point: core tools exist whether or not any module does.
import { describe, it, expect, beforeEach } from "vitest";
import { McpToolsController } from "./mcp-tools.controller";
import { resetModules, registerModule } from "./registry";
import { allCoreTools, registerCoreTools, resetCoreTools, registerIamCoreTools } from "../core/core-tools";
import { agencyModule } from "./agency";
import { pmModule } from "./pm";
import { itModule } from "./it";
import { billingModule } from "./billing";
import { clientsModule } from "./clients";
import { knowledgeModule } from "./knowledge";
import { automationConsoleModule } from "./automation-console";

const CORE_NAMES = allCoreTools().map((t) => t.name);

describe("McpToolsController (WS2 §6 aggregation)", () => {
  beforeEach(() => resetModules());

  it("WSA-2: lists tools from every registered module (main.ts's full compiled-in set)", () => {
    [agencyModule, pmModule, itModule, billingModule, clientsModule, knowledgeModule, automationConsoleModule].forEach(registerModule);
    const names = new McpToolsController().toolDefs().map((d) => d.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "pm.listTasks", "it.listDevices", "billing.listInvoices",
        "clients.listClients", "knowledge.listSources", "automation.listWorkflows",
      ]),
    );
  });

  it("returns core tools FIRST, then the union of enabled-in-code modules' mcpTools with their HTTP mapping", () => {
    registerModule(agencyModule);
    const defs = new McpToolsController().toolDefs();
    const byName = Object.fromEntries(defs.map((d) => [d.name, d]));
    // Order is asserted, not just membership: a stable order makes a diff of this endpoint between two
    // releases read as "what changed" rather than "what moved".
    expect(Object.keys(byName)).toEqual([...CORE_NAMES, "agency.listCampaigns", "agency.pendingApprovals"]);
    expect(byName["agency.pendingApprovals"]).toMatchObject({
      method: "GET",
      pathTemplate: "/api/:tenantId/modules/agency/approvals/pending",
      minAssurance: "low",
    });
  });

  it("with NO modules registered the aggregate is exactly the core set — core does not depend on modules", () => {
    // This replaces the old "is empty when no modules are registered". `positions`/`role-grants` are
    // core controllers over core tables; there is no module whose absence should hide them.
    expect(new McpToolsController().toolDefs().map((d) => d.name)).toEqual(CORE_NAMES);
  });

  it("🔴 THROWS on a duplicate tool name across the two registries", () => {
    // Neither registry can see the other, so this controller is the only place that can catch it. It
    // throws rather than de-duplicating: with two owners for one name the hub's advertised surface
    // would depend on registration order and the loser would be silently unreachable — a failure that
    // presents as "the tool exists but does the wrong thing", which is the worst shape to debug.
    registerCoreTools([{ ...agencyModule.mcpTools[0] }]);
    registerModule(agencyModule);
    try {
      expect(() => new McpToolsController().toolDefs()).toThrow(/duplicate MCP tool name 'agency.listCampaigns'/);
    } finally {
      // Restore the production core set for whatever runs next in this worker — leaving the registry
      // holding a duplicate (or empty) would silently weaken every later assertion in this file.
      resetCoreTools();
      registerIamCoreTools();
    }
  });
});
