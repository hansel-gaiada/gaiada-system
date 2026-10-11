// M5-P1-c — the agent-surface gate for the lead pipeline tools (`agency_pipeline.*`), at the layer mcp-hub
// owns: the impact gate and the assurance / workflow-scope checks.
//
// Design: docs/plans/2026-10-11-m5-lead-pipeline-design.md §6. The tool DEFS live in
// platform-nest/src/core/core-tools.ts (pinned by core-tools.test.ts) and reach this hub at boot through
// GET /mcp/tool-defs, so, as in agency-intake-tools.test.ts, the fixture registers a tool with the SAME
// name / write / impact / minAssurance the real def carries. The gate is what is under test.
//
// What this pins:
//   - moveStage and setDealValue are LOW: a verified agent runs them unattended, with no suspension. A move
//     sends nothing itself; the only external effect it can start (a P2 ad upload) has its own approval.
//   - an n8n workflow is refused both of them: no workflow is scoped for this namespace, and a low-assurance
//     principal is refused on minAssurance, so neither door opens by accident.
//   - won and lost have NO tool in this namespace: they are agency_intake.convert (medium, suspends for an
//     agent) and agency_intake.decline.
import { describe, it, expect, beforeEach } from "vitest";
import { config } from "./config";
import { resetRegistry, registerTool } from "./registry";
import { authorize } from "./policy";
import { AUTOMATION_ALLOWLIST } from "./automation-policy";
import type { Principal } from "./principal";

const HUMAN: Principal = { provider: "platform", externalId: "staff-1", assurance: "verified" };
const AGENT: Principal = { ...HUMAN, agent: "agent:agency-pipeline" };
const N8N_VERIFIED: Principal = { provider: "n8n", externalId: "wf:pipeline-fanout", assurance: "verified" };
const N8N_LOW: Principal = { provider: "n8n", externalId: "wf:pipeline-fanout", assurance: "low" };
const LOW_HUMAN: Principal = { provider: "whatsapp", externalId: "chat-9", assurance: "low" };

const READS = ["agency_pipeline.reference", "agency_pipeline.stageHistory"];
const LOW_WRITES = ["agency_pipeline.moveStage", "agency_pipeline.setDealValue"];

function tool(name: string, over: Partial<{ write: boolean; impact: "low" | "medium" | "high" }> = {}) {
  registerTool({
    name,
    description: "x",
    minAssurance: "verified",
    inputSchema: { type: "object" },
    handler: async () => "",
    ...over,
  });
}

describe("agency_pipeline.* — the in-code gate (fail-closed fallback)", () => {
  beforeEach(() => {
    resetRegistry();
    config.cerbosUrl = "";
    for (const r of READS) tool(r);
    for (const w of LOW_WRITES) tool(w, { write: true, impact: "low" });
    tool("agency_intake.convert", { write: true, impact: "medium" });
    tool("agency_intake.decline", { write: true, impact: "low" });
  });

  it("a verified AGENT runs moveStage and setDealValue unattended: low impact, no suspension", () => {
    for (const name of LOW_WRITES) {
      const d = authorize(AGENT, name);
      expect(d.allow, name).toBe(true);
    }
  });

  it("a verified human runs them too, and both reads run unattended for an agent", () => {
    for (const name of [...LOW_WRITES, ...READS]) expect(authorize(HUMAN, name).allow, name).toBe(true);
    for (const name of READS) expect(authorize(AGENT, name).allow, name).toBe(true);
  });

  it("an n8n workflow is REFUSED both writes (and both reads): no workflow is scoped for this namespace", () => {
    for (const name of [...LOW_WRITES, ...READS]) {
      const d = authorize(N8N_VERIFIED, name);
      expect(d.allow, name).toBe(false);
      if (!d.allow) expect(d.reason).toMatch(/not scoped for/);
    }
    for (const [wf, scope] of Object.entries(AUTOMATION_ALLOWLIST)) {
      expect(scope.filter((t) => t.startsWith("agency_pipeline.")), wf).toEqual([]);
    }
  });

  it("minAssurance holds: a low-assurance n8n principal and a low-assurance chat caller are refused on assurance", () => {
    for (const name of [...LOW_WRITES, ...READS]) {
      for (const p of [N8N_LOW, LOW_HUMAN]) {
        const d = authorize(p, name);
        expect(d.allow, `${p.provider} ${name}`).toBe(false);
        if (!d.allow) expect(d.reason).toMatch(/requires verified assurance/);
      }
    }
  });

  it("WON is not reachable through this namespace: an agent that wants it hits convert, which SUSPENDS (medium)", () => {
    const d = authorize(AGENT, "agency_intake.convert");
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toMatch(/^suspend:/);
    // and the 'plausible' names are not live
    for (const name of ["agency_pipeline.won", "agency_pipeline.lost", "agency_pipeline.convert", "agency_pipeline.decline"]) {
      const x = authorize(AGENT, name);
      expect(x.allow, name).toBe(false);
      if (!x.allow) expect(x.reason).toMatch(/^unknown tool:/);
    }
  });

  it("LOST is agency_intake.decline, low: an agent runs it unattended", () => {
    expect(authorize(AGENT, "agency_intake.decline").allow).toBe(true);
  });

  it("a medium reclassification of moveStage would suspend an agent (the control that shows the test bites)", () => {
    resetRegistry();
    tool("agency_pipeline.moveStage", { write: true, impact: "medium" });
    const d = authorize(AGENT, "agency_pipeline.moveStage");
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toMatch(/^suspend:/);
  });
});
