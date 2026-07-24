import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { config } from "./config";
import { startSession, getSessionStatus, getQr, stopSession, logoutSession, restartSession } from "./waha-admin";

function jsonRes(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

describe("waha-admin (session lifecycle client)", () => {
  beforeEach(() => {
    config.wahaUrl = "http://waha.test";
    config.wahaSession = "default";
    config.wahaApiKey = "wa-key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("startSession: creates the session with the NOWEB store body, then reads status", async () => {
    const calls: Array<{ url: string; method: string; body?: string; apiKey?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, opts: any = {}) => {
        calls.push({ url, method: opts.method ?? "GET", body: opts.body, apiKey: opts.headers?.["X-Api-Key"] });
        if (url === "http://waha.test/api/sessions" && opts.method === "POST") {
          return jsonRes(201, { name: "default", status: "SCAN_QR_CODE" });
        }
        if (url === "http://waha.test/api/sessions/default") {
          return jsonRes(200, { name: "default", status: "SCAN_QR_CODE", engine: { engine: "NOWEB" } });
        }
        throw new Error(`unexpected call: ${opts.method ?? "GET"} ${url}`);
      }),
    );

    const result = await startSession();
    expect(result).toEqual({ session: "default", status: "SCAN_QR_CODE", engine: "NOWEB", me: null });

    expect(calls[0]).toMatchObject({ url: "http://waha.test/api/sessions", method: "POST", apiKey: "wa-key" });
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      name: "default",
      start: true,
      config: { noweb: { store: { enabled: true, fullSync: false } } },
    });
    expect(calls[1]!.url).toBe("http://waha.test/api/sessions/default");
  });

  it("startSession: falls back to POST .../start when the session already exists (422)", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, opts: any = {}) => {
        const method = opts.method ?? "GET";
        calls.push(`${method} ${url}`);
        if (url === "http://waha.test/api/sessions" && method === "POST") return jsonRes(422, { error: "already exists" });
        if (url === "http://waha.test/api/sessions/default/start" && method === "POST") return jsonRes(200, {});
        if (url === "http://waha.test/api/sessions/default") {
          return jsonRes(200, { status: "WORKING", me: { id: "1@c.us", pushName: "Bot" } });
        }
        throw new Error(`unexpected call: ${method} ${url}`);
      }),
    );

    const result = await startSession();
    expect(result).toEqual({ session: "default", status: "WORKING", engine: null, me: { id: "1@c.us", pushName: "Bot" } });
    expect(calls).toEqual([
      "POST http://waha.test/api/sessions",
      "POST http://waha.test/api/sessions/default/start",
      "GET http://waha.test/api/sessions/default",
    ]);
  });

  it("startSession: also treats 409 as 'already exists'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, opts: any = {}) => {
        const method = opts.method ?? "GET";
        if (url === "http://waha.test/api/sessions" && method === "POST") return jsonRes(409, {});
        if (url.endsWith("/start")) return jsonRes(200, {});
        return jsonRes(200, { status: "STARTING" });
      }),
    );
    expect((await startSession()).status).toBe("STARTING");
  });

  it("startSession: a network failure on create still resolves via the status read (never throws)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "http://waha.test/api/sessions") throw new Error("ECONNREFUSED");
        return jsonRes(200, { status: "unknown" });
      }),
    );
    const result = await startSession();
    expect(result.status).toBe("unknown");
  });

  it("getSessionStatus: maps a 404 (session never created) to STOPPED", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes(404, {})));
    expect(await getSessionStatus()).toEqual({ session: "default", status: "STOPPED", engine: null, me: null });
  });

  it("getSessionStatus: reports 'unreachable' on a network failure, never throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    expect(await getSessionStatus()).toEqual({ session: "default", status: "unreachable", engine: null, me: null });
  });

  it("getSessionStatus: passes through an unrecognized status string verbatim (engine-tolerant)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes(200, { status: "SOME_NEW_ENGINE_STATE" })));
    expect((await getSessionStatus()).status).toBe("SOME_NEW_ENGINE_STATE");
  });

  it("stopSession / logoutSession / restartSession call the session-scoped WAHA path", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, opts: any = {}) => {
        calls.push(`${opts.method ?? "GET"} ${url}`);
        return jsonRes(200, { status: "STOPPED" });
      }),
    );
    await stopSession();
    expect(calls).toContain("POST http://waha.test/api/sessions/default/stop");

    calls.length = 0;
    await logoutSession();
    expect(calls).toContain("POST http://waha.test/api/sessions/default/logout");

    calls.length = 0;
    await restartSession();
    expect(calls).toContain("POST http://waha.test/api/sessions/default/restart");
  });

  it("restartSession: falls back to stop -> start when /restart is absent (404) on this image", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, opts: any = {}) => {
        const method = opts.method ?? "GET";
        calls.push(`${method} ${url}`);
        if (url.endsWith("/restart")) return jsonRes(404, {});
        if (url.endsWith("/stop")) return jsonRes(200, {});
        if (url === "http://waha.test/api/sessions" && method === "POST") return jsonRes(201, {});
        if (url.endsWith("/start")) return jsonRes(200, {});
        if (url === "http://waha.test/api/sessions/default") return jsonRes(200, { status: "WORKING" });
        throw new Error(`unexpected: ${method} ${url}`);
      }),
    );
    const result = await restartSession();
    expect(calls).toContain("POST http://waha.test/api/sessions/default/restart");
    expect(calls).toContain("POST http://waha.test/api/sessions/default/stop");
    expect(result.status).toBe("WORKING");
  });

  it("getQr: returns a base64 data URL when a QR is available", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/auth/qr")) {
          return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode("fake-png-bytes").buffer };
        }
        return jsonRes(200, { status: "SCAN_QR_CODE" });
      }),
    );
    const result = await getQr();
    expect(result.status).toBe("SCAN_QR_CODE");
    expect(result.qr).toMatch(/^data:image\/png;base64,/);
    expect(Buffer.from(result.qr!.split(",")[1]!, "base64").toString()).toBe("fake-png-bytes");
  });

  it("getQr: qr:null (never an error) when already paired / no QR available", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/auth/qr")) return jsonRes(422, { error: "no qr" });
        return jsonRes(200, { status: "WORKING" });
      }),
    );
    expect(await getQr()).toEqual({ qr: null, status: "WORKING" });
  });

  it("getQr: reports unreachable without throwing on a network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    expect(await getQr()).toEqual({ qr: null, status: "unreachable" });
  });
});
