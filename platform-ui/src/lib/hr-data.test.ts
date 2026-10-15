import { describe, it, expect, vi, beforeEach } from "vitest";
import { listCasesResult, listLeaveResult } from "./hr-data";

// DW-7e: the honest HR list readers. 200 is the rows (an empty 200 is a real zero); 403 is `forbidden`; every other
// failure, a 404 included, is `unavailable`. Never `ok` with [] for a read that did not return data.
const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

beforeEach(() => {
  process.env.PLATFORM_URL = "http://p.test";
  process.env.PLATFORM_SERVICE_TOKEN = "t";
  delete process.env.DEMO_MODE;
});

describe.each([
  ["listLeaveResult", (u: string) => listLeaveResult(u, "co-a", { status: "pending" }), "/api/co-a/modules/hr/leave?status=pending"],
  ["listCasesResult", (u: string) => listCasesResult(u, "co-a", { kind: "onboarding", status: "open" }), "/api/co-a/modules/hr/cases?kind=onboarding&status=open"],
])("%s", (_name, read, path) => {
  it("returns the rows on 200, from the right route", async () => {
    const fetchMock = answer(200, [{ id: "r1" }, { id: "r2" }]);
    vi.stubGlobal("fetch", fetchMock);
    expect(await read("u1")).toEqual({ kind: "ok", data: [{ id: "r1" }, { id: "r2" }] });
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(`http://p.test${path}`);
  });

  it("keeps an empty 200 as ok: that one is evidence of an empty queue", async () => {
    vi.stubGlobal("fetch", answer(200, []));
    expect(await read("u1")).toEqual({ kind: "ok", data: [] });
  });

  it("is forbidden on 403, never an empty list", async () => {
    vi.stubGlobal("fetch", answer(403, { error: "forbidden" }));
    expect(await read("u1")).toEqual({ kind: "forbidden" });
  });

  it.each([404, 500, 503])("is unavailable on %i, never an empty list", async (status) => {
    vi.stubGlobal("fetch", answer(status, { error: "nope" }));
    expect(await read("u1")).toMatchObject({ kind: "unavailable" });
  });

  it("is unavailable when the request itself throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("socket hang up"); }));
    expect(await read("u1")).toMatchObject({ kind: "unavailable" });
  });
});

it("sends no query string when no filter is given", async () => {
  const fetchMock = answer(200, []);
  vi.stubGlobal("fetch", fetchMock);
  await listCasesResult("u1", "co-a");
  expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe("http://p.test/api/co-a/modules/hr/cases");
});
