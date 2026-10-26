import { describe, it, expect, vi, afterAll } from "vitest";

// SCP-1c: the demo store answers the settings and cycles routes. It seeds the current month's cycles from the day it is first touched, so the
// clock is pinned to mid-month (Friday 16 October 2026, midday in Singapore) before it is imported (hence vi.hoisted). Only Date is faked.
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T04:00:00Z"));
});
afterAll(() => vi.useRealTimers());

import { socialDemo } from "./demoSocial";
import { asCycleTable, asSocialSettings } from "./socialCycles";

const call = (method: string, path: string, body?: unknown, q: Record<string, string> = {}) =>
  socialDemo(method, `/api/co-agency/modules/social/${path}`, new URLSearchParams(q), body === undefined ? undefined : JSON.stringify(body));

describe("GET settings", () => {
  it("answers the settings shape with a known calendar and canPlan (the demo user is the superadmin)", () => {
    const r = call("GET", "settings");
    expect(r?.status).toBe(200);
    expect(asSocialSettings(r?.json)).toEqual({ bufferWorkingDays: 1, boostCandidateFactor: 1.25, holidayCalendar: { known: true, name: "Demo public holidays" }, canPlan: true });
  });
});

describe("GET cycles", () => {
  it("lists the two demo engagements of the current month with a cycle each, and fixed health: one on track, one late", () => {
    const r = call("GET", "cycles", undefined, { month: "2026-10" });
    expect(r?.status).toBe(200);
    const t = asCycleTable(r?.json);
    expect(t.month).toBe("2026-10");
    expect(t.rows.map((x) => x.engagementId)).toEqual(["soc-eng-1", "soc-eng-2"]);
    expect(t.rows.every((x) => x.cycleId !== null)).toBe(true);
    expect(t.rows.map((x) => x.health?.state)).toEqual(["on_track", "late"]);
    // batch B: the last working day of September 2026 (a Wednesday); batch A: Tuesday the 15th. Ready-by is one working day before the deadline.
    expect(t.rows[0].deadline).toBe("2026-09-30");
    expect(t.rows[0].readyBy).toBe("2026-09-29");
    expect(t.rows[1].deadline).toBe("2026-09-15");
    expect(t.rows[1].readyBy).toBe("2026-09-14");
    for (const x of t.rows) {
      const c = x.counts;
      expect(c.planned + c.inProduction + c.withClient + c.clientChanges + c.approved + c.scheduled + c.live).toBe(c.counted);
    }
  });

  it("a month with no cycle has the pre-fill and no health; the month is validated", () => {
    const t = asCycleTable(call("GET", "cycles", undefined, { month: "2026-12" })?.json);
    expect(t.rows.every((x) => x.cycleId === null && x.health === null)).toBe(true);
    expect(t.rows.map((x) => x.prefill.deadline)).toEqual(["2026-11-30", "2026-11-13"]); // B: 30 Nov (Mon); A: 15 Nov is a Sunday
    expect(call("GET", "cycles", undefined, { month: "2026-13" })).toMatchObject({ status: 400, json: { error: "invalid_field", field: "month" } });
  });

  it("answers one cycle's health, and 404 cycle_not_found for another id", () => {
    const t = asCycleTable(call("GET", "cycles", undefined, { month: "2026-10" })?.json);
    const r = call("GET", `cycles/${t.rows[1].cycleId}/health`);
    expect(r?.status).toBe(200);
    const body = r?.json as { client: { state: string; lateWith: string }; posts: Array<{ health: { state: string } }> };
    expect(body.client).toMatchObject({ state: "late", lateWith: "designer" });
    expect(body.posts.map((p) => p.health.state)).toContain("done");
    expect(call("GET", "cycles/nope/health")).toMatchObject({ status: 404, json: { error: "cycle_not_found" } });
  });
});

describe("PUT cycles", () => {
  it("validates before it looks anything up, and one bad row refuses all", () => {
    expect(call("PUT", "cycles", { month: "x", rows: [] })).toMatchObject({ status: 400, json: { field: "month" } });
    expect(call("PUT", "cycles", { month: "2026-12", rows: "no" })).toMatchObject({ status: 400, json: { field: "rows" } });
    const bad = call("PUT", "cycles", { month: "2026-12", rows: [{ engagementId: "soc-eng-1", deadline: "2026-11-30" }, { engagementId: "soc-eng-2", deadline: "2020-01-01" }] });
    expect(bad).toMatchObject({ status: 400, json: { error: "invalid_field", field: "rows[1].deadline" } });
    expect(asCycleTable(call("GET", "cycles", undefined, { month: "2026-12" })?.json).rows.every((x) => x.cycleId === null)).toBe(true);
    expect(call("PUT", "cycles", { month: "2026-12", rows: [{ engagementId: "ghost", deadline: "2026-11-30" }] })).toMatchObject({ status: 404, json: { error: "engagement_not_found", failedId: "ghost" } });
  });

  it("upserts and answers the table with the ready-by it computed", () => {
    const r = call("PUT", "cycles", { month: "2026-12", rows: [{ engagementId: "soc-eng-1", deadline: "2026-11-30" }] });
    expect(r?.status).toBe(200);
    const row = asCycleTable(r?.json).rows.find((x) => x.engagementId === "soc-eng-1")!;
    expect(row.deadline).toBe("2026-11-30");
    expect(row.readyBy).toBe("2026-11-27");
    expect(row.cycleId).not.toBeNull();
  });
});

describe("PUT settings", () => {
  it("validates, then recomputes the open cycles' ready-by with the new buffer", () => {
    expect(call("PUT", "settings", { bufferWorkingDays: 11 })).toMatchObject({ status: 400, json: { field: "bufferWorkingDays" } });
    expect(call("PUT", "settings", { boostCandidateFactor: 1.255 })).toMatchObject({ status: 400, json: { field: "boostCandidateFactor" } });
    expect(call("PUT", "settings", { nope: 1 })).toMatchObject({ status: 400, json: { error: "unknown_field", field: "nope" } });
    const r = call("PUT", "settings", { bufferWorkingDays: 3, boostCandidateFactor: 2 });
    expect(r?.status).toBe(200);
    expect(r?.json).toMatchObject({ bufferWorkingDays: 3, boostCandidateFactor: 2 });
    const t = asCycleTable(call("GET", "cycles", undefined, { month: "2026-10" })?.json);
    expect(t.rows[0].readyBy).toBe("2026-09-25"); // three working days before Wednesday 30 September
    expect(t.bufferWorkingDays).toBe(3);
  });
});
