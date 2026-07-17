// IT subsystem (§6) — device registry, events, heartbeat ingest, and IT-role gating.
// Against live Postgres + RLS + Cerbos.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { withTenants } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("IT subsystem (§6)", () => {
  let app: NestFastifyApplication;
  let tenant: string;
  let itAdmin: string;
  let member: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    tenant = await createCompany("Agency A", ["agency"]);
    itAdmin = await createUser("it@a.test");
    member = await createUser("mem@a.test");
    await addMembership(tenant, itAdmin);
    await addMembership(tenant, member);
    await grantRole(itAdmin, await createRole("it_admin"), "company", tenant);
    await grantRole(member, await createRole("member"), "company", tenant);
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  let deviceId: string;

  it("IT staff registers a device; any member can read it; device.registered emitted", async () => {
    const r = await app.inject({
      method: "POST", url: `/api/${tenant}/it/devices`, headers: asUser(itAdmin),
      payload: { name: "Lobby CCTV", kind: "cctv", site: "HQ", network: "cameras", ip: "10.0.0.5", vendor: "Hik" },
    });
    expect(r.statusCode).toBe(201);
    deviceId = (r.json() as { id: string }).id;

    const list = (await app.inject({ method: "GET", url: `/api/${tenant}/it/devices`, headers: asUser(member) })).json() as Array<{ id: string; kind: string; status: string; uptimeSec: number | null }>;
    const found = list.find((d) => d.id === deviceId)!;
    expect(found.kind).toBe("cctv");
    expect(found.status).toBe("unknown");
    expect(found.uptimeSec).toBeNull();

    const ev = await withTenants([tenant], (c) =>
      c.query(`SELECT event_type FROM outbox_events WHERE entity_type = 'device' AND entity_id = $1`, [deviceId]),
    );
    expect(ev.rows).toContainEqual({ event_type: "device.registered" });
  });

  it("a plain member cannot register a device (403)", async () => {
    const r = await app.inject({ method: "POST", url: `/api/${tenant}/it/devices`, headers: asUser(member), payload: { name: "x", kind: "server" } });
    expect(r.statusCode).toBe(403);
  });

  it("heartbeat updates status, appends the series, and records a status-change event", async () => {
    const h1 = await app.inject({ method: "POST", url: `/api/${tenant}/it/devices/${deviceId}/heartbeat`, headers: asUser(itAdmin), payload: { status: "online", latencyMs: 12, uptimeSec: 3600 } });
    expect(h1.statusCode).toBe(200);
    await app.inject({ method: "POST", url: `/api/${tenant}/it/devices/${deviceId}/heartbeat`, headers: asUser(itAdmin), payload: { status: "degraded", latencyMs: 240 } });

    const detail = (await app.inject({ method: "GET", url: `/api/${tenant}/it/devices/${deviceId}`, headers: asUser(member) })).json() as { status: string; heartbeats: number[]; events: Array<{ type: string }>; uptimeSec: number | null };
    expect(detail.status).toBe("degraded");
    expect(detail.heartbeats).toEqual([12, 240]);
    expect(detail.uptimeSec).toBe(3600);
    expect(detail.events.map((e) => e.type)).toEqual(expect.arrayContaining(["registered", "online", "degraded"]));

    const events = (await app.inject({ method: "GET", url: `/api/${tenant}/it/events?deviceId=${deviceId}`, headers: asUser(member) })).json() as Array<{ type: string; severity: string }>;
    expect(events.find((e) => e.type === "degraded")?.severity).toBe("warn");
  });

  it("workflow viewer degrades to [] when n8n is not configured", async () => {
    const prev = config.services.automation;
    config.services.automation = { url: "", token: "" };
    const r = await app.inject({ method: "GET", url: `/api/admin/automation/workflows`, headers: asUser(itAdmin) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual([]);
    config.services.automation = prev;
  });
});
