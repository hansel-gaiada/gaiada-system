// A1: /admin/session/* route tests against a stubbed WAHA server (global fetch mock —
// the same convention as media.test.ts) covering auth (401/503), the create-or-start
// already-exists fallback, QR-null-when-already-paired, and session-event -> /health +
// /admin/session/status wiring end to end through the real webhook path.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildApp } from "./server";
import { config } from "./config";
import { resetSessionState } from "./session-state";

const gw = { sendText: async () => {} };

function jsonRes(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

const SESSION_ROUTES: Array<["GET" | "POST", string]> = [
  ["POST", "/admin/session/start"],
  ["GET", "/admin/session/status"],
  ["GET", "/admin/session/qr"],
  ["POST", "/admin/session/stop"],
  ["POST", "/admin/session/logout"],
  ["POST", "/admin/session/restart"],
];

describe("admin session routes", () => {
  beforeEach(() => {
    config.adminToken = "sekret";
    config.wahaUrl = "http://waha.test";
    config.wahaSession = "default";
    resetSessionState();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("401s every session route without the admin token", async () => {
    const app = buildApp(gw as any);
    for (const [method, url] of SESSION_ROUTES) {
      const res = await app.inject({ method, url });
      expect(res.statusCode).toBe(401);
    }
    await app.close();
  });

  it("503s every session route when ADMIN_TOKEN is unset (fail-closed)", async () => {
    config.adminToken = "";
    const app = buildApp(gw as any);
    for (const [method, url] of SESSION_ROUTES) {
      const res = await app.inject({ method, url, headers: { authorization: "Bearer whatever" } });
      expect(res.statusCode).toBe(503);
    }
    await app.close();
  });

  it("POST /admin/session/start: already-exists (422) falls back to /start, then returns status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, opts: any = {}) => {
        const method = opts.method ?? "GET";
        if (url === "http://waha.test/api/sessions" && method === "POST") return jsonRes(422, {});
        if (url === "http://waha.test/api/sessions/default/start") return jsonRes(200, {});
        if (url === "http://waha.test/api/sessions/default") {
          return jsonRes(200, { status: "SCAN_QR_CODE", engine: { engine: "NOWEB" } });
        }
        throw new Error(`unexpected ${method} ${url}`);
      }),
    );
    const app = buildApp(gw as any);
    const res = await app.inject({ method: "POST", url: "/admin/session/start", headers: { authorization: "Bearer sekret" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ session: "default", status: "SCAN_QR_CODE", engine: "NOWEB", me: null });
    await app.close();
  });

  it("GET /admin/session/status: merges the WAHA status with the last recorded session event", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonRes(200, { status: "WORKING", me: { id: "1@c.us", pushName: "Bot" } })),
    );
    const app = buildApp(gw as any);
    // Drive a real session.status webhook through the whole new pipeline (webhook auth ->
    // normalizeWahaEvent -> handleEvent -> session-state) rather than poking the tracker
    // directly, so this proves the wiring end to end.
    config.webhookSecret = "hook-sekret";
    const hookRes = await app.inject({
      method: "POST",
      url: "/webhook?token=hook-sekret",
      payload: { event: "session.status", payload: { name: "default", status: "WORKING", timestamp: 42 } },
    });
    expect(hookRes.statusCode).toBe(200);

    const res = await app.inject({ method: "GET", url: "/admin/session/status", headers: { authorization: "Bearer sekret" } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { session: string; status: string; me: unknown; lastEvent: { status: string; ts: number } | null };
    expect(body.session).toBe("default");
    expect(body.status).toBe("WORKING");
    expect(body.me).toEqual({ id: "1@c.us", pushName: "Bot" });
    expect(body.lastEvent).toEqual({ status: "WORKING", ts: 42000 });
    await app.close();
  });

  it("GET /admin/session/qr: returns a data URL when a QR is available, with Cache-Control: no-store", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/auth/qr")) {
          return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode("png-bytes").buffer };
        }
        return jsonRes(200, { status: "SCAN_QR_CODE" });
      }),
    );
    const app = buildApp(gw as any);
    const res = await app.inject({ method: "GET", url: "/admin/session/qr", headers: { authorization: "Bearer sekret" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json() as { qr: string | null; status: string };
    expect(body.qr).toMatch(/^data:image\/png;base64,/);
    expect(body.status).toBe("SCAN_QR_CODE");
    await app.close();
  });

  it("GET /admin/session/qr: qr:null (HTTP 200, not an error) when already paired", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/auth/qr")) return jsonRes(422, { error: "already paired" });
        return jsonRes(200, { status: "WORKING" });
      }),
    );
    const app = buildApp(gw as any);
    const res = await app.inject({ method: "GET", url: "/admin/session/qr", headers: { authorization: "Bearer sekret" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ qr: null, status: "WORKING" });
    await app.close();
  });

  it("POST stop / logout / restart: 200 and reach the session-scoped WAHA path", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, opts: any = {}) => {
        calls.push(`${opts.method ?? "GET"} ${url}`);
        return jsonRes(200, { status: "STOPPED" });
      }),
    );
    const app = buildApp(gw as any);
    for (const path of ["stop", "logout", "restart"]) {
      const res = await app.inject({ method: "POST", url: `/admin/session/${path}`, headers: { authorization: "Bearer sekret" } });
      expect(res.statusCode).toBe(200);
    }
    expect(calls).toContain("POST http://waha.test/api/sessions/default/stop");
    expect(calls).toContain("POST http://waha.test/api/sessions/default/logout");
    expect(calls).toContain("POST http://waha.test/api/sessions/default/restart");
    await app.close();
  });

  it("/health reports the tracked session status (unknown at boot, then live after an event)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes(200, { status: "WORKING" })));
    const app = buildApp(gw as any);
    const before = await app.inject({ method: "GET", url: "/health" });
    expect(before.json().session).toBe("unknown");

    config.webhookSecret = "hook-sekret-2";
    await app.inject({
      method: "POST",
      url: "/webhook?token=hook-sekret-2",
      payload: { event: "session.status", payload: { name: "default", status: "WORKING" } },
    });
    const after = await app.inject({ method: "GET", url: "/health" });
    expect(after.json()).toMatchObject({ ok: true, session: "WORKING" });
    await app.close();
  });
});
