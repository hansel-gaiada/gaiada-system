// IT subsystem (§6) — device registry, events, heartbeat ingest, and IT-role gating.
// Against live Postgres + RLS + Cerbos.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { withTenants } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import { sweepTenantStatuses } from "./discovery.service";

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
    tenant = await createCompany("Agency A", ["agency", "it"]);
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

  // ─── IT-02: the edit/delete half that 0019 promised and never shipped ───────────────────────
  it("PATCH edits a manual device's columns directly", async () => {
    const r = await app.inject({
      method: "PATCH", url: `/api/${tenant}/it/devices/${deviceId}`, headers: asUser(itAdmin),
      payload: { name: "Lobby CCTV (east)", vendor: "Hikvision", labels: ["lobby", "entrance"] },
    });
    expect(r.statusCode).toBe(200);
    const d = (await app.inject({ method: "GET", url: `/api/${tenant}/it/devices/${deviceId}`, headers: asUser(member) })).json() as { name: string; vendor: string; labels: string[] };
    expect(d.name).toBe("Lobby CCTV (east)");
    expect(d.vendor).toBe("Hikvision");
    expect(d.labels).toEqual(["lobby", "entrance"]);
  });

  it("PATCH rejects an empty name, an unknown field and a bad kind", async () => {
    for (const payload of [{ name: "  " }, { nope: 1 }, { kind: "toaster" }]) {
      const r = await app.inject({ method: "PATCH", url: `/api/${tenant}/it/devices/${deviceId}`, headers: asUser(itAdmin), payload });
      expect(r.statusCode).toBe(400);
    }
  });

  it("a plain member can neither edit nor delete a device (403)", async () => {
    expect((await app.inject({ method: "PATCH", url: `/api/${tenant}/it/devices/${deviceId}`, headers: asUser(member), payload: { name: "x" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: `/api/${tenant}/it/devices/${deviceId}`, headers: asUser(member) })).statusCode).toBe(403);
  });

  // ─── IT-05: discovery ingest, classification, topology ──────────────────────────────────────
  it("a discovery report upserts infrastructure + managed hosts, DROPS byod, and resolves uplinks", async () => {
    const report = {
      source: "unifi", site: "Bali Office",
      devices: [
        { externalId: "u-gw", name: "Gateway", hostname: "unifi.localdomain", adopted: true, mac: "28:70:4e:74:55:10", ip: "10.10.0.1", isWired: true },
        { externalId: "u-ap1", name: "AP Office", adopted: true, mac: "94:2a:6f:42:fe:35", ip: "10.10.0.2", isWired: true, uplinkMac: "28:70:4e:74:55:10", uplinkPort: 3 },
        { externalId: "c-gda01", hostname: "GDA-01.local", ip: "10.10.2.39", mac: "c8:8a:9a:cb:ec:a1", isWired: false, ssid: "GDA", uplinkMac: "94:2a:6f:42:fe:35" },
        { externalId: "c-gda07", hostname: "GDA-07.local", ip: "10.10.1.22", mac: "c8:8a:9a:ca:f1:fc", isWired: false, ssid: "GDA", uplinkMac: "94:2a:6f:42:fe:35" },
        // Personal phones — must be COUNTED and DISCARDED, never persisted (privacy gate §6).
        { externalId: "c-phone1", hostname: "Ratihs-iPhone", ip: "10.10.1.248", mac: "fc:31:5d:41:b7:e4" },
        { externalId: "c-phone2", hostname: "A56-milik-Tini", ip: "10.10.3.72", mac: "5a:3a:8c:12:68:80" },
      ],
    };
    const r = await app.inject({ method: "POST", url: `/api/${tenant}/it/discovery/report`, headers: asUser(itAdmin), payload: report });
    expect(r.statusCode).toBe(200);
    const res = r.json() as { devicesSeen: number; devicesUpserted: number; byodCount: number; linksUpserted: number };
    expect(res.devicesSeen).toBe(6);
    expect(res.devicesUpserted).toBe(4); // 2 infrastructure + 2 managed
    expect(res.byodCount).toBe(2);
    expect(res.linksUpserted).toBe(3);   // ap1→gw, gda01→ap1, gda07→ap1

    const list = (await app.inject({ method: "GET", url: `/api/${tenant}/it/devices`, headers: asUser(member) })).json() as Array<{ name: string; deviceClass: string; discoverySource: string; status: string }>;
    // No personal phone became a row.
    expect(list.some((d) => d.name.includes("iPhone") || d.name.includes("milik"))).toBe(false);
    const gw = list.find((d) => d.name === "Gateway")!;
    expect(gw.deviceClass).toBe("infrastructure");
    expect(gw.discoverySource).toBe("unifi");
    // Freshly seen ⇒ derived status is online, NOT the old permanent 'unknown'.
    expect(gw.status).toBe("online");
  });

  it("re-posting the same report is idempotent (no duplicate rows)", async () => {
    const before = (await app.inject({ method: "GET", url: `/api/${tenant}/it/devices`, headers: asUser(member) })).json() as unknown[];
    const report = { source: "unifi", devices: [{ externalId: "u-gw", name: "Gateway", adopted: true, mac: "28:70:4e:74:55:10", ip: "10.10.0.1" }] };
    await app.inject({ method: "POST", url: `/api/${tenant}/it/discovery/report`, headers: asUser(itAdmin), payload: report });
    const after = (await app.inject({ method: "GET", url: `/api/${tenant}/it/devices`, headers: asUser(member) })).json() as unknown[];
    expect(after.length).toBe(before.length);
  });

  it("GET /it/topology returns nodes, resolved edges and the last-run staleness signal", async () => {
    const t = (await app.inject({ method: "GET", url: `/api/${tenant}/it/topology`, headers: asUser(member) })).json() as {
      devices: Array<{ id: string; name: string }>;
      links: Array<{ childDeviceId: string; parentDeviceId: string; port: number | null; medium: string }>;
      lastRun: { ok: boolean; devicesSeen: number; byodCount: number } | null;
    };
    expect(t.devices.length).toBeGreaterThanOrEqual(4);
    expect(t.links.length).toBeGreaterThanOrEqual(3);
    // lastRun is what lets the UI distinguish "dead collector" from "empty network".
    expect(t.lastRun?.ok).toBe(true);
    const byName = new Map(t.devices.map((d) => [d.name, d.id]));
    const ap = byName.get("AP Office")!;
    const gw = byName.get("Gateway")!;
    expect(t.links.find((l) => l.childDeviceId === ap)?.parentDeviceId).toBe(gw);
    expect(t.links.find((l) => l.childDeviceId === ap)?.port).toBe(3);
  });

  it("a discovered device's collector-owned facts are not editable, but its label fields are", async () => {
    const list = (await app.inject({ method: "GET", url: `/api/${tenant}/it/devices`, headers: asUser(member) })).json() as Array<{ id: string; name: string }>;
    const gda01 = list.find((d) => d.name === "GDA-01.local")!;

    // ip is a network fact — pinning it would make the registry lie about the network.
    const bad = await app.inject({ method: "PATCH", url: `/api/${tenant}/it/devices/${gda01.id}`, headers: asUser(itAdmin), payload: { ip: "9.9.9.9" } });
    expect(bad.statusCode).toBe(400);

    const ok = await app.inject({ method: "PATCH", url: `/api/${tenant}/it/devices/${gda01.id}`, headers: asUser(itAdmin), payload: { name: "Reception PC" } });
    expect(ok.statusCode).toBe(200);

    // THE POINT OF THE OVERRIDE LAYER: the next poll rewrites the underlying `name` column, and the
    // operator's correction must still be what everyone reads afterwards.
    await app.inject({
      method: "POST", url: `/api/${tenant}/it/discovery/report`, headers: asUser(itAdmin),
      payload: { source: "unifi", devices: [{ externalId: "c-gda01", hostname: "GDA-01.local", ip: "10.10.2.39", mac: "c8:8a:9a:cb:ec:a1" }] },
    });
    const after = (await app.inject({ method: "GET", url: `/api/${tenant}/it/devices/${gda01.id}`, headers: asUser(member) })).json() as { name: string; ip: string };
    expect(after.name).toBe("Reception PC");
    expect(after.ip).toBe("10.10.2.39"); // the fact itself still tracks the network
  });

  it("DELETE soft-deletes, drops the device's topology edges, and 404s afterwards", async () => {
    const list = (await app.inject({ method: "GET", url: `/api/${tenant}/it/devices`, headers: asUser(member) })).json() as Array<{ id: string; name: string }>;
    const gda07 = list.find((d) => d.name === "GDA-07.local")!;

    expect((await app.inject({ method: "DELETE", url: `/api/${tenant}/it/devices/${gda07.id}`, headers: asUser(itAdmin) })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/${tenant}/it/devices/${gda07.id}`, headers: asUser(member) })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/api/${tenant}/it/devices/${gda07.id}`, headers: asUser(itAdmin) })).statusCode).toBe(404);

    const topo = (await app.inject({ method: "GET", url: `/api/${tenant}/it/topology`, headers: asUser(member) })).json() as { links: Array<{ childDeviceId: string }> };
    expect(topo.links.some((l) => l.childDeviceId === gda07.id)).toBe(false);

    const ev = await withTenants([tenant], (c) =>
      c.query(`SELECT event_type FROM outbox_events WHERE entity_type = 'device' AND entity_id = $1`, [gda07.id]),
    );
    expect(ev.rows).toContainEqual({ event_type: "device.deleted" });
  });

  it("the stale reaper flips a device the collector stopped reporting to offline", async () => {
    const list = (await app.inject({ method: "GET", url: `/api/${tenant}/it/devices`, headers: asUser(member) })).json() as Array<{ id: string; name: string; status: string }>;
    const gw = list.find((d) => d.name === "Gateway")!;
    expect(gw.status).toBe("online");

    // Sweep with a clock 2 hours ahead — the same thing that happens when a device disappears.
    const changed = await sweepTenantStatuses(tenant, new Date(Date.now() + 2 * 3600 * 1000));
    expect(changed).toBeGreaterThan(0);

    const after = (await app.inject({ method: "GET", url: `/api/${tenant}/it/devices/${gw.id}`, headers: asUser(member) })).json() as { status: string; events: Array<{ type: string }> };
    expect(after.status).toBe("offline");
    expect(after.events.map((e) => e.type)).toContain("offline");
  });

  it("search + class filters narrow the device list", async () => {
    const byClass = (await app.inject({ method: "GET", url: `/api/${tenant}/it/devices?deviceClass=infrastructure`, headers: asUser(member) })).json() as Array<{ deviceClass: string }>;
    expect(byClass.length).toBeGreaterThan(0);
    expect(byClass.every((d) => d.deviceClass === "infrastructure")).toBe(true);

    const byIp = (await app.inject({ method: "GET", url: `/api/${tenant}/it/devices?q=10.10.0.1`, headers: asUser(member) })).json() as Array<{ name: string }>;
    expect(byIp.some((d) => d.name === "Gateway")).toBe(true);
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
