import { describe, it, expect, vi, beforeEach } from "vitest";
import { listDevicesResult } from "./it-data";

// DW-7e: the honest device list. `listDevices` degrades 403 and 404 to [], which a "devices offline" tile cannot use.
const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

beforeEach(() => {
  process.env.PLATFORM_URL = "http://p.test";
  process.env.PLATFORM_SERVICE_TOKEN = "t";
  delete process.env.DEMO_MODE;
});

describe("listDevicesResult", () => {
  it("returns the devices on 200, from the devices route", async () => {
    const fetchMock = answer(200, [{ id: "d1", status: "offline" }]);
    vi.stubGlobal("fetch", fetchMock);
    expect(await listDevicesResult("u1", "co-a")).toEqual({ kind: "ok", data: [{ id: "d1", status: "offline" }] });
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe("http://p.test/api/co-a/it/devices");
  });

  it("keeps an empty 200 as ok", async () => {
    vi.stubGlobal("fetch", answer(200, []));
    expect(await listDevicesResult("u1", "co-a")).toEqual({ kind: "ok", data: [] });
  });

  it("is forbidden on 403 and unavailable on 404 or 5xx, never an empty list", async () => {
    vi.stubGlobal("fetch", answer(403, { error: "forbidden" }));
    expect(await listDevicesResult("u1", "co-a")).toEqual({ kind: "forbidden" });
    for (const status of [404, 500, 503]) {
      vi.stubGlobal("fetch", answer(status, { error: "nope" }));
      expect(await listDevicesResult("u1", "co-a")).toMatchObject({ kind: "unavailable" });
    }
  });
});
