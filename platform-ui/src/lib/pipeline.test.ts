import { describe, it, expect } from "vitest";
import { describeBlockage, groupStagesByTrack, humanizeStageName, isStageLocked, type PipelineGate, type PipelineStage } from "./pipeline";

function gate(over: Partial<PipelineGate>): PipelineGate {
  return {
    id: "g-1", run_id: "r-1", stage_id: null, kind: "prd_review", actor_side: "internal",
    status: "pending", decision: null, note: null, decided_by: null, decided_at: null,
    created_at: "2026-07-01T00:00:00Z", ...over,
  };
}
function stage(over: Partial<PipelineStage>): PipelineStage {
  return {
    id: "s-1", track: "delivery", name: "prd_extract", status: "pending",
    artifact_ref: null, confidence: null, updated_at: "2026-07-01T00:00:00Z", ...over,
  };
}

describe("humanizeStageName", () => {
  it("title-cases underscored slugs and uppercases known acronyms", () => {
    expect(humanizeStageName("prd_extract")).toBe("PRD Extract");
    expect(humanizeStageName("scope_extract")).toBe("Scope Extract");
    expect(humanizeStageName("claude_design")).toBe("Claude Design");
    expect(humanizeStageName("staging")).toBe("Staging");
  });
});

describe("groupStagesByTrack", () => {
  it("buckets stages by track, keeping input order, with empty arrays for missing tracks", () => {
    const stages = [stage({ id: "a", track: "delivery" }), stage({ id: "b", track: "scope" }), stage({ id: "c", track: "delivery" })];
    const grouped = groupStagesByTrack(stages);
    expect(grouped.delivery.map((s) => s.id)).toEqual(["a", "c"]);
    expect(grouped.scope.map((s) => s.id)).toEqual(["b"]);
    expect(grouped.report).toEqual([]);
  });
});

describe("describeBlockage", () => {
  it("surfaces the first pending gate, naming which side is holding it up", () => {
    const gates = [gate({ id: "g1", status: "decided" }), gate({ id: "g2", kind: "scope_signoff", actor_side: "client", status: "pending" })];
    const out = describeBlockage({ status: "scope_pending" }, gates);
    expect(out.text).toBe("Waiting on the client: Scope sign-off");
    expect(out.pendingGate?.id).toBe("g2");
  });

  it("names internal review (not the client) for an internal pending gate", () => {
    const gates = [gate({ kind: "pm_review", actor_side: "internal", status: "pending" })];
    const out = describeBlockage({ status: "delivery_active" }, gates);
    expect(out.text).toBe("Waiting on internal review: PM review");
  });

  it("falls back to run.status when no gate is pending", () => {
    expect(describeBlockage({ status: "complete" }, []).text).toMatch(/complete/i);
    expect(describeBlockage({ status: "blocked" }, []).text).toMatch(/blocked/i);
    expect(describeBlockage({ status: "delivery_active" }, []).text).toMatch(/in progress/i);
  });
});

// WD-03 (D-3) — mirrors the backend's PipelineController.updateStage lock rule exactly (same
// kind-by-track convention), so a UI regression here would silently desync from what the backend
// actually enforces.
describe("isStageLocked", () => {
  it("is unlocked before any client gate is decided — editable, even on a 'done' stage", () => {
    const prd = stage({ track: "delivery", status: "done" });
    expect(isStageLocked(prd, [gate({ kind: "prd_sign", actor_side: "client", status: "pending" })])).toBe(false);
    expect(isStageLocked(prd, [])).toBe(false);
  });

  it("locks the delivery track once prd_sign is decided by the client", () => {
    const prd = stage({ track: "delivery" });
    const gates = [gate({ kind: "prd_sign", actor_side: "client", status: "decided", decision: "signed" })];
    expect(isStageLocked(prd, gates)).toBe(true);
  });

  it("locks the scope track once scope_signoff is decided, independent of the delivery track's gate", () => {
    const scope = stage({ id: "s-scope", track: "scope" });
    const gates = [
      gate({ kind: "prd_sign", actor_side: "client", status: "decided" }), // delivery signed
      gate({ kind: "scope_signoff", actor_side: "client", status: "pending" }), // scope NOT yet
    ];
    expect(isStageLocked(scope, gates)).toBe(false);
  });

  it("an internal-side decided gate never locks a client-facing artifact", () => {
    const prd = stage({ track: "delivery" });
    const gates = [gate({ kind: "pm_review", actor_side: "internal", status: "decided" })];
    expect(isStageLocked(prd, gates)).toBe(false);
  });

  it("the report track never locks — no client ever signs it", () => {
    const report = stage({ id: "s-report", track: "report" });
    const gates = [
      gate({ kind: "prd_sign", actor_side: "client", status: "decided" }),
      gate({ kind: "scope_signoff", actor_side: "client", status: "decided" }),
    ];
    expect(isStageLocked(report, gates)).toBe(false);
  });
});
