import { describe, it, expect, vi, beforeEach } from "vitest";
import { readLibraryAssets, readRequestDetail, readRequestSummary, readRequests, readTaskAssigneeIds } from "./requests-data";

beforeEach(() => {
  process.env.PLATFORM_URL = "http://p.test";
  process.env.PLATFORM_SERVICE_TOKEN = "t";
  delete process.env.DEMO_MODE;
});

const reply = (status: number, body: unknown = {}) => vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify(body), { status }));
const row = (over: Record<string, unknown> = {}) => ({
  id: "r1", kind: "assets", title: "Banners", status: "open", toUnit: { id: "d", name: "Creatives", unitMissing: false },
  requestedBy: { id: "u", name: "Ayu" }, work: null, assetCount: 0, ...over,
});

// Plan trap 4 / readiness-bar criterion 5: a read that fails says so. None of these may ever come back as an "ok" answer
// carrying an empty list, because the page would then claim "no requests".
describe("readRequests", () => {
  it("is forbidden on a 403, never an empty list", async () => {
    vi.stubGlobal("fetch", reply(403, { error: "forbidden" }));
    expect(await readRequests("u", "t1", { box: "mine" }, "open")).toEqual({ kind: "forbidden" });
  });

  it("is unavailable on a 500, carrying the backend's words", async () => {
    vi.stubGlobal("fetch", reply(500, { error: "database went away" }));
    expect(await readRequests("u", "t1", { box: "sent", unitId: "d1" }, "open")).toEqual({ kind: "unavailable", reason: "database went away" });
  });

  it("is unavailable on a 404: a route the backend does not serve is not 'no requests'", async () => {
    vi.stubGlobal("fetch", reply(404, { error: "not found" }));
    expect((await readRequests("u", "t1", { box: "mine" }, "open")).kind).toBe("unavailable");
  });

  it("is unavailable on a 400 (a department that is not one)", async () => {
    vi.stubGlobal("fetch", reply(400, { error: "unitId is not a department", reason: "unit_invalid" }));
    expect((await readRequests("u", "t1", { box: "sent", unitId: "x" }, "open")).kind).toBe("unavailable");
  });

  it("is unavailable when the request itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("socket hang up"); }));
    expect(await readRequests("u", "t1", { box: "mine" }, "open")).toEqual({ kind: "unavailable", reason: "socket hang up" });
  });

  it("treats a 200 that is not a list as a broken read", async () => {
    vi.stubGlobal("fetch", reply(200, { rows: [] }));
    expect((await readRequests("u", "t1", { box: "mine" }, "open")).kind).toBe("unavailable");
  });

  it("is ok with no rows only when the server answered with an empty list", async () => {
    vi.stubGlobal("fetch", reply(200, []));
    expect(await readRequests("u", "t1", { box: "mine" }, "open")).toEqual({ kind: "ok", data: [] });
  });

  it("asks for my requests with the status, and for a department's sent requests with its id", async () => {
    const f = reply(200, [row()]);
    vi.stubGlobal("fetch", f);
    const mine = await readRequests("u", "t1", { box: "mine" }, "closed");
    expect(String(f.mock.calls[0][0])).toBe("http://p.test/api/t1/requests?box=mine&status=closed");
    expect(mine.kind === "ok" && mine.data[0].title).toBe("Banners");
    await readRequests("u", "t1", { box: "sent", unitId: "d 1" }, "all");
    expect(String(f.mock.calls[1][0])).toBe("http://p.test/api/t1/requests?box=sent&status=all&unitId=d+1");
  });

  it("drops a row it cannot read rather than showing a blank", async () => {
    vi.stubGlobal("fetch", reply(200, [row(), { nonsense: true }]));
    const r = await readRequests("u", "t1", { box: "mine" }, "open");
    expect(r.kind === "ok" && r.data.map((x) => x.id)).toEqual(["r1"]);
  });
});

describe("readRequestSummary", () => {
  it("is forbidden on a 403 and unavailable on a 5xx, never 0", async () => {
    vi.stubGlobal("fetch", reply(403, { error: "forbidden" }));
    expect(await readRequestSummary("u", "t1", "d1")).toEqual({ kind: "forbidden" });
    vi.stubGlobal("fetch", reply(503, { error: "down" }));
    expect(await readRequestSummary("u", "t1", "d1")).toEqual({ kind: "unavailable", reason: "down" });
  });

  it("is unavailable when the answer has no numbers", async () => {
    vi.stubGlobal("fetch", reply(200, {}));
    expect((await readRequestSummary("u", "t1", "d1")).kind).toBe("unavailable");
  });

  it("reads the counts", async () => {
    const f = reply(200, { incoming: { open: 4, oldestOpenAt: null }, sent: { open: 2 } });
    vi.stubGlobal("fetch", f);
    expect(await readRequestSummary("u", "t1", "d1")).toEqual({ kind: "ok", data: { incoming: { open: 4, oldestOpenAt: null }, sent: { open: 2 } } });
    expect(String(f.mock.calls[0][0])).toBe("http://p.test/api/t1/requests/summary?unitId=d1");
  });
});

describe("readRequestDetail", () => {
  it("is ok with null on a 404, so the page can call notFound()", async () => {
    vi.stubGlobal("fetch", reply(404, { error: "request not found", reason: "request_not_found" }));
    expect(await readRequestDetail("u", "t1", "r1")).toEqual({ kind: "ok", data: null });
  });

  it("is forbidden on a 403 and unavailable on a 5xx", async () => {
    vi.stubGlobal("fetch", reply(403, { error: "forbidden" }));
    expect(await readRequestDetail("u", "t1", "r1")).toEqual({ kind: "forbidden" });
    vi.stubGlobal("fetch", reply(503, { error: "down" }));
    expect((await readRequestDetail("u", "t1", "r1")).kind).toBe("unavailable");
  });

  it("treats a 200 that is not a request as a broken read, not as 'no such request'", async () => {
    vi.stubGlobal("fetch", reply(200, []));
    expect((await readRequestDetail("u", "t1", "r1")).kind).toBe("unavailable");
  });

  it("reads the request with its brief, form and delivered assets", async () => {
    const f = reply(200, { ...row({ work: null }), brief: "Need banners", form: { deliverables: [] }, declineReason: null, assets: [{ id: "a1", name: "x.png", contentType: "image/png", href: "/h" }] });
    vi.stubGlobal("fetch", f);
    const r = await readRequestDetail("u", "t1", "r 1");
    expect(String(f.mock.calls[0][0])).toBe("http://p.test/api/t1/requests/r%201");
    expect(r.kind === "ok" && r.data?.brief).toBe("Need banners");
    expect(r.kind === "ok" && r.data?.work).toEqual({ state: "removed" });
    expect(r.kind === "ok" && r.data?.assets.map((a) => a.id)).toEqual(["a1"]);
  });
});

describe("readTaskAssigneeIds", () => {
  it("reads the people on the task", async () => {
    vi.stubGlobal("fetch", reply(200, { id: "t", assignee: { kind: "department", refId: "d", responsibleId: "u2" }, contributors: [{ userId: "u3" }] }));
    expect(await readTaskAssigneeIds("u", "t1", "t")).toEqual({ kind: "ok", data: ["u2", "u3"] });
  });

  it("is ok with null when the task is gone, unavailable on a failure, forbidden on a 403", async () => {
    vi.stubGlobal("fetch", reply(404, { error: "gone" }));
    expect(await readTaskAssigneeIds("u", "t1", "t")).toEqual({ kind: "ok", data: null });
    vi.stubGlobal("fetch", reply(500, { error: "boom" }));
    expect((await readTaskAssigneeIds("u", "t1", "t")).kind).toBe("unavailable");
    vi.stubGlobal("fetch", reply(403, { error: "no" }));
    expect(await readTaskAssigneeIds("u", "t1", "t")).toEqual({ kind: "forbidden" });
  });
});

describe("readLibraryAssets", () => {
  it("is unavailable on a 404: an empty picker must mean the library is empty", async () => {
    vi.stubGlobal("fetch", reply(404, { error: "not found" }));
    expect((await readLibraryAssets("u", "t1")).kind).toBe("unavailable");
  });

  it("is forbidden on a 403, and ok with the assets otherwise", async () => {
    vi.stubGlobal("fetch", reply(403, { error: "no" }));
    expect(await readLibraryAssets("u", "t1")).toEqual({ kind: "forbidden" });
    vi.stubGlobal("fetch", reply(200, [{ id: "a1", name: "x.png", content_type: "image/png" }]));
    const r = await readLibraryAssets("u", "t1");
    expect(r.kind === "ok" && r.data[0].id).toBe("a1");
  });
});
