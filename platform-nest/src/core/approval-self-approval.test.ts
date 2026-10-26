// PGL-05 (PV-D46 (1)) — the self-approval rule as a PURE function, and the structural facts it depends on. No database.
// The decide route, the façade, the second wall and the hints are driven for real in `pgl-05-approvals.db.test.ts`.
//
// What this file pins:
//   - the rule's four inputs (origin, effective impact, filer, the decider and the human the decide call acts for);
//   - that the effective impact is the HIGHEST of the server-side tiers and the stored value, so the filer, who supplies
//     the stored value, can raise it but never lower a server-side "high";
//   - that EVERY executable registry entry resolves to a server-side tier (the platform's own tool def, or the entry's
//     declared tier for a hub-local tool), and that the two never both exist for one tool: a tool that can execute always
//     has an impact the filer cannot lower, and no tier is restated twice;
//   - the act-for filing refusal.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { registerModule, resetModules } from "../modules/registry";
import { webdevModule } from "../modules/webdev";
import { socialModule } from "../modules/social";
import { hrModule } from "../modules/hr";
import { allCoreTools } from "./core-tools";
import {
  getExecutable,
  listExecutableApprovals,
  registerAllExecutableApprovals,
  resetExecutableApprovals,
} from "./approval-executables";
import {
  ACT_FOR_FILING_UNSUPPORTED,
  SELF_APPROVAL,
  actForFilingRefusal,
  effectiveApprovalImpact,
  platformToolImpact,
  selfApprovalVerdict,
  serverSideToolImpact,
} from "./approval-self-approval";

const FILER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const THIRD = "33333333-3333-4333-8333-333333333333";

describe("PGL-05 · the self-approval rule (pure)", () => {
  beforeAll(() => {
    // The modules that own executable tools, registered the way bootstrap() does, so their tool defs are visible.
    resetModules();
    registerModule(webdevModule);
    registerModule(socialModule);
    registerModule(hrModule);
    resetExecutableApprovals();
    registerAllExecutableApprovals();
  });
  afterAll(() => {
    resetModules();
  });

  const high = (over: Partial<{ origin: string; toolName: string; impact: string | null; requestedBy: string | null }> = {}) => ({
    origin: "agent", toolName: "invoices.issue", impact: "high", requestedBy: FILER, ...over,
  });

  it("🔴 the filer approving their own high-impact agent request is refused as self_approval", () => {
    expect(selfApprovalVerdict(high(), { userId: FILER })).toEqual({ ok: false, reason: SELF_APPROVAL });
  });

  it("🔴 a decider acting FOR the filer is refused; the filer acting for someone else is refused too", () => {
    expect(selfApprovalVerdict(high(), { userId: OTHER, actForUserId: FILER })).toEqual({ ok: false, reason: SELF_APPROVAL });
    expect(selfApprovalVerdict(high(), { userId: FILER, actForUserId: OTHER })).toEqual({ ok: false, reason: SELF_APPROVAL });
  });

  it("covers both D14 origins, automation and agent, and no other origin", () => {
    expect(selfApprovalVerdict(high({ origin: "automation" }), { userId: FILER })).toEqual({ ok: false, reason: SELF_APPROVAL });
    for (const origin of ["hr", "iam", "search", "webdesk", "github", "credential_reveal"]) {
      expect(selfApprovalVerdict(high({ origin }), { userId: FILER }), origin).toEqual({ ok: true });
    }
  });

  it("a different approver passes, also when acting for a third person", () => {
    expect(selfApprovalVerdict(high(), { userId: OTHER })).toEqual({ ok: true });
    expect(selfApprovalVerdict(high(), { userId: OTHER, actForUserId: THIRD })).toEqual({ ok: true });
  });

  it("medium, low and unclassified rows are unchanged: the filer may approve them", () => {
    expect(selfApprovalVerdict(high({ toolName: "contracts.send", impact: "medium" }), { userId: FILER })).toEqual({ ok: true });
    expect(selfApprovalVerdict(high({ toolName: "pm.createTask", impact: "medium" }), { userId: FILER })).toEqual({ ok: true });
    expect(selfApprovalVerdict(high({ toolName: "test.unknown-tool", impact: "unclassified" }), { userId: FILER })).toEqual({ ok: true });
    expect(selfApprovalVerdict(high({ toolName: "test.unknown-tool", impact: "medium" }), { userId: FILER })).toEqual({ ok: true });
  });

  it("🔴 the filer cannot dodge the rule by under-labelling: a server-side HIGH tool stored as medium or unclassified is high", () => {
    for (const stored of ["medium", "unclassified", null]) {
      expect(selfApprovalVerdict(high({ impact: stored }), { userId: FILER }), String(stored)).toEqual({ ok: false, reason: SELF_APPROVAL });
      expect(selfApprovalVerdict(high({ toolName: "contracts.countersign", impact: stored }), { userId: FILER })).toEqual({ ok: false, reason: SELF_APPROVAL });
      // Hub-local: deploy.production's tier comes from its registry entry.
      expect(selfApprovalVerdict(high({ toolName: "deploy.production", impact: stored, origin: "automation" }), { userId: FILER }))
        .toEqual({ ok: false, reason: SELF_APPROVAL });
    }
  });

  it("the stored value can only RAISE the tier: a low/medium tool filed as high is held to the rule", () => {
    expect(effectiveApprovalImpact("contracts.send", "high")).toBe("high");
    expect(effectiveApprovalImpact("pm.createTask", "high")).toBe("high");
    expect(selfApprovalVerdict(high({ toolName: "contracts.send", impact: "high" }), { userId: FILER })).toEqual({ ok: false, reason: SELF_APPROVAL });
  });

  it("a high row with no decider id is refused (approver_unknown); a row with no filer has no filer to exclude", () => {
    expect(selfApprovalVerdict(high(), { userId: null })).toEqual({ ok: false, reason: "approver_unknown" });
    expect(selfApprovalVerdict(high(), { userId: "" })).toEqual({ ok: false, reason: "approver_unknown" });
    expect(selfApprovalVerdict(high({ requestedBy: null }), { userId: FILER })).toEqual({ ok: true });
    // Not high: an id-less decider is not this rule's business (the entry's approverCheck and Cerbos still run).
    expect(selfApprovalVerdict(high({ toolName: "contracts.send", impact: "medium" }), { userId: null })).toEqual({ ok: true });
  });

  it("the tiers the rule reads: platform defs, then the registry's declared tier for hub-local tools", () => {
    expect(platformToolImpact("contracts.countersign")).toBe("high");
    expect(platformToolImpact("invoicePayments.decide")).toBe("high");
    expect(platformToolImpact("contracts.send")).toBe("medium");
    expect(platformToolImpact("deploy.production")).toBeUndefined();
    expect(serverSideToolImpact("deploy.production")).toBe("high");
    expect(serverSideToolImpact("deploy.staging")).toBe("low");
    expect(serverSideToolImpact("test.unknown-tool")).toBeUndefined();
    expect(effectiveApprovalImpact("test.unknown-tool", null)).toBe("unclassified");
    expect(effectiveApprovalImpact("test.unknown-tool", "unclassified")).toBe("unclassified");
  });

  it("🔴 STRUCTURAL: every executable registry entry has a server-side tier, declared exactly once", () => {
    const entries = listExecutableApprovals();
    expect(entries.length).toBeGreaterThan(20); // the real registry, not an empty one
    const missing: string[] = [];
    const restated: string[] = [];
    for (const e of entries) {
      const fromDef = platformToolImpact(e.toolName);
      if (!fromDef && !e.impact) missing.push(e.toolName);
      if (fromDef && e.impact) restated.push(e.toolName);
    }
    // A tool that can EXECUTE must have an impact the filer cannot lower. Fix: give the tool an `impact` on its
    // McpToolDef (platform-defined) or on its registry entry (hub-local only).
    expect(missing, "executable tools with no server-side impact tier").toEqual([]);
    // Two copies of a tier drift; a platform-defined tool's tier lives on its def alone.
    expect(restated, "platform-defined tools whose tier is restated on the registry entry").toEqual([]);
  });

  it("the D14 high tools the ruling is about resolve high: countersign, payment decide, invoice issue/void, deploy.production", () => {
    for (const t of ["contracts.countersign", "invoicePayments.decide", "invoices.issue", "invoices.voidIssued", "deploy.production"]) {
      expect(getExecutable(t), t).toBeDefined();
      expect(serverSideToolImpact(t), t).toBe("high");
    }
    // Every platform tool def the hub sees for contracts/payments: the writes carry a tier.
    const billing = allCoreTools().filter((d) => d.name.startsWith("contracts.") || d.name.startsWith("invoicePayments."));
    for (const d of billing.filter((x) => x.write)) expect(d.impact, d.name).toBeDefined();
  });

  it("PGL-07 cross-side pin: the ONLY non-write contract/payment defs are the hub's read set", () => {
    // mcp-hub/src/automation-policy.pgl07.test.ts restates this set as the only contract/payment tools a workflow may
    // name. If a new READ is added here, add it there; if one of these ever becomes a write, both sides must change.
    const billing = allCoreTools().filter((d) => d.name.startsWith("contracts.") || d.name.startsWith("invoicePayments."));
    expect(billing.filter((d) => !d.write).map((d) => d.name).sort()).toEqual(["contracts.get", "contracts.list", "invoicePayments.list"]);
  });

  it("🔴 a filing that acts for SOMEONE ELSE is refused (its human would not be recorded); acting for oneself is fine", () => {
    expect(actForFilingRefusal({ userId: OTHER, actFor: { userId: FILER } })).toBe(ACT_FOR_FILING_UNSUPPORTED);
    expect(actForFilingRefusal({ userId: FILER, actFor: { userId: FILER } })).toBeNull();
    expect(actForFilingRefusal({ userId: FILER })).toBeNull();
  });
});
