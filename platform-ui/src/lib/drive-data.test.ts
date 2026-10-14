import { describe, it, expect, vi, beforeEach } from "vitest";
import { readDriveStatus } from "./drive-data";

// DW-6i UI: the reader behind the Drive block and the attach-button gate. It reads the token-free STATUS route for the active
// company (never the Picker route, which mints a token), keeps a refusal as data, and keeps only the four status fields.

beforeEach(() => {
  process.env.PLATFORM_URL = "http://p.test";
  process.env.PLATFORM_SERVICE_TOKEN = "t";
  delete process.env.DEMO_MODE;
});

const reply = (status: number, body: unknown = {}) => vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify(body), { status }));
const answer = (over: Record<string, unknown> = {}) => ({
  configured: true, connected: true, needsReconnect: false, accountEmail: "a@b.test", accessToken: "ya29.secret", expiresAt: "2026-10-14T10:00:00Z",
  apiKey: "key", appId: "123", ...over,
});

describe("readDriveStatus", () => {
  it("asks the status route for the active company, never the Picker route", async () => {
    const f = reply(200, answer());
    vi.stubGlobal("fetch", f);
    await readDriveStatus("u", "co-1");
    expect(f).toHaveBeenCalledTimes(1);
    expect(String(f.mock.calls[0][0])).toBe("http://p.test/api/co-1/integrations/google-drive");
    expect((f.mock.calls[0][1] as RequestInit | undefined)?.method ?? "GET").toBe("GET");
  });

  it("returns the four status fields only, even if an answer carried more (a token, the key, the app id)", async () => {
    vi.stubGlobal("fetch", reply(200, answer()));
    const r = await readDriveStatus("u", "co-1");
    expect(r).toEqual({ kind: "ok", data: { configured: true, connected: true, needsReconnect: false, accountEmail: "a@b.test" } });
    expect(JSON.stringify(r)).not.toContain("ya29");
    expect(JSON.stringify(r)).not.toContain("apiKey");
  });

  it("reads configured: false as ok data, not as an error (the normal state until the OAuth client exists)", async () => {
    vi.stubGlobal("fetch", reply(200, answer({ configured: false, connected: false, accessToken: null, apiKey: null, appId: null, accountEmail: null })));
    expect(await readDriveStatus("u", "co-1")).toEqual({
      kind: "ok", data: { configured: false, connected: false, needsReconnect: false, accountEmail: null },
    });
  });

  it("reads needsReconnect", async () => {
    vi.stubGlobal("fetch", reply(200, answer({ connected: false, needsReconnect: true, accessToken: null })));
    const r = await readDriveStatus("u", "co-1");
    expect(r.kind === "ok" && r.data.needsReconnect).toBe(true);
  });

  it("is forbidden on a 403, never 'not connected'", async () => {
    vi.stubGlobal("fetch", reply(403, { error: "forbidden" }));
    expect(await readDriveStatus("u", "co-1")).toEqual({ kind: "forbidden" });
  });

  it("is unavailable on a 404, a 500 and a thrown fetch, each with words", async () => {
    vi.stubGlobal("fetch", reply(404, { error: "not found" }));
    expect(await readDriveStatus("u", "co-1")).toEqual({ kind: "unavailable", reason: "not found" });
    vi.stubGlobal("fetch", reply(500, { error: "database went away" }));
    expect((await readDriveStatus("u", "co-1")).kind).toBe("unavailable");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("socket hang up"); }));
    expect(await readDriveStatus("u", "co-1")).toEqual({ kind: "unavailable", reason: "socket hang up" });
  });

  it("treats a 200 that is not the status shape as a broken read", async () => {
    vi.stubGlobal("fetch", reply(200, { hello: "world" }));
    const r = await readDriveStatus("u", "co-1");
    expect(r.kind).toBe("unavailable");
  });
});
