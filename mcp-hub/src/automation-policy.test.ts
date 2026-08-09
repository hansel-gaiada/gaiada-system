import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { authorize, visibleTools } from "./policy";
import { resetRegistry, registerTool } from "./registry";
import { registerCoreTools } from "./tools";
import { registerPlatformTools } from "./platform-tools";
import { registerPlatformWriteTools } from "./platform-write-tools";
import { registerModuleTools } from "./module-tools";
import { registerWorkActivityTools } from "./work-activity-tools";
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
    registerWorkActivityTools();
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

  // SM-55 (architect ruling §6ad/A13): SM-15's search-marketing allow-list entries are retired —
  // no allow-list may ever give n8n a path to a money-spending tool. These ids must stay unknown
  // (deny-by-default), proving the general rule rather than a hardcoded exception for search.
  it("SM-55: the retired search-marketing workflow ids are unknown, not scoped to anything", () => {
    for (const id of ["wf:sm-rank-pull", "wf:sm-keyword-refresh", "wf:sm-rank-collect"]) {
      const p = wf(id);
      expect(visibleTools(p)).toHaveLength(0);
      const d = authorize(p, "llm.summarize");
      expect(d.allow).toBe(false);
      if (!d.allow) expect(d.reason).toMatch(/not scoped/);
    }
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

  // WD-26: the two new per-workflow accounts are scoped to exactly their own tools — invisible to
  // every other wf:* account, and to each other's tools too (per-flow scoping doctrine).
  it("wf:wd-digests is scoped to its own tools only (invisible to wf:wd-stale-nag's tools)", () => {
    const p = wf("wf:wd-digests");
    const visible = visibleTools(p).map((t) => t.name).sort();
    expect(visible).toEqual(["llm.summarize", "notify", "projects.get", "workActivity.feed", "workActivity.relink"].sort());
    expect(authorize(p, "workActivity.staleTasks").allow).toBe(false);
  });

  it("wf:wd-stale-nag is scoped to its own tools only (invisible to wf:wd-digests' tools)", () => {
    const p = wf("wf:wd-stale-nag");
    const visible = visibleTools(p).map((t) => t.name).sort();
    expect(visible).toEqual(["notify", "workActivity.staleTasks"].sort());
    expect(authorize(p, "workActivity.feed").allow).toBe(false);
    expect(authorize(p, "workActivity.relink").allow).toBe(false);
  });

  it("workActivity.relink is a LOW-impact write for wf:wd-digests (auto-runs, no medium+ write anywhere)", () => {
    expect(authorize(wf("wf:wd-digests"), "workActivity.relink").allow).toBe(true);
  });

  // TR-22: the two P4 seal/generate/deliver flows are scoped to ONLY `notify` — everything else
  // they do (seal/overview/export) is a direct-to-platform call, never a hub tool, same shape as
  // TR-11's three reads/writes above.
  it("wf:reports-weekly-seal and wf:reports-monthly-seal are scoped to notify ONLY", () => {
    for (const id of ["wf:reports-weekly-seal", "wf:reports-monthly-seal"]) {
      const p = wf(id);
      const visible = visibleTools(p).map((t) => t.name).sort();
      expect(visible).toEqual(["notify"]);
      expect(authorize(p, "notify").allow).toBe(true);
      expect(authorize(p, "reports.getDocument").allow).toBe(false);
    }
  });

  // PRV-03 — the provision<->ERP seam's automation entry point. Registration is part of the
  // feature (this estate has hit "correct-but-unwired" six times), so this pins BOTH halves: the
  // allow-list membership itself, and that calling it directly (no grant) suspends as a
  // medium-impact write rather than either executing or being invisible/unscoped.
  it("wf:delivery is scoped to webdev.provisionSite (PRV-03), and an ungranted call suspends as a medium-impact write", () => {
    expect(AUTOMATION_ALLOWLIST["wf:delivery"]).toContain("webdev.provisionSite");
    registerTool({
      name: "webdev.provisionSite",
      description: "provision a site+repo",
      minAssurance: "low",
      write: true,
      impact: "medium",
      inputSchema: { type: "object" },
      handler: async () => "PROVISIONED",
    });
    const p = wf("wf:delivery");
    expect(visibleTools(p).map((t) => t.name)).toContain("webdev.provisionSite");
    const d = authorize(p, "webdev.provisionSite");
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toMatch(/suspend.*medium-impact/);
  });

  it("does NOT grant humans automation scoping (a low human keeps normal visibility)", () => {
    const human: Principal = { provider: "whatsapp", externalId: "628110@c.us", assurance: "low" };
    const names = visibleTools(human).map((t) => t.name);
    expect(names).toContain("llm.summarize");
    expect(names).toContain("projects.create");
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // D14-14 — approvals.resolveExecute: never scoped, and the fail-closed tripwire if it ever is.
  //
  // These isolate the WORKFLOW-SCOPE and IMPACT-SUSPEND logic specifically, so they mint a "verified"
  // n8n principal (`wfVerified`, NOT the file's shared `wf()` helper, which mints "low" — the same
  // ceiling the real `mintPrincipal()` puts on every envelope-derived principal today). With a real
  // "low" n8n principal the assurance-rank check in `authorize()` denies FIRST, before workflow scope
  // or impact is ever consulted — which is an even stronger floor than either of these tests targets,
  // but it would make both tests trivially pass for the wrong reason (a `wf()`-minted principal always
  // reads "denied: ... requires verified assurance", never "not scoped" or "suspend: ... high-impact").
  // Elevating assurance here isolates the SPECIFIC mechanisms Ruling 1 calls out; the real-world
  // assurance ceiling is exercised separately in the LAST test in this block.
  // ════════════════════════════════════════════════════════════════════════════════════════════════
  function wfVerified(externalId: string): Principal {
    return { provider: "n8n", externalId, assurance: "verified" };
  }

  describe("approvals.resolveExecute is never model/workflow-selectable (D14-14, architect Ruling 1)", () => {
    it("is in NO real workflow's AUTOMATION_ALLOWLIST entry (structural — catches an accidental future addition)", () => {
      const offenders = Object.entries(AUTOMATION_ALLOWLIST)
        .filter(([, tools]) => tools.includes("approvals.resolveExecute"))
        .map(([wf]) => wf);
      expect(offenders).toEqual([]);
    });

    it("a verified n8n principal is STILL denied by the WORKFLOW-SCOPE check (deny-by-default — no allowlist entry names it)", () => {
      const d = authorize(wfVerified("wf:new-client-seed"), "approvals.resolveExecute"); // a real, otherwise-write-capable workflow
      expect(d.allow).toBe(false);
      if (!d.allow) expect(d.reason).toMatch(/not scoped/);
    });

    it("THE TRIPWIRE: if it were EVER (mis-)scoped into a workflow, the impact gate would suspend it, not execute it", () => {
      // Simulates the one mistake the architect's Ruling 1 explicitly guards against: someone adding
      // this name to a real AUTOMATION_ALLOWLIST entry. Even then, the workflow-scope check would pass
      // (that's the whole point of the mistake) — but the write:true/impact:"high" label the tool
      // itself carries (registered in platform-write-tools.ts) means the D14 impact-suspend branch in
      // `policy.ts` fires next, deny-with-suspend rather than allow. The honesty of the label IS the
      // fail-closed backstop.
      AUTOMATION_ALLOWLIST["wf:d14-14-mis-scoped-tripwire-test"] = ["approvals.resolveExecute"];
      try {
        const d = authorize(wfVerified("wf:d14-14-mis-scoped-tripwire-test"), "approvals.resolveExecute");
        expect(d.allow).toBe(false);
        if (!d.allow) expect(d.reason).toMatch(/suspend.*high-impact/);
      } finally {
        delete AUTOMATION_ALLOWLIST["wf:d14-14-mis-scoped-tripwire-test"];
      }
    });

    it("a real (\"low\") n8n envelope is denied on assurance ALONE, before workflow-scope is even consulted — the actual production floor", () => {
      const d = authorize(wf("wf:new-client-seed"), "approvals.resolveExecute"); // wf() mints "low", like real mintPrincipal()
      expect(d.allow).toBe(false);
      if (!d.allow) expect(d.reason).toMatch(/assurance/);
    });

    it("a non-automation (agent-envelope) principal is NOT gated by the workflow-scope/impact-suspend branch at all — assurance is the only floor", () => {
      // The runner's OBO envelope for an agent goal is never provider==="n8n" (it is the ORIGINAL
      // human/channel requester's envelope — telegram/whatsapp/platform/etc.), so `isAutomation()` is
      // false and the whole automation branch in policy.ts (workflow scope + impact suspend) is
      // skipped entirely, exactly as the architect's Ruling 1 states ("the agent-side gate never sees
      // a tool that no AgentDef lists"). What remains is the assurance floor (minAssurance:"verified"
      // on the tool itself) — a "low" agent-envelope principal is denied there, not by this branch.
      const agentEnvelope: Principal = { provider: "telegram", externalId: "tg:555", assurance: "low" };
      const d = authorize(agentEnvelope, "approvals.resolveExecute");
      expect(d.allow).toBe(false);
      if (!d.allow) expect(d.reason).toMatch(/assurance/);
      const verifiedAgentEnvelope: Principal = { provider: "telegram", externalId: "tg:555", assurance: "verified" };
      expect(authorize(verifiedAgentEnvelope, "approvals.resolveExecute").allow).toBe(true);
    });
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
