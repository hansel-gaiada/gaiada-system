// P2-07 (structural gap) — the core-owned tool surface, and the invariants that keep it honest.
//
// Two of these tests exist because of failures this program actually had rather than in the abstract:
// the declared-write-without-a-D14-executor shape (which would let an agent's approved write suspend
// and then silently do nothing), and the exact-name-list pin (the one place a tool appearing on or
// vanishing from the agent surface shows up in a diff).
import { describe, it, expect } from "vitest";
import { allCoreTools, registerCoreTools } from "./core-tools";
import { getExecutable, isBarredExecutable } from "./approval-executables";

const tools = allCoreTools();
const byName = new Map(tools.map((t) => [t.name, t]));

describe("P2-07 · the core-owned MCP tool surface", () => {
  it("declares exactly this set — the pin that makes an agent-surface change visible in a diff", () => {
    expect(tools.map((t) => t.name)).toEqual([
      "iam.listPositions",
      "iam.listAttachableRoles",
      "iam.listRoleGrants",
      "iam.requestAssignment",
      "iam.requestOverride",
    ]);
  });

  it("rejects a duplicate registration rather than overwriting silently", () => {
    expect(() => registerCoreTools([{ ...byName.get("iam.listPositions")! }])).toThrow(/already registered/i);
  });

  it("every tool requires a verified caller", () => {
    // These read and propose changes to who holds which authority. A low-assurance door here would be
    // wider than the human UI's, which is the line the agentic-native bar draws.
    for (const t of tools) expect(t.minAssurance, t.name).toBe("verified");
  });

  it("the path templates name every parameter their inputSchema requires", () => {
    // The hub fills `:param` tokens from the tool's args. A token with no required arg is a tool that
    // cannot be called correctly — cheap to assert, invisible otherwise.
    for (const t of tools) {
      if (!t.pathTemplate) continue;
      const tokens = [...t.pathTemplate.matchAll(/:(\w+)/g)].map((m) => m[1]);
      const required = (t.inputSchema as { required?: string[] })?.required ?? [];
      for (const tok of tokens) expect(required, `${t.name} must require :${tok}`).toContain(tok);
    }
  });

  it("the reads are reads: no `write`, no `impact`, GET only", () => {
    for (const name of ["iam.listPositions", "iam.listAttachableRoles", "iam.listRoleGrants"]) {
      const t = byName.get(name)!;
      expect(t.method).toBe("GET");
      expect(t.write).toBeUndefined();
      expect(t.impact).toBeUndefined();
    }
  });

  it("🔴 the two PROPOSAL tools are impact `low`, and that is load-bearing, not a shrug", () => {
    // Their whole effect is a PENDING approval row a human then decides. Marking either medium would
    // require an approval in order to ask for an approval — and because a medium write also needs a
    // D14 executor to complete at all, it would dead-end the natural agent path silently. Filing a
    // request is the low-impact action; granting is the high one, which is why granting is not here.
    for (const name of ["iam.requestAssignment", "iam.requestOverride"]) {
      const t = byName.get(name)!;
      expect(t.write).toBe(true);
      expect(t.impact).toBe("low");
      expect(t.method).toBe("POST");
    }
    // A proposal without a justification is not a proposal — the human deciding it needs the reason,
    // and both endpoints require one server-side.
    for (const name of ["iam.requestAssignment", "iam.requestOverride"]) {
      expect((byName.get(name)!.inputSchema as { required?: string[] }).required).toContain("justification");
    }
  });

  it("🔴 no core tool declares a medium/high write without a D14 executor (or an explicit bar)", () => {
    // The invariant from `hr-employee-tools.test.ts`, restated for this registry because the failure
    // shape is identical and worse here: an approved role-grant that silently does nothing would leave
    // a human believing they granted access that does not exist. `low` is exempt — it executes
    // directly and never reaches the registry.
    for (const t of tools) {
      if (!t.write || t.impact === "low") continue;
      const covered = !!getExecutable(t.name) || isBarredExecutable(t.name);
      expect({ tool: t.name, covered }).toEqual({ tool: t.name, covered: true });
    }
  });

  it("🔴 the schemas match the REAL handlers — three mismatches were found this way", () => {
    // Every one of these was wrong on first writing, and none is visible to the path-template check:
    //   1. iam.listPositions advertised unitNodeId/status filters the handler does not read.
    //   2. iam.listRoleGrants made `userId` optional; the endpoint 400s without it.
    //   3. iam.requestOverride called the field `scopeKind` (the DB column family's name) where the
    //      handler reads `scopeType`, and offered "global", which this surface refuses. That one is the
    //      worst shape available: the call would have SUCCEEDED and silently defaulted to company
    //      scope — doing something other than what was asked.
    // Pinned as literals rather than derived, because deriving them from the controller is what a
    // schema already claims to do; the point is that a human checked once.
    expect(Object.keys((byName.get("iam.listPositions")!.inputSchema as { properties: object }).properties)).toEqual([
      "tenantId",
    ]);
    expect((byName.get("iam.listRoleGrants")!.inputSchema as { required: string[] }).required).toEqual([
      "tenantId",
      "userId",
    ]);
    const override = byName.get("iam.requestOverride")!.inputSchema as {
      properties: Record<string, { enum?: string[] }>;
    };
    expect(Object.keys(override.properties)).toContain("scopeType");
    expect(Object.keys(override.properties)).not.toContain("scopeKind");
    expect(override.properties.scopeType.enum).toEqual(["company", "org_unit"]);
  });

  it("🔴 the DIRECT grant/assign writes are absent — an owner decision, not an oversight", () => {
    // Recorded as a test so the absence is a stated position rather than a hole someone fills by
    // accident. A tool that grants a role is a privilege-escalation surface, and the estate's audit
    // attribution currently says "Alice" rather than "Alice's agent" — granting rights through a
    // surface whose attribution is known to be wrong is the combination worth refusing on purpose.
    // The proposal tools above give an agent notice-and-propose with no escalation.
    for (const absent of ["iam.grantRole", "iam.revokeRoleGrant", "iam.assignPosition", "iam.unassignPosition"]) {
      expect(byName.has(absent), `${absent} must not be declared without an owner decision`).toBe(false);
    }
  });
});
