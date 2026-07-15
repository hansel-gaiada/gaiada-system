import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { authorize, visibleTools } from "./policy";
import { resetRegistry, registerTool } from "./registry";
import { registerCoreTools } from "./tools";
import { registerPlatformTools } from "./platform-tools";
import { registerPlatformWriteTools } from "./platform-write-tools";
import { registerModuleTools } from "./module-tools";
import { AUTOMATION_ALLOWLIST } from "./automation-policy";
import type { Principal } from "./principal";

// An n8n workflow principal (as minted from OBO headers x-obo-provider/x-obo-external-id).
function wf(externalId: string): Principal {
  return { provider: "n8n", externalId, assurance: "low" };
}

// Module-contributed tools (e.g. agency.pendingApprovals) are aggregated from the platform at
// boot (WS2 §6); tests stub that fetch so the module tool is present in the registry.
const moduleDefsFetch = (async () => ({
  ok: true,
  status: 200,
  json: async () => [
    { name: "agency.pendingApprovals", description: "Approvals waiting", minAssurance: "low", method: "GET", pathTemplate: "/api/:tenantId/modules/agency/approvals/pending", inputSchema: { type: "object", properties: { tenantId: { type: "string" } }, required: ["tenantId"] } },
  ],
})) as unknown as typeof fetch;

describe("automation scoped service accounts + write gate (WS4 §3)", () => {
  beforeEach(async () => {
    resetRegistry();
    registerCoreTools();
    registerPlatformTools();
    registerPlatformWriteTools();
    await registerModuleTools(moduleDefsFetch);
  });

  it("scopes a workflow to only its allow-listed tools (deny-by-default)", () => {
    const p = wf("wf:stale-approval-chaser"); // scoped to ["agency.pendingApprovals", "notify"]
    const visible = visibleTools(p).map((t) => t.name).sort();
    expect(visible).toEqual(["agency.pendingApprovals", "notify"]);
    expect(authorize(p, "agency.pendingApprovals").allow).toBe(true);
    expect(authorize(p, "notify").allow).toBe(true);
    // Out of scope even though a low-assurance human could see it:
    expect(authorize(p, "llm.summarize").allow).toBe(false);
  });

  it("denies an unknown workflow id everything", () => {
    const p = wf("wf:not-registered");
    expect(visibleTools(p)).toHaveLength(0);
    const d = authorize(p, "llm.summarize");
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toMatch(/not scoped/);
  });

  it("allows a LOW-impact write for a scoped workflow (auto)", () => {
    const p = wf("wf:new-client-seed"); // scoped to projects.create + tasks.create (both low)
    expect(authorize(p, "projects.create").allow).toBe(true);
    expect(authorize(p, "tasks.create").allow).toBe(true);
  });

  it("a write workflow may call approvals.request (the LOW-impact suspension surface)", () => {
    // The impact-gate/suspend path (§3/D14): a write workflow files a pending approval via this
    // tool when the gate refuses a medium+/unclassified write. It's a low write, so it runs auto.
    expect(authorize(wf("wf:new-client-seed"), "approvals.request").allow).toBe(true);
    expect(authorize(wf("wf:task-sla"), "approvals.request").allow).toBe(true);
    // A read-only workflow is NOT scoped for it.
    expect(authorize(wf("wf:stale-approval-chaser"), "approvals.request").allow).toBe(false);
  });

  it("does NOT grant humans automation scoping (a low human keeps normal visibility)", () => {
    const human: Principal = { provider: "whatsapp", externalId: "628110@c.us", assurance: "low" };
    const names = visibleTools(human).map((t) => t.name);
    expect(names).toContain("llm.summarize");
    expect(names).toContain("projects.create");
  });
});

describe("D14 write gate suspends medium+/unclassified writes for automation", () => {
  beforeEach(() => {
    resetRegistry();
    registerTool({
      name: "money.transfer",
      description: "test medium write",
      minAssurance: "low",
      write: true,
      impact: "medium",
      inputSchema: { type: "object" },
      handler: async () => "ok",
    });
    registerTool({
      name: "danger.unclassified",
      description: "test unclassified write",
      minAssurance: "low",
      write: true, // no impact declared -> confirm-required
      inputSchema: { type: "object" },
      handler: async () => "ok",
    });
    AUTOMATION_ALLOWLIST["wf:test-writes"] = ["money.transfer", "danger.unclassified"];
  });
  afterEach(() => {
    delete AUTOMATION_ALLOWLIST["wf:test-writes"];
  });

  it("suspends a medium-impact write (approval required)", () => {
    const d = authorize(wf("wf:test-writes"), "money.transfer");
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toMatch(/suspend.*medium-impact/);
  });

  it("suspends an unclassified write", () => {
    const d = authorize(wf("wf:test-writes"), "danger.unclassified");
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toMatch(/suspend.*unclassified/);
  });
});
