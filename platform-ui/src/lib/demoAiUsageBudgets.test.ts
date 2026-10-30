import { describe, it, expect } from "vitest";
import { aiUsageDemo } from "./demoAiUsage";
import { asCompanyUsage, asUnitUsage } from "./aiUsage";
import { asAllowances, liftOffered } from "./aiBudget";

// AIP-17b and AIP-18 (BFF §66.8, §66.9, §66.11): the demo store's budgets, allowances and lift. Checked by the SAME parsers the screens use, in the
// server's order of checks (403 before the body is looked at, then 400, then 404), and STATEFUL: a write moves what the next read says. The store lives
// on `globalThis`, so every test that writes puts the seed back.
const PATH = "/api/co-agency/ai-usage";
const get = (path: string, userId: string, qs = "month=2026-10") => aiUsageDemo("GET", `${PATH}/${path}`, new URLSearchParams(qs), userId)!;
const send = (method: string, path: string, userId: string, body?: unknown) =>
  aiUsageDemo(method, `${PATH}/${path}`, new URLSearchParams(), userId, body === undefined ? undefined : JSON.stringify(body))!;
const put = (path: string, userId: string, body: unknown) => send("PUT", path, userId, body);
const now = new Date().toISOString().slice(0, 7);

describe("the demo budget lines (§66.8)", () => {
  it("gives the company view an alert figure at 80 percent or more, Web Dev in Soft stop over its figure, and SEO in Report only and well under", () => {
    const c = asCompanyUsage(get("company", "demo-owner").json);
    expect(c.budgets.company?.state).toBe("over_80");
    expect(c.budgets.company?.percent).toBeGreaterThanOrEqual(80);
    expect(c.budgets.company?.percent).toBeLessThan(100);
    expect(c.budgets.units.map((u) => [u.unitNodeId, u.mode, u.state, u.stopLifted])).toEqual([
      ["dept-1", "soft_stop", "over_100", false],
      ["dept-3", "report", "under", false],
    ]);
  });
  it("gives a department its OWN line, or null (the key is there either way)", () => {
    const web = asUnitUsage(get("units/dept-1", "demo-owner").json);
    expect(web.budget).toMatchObject({ unitNodeId: "dept-1", mode: "soft_stop", state: "over_100" });
    const hr = get("units/dept-6", "demo-owner").json as { budget: unknown };
    expect(hr.budget).toBeNull();
  });
  it("says an unknown spend (a month with no use) as null, never 0", () => {
    const empty = asUnitUsage(get("units/dept-1", "demo-owner", "month=2026-01").json);
    expect(empty.budget?.spentUsd).toBeNull();
    expect(empty.budget?.state).toBe("under");
  });
  it("tells who may manage and who may lift: the owner both, a unit's head the lift on their own unit only, the admin neither", () => {
    expect(asUnitUsage(get("units/dept-1", "demo-owner").json).capabilities).toMatchObject({ canManage: true, canLiftStop: true });
    expect(asUnitUsage(get("units/dept-1", "u-webhead").json).capabilities).toMatchObject({ canManage: false, canLiftStop: true });
    expect(asUnitUsage(get("units/dept-1", "demo-hansel").json).capabilities).toMatchObject({ canManage: false, canLiftStop: false });
    expect(asCompanyUsage(get("company", "demo-hansel").json).capabilities).toMatchObject({ canManage: false, canLiftStop: false });
  });
  it("offers the lift on the seeded Web Dev line, to its head, in the month the page is on", () => {
    // The seeded figures exist for September and October 2026 only, so the state is read in October.
    const oct = asUnitUsage(get("units/dept-1", "u-webhead", "month=2026-10").json);
    expect(liftOffered(oct.budget, oct.capabilities, "2026-10", new Date("2026-10-30T12:00:00Z"))).toBe(true);
  });
});

describe("the demo allowances (§66.9)", () => {
  it("answers the default and the overrides to the owner, with the person's name", () => {
    const a = asAllowances(get("allowances", "demo-owner").json);
    expect(a.defaultDailyReplies).toBe(200);
    expect(a.overrides).toEqual([expect.objectContaining({ userId: "u-web-2", name: "Made Putra", dailyReplies: 350 })]);
  });
  it("is 403 for everyone else, a unit's head and the admin included", () => {
    for (const u of ["u-webhead", "demo-hansel", "u-any", "demo-client"]) expect(get("allowances", u).status).toBe(403);
  });
});

describe("the demo writes: the server's order of checks", () => {
  it("403 comes before the body is looked at: a refused caller with a bad body still gets 403", () => {
    expect(put("budgets/company", "demo-hansel", { monthlyUsd: "abc" }).status).toBe(403);
    expect(put("budgets/units/nope", "u-webhead", {}).status).toBe(403);
    expect(put("allowances/u-web-2", "u-webhead", { dailyReplies: 0 }).status).toBe(403);
  });
  it("400 for a bad body, naming the field: a number for money, five places, zero, an unknown key, a mode with no figure", () => {
    const cases: [string, unknown, string][] = [
      ["budgets/company", { monthlyUsd: 40 }, "monthlyUsd"],
      ["budgets/company", { monthlyUsd: "1.23456" }, "monthlyUsd"],
      ["budgets/company", { monthlyUsd: "0" }, "monthlyUsd"],
      ["budgets/company", { monthlyUsd: "5", mode: "report" }, "mode"], // the company figure has no mode (AIP-D8)
      ["budgets/company", {}, "monthlyUsd"],
      ["budgets/units/dept-1", { monthlyUsd: "5", mode: "hard" }, "mode"],
      ["budgets/units/dept-1", { monthlyUsd: null, mode: "report" }, "mode"],
      ["allowances/u-web-2", { dailyReplies: 1.5 }, "dailyReplies"],
      ["allowances/u-web-2", { dailyReplies: 100001 }, "dailyReplies"],
      ["allowances/u-web-2", {}, "dailyReplies"],
    ];
    for (const [path, body, field] of cases) {
      const r = put(path, "demo-owner", body);
      expect([path, r.status, (r.json as { field?: string }).field]).toEqual([path, 400, field]);
    }
  });
  it("404 for a unit the tree does not have and a person who is not a member, after the body", () => {
    expect(put("budgets/units/nope", "demo-owner", { monthlyUsd: "5" })).toMatchObject({ status: 404, json: { error: "unit_not_found" } });
    expect(put("allowances/u-stranger", "demo-owner", { dailyReplies: 5 })).toMatchObject({ status: 404, json: { error: "person_not_found" } });
    expect(put("budgets/units/nope", "demo-owner", { monthlyUsd: "x" }).status).toBe(400);
  });
  it("sets, changes and removes the company figure, and the next read says so (the figure canonicalised to 4 places)", () => {
    const set = put("budgets/company", "demo-owner", { monthlyUsd: "40" });
    expect(set.status).toBe(200);
    expect(set.json).toMatchObject({ changed: true, budget: { monthlyUsd: "40.0000", state: "under" } });
    expect(asCompanyUsage(get("company", "demo-owner").json).budgets.company?.monthlyUsd).toBe("40.0000");
    expect(put("budgets/company", "demo-owner", { monthlyUsd: "40.00" }).json).toMatchObject({ changed: false });
    const gone = put("budgets/company", "demo-owner", { monthlyUsd: null });
    expect(gone.json).toMatchObject({ changed: true, budget: null });
    expect(asCompanyUsage(get("company", "demo-owner").json).budgets.company).toBeNull();
    expect(put("budgets/company", "demo-owner", { monthlyUsd: null }).json).toMatchObject({ changed: false });
    put("budgets/company", "demo-owner", { monthlyUsd: "0.0011" }); // the seed
  });
  it("a new department budget is Report only (AIP-D7); omitting the mode on an update keeps the stored one; removing deletes it", () => {
    expect(put("budgets/units/dept-6", "demo-owner", { monthlyUsd: "10" }).json).toMatchObject({ changed: true, budget: { mode: "report", monthlyUsd: "10.0000" } });
    expect(put("budgets/units/dept-6", "demo-owner", { monthlyUsd: "10", mode: "soft_stop" }).json).toMatchObject({ budget: { mode: "soft_stop" } });
    expect(put("budgets/units/dept-6", "demo-owner", { monthlyUsd: "12" }).json).toMatchObject({ budget: { mode: "soft_stop", monthlyUsd: "12.0000" } });
    expect(put("budgets/units/dept-6", "demo-owner", { monthlyUsd: null }).json).toMatchObject({ changed: true, budget: null });
    expect((get("units/dept-6", "demo-owner").json as { budget: unknown }).budget).toBeNull();
  });
  it("sets and clears a person's allowance, `isDefault` and `changed` as the server says them", () => {
    expect(put("allowances/u-webhead", "demo-owner", { dailyReplies: 500 }).json).toMatchObject({ changed: true, dailyReplies: 500, isDefault: false });
    expect(put("allowances/u-webhead", "demo-owner", { dailyReplies: 500 }).json).toMatchObject({ changed: false });
    expect(asAllowances(get("allowances", "demo-owner").json).overrides.map((o) => o.userId)).toContain("u-webhead");
    expect(put("allowances/u-webhead", "demo-owner", { dailyReplies: null }).json).toMatchObject({ changed: true, dailyReplies: 200, isDefault: true });
    expect(put("allowances/u-webhead", "demo-owner", { dailyReplies: null }).json).toMatchObject({ changed: false });
  });
  it("only the three verbs exist: a GET on a write route and a PUT on a read route are 404", () => {
    expect(send("DELETE", "budgets/company", "demo-owner").status).toBe(404);
    expect(send("GET", "budgets/company", "demo-owner").status).toBe(404);
    expect(send("POST", "allowances", "demo-owner", {}).status).toBe(404);
  });
});

describe("the demo lift (§66.11)", () => {
  it("is 403 for a head of another unit, and for the admin, before the unit is looked at", () => {
    expect(send("POST", "budgets/units/dept-1/lift", "dept-manager").status).toBe(403);
    expect(send("POST", "budgets/units/dept-1/lift", "demo-hansel").status).toBe(403);
    expect(send("POST", "budgets/units/nope/lift", "u-webhead").status).toBe(403);
  });
  it("404 no_soft_stop for a Report only budget or no budget; 404 unit_not_found for the owner naming no unit", () => {
    expect(send("POST", "budgets/units/dept-3/lift", "demo-owner")).toMatchObject({ status: 404, json: { error: "no_soft_stop" } });
    expect(send("POST", "budgets/units/dept-6/lift", "demo-owner")).toMatchObject({ status: 404, json: { error: "no_soft_stop" } });
    expect(send("POST", "budgets/units/nope/lift", "demo-owner")).toMatchObject({ status: 404, json: { error: "unit_not_found" } });
  });
  it("lifts for the month: the head's lift answers the line with stopLifted, the next read says it, and lifting again changes nothing", () => {
    const r = send("POST", "budgets/units/dept-1/lift", "u-webhead");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ month: now, changed: true, budget: { unitNodeId: "dept-1", mode: "soft_stop", stopLifted: true } });
    expect(asUnitUsage(get("units/dept-1", "demo-owner", `month=${now}`).json).budget?.stopLifted).toBe(true);
    expect(send("POST", "budgets/units/dept-1/lift", "demo-owner").json).toMatchObject({ changed: false });
    // a past month's line is not marked lifted: the lift was for the current one
    if (now !== "2026-10") expect(asUnitUsage(get("units/dept-1", "demo-owner", "month=2026-10").json).budget?.stopLifted).toBe(false);
  });
});
