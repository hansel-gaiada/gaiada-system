import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getMyKpiAlerts, getUnitKpiAlerts } from "./deptKpiAlerts";
import type { KpiAlert } from "./deptKpiAlertFormat";

// DW-4j-2 — the two honest readers (BFF §43.5). The four answers a read can give (ok, not yours to read, does not exist, failed) stay four
// different answers, and none of them becomes an empty list. The server is stubbed at `fetch`, so the paths and the status mapping are the real ones.

const row: KpiAlert = {
  id: "al-1", unit: { id: "dept-2", name: "Creatives" }, kpiKey: "asset-requests-on-time", kpiLabel: "Asset requests delivered on time", kpiUnit: "percent",
  periodStart: "2026-10-01", openedAt: "2026-10-03T06:30:00.000Z", value: 0.72, target: 0.9,
  acknowledgedBy: null, acknowledgedByName: null, acknowledgedAt: null, ackNote: null, resolvedAt: null, resolvedCondition: null,
};

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
let urls: string[];
const answer = (res: () => Response) => {
  urls = [];
  vi.stubGlobal("fetch", vi.fn(async (u: string) => { urls.push(String(u)); return res(); }));
};

let prevDemo: string | undefined;
beforeEach(() => {
  prevDemo = process.env.DEMO_MODE;
  delete process.env.DEMO_MODE;
  process.env.PLATFORM_URL = "http://p.test";
  process.env.PLATFORM_SERVICE_TOKEN = "t";
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (prevDemo === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = prevDemo;
});

describe("getMyKpiAlerts (GET dept-kpis/alerts)", () => {
  it("returns the caller's alerts from the unscoped path", async () => {
    answer(() => json(200, { alerts: [row] }));
    expect(await getMyKpiAlerts("u1", "co-a")).toEqual({ kind: "ok", data: [row] });
    expect(urls).toEqual(["http://p.test/api/co-a/dept-kpis/alerts"]);
  });
  it("returns an ok with no rows for a caller who heads nothing: that is true, and it is not a failure", async () => {
    answer(() => json(200, { alerts: [] }));
    expect(await getMyKpiAlerts("u1", "co-a")).toEqual({ kind: "ok", data: [] });
  });
  it("says forbidden for a 403, never an empty list", async () => {
    answer(() => json(403, { error: "not authorized" }));
    expect(await getMyKpiAlerts("u1", "co-a")).toEqual({ kind: "forbidden" });
  });
  it("says not_found for a bare 404 (the reports module is dark for the company), never an empty list", async () => {
    answer(() => json(404, { error: "Not Found" }));
    expect(await getMyKpiAlerts("u1", "co-a")).toEqual({ kind: "not_found" });
  });
  it("says error for a 500, a network failure and an answer that is not the documented shape", async () => {
    answer(() => json(500, { error: "boom" }));
    expect(await getMyKpiAlerts("u1", "co-a")).toEqual({ kind: "error", reason: "boom" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    expect(await getMyKpiAlerts("u1", "co-a")).toEqual({ kind: "error", reason: "network down" });
    answer(() => json(200, []));
    expect((await getMyKpiAlerts("u1", "co-a")).kind).toBe("error");
    answer(() => json(200, { alerts: [{ id: "x" }] }));
    expect((await getMyKpiAlerts("u1", "co-a")).kind).toBe("error");
  });
});

describe("getUnitKpiAlerts (GET dept-kpis/alerts?unitNodeId=)", () => {
  it("returns the unit's history from the scoped path, with the unit id encoded", async () => {
    answer(() => json(200, { alerts: [row] }));
    expect(await getUnitKpiAlerts("u1", "co-a", "dept-2")).toEqual({ kind: "ok", data: [row] });
    expect(urls).toEqual(["http://p.test/api/co-a/dept-kpis/alerts?unitNodeId=dept-2"]);
    await getUnitKpiAlerts("u1", "co-a", "d/1 &x");
    expect(urls[1]).toBe("http://p.test/api/co-a/dept-kpis/alerts?unitNodeId=d%2F1%20%26x");
  });
  it("returns an ok with no rows for a unit that has no alerts yet", async () => {
    answer(() => json(200, { alerts: [] }));
    expect(await getUnitKpiAlerts("u1", "co-a", "dept-2")).toEqual({ kind: "ok", data: [] });
  });
  it("says forbidden for a 403", async () => {
    answer(() => json(403, { error: "outside your reporting line" }));
    expect(await getUnitKpiAlerts("u1", "co-a", "dept-2")).toEqual({ kind: "forbidden" });
  });
  it("says not_found for the typed unit 404 only", async () => {
    answer(() => json(404, { error: "unit_not_found", field: "unitNodeId" }));
    expect(await getUnitKpiAlerts("u1", "co-a", "dept-99")).toEqual({ kind: "not_found" });
    answer(() => json(404, { error: "unit_not_found" }));
    expect(await getUnitKpiAlerts("u1", "co-a", "dept-99")).toEqual({ kind: "not_found" });
  });
  it("says error, not not_found, for a bare 404: the unit page already read the unit, so a dark module is a failure here", async () => {
    answer(() => json(404, { error: "Not Found" }));
    expect(await getUnitKpiAlerts("u1", "co-a", "dept-2")).toEqual({ kind: "error", reason: "Not Found" });
  });
  it("says error for a 500 and for a row of the wrong shape", async () => {
    answer(() => json(500, { error: "boom" }));
    expect(await getUnitKpiAlerts("u1", "co-a", "dept-2")).toEqual({ kind: "error", reason: "boom" });
    answer(() => json(200, { alerts: [{ ...row, openedAt: 5 }] }));
    expect((await getUnitKpiAlerts("u1", "co-a", "dept-2")).kind).toBe("error");
  });
});
