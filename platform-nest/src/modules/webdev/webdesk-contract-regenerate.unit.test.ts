// M6-P4c — `webdesk.contract.regenerate`, the parts that need NO service: its approval class (the MCP tool
// def's write/impact, which is what the hub's D14 gate keys on), the D14 pairing (the executable registry
// entry AND the name in resource_mcp_tool.yaml's executable list), that it is NOT always-WS4, that the ERP's
// class matches WebDesk's own registry, and the structural precondition + lock key. The HTTP route against a
// fake WebDesk and the approval -> execute path run in webdesk-contract-regenerate.test.ts (the Linux gate).
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { webdevModule } from "./index";
import { getExecutable, WEBDESK_CONTRACT_REGISTRY_TOOLS } from "../../core/approval-executables";

const T = "0f1e2d3c-4b5a-4968-8776-655443322110";
const POLICY = join(__dirname, "../../../cerbos/policies/resource_mcp_tool.yaml");
const WEBDESK_COMMANDS = join(__dirname, "../../../../webdesk/api/src/control/command-types.ts");

describe("webdesk.contract.regenerate — approval class", () => {
  const tool = webdevModule.mcpTools.find((t) => t.name === "webdesk.contract.regenerate");

  it("is a MEDIUM write on the real route (an attended human runs it; an unattended caller suspends into WS4)", () => {
    expect(tool).toBeDefined();
    expect(tool!.write).toBe(true);
    expect(tool!.impact).toBe("medium");
    expect(tool!.method).toBe("POST");
    expect(tool!.pathTemplate).toBe("/api/:tenantId/modules/webdev/control/contract/regenerate");
    expect(tool!.minAssurance).toBe("low");
    const schema = tool!.inputSchema as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(schema.properties).sort()).toEqual(["slug", "tenantId"]);
    expect(schema.required).toEqual(["tenantId"]); // slug omitted = every tenant of THIS company
  });

  it("matches WebDesk's own classification of contract.regenerate (and tenant.provision): medium, never high", () => {
    // Read from WebDesk's registry when the checkout has it (the monorepo always does; a partial archive may not).
    if (!existsSync(WEBDESK_COMMANDS)) return;
    const src = readFileSync(WEBDESK_COMMANDS, "utf8");
    expect(src).toMatch(/"contract\.regenerate":\s*\{\s*command:\s*"contract\.regenerate",\s*impactClass:\s*"medium"/);
    expect(src).toMatch(/"tenant\.provision":\s*\{\s*command:\s*"tenant\.provision",\s*impactClass:\s*"medium"/);
  });

  it("D14 pairing: a registry entry exists AND resource_mcp_tool.yaml's executable list names it", () => {
    expect(WEBDESK_CONTRACT_REGISTRY_TOOLS).toEqual(["webdesk.contract.regenerate"]);
    const e = getExecutable("webdesk.contract.regenerate");
    expect(e).toBeDefined();
    expect(typeof e!.precondition).toBe("function");
    expect(typeof e!.lockKey).toBe("function");
    const yaml = readFileSync(POLICY, "utf8");
    const list = yaml.slice(yaml.indexOf('request.resource.attr.name in ["deploy.staging"'));
    const bracket = list.slice(0, list.indexOf("])"));
    expect(bracket).toContain('"webdesk.contract.regenerate"');
  });

  it("is NOT in the always-WS4 list (that list is for HIGH commands; WebDesk does not require WS4 here)", () => {
    const yaml = readFileSync(POLICY, "utf8");
    const start = yaml.indexOf('!(request.resource.attr.name in ["webdesk.site.promote"');
    expect(start).toBeGreaterThan(0);
    const alwaysWs4 = yaml.slice(start, yaml.indexOf("])", start));
    expect(alwaysWs4).not.toContain("webdesk.contract.regenerate");
  });

  it("precondition: structural only — a slug, or none (company scope); a malformed slug is refused before any grant", async () => {
    const e = getExecutable("webdesk.contract.regenerate")!;
    const c = {} as never; // a precondition that touched the client would throw here
    expect(await e.precondition!(c, { tenantId: T, slug: "acme-site" })).toEqual({ ok: true });
    expect(await e.precondition!(c, { tenantId: T })).toEqual({ ok: true });
    expect(await e.precondition!(c, { tenantId: T, slug: "Not A Slug" })).toEqual({ ok: false, reason: "tenant_slug_invalid" });
    expect(await e.precondition!(c, { tenantId: T, slug: "" })).toEqual({ ok: false, reason: "tenant_slug_invalid" });
    expect(await e.precondition!(c, { tenantId: T, slug: 42 })).toEqual({ ok: false, reason: "tenant_slug_invalid" });
  });

  it("lock key: (company, tenant); a company-wide run is its own unit", () => {
    const e = getExecutable("webdesk.contract.regenerate")!;
    expect(e.lockKey!({ tenantId: T, slug: "acme" })).toBe(`webdesk:contract:${T}:acme`);
    expect(e.lockKey!({ tenantId: T })).toBe(`webdesk:contract:${T}:*`);
    expect(e.lockKey!({ tenantId: T, slug: "a" })).not.toBe(e.lockKey!({ tenantId: T, slug: "b" }));
  });
});
