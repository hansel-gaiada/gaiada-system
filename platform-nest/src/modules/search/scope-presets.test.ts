// SM-02 — pure unit tests for the preset -> tool_scope seeding table (design §04). No DB/Cerbos
// needed; the DB-backed proof that preset seeding actually lands in `search_engagements.tool_scope`
// lives in search.test.ts.
import { describe, it, expect } from "vitest";
import { isScopePreset, seedToolScope, SCOPE_PRESET_VALUES } from "./scope-presets";

describe("scope-presets (SM-02)", () => {
  it("isScopePreset accepts exactly the 4 documented values", () => {
    for (const v of SCOPE_PRESET_VALUES) expect(isScopePreset(v)).toBe(true);
    expect(isScopePreset("premium")).toBe(false);
    expect(isScopePreset(undefined)).toBe(false);
    expect(isScopePreset(42)).toBe(false);
  });

  it("seedToolScope returns undefined for 'custom' and for unrecognized/undefined input (leave as-is)", () => {
    expect(seedToolScope("custom")).toBeUndefined();
    expect(seedToolScope(undefined)).toBeUndefined();
  });

  it("'light' disables every paid pull, keeps only $0 audits", () => {
    const s = seedToolScope("light")!;
    expect(s.rank).toEqual({ enabled: false });
    expect(s.volume).toEqual({ enabled: false });
    expect(s.backlinks).toEqual({ enabled: false });
    expect(s.ai_visibility).toEqual({ enabled: false });
    expect(s.audit_technical).toMatchObject({ enabled: true });
    expect(s.audit_cwv).toMatchObject({ enabled: true });
    expect(s.sem_sync).toEqual({ enabled: false, mode: "manual" });
  });

  it("'standard' matches the design §04 illustrative shape exactly", () => {
    const s = seedToolScope("standard")!;
    expect(s).toEqual({
      rank: { enabled: true, cadence: "weekly", maxKeywords: 50 },
      volume: { enabled: true },
      backlinks: { enabled: false },
      ai_visibility: { enabled: true, cadence: "weekly" },
      audit_technical: { enabled: true, cadence: "weekly" },
      audit_cwv: { enabled: true },
      sem_sync: { enabled: false, mode: "manual" },
    });
  });

  it("'heavy' is a strict superset — everything 'standard' enables stays enabled, plus backlinks/daily rank", () => {
    const standard = seedToolScope("standard")!;
    const heavy = seedToolScope("heavy")!;
    for (const key of Object.keys(standard)) {
      const std = standard[key] as { enabled: boolean };
      const hvy = heavy[key] as { enabled: boolean };
      if (std.enabled) expect(hvy.enabled).toBe(true);
    }
    expect(heavy.backlinks).toEqual({ enabled: true, cadence: "monthly" });
    expect(heavy.rank).toMatchObject({ enabled: true, cadence: "daily" });
  });

  it("no preset ships a 'provider' override (Semrush is still decision-gated, OQ-3)", () => {
    for (const p of ["light", "standard", "heavy"] as const) {
      expect(seedToolScope(p)!.provider).toBeUndefined();
    }
  });

  it("returns an independent copy each call (no shared-mutable-literal leak)", () => {
    const a = seedToolScope("light")!;
    (a.rank as { enabled: boolean }).enabled = true;
    const b = seedToolScope("light")!;
    expect((b.rank as { enabled: boolean }).enabled).toBe(false);
  });
});
