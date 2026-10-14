import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFigmaConnection, readFigmaLinks } from "./figma-data";

beforeEach(() => {
  process.env.PLATFORM_URL = "http://p.test";
  process.env.PLATFORM_SERVICE_TOKEN = "t";
  delete process.env.DEMO_MODE;
});

const reply = (status: number, body: unknown = {}) => vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify(body), { status }));
const link = (over: Record<string, unknown> = {}) => ({
  id: "l1", targetKind: "pm_task", targetId: "t1", fileKey: "k", nodeId: null, url: "https://www.figma.com/design/k",
  title: null, lastModified: null, openComments: null, cachedAt: null, assetGroupId: null, stale: false, refreshError: null, ...over,
});

describe("readFigmaLinks", () => {
  it("asks for the target's links by kind and id, for the active company", async () => {
    const f = reply(200, { figmaConnected: true, items: [] });
    vi.stubGlobal("fetch", f);
    await readFigmaLinks("u", "co-1", "work_request", "r 1");
    expect(String(f.mock.calls[0][0])).toBe("http://p.test/api/co-1/figma-links?targetKind=work_request&targetId=r+1");
  });

  it("is ok with an empty list only when the server answered with one, and keeps whether Figma is connected", async () => {
    vi.stubGlobal("fetch", reply(200, { figmaConnected: false, items: [] }));
    expect(await readFigmaLinks("u", "co-1", "pm_task", "t1")).toEqual({ kind: "ok", data: { figmaConnected: false, items: [] } });
  });

  it("keeps a never-read link's unknowns as null", async () => {
    vi.stubGlobal("fetch", reply(200, { figmaConnected: false, items: [link()] }));
    const r = await readFigmaLinks("u", "co-1", "pm_task", "t1");
    expect(r.kind === "ok" && r.data.items[0].openComments).toBeNull();
    expect(r.kind === "ok" && r.data.items[0].title).toBeNull();
  });

  it("is forbidden on a 403, never an empty list", async () => {
    vi.stubGlobal("fetch", reply(403, { error: "forbidden" }));
    expect(await readFigmaLinks("u", "co-1", "pm_task", "t1")).toEqual({ kind: "forbidden" });
  });

  it("is unavailable on a 404, a 500 and a thrown fetch, each with words", async () => {
    vi.stubGlobal("fetch", reply(404, { error: "target_not_found: target not found" }));
    expect(await readFigmaLinks("u", "co-1", "pm_task", "t1")).toEqual({ kind: "unavailable", reason: "target_not_found: target not found" });
    vi.stubGlobal("fetch", reply(500, { error: "database went away" }));
    expect((await readFigmaLinks("u", "co-1", "pm_task", "t1")).kind).toBe("unavailable");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("socket hang up"); }));
    expect(await readFigmaLinks("u", "co-1", "pm_task", "t1")).toEqual({ kind: "unavailable", reason: "socket hang up" });
  });

  it("treats a 200 that is not the list shape as a broken read, not as no links", async () => {
    vi.stubGlobal("fetch", reply(200, []));
    expect((await readFigmaLinks("u", "co-1", "pm_task", "t1")).kind).toBe("unavailable");
    vi.stubGlobal("fetch", reply(200, { items: [] }));
    expect((await readFigmaLinks("u", "co-1", "pm_task", "t1")).kind).toBe("unavailable");
  });
});

describe("readFigmaConnection", () => {
  it("reads the masked status", async () => {
    const f = reply(200, { connected: true, tokenType: "pat" });
    vi.stubGlobal("fetch", f);
    expect(await readFigmaConnection("u", "co-1")).toEqual({ kind: "ok", data: { connected: true, tokenType: "pat" } });
    expect(String(f.mock.calls[0][0])).toBe("http://p.test/api/co-1/integrations/figma");
  });

  it("is forbidden on a 403 and unavailable on a failure or a wrong shape, never 'not connected'", async () => {
    vi.stubGlobal("fetch", reply(403, {}));
    expect(await readFigmaConnection("u", "co-1")).toEqual({ kind: "forbidden" });
    vi.stubGlobal("fetch", reply(502, { error: "bad gateway" }));
    expect((await readFigmaConnection("u", "co-1")).kind).toBe("unavailable");
    vi.stubGlobal("fetch", reply(200, { ok: true }));
    expect((await readFigmaConnection("u", "co-1")).kind).toBe("unavailable");
  });
});
