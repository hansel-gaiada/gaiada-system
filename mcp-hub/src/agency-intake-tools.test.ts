// AD-8 — the golden case for Agency Discovery Intake's readiness-bar criterion 1 (tool parity) and
// criterion 4 (impact-classified writes), at the layer this ticket actually owns: mcp-hub's own D14
// impact gate.
//
// Design: docs/superpowers/plans/2026-09-05-agency-discovery-intake-design.md §8 (compliance table),
// §8(b) (the limitation this suite is written to PROVE, not paper over).
//
// ── WHAT THIS FILE DOES AND DOES NOT PROVE ───────────────────────────────────────────────────────
// `agency_intake.*` tool defs are declared in platform-nest/src/core/core-tools.ts and reach this hub
// generically at boot via GET /mcp/tool-defs (mcp-hub/src/module-tools.ts) — there is no
// agency-intake-specific file on the hub side to unit test the SHAPE of. What genuinely belongs here,
// and is this ticket's own golden case, is the D14 impact gate's behaviour for these exact tool names:
// mirrors mcp-hub/src/agent-impact-gate.test.ts's own pattern (fixture-registers a tool with the SAME
// name/write/impact the real def carries, then asserts what `authorize()`/`authorizeCall()` do with
// it) — the pattern that file itself established for exactly this reason: the gate logic is what's
// under test, not the wire fetch.
//
// §8(b), stated plainly and pinned by the tests below: `agency_intake.convert` is medium-impact, so an
// UNATTENDED caller (an agent) SUSPENDS before the platform is ever reached — this is the
// "an agent-initiated convert suspends and never executes [in that call]" the design commits to. It
// stays true regardless of whether a SEPARATE, later, human-approved resume of that same request can
// eventually execute (core/approval-executables.ts's AD-8 entry registers that eligibility) — this
// suite does not touch that path at all, on purpose: proving it needs a reachable mcp-hub + Cerbos +
// platform round trip, which is out of this file's reach exactly as d14-09-agent-origin-authority.
// test.ts's own scope note says it is for every other D14-gated tool. No n8n workflow is scoped for
// this namespace today (asserted below, against the real allow-list) — there is no automation use
// case for Agency Discovery Intake in the design, so the impact gate's n8n branch is untested here for
// the honest reason that nothing calls it, not because it was skipped.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { config } from "./config";
import { resetRegistry, registerTool } from "./registry";
import { authorize, authorizeCall } from "./policy";
import { AUTOMATION_ALLOWLIST } from "./automation-policy";
import type { Principal } from "./principal";

const HUMAN: Principal = { provider: "platform", externalId: "staff-1", assurance: "verified" };
const AGENT: Principal = { ...HUMAN, agent: "agent:agency-lead-filer" };

/** Registers a fixture tool with the SAME name/write/impact the real `core-tools.ts` def carries —
 *  the gate is what is under test, so the fixture only needs to match on the three fields the gate
 *  actually reads. */
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

const READS = ["agency_intake.listLeads", "agency_intake.getLead", "agency_intake.listSubmissions"];
const LOW_WRITES = ["agency_intake.invite", "agency_intake.open", "agency_intake.decline", "agency_intake.nurture"];

describe("agency_intake.* — the in-code gate (fail-closed fallback)", () => {
  beforeEach(() => {
    resetRegistry();
    config.cerbosUrl = "";
    for (const r of READS) tool(r);
    for (const w of LOW_WRITES) tool(w, { write: true, impact: "low" });
    tool("agency_intake.convert", { write: true, impact: "medium" });
  });

  it("🔴 THE CORE PROOF (§8(b)) — an AGENT calling agency_intake.convert SUSPENDS, never executes in that call", () => {
    const d = authorize(AGENT, "agency_intake.convert");
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.reason).toMatch(/^suspend:/);
      expect(d.reason).toContain("agent:agency-lead-filer");
      expect(d.reason).toContain("medium-impact");
    }
  });

  it("no n8n workflow is scoped for ANY agency_intake tool today — this namespace is agent/human only", () => {
    // There is no n8n use case for Agency Discovery Intake in the design (§9.3: no automation topic
    // either) — asserted here as a real config fact, not simulated with a made-up workflow id, because
    // a fabricated `wf:*` would pass the workflow-scope check trivially and prove nothing about the
    // actual allow-list. If a future ticket DOES give n8n a reason to touch this namespace, this test
    // fails and names exactly what changed.
    for (const [wf, scope] of Object.entries(AUTOMATION_ALLOWLIST)) {
      const leaked = scope.filter((t) => t.startsWith("agency_intake."));
      expect(leaked, wf).toEqual([]);
    }
  });

  it("the SAME write is ALLOWED for a plain attended human — the control that proves this is about attendance, not the tool", () => {
    expect(authorize(HUMAN, "agency_intake.convert").allow).toBe(true);
  });

  it("the four LOW-impact triage/invite writes run UNATTENDED for an agent — criterion 1 needs writes, not just suspension", () => {
    for (const name of LOW_WRITES) {
      expect(authorize(AGENT, name).allow, name).toBe(true);
    }
  });

  it("all three reads run unattended for an agent — a namespace with reads and no writes would fail criterion 1, but reads must never be gated", () => {
    for (const name of READS) {
      expect(authorize(AGENT, name).allow, name).toBe(true);
    }
  });

  it("an unknown 'plausible' tool name is not accidentally live — only the shipped name is registered", () => {
    for (const name of ["agency_lead.convert", "agency.lead.convert", "agency_intake.triage"]) {
      const d = authorize(AGENT, name);
      expect(d.allow, name).toBe(false);
      if (!d.allow) expect(d.reason).toMatch(/^unknown tool:/);
    }
  });
});

describe("agency_intake.convert — the Cerbos payload (authoritative when configured)", () => {
  const realFetch = globalThis.fetch;
  let sent: Array<Record<string, unknown>> = [];

  beforeEach(() => {
    resetRegistry();
    tool("agency_intake.convert", { write: true, impact: "medium" });
    sent = [];
    config.cerbosUrl = "http://cerbos.test";
    // Minimal inline stub (mirrors agent-impact-gate.test.ts's own Cerbos stub) — allow everything, so
    // the only thing under test is what the hub told Cerbos about the caller.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { body?: string }) => {
        if (!String(url).startsWith("http://cerbos.test")) return realFetch(url as never, init as never);
        const body = JSON.parse(init?.body ?? "{}") as { principal?: Record<string, unknown> };
        sent.push(body.principal ?? {});
        return {
          ok: true,
          status: 200,
          json: async () => ({ results: [{ resource: { id: "t" }, actions: { call: "EFFECT_ALLOW" } }] }),
        } as never;
      }) as unknown as typeof fetch,
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it("🔴 sends isUnattended=true for an agent calling convert — the attribute the policy keys the gate on", async () => {
    await authorizeCall(AGENT, "agency_intake.convert");
    const attr = (sent[0]?.attr ?? {}) as Record<string, unknown>;
    expect(attr.isUnattended).toBe(true);
    expect(attr.isAutomation).toBe(false);
  });

  it("sends isUnattended=false for a plain human calling convert", async () => {
    await authorizeCall(HUMAN, "agency_intake.convert");
    const attr = (sent[0]?.attr ?? {}) as Record<string, unknown>;
    expect(attr.isUnattended).toBe(false);
  });
});
