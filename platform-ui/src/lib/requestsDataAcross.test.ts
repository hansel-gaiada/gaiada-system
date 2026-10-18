import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  readOutboundDetail, readOutboundFiles, readOutboundRequests, readOutboundSummary, readRequestRoutes, routesForShell,
} from "./requests-data";

// DW-10e: the readers of the sender routes (BFF §60.5). Each runs under the ASKING company's id and returns a ReadResult: a refusal or a failed
// read is DATA the page renders, never an empty list that reads as "you sent nothing" (plan trap 4).
beforeEach(() => {
  process.env.PLATFORM_URL = "http://p.test";
  process.env.PLATFORM_SERVICE_TOKEN = "t";
  delete process.env.DEMO_MODE;
});

const reply = (status: number, body: unknown = {}) => vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify(body), { status }));
const urlOf = (f: ReturnType<typeof reply>) => String(f.mock.calls[0][0]);
const senderRow = (over: Record<string, unknown> = {}) => ({
  id: "r1", kind: "assets", title: "Banners", status: "open", toUnit: { id: "dept-2", name: "Creatives", unitMissing: false },
  requestedBy: { id: "u", name: "Ayu" }, work: { type: "pm_task", status: "new", isDone: false, responsibleName: null }, assetCount: 0,
  receivingCompany: { id: "co-agency", name: "Gaia Digital Agency" }, routeId: "rt-1", price: null, ...over,
});

describe("readRequestRoutes", () => {
  it("reads the company's routes from the asking company's own URL", async () => {
    const f = reply(200, { enabled: true, routes: [{ routeId: "rt-1", kind: "assets", company: { id: "co-agency", name: "Gaia" }, unit: { name: "Creatives" } }] });
    vi.stubGlobal("fetch", f);
    const r = await readRequestRoutes("u", "co-resort");
    expect(urlOf(f)).toBe("http://p.test/api/co-resort/requests/routes");
    expect(r).toEqual({ kind: "ok", data: { enabled: true, routes: [{ routeId: "rt-1", kind: "assets", company: { id: "co-agency", name: "Gaia" }, unit: { name: "Creatives" } }] } });
  });

  it("is ok with enabled false when the switch is off: an answer, not a failure", async () => {
    vi.stubGlobal("fetch", reply(200, { enabled: false, routes: [] }));
    expect(await readRequestRoutes("u", "t1")).toEqual({ kind: "ok", data: { enabled: false, routes: [] } });
  });

  it("is forbidden on a 403, unavailable on a 5xx, a 404 and a failed request, and unavailable on a broken 200", async () => {
    vi.stubGlobal("fetch", reply(403, { error: "forbidden" }));
    expect(await readRequestRoutes("u", "t1")).toEqual({ kind: "forbidden" });
    vi.stubGlobal("fetch", reply(500, { error: "database went away" }));
    expect(await readRequestRoutes("u", "t1")).toEqual({ kind: "unavailable", reason: "database went away" });
    vi.stubGlobal("fetch", reply(404, { error: "not found" }));
    expect((await readRequestRoutes("u", "t1")).kind).toBe("unavailable");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("socket hang up"); }));
    expect(await readRequestRoutes("u", "t1")).toEqual({ kind: "unavailable", reason: "socket hang up" });
    vi.stubGlobal("fetch", reply(200, []));
    expect((await readRequestRoutes("u", "t1")).kind).toBe("unavailable");
  });
});

describe("routesForShell", () => {
  it("is the list of routes on an ok read, and null on any refusal or failure (which hides, never throws)", async () => {
    vi.stubGlobal("fetch", reply(200, { enabled: true, routes: [{ routeId: "rt-1", kind: "assets", company: { id: "c", name: "Gaia" }, unit: { name: "Creatives" } }] }));
    expect(await routesForShell("u", "co-a")).toHaveLength(1);
    vi.stubGlobal("fetch", reply(403, {}));
    expect(await routesForShell("u", "co-b")).toBeNull();
    vi.stubGlobal("fetch", reply(500, {}));
    expect(await routesForShell("u", "co-c")).toBeNull();
    expect(await routesForShell("u", null)).toBeNull();
  });
});

describe("readOutboundRequests", () => {
  it("asks for my sent requests with the status, and for a department's with its id, always under the asking company", async () => {
    const f = reply(200, { scope: "own", rows: [senderRow()] });
    vi.stubGlobal("fetch", f);
    const mine = await readOutboundRequests("u", "co-resort", { box: "mine" }, "closed");
    expect(urlOf(f)).toBe("http://p.test/api/co-resort/requests/outbound?box=mine&status=closed");
    expect(mine.kind === "ok" && mine.data.scope).toBe("own");
    expect(mine.kind === "ok" && mine.data.rows[0]).toMatchObject({ id: "r1", receivingCompany: { name: "Gaia Digital Agency" }, routeId: "rt-1" });
    await readOutboundRequests("u", "co-resort", { box: "sent", unitId: "hosp dept" }, "all", { kind: "engineering" });
    expect(String(f.mock.calls[1][0])).toBe("http://p.test/api/co-resort/requests/outbound?box=sent&status=all&unitId=hosp+dept&kind=engineering");
  });

  it("carries the company scope when the caller is a manager or administrator", async () => {
    vi.stubGlobal("fetch", reply(200, { scope: "company", rows: [] }));
    expect(await readOutboundRequests("u", "t1", { box: "mine" }, "open")).toEqual({ kind: "ok", data: { scope: "company", rows: [] } });
  });

  it("DW-D43 carries the unit scope when the caller heads a department", async () => {
    vi.stubGlobal("fetch", reply(200, { scope: "unit", rows: [senderRow()] }));
    const r = await readOutboundRequests("u", "t1", { box: "sent", unitId: "d-creative" }, "open");
    expect(r.kind === "ok" && r.data.scope).toBe("unit");
    expect(r.kind === "ok" && r.data.rows.map((x) => x.id)).toEqual(["r1"]);
  });

  it("is forbidden on a 403 and unavailable on a 400, a 404, a 5xx and a failed request, never an empty list", async () => {
    vi.stubGlobal("fetch", reply(403, { error: "forbidden" }));
    expect(await readOutboundRequests("u", "t1", { box: "mine" }, "open")).toEqual({ kind: "forbidden" });
    for (const status of [400, 404, 500]) {
      vi.stubGlobal("fetch", reply(status, { error: `e${status}` }));
      expect(await readOutboundRequests("u", "t1", { box: "mine" }, "open"), String(status)).toEqual({ kind: "unavailable", reason: `e${status}` });
    }
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("timeout"); }));
    expect(await readOutboundRequests("u", "t1", { box: "mine" }, "open")).toEqual({ kind: "unavailable", reason: "timeout" });
  });

  it("treats a 200 without a scope, or without rows, as a broken read, not as 'you sent nothing'", async () => {
    for (const body of [[], { rows: [] }, { scope: "own" }, { scope: "everyone", rows: [] }, { scope: "units", rows: [] }, { scope: "own", rows: "none" }]) {
      vi.stubGlobal("fetch", reply(200, body));
      expect((await readOutboundRequests("u", "t1", { box: "mine" }, "open")).kind, JSON.stringify(body)).toBe("unavailable");
    }
  });

  it("drops a row that is not a request, and keeps the rest", async () => {
    vi.stubGlobal("fetch", reply(200, { scope: "own", rows: [senderRow(), { id: 5 }, null] }));
    const r = await readOutboundRequests("u", "t1", { box: "mine" }, "open");
    expect(r.kind === "ok" && r.data.rows.map((x) => x.id)).toEqual(["r1"]);
  });
});

describe("readOutboundSummary", () => {
  it("reads the scope and the open count for a department", async () => {
    const f = reply(200, { scope: "own", sent: { open: 2 } });
    vi.stubGlobal("fetch", f);
    expect(await readOutboundSummary("u", "co-resort", "hosp dept")).toEqual({ kind: "ok", data: { scope: "own", sent: { open: 2 } } });
    expect(urlOf(f)).toBe("http://p.test/api/co-resort/requests/outbound/summary?unitId=hosp%20dept");
  });

  it("is a failure, never 0, on a refusal, a fault or a shape it cannot read", async () => {
    vi.stubGlobal("fetch", reply(403, {}));
    expect(await readOutboundSummary("u", "t1", "d")).toEqual({ kind: "forbidden" });
    vi.stubGlobal("fetch", reply(500, { error: "boom" }));
    expect(await readOutboundSummary("u", "t1", "d")).toEqual({ kind: "unavailable", reason: "boom" });
    vi.stubGlobal("fetch", reply(200, { sent: { open: 0 } }));
    expect((await readOutboundSummary("u", "t1", "d")).kind).toBe("unavailable");
  });
});

describe("readOutboundDetail", () => {
  it("reads one request, with its assets, from the asking company's URL", async () => {
    const f = reply(200, { ...senderRow(), brief: "b", form: {}, declineReason: null, assets: [{ id: "a1", name: "x.png", contentType: "image/png", href: "/x" }] });
    vi.stubGlobal("fetch", f);
    const r = await readOutboundDetail("u", "co-resort", "r 1");
    expect(urlOf(f)).toBe("http://p.test/api/co-resort/requests/outbound/r%201");
    expect(r.kind === "ok" && r.data?.assets.map((a) => a.id)).toEqual(["a1"]);
    expect(r.kind === "ok" && r.data?.receivingCompany?.name).toBe("Gaia Digital Agency");
  });

  it("is ok with null on a 404 (request_not_found: absent, or another person's), forbidden on 403, unavailable on a fault or a broken answer", async () => {
    vi.stubGlobal("fetch", reply(404, { error: "no", reason: "request_not_found" }));
    expect(await readOutboundDetail("u", "t1", "r1")).toEqual({ kind: "ok", data: null });
    vi.stubGlobal("fetch", reply(403, {}));
    expect(await readOutboundDetail("u", "t1", "r1")).toEqual({ kind: "forbidden" });
    vi.stubGlobal("fetch", reply(500, { error: "boom" }));
    expect(await readOutboundDetail("u", "t1", "r1")).toEqual({ kind: "unavailable", reason: "boom" });
    vi.stubGlobal("fetch", reply(200, { nope: true }));
    expect((await readOutboundDetail("u", "t1", "r1")).kind).toBe("unavailable");
  });
});

describe("readOutboundFiles", () => {
  it("reads the file list, and is unavailable, not empty, when it cannot", async () => {
    const f = reply(200, [{ id: "f1", filename: "a.pdf", contentType: "application/pdf", byteSize: 1, createdAt: null, url: null }]);
    vi.stubGlobal("fetch", f);
    const r = await readOutboundFiles("u", "co-resort", "r1");
    expect(urlOf(f)).toBe("http://p.test/api/co-resort/requests/outbound/r1/files");
    expect(r.kind === "ok" && r.data.map((x) => x.id)).toEqual(["f1"]);
    vi.stubGlobal("fetch", reply(200, { files: [] }));
    expect((await readOutboundFiles("u", "t1", "r1")).kind).toBe("unavailable");
    vi.stubGlobal("fetch", reply(404, { error: "x" }));
    expect((await readOutboundFiles("u", "t1", "r1")).kind).toBe("unavailable");
    vi.stubGlobal("fetch", reply(403, {}));
    expect(await readOutboundFiles("u", "t1", "r1")).toEqual({ kind: "forbidden" });
  });
});
