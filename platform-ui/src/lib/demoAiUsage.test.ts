import { describe, it, expect } from "vitest";
import { aiUsageDemo } from "./demoAiUsage";
import { asCompanyUsage, asMyUsage, asUnitUsage, formatCost } from "./aiUsage";

// AIP-16 and AIP-05: the demo store answers in the shape of BFF section 66 (checked by the SAME parsers the screens use, so a demo that drifts from the
// contract fails here and not in front of a person), in the server's order of checks, and holds use in two months only.
const get = (path: string, userId: string, qs = "month=2026-10") => aiUsageDemo("GET", `/api/co-agency/ai-usage/${path}`, new URLSearchParams(qs), userId);

describe("the demo AI usage reads", () => {
  it("answers `me` for any staff identity in the shape the screen parses", () => {
    const r = get("me", "u-any")!;
    expect(r.status).toBe(200);
    const a = asMyUsage(r.json);
    expect(a.month).toBe("2026-10");
    expect(a.bySurface.map((s) => s.surface)).toContain("knowledge");
    // the live shape: embeds outnumber replies, one surface has null token sums and no cost
    const agent = a.bySurface.find((s) => s.surface === "agent")!;
    expect([agent.promptTokens, agent.costUsd]).toEqual([null, null]);
    expect(formatCost(a.totals.costUsd)).toMatch(/^\$0\.00|^under/);
  });
  it("refuses a client contact on every route", () => {
    for (const p of ["me", "company", "units/dept-1"]) expect(get(p, "demo-client")!.status).toBe(403);
  });
  it("gives the owner and a unit's head the `people` key, and the company admin none", () => {
    expect(asUnitUsage(get("units/dept-1", "demo-owner")!.json).people?.length).toBeGreaterThan(0);
    expect(asUnitUsage(get("units/dept-1", "u-webhead")!.json).people?.length).toBeGreaterThan(0);
    const admin = get("units/dept-1", "demo-hansel")!;
    expect(admin.status).toBe(200);
    expect("people" in (admin.json as object)).toBe(false);
    expect(asUnitUsage(admin.json).people).toBeNull();
  });
  it("refuses a head of another unit and a member BEFORE saying whether the unit exists; 404 only for the company tier", () => {
    expect(get("units/dept-3", "u-webhead")!.status).toBe(403);
    expect(get("units/nope", "u-webhead")!.status).toBe(403);
    expect(get("units/dept-1", "u-any")!.status).toBe(403);
    expect(get("units/nope", "demo-hansel")!.status).toBe(404);
    expect(get("units/nope", "demo-owner")!.status).toBe(404);
  });
  it("answers the company to the owner and the admin only, with the null department bucket and the no-person lines", () => {
    expect(get("company", "u-webhead")!.status).toBe(403);
    expect(get("company", "u-any")!.status).toBe(403);
    const a = asCompanyUsage(get("company", "demo-hansel")!.json);
    expect(a.byDepartment.some((d) => d.unitNodeId === null)).toBe(true);
    expect(a.noPerson.length).toBeGreaterThan(0);
  });
  it("answers an empty month for a month with no use, and 400 for a bad month after the decision", () => {
    const empty = asMyUsage(get("me", "u-any", "month=2026-01")!.json);
    expect(empty.totals.calls).toBe(0);
    expect(empty.bySurface).toEqual([]);
    expect(get("me", "u-any", "month=2026-13")!.status).toBe(400);
    expect(get("me", "demo-client", "month=2026-13")!.status).toBe(403);
  });
  it("leaves every other path to the rest of the fixtures", () => {
    expect(aiUsageDemo("GET", "/api/co-agency/knowledge", new URLSearchParams(), "u-any")).toBeNull();
    expect(aiUsageDemo("GET", "/api/co-agency/ai-usage/other", new URLSearchParams(), "u-any")).toBeNull();
  });
});
