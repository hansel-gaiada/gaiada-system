// The risk ladder's two invariants, pinned. Design: 2026-08-22-hermes-moe-personas-training.md §4.
//
// These are not routine unit tests. Each block below guards a property whose LOSS IS SILENT — the
// system keeps returning 200s while quietly permitting more than it should. That is the failure mode
// this estate has already met twice (the D14 impact gate that didn't apply to agents; the synthetic
// probe that couldn't see a provider outage), so the properties get tests rather than comments.
import { describe, it, expect } from "vitest";
import {
  computeRisk,
  strongest,
  tierFromImpact,
  tierFromHost,
  runsUnattended,
  mustBeHiddenFromSeat,
  UNRESOLVED_TIER,
  type RiskRule,
} from "./risk";

const RULES: RiskRule[] = [
  { action: "read", env: "*", dataClass: "*", minTier: "R0" },
  { action: "*", env: "staging", dataClass: "*", minTier: "R0" },
  { action: "update", env: "production", dataClass: "*", minTier: "R1" },
  { action: "delete", env: "*", dataClass: "*", minTier: "R2" },
  { action: "delete", env: "production", dataClass: "*", minTier: "R3" },
  { action: "*", env: "*", dataClass: "personal_financial", minTier: "R2" },
];

describe("invariant 1 — the tool's declared impact is a FLOOR", () => {
  it("computation RAISES above the floor", () => {
    // A low-impact tool used to delete in production is not a low-risk call.
    const d = computeRisk({ action: "delete", env: "production", impact: "low", isWrite: true }, RULES);
    expect(d.floor).toBe("R0");
    expect(d.tier).toBe("R3");
  });

  it("computation can NEVER lower the floor — the whole point of a floor", () => {
    // Staging says R0. The tool says high. High must win: a tool that declares itself dangerous
    // stays dangerous even where policy is permissive.
    const d = computeRisk({ action: "update", env: "staging", impact: "high", isWrite: true }, RULES);
    expect(d.floor).toBe("R2");
    expect(d.tier).toBe("R2");
  });

  it("a high-impact tool with NO matching rule still lands at its floor", () => {
    const d = computeRisk({ action: "unheard-of", impact: "high", isWrite: true }, []);
    expect(d.tier).toBe("R2");
  });
});

describe("invariant 2 — FAIL CLOSED (the property a refactor is most likely to invert)", () => {
  it("an UNCLASSIFIED write resolves to R2, never R0", () => {
    // "No rule matched" reads intuitively as "nothing to worry about". It must not.
    const d = computeRisk({ action: "mystery", impact: undefined, isWrite: true }, []);
    expect(d.tier).toBe(UNRESOLVED_TIER);
    expect(d.tier).toBe("R2");
    expect(d.unresolved).toBe(true);
  });

  it("an UNKNOWN host is not a safe host", () => {
    expect(tierFromHost(undefined)).toBe("R2");
  });

  it("the fail-closed constant is R2 — if this ever reads R0 the ladder is inverted", () => {
    expect(UNRESOLVED_TIER).toBe("R2");
  });
});

describe("environment as a first-class axis", () => {
  it("staging is the deliberate agent playground", () => {
    const d = computeRisk({ action: "update", env: "staging", impact: "low", isWrite: true }, RULES);
    expect(d.tier).toBe("R0");
    expect(runsUnattended(d.tier)).toBe(true);
  });

  it("the SAME action on production is not", () => {
    const d = computeRisk({ action: "update", env: "production", impact: "low", isWrite: true }, RULES);
    expect(d.tier).toBe("R2"); // host contributes R2 for production
    expect(runsUnattended(d.tier)).toBe(false);
  });

  it("an explicit host risk_weight overrides the env-derived tier (shared WP hosting)", () => {
    // env=production would derive R2; the override says R3 because rollback is weaker there.
    expect(tierFromHost("production", "R3")).toBe("R3");
  });
});

describe("strongest-wins matching (NOT most-specific-wins)", () => {
  it("a narrow R0 rule cannot silently downgrade a broad stronger rule", () => {
    // This is the single reason matching is non-exclusive. Under "most specific wins", the narrow
    // staging R0 rule would beat the personal_financial R2 rule and quietly permit the call.
    const d = computeRisk(
      { action: "update", env: "staging", dataClass: "personal_financial", impact: "low", isWrite: true },
      RULES,
    );
    expect(d.tier).toBe("R2");
  });

  it("every contributing rule is reported, so a decision can be explained", () => {
    const d = computeRisk({ action: "delete", env: "production", impact: "low", isWrite: true }, RULES);
    expect(d.matched.length).toBeGreaterThan(1);
    expect(d.matched.map((r) => r.minTier)).toContain("R3");
  });

  it("strongest() is order-independent", () => {
    expect(strongest("R0", "R3", "R1")).toBe("R3");
    expect(strongest("R3", "R0")).toBe(strongest("R0", "R3"));
  });
});

describe("continuity with the EXISTING gate (policy.ts:73) — this must not regress", () => {
  // Today: an unattended write suspends unless impact === "low". Under the ladder that is exactly
  // "R0 runs unattended, R1+ suspends". These four cases assert the mapping is the same rule.
  it("low impact is the ONLY impact that runs unattended", () => {
    expect(runsUnattended(tierFromImpact("low", true))).toBe(true);
    expect(runsUnattended(tierFromImpact("medium", true))).toBe(false);
    expect(runsUnattended(tierFromImpact("high", true))).toBe(false);
    expect(runsUnattended(tierFromImpact(undefined, true))).toBe(false);
  });

  it("reads are not gated by tier — scope (Cerbos + RLS) is their gate", () => {
    expect(tierFromImpact(undefined, false)).toBe("R0");
  });
});

describe("R3 is enforced by ABSENCE, never by instruction", () => {
  it("only R3 is hidden from a seat's tool view", () => {
    expect(mustBeHiddenFromSeat("R3")).toBe(true);
    expect(mustBeHiddenFromSeat("R2")).toBe(false);
    expect(mustBeHiddenFromSeat("R0")).toBe(false);
  });

  it("production deletion is R3 — the human acts, the agent escorts", () => {
    const d = computeRisk({ action: "delete", env: "production", impact: "high", isWrite: true }, RULES);
    expect(d.tier).toBe("R3");
    expect(mustBeHiddenFromSeat(d.tier)).toBe(true);
  });
});
