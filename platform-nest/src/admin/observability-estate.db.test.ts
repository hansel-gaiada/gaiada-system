// MSO-05 — live-DB / app.inject coverage for the estate observability endpoint. The pure
// freshness/null-vs-zero logic is unit-tested in estate-observability.test.ts without any
// infrastructure; this file proves the NestJS wiring: the isElevated gate, the `infra_hosts`
// withGlobal() read against a REAL RLS-restricted role, and the Prometheus/Alertmanager fetches
// assembling into the wire response end-to-end via `app.inject`.
//
// Needs DATABASE_URL_TEST + CERBOS_URL — skips silently otherwise (see platform-nest/CLAUDE.md).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";
import { withGlobal } from "../db";
import type { EstateObservabilitySnapshot } from "./estate-observability";

const asUser = (id: string) => ({ authorization: "Bearer svc-token", "x-user-id": id });

// Query strings copied verbatim from observability.controller.ts so the stub can route on them —
// if the controller's PromQL ever changes, this file's routing must be updated in step (a stub
// silently answering the WRONG query with a canned response is worse than a 404).
const Q = {
  freshness: 'max by (host) (last_over_time(timestamp(up{host!=""})[48h:1m]))',
  cpu: '100 - (avg by (host) (rate(node_cpu_seconds_total{mode="idle",host!=""}[5m])) * 100)',
  cores: 'count by (host) (node_cpu_seconds_total{mode="idle",host!=""})',
  mem: '(1 - (node_memory_MemAvailable_bytes{host!=""} / node_memory_MemTotal_bytes{host!=""})) * 100',
  load1: 'node_load1{host!=""}',
  uptime: '(time() - node_boot_time_seconds{host!=""}) / 86400',
  up: 'up{host!=""}',
  pg: 'pg_up{host!=""}',
  redis: 'redis_up{host!=""}',
};

function startPrometheusStub(nowSec: number): Promise<{ server: Server; base: string }> {
  const gdaLastSample = nowSec - 30; // fresh
  const sumopodLastSample = nowSec - 300; // stale (>90s, <=600s)
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "", "http://x");
    const send = (result: unknown[]) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "success", data: { result } }));
    };
    const query = url.searchParams.get("query") ?? "";
    const vec = (host: string, value: number, extra: Record<string, string> = {}) => ({
      metric: { host, ...extra },
      value: [nowSec, String(value)],
    });

    if (query === Q.freshness)
      return send([
        vec("gda-aicenter", gdaLastSample),
        vec("sumopod", sumopodLastSample),
        vec("ghost-box", gdaLastSample), // fresh, but see below: no infra_hosts row for it
      ]);
    if (query === Q.cpu) return send([vec("gda-aicenter", 12.5), vec("sumopod", 3.1)]);
    if (query === Q.cores) return send([vec("gda-aicenter", 4), vec("sumopod", 2)]);
    if (query === Q.mem) return send([vec("gda-aicenter", 55), vec("sumopod", 20)]);
    if (query.startsWith("(1 - (node_filesystem_avail_bytes")) return send([vec("gda-aicenter", 40), vec("sumopod", 10)]);
    if (query.startsWith("node_filesystem_avail_bytes")) return send([vec("gda-aicenter", 100), vec("sumopod", 400)]);
    if (query.startsWith("predict_linear(")) return send([vec("gda-aicenter", 80), vec("sumopod", 390)]);
    if (query === Q.load1) return send([vec("gda-aicenter", 0.8), vec("sumopod", 0.1)]);
    if (query === Q.uptime) return send([vec("gda-aicenter", 12.3), vec("sumopod", 40.1)]);
    if (query === Q.up) {
      return send([
        vec("gda-aicenter", 1, { job: "node", env: "production" }),
        vec("gda-aicenter", 0, { job: "cadvisor", env: "production" }),
        vec("sumopod", 1, { job: "node", env: "ops" }),
        // A host with live series but NO infra_hosts row — the "unregistered host" case.
        vec("ghost-box", 1, { job: "node", env: "dev" }),
      ]);
    }
    if (query === Q.pg) return send([vec("gda-aicenter", 0, { instance: "pg:5432" })]); // measured, and DOWN
    if (query === Q.redis) return send([]); // gda-aicenter ships no redis exporter in this fixture
    return send([]);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

function startAlertmanagerStub(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify([
        { labels: { alertname: "Watchdog", severity: "none" }, status: { state: "active" } },
        { labels: { alertname: "DiskSpaceLow", severity: "page", host: "gda-aicenter" }, status: { state: "active" } },
        {
          labels: { alertname: "DiskSpaceLow", severity: "page", host: "sumopod" },
          status: { state: "suppressed", silencedBy: ["sil-1"] },
        },
      ]),
    );
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

describe.skipIf(!TEST_URL)("estate observability — GET /api/admin/observability (MSO-05)", () => {
  let app: NestFastifyApplication;
  let promStub: Server;
  let amStub: Server;
  let admin: string;
  let member: string;
  let promBaseUrl: string;
  let amBaseUrl: string;
  const priorPrometheusUrl = config.observability.prometheusUrl;
  const priorAlertmanagerUrl = config.observability.alertmanagerUrl;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";

    const nowSec = Math.floor(Date.now() / 1000);
    const { server: ps, base: promBase } = await startPrometheusStub(nowSec);
    const { server: as, base: amBase } = await startAlertmanagerStub();
    promStub = ps;
    amStub = as;
    promBaseUrl = promBase;
    amBaseUrl = amBase;
    config.observability.prometheusUrl = promBase;
    config.observability.alertmanagerUrl = amBase;

    // infra_hosts has no fixture helper (new MSO-04/05 table) — insert directly via withGlobal,
    // the same escape hatch the table itself is designed to be read through.
    await withGlobal((c) =>
      c.query(
        `INSERT INTO infra_hosts (key, display_name, env, role, status)
         VALUES ($1,$2,$3,$4,$5), ($6,$7,$8,$9,$10), ($11,$12,$13,$14,$15)
         ON CONFLICT (key) DO NOTHING`,
        [
          "gda-aicenter", "gda-aicenter", "production", "erp-core", "active",
          "sumopod", "SumoPod", "ops", "observability-hub", "active",
          "planned-box", "Planned Box", "dev", "ai-host", "onboarding",
        ],
      ),
    );

    const tenant = await createCompany("Ops Co", []);
    admin = await createUser("obs-admin@a.test");
    member = await createUser("obs-member@a.test");
    await addMembership(tenant, admin);
    await addMembership(tenant, member);
    const adminRole = await createRole("platform_admin");
    const memberRole = await createRole("member");
    await grantRole(admin, adminRole, "global", null);
    await grantRole(member, memberRole, "company", tenant);

    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    await new Promise<void>((r) => promStub.close(() => r()));
    await new Promise<void>((r) => amStub.close(() => r()));
    config.observability.prometheusUrl = priorPrometheusUrl;
    config.observability.alertmanagerUrl = priorAlertmanagerUrl;
    await teardownTestDb();
  });

  it("refuses a non-platform-admin with 403", async () => {
    const r = await app.inject({ method: "GET", url: "/api/admin/observability", headers: asUser(member) });
    expect(r.statusCode).toBe(403);
  });

  it("assembles the estate: registered+live, never-reported, and unregistered hosts all appear", async () => {
    const r = await app.inject({ method: "GET", url: "/api/admin/observability", headers: asUser(admin) });
    expect(r.statusCode).toBe(200);
    const body = r.json() as EstateObservabilitySnapshot;
    expect(body.available).toBe(true);
    expect(body.hosts).not.toBeNull();

    const byKey = Object.fromEntries((body.hosts ?? []).map((h) => [h.key, h]));

    expect(byKey["gda-aicenter"]).toMatchObject({ registered: true, env: "production", freshness: { state: "fresh" } });
    expect(byKey["sumopod"]).toMatchObject({ registered: true, env: "ops", freshness: { state: "stale" } });

    // Registered but never reported: appears as "never", not omitted.
    expect(byKey["planned-box"]).toMatchObject({
      registered: true,
      status: "onboarding",
      freshness: { state: "never", lastSampleAgeSeconds: null },
      host: null,
      targets: null,
      datastores: null,
    });

    // Series-only, no infra_hosts row: unregistered, visibly abnormal.
    expect(byKey["ghost-box"]).toMatchObject({ registered: false, env: null, status: null });

    expect(body.hosts).not.toContainEqual(expect.objectContaining({ key: "" }));
  });

  it("containersRunning is null-with-note for every host, never a coerced 0 (MON-09n)", async () => {
    const r = await app.inject({ method: "GET", url: "/api/admin/observability", headers: asUser(admin) });
    const body = r.json() as EstateObservabilitySnapshot;
    for (const h of body.hosts ?? []) {
      expect(h.containersRunning.value).toBeNull();
      expect(h.containersRunning.note).toMatch(/MON-09n/);
    }
  });

  it("targets/datastores distinguish measured-and-down from not-shipped", async () => {
    const r = await app.inject({ method: "GET", url: "/api/admin/observability", headers: asUser(admin) });
    const body = r.json() as EstateObservabilitySnapshot;
    const byKey = Object.fromEntries((body.hosts ?? []).map((h) => [h.key, h]));

    // gda-aicenter: one up target (node), one down (cadvisor).
    expect(byKey["gda-aicenter"].targets).toMatchObject({ up: 1, down: 1, downJobs: ["cadvisor"] });
    // gda-aicenter ships postgres (down) but no redis exporter -> redis is [] (measured none), not null.
    expect(byKey["gda-aicenter"].datastores?.postgres).toEqual([{ instance: "pg:5432", up: false }]);
    expect(byKey["gda-aicenter"].datastores?.redis).toEqual([]);
    // sumopod ships neither pg nor redis in this fixture -> datastores is null (nothing to measure).
    expect(byKey["sumopod"].datastores).toBeNull();
  });

  it("alerts come from Alertmanager: Watchdog excluded, silenced state visible, board totals split active/suppressed", async () => {
    const r = await app.inject({ method: "GET", url: "/api/admin/observability", headers: asUser(admin) });
    const body = r.json() as EstateObservabilitySnapshot;
    const names = (body.alerts ?? []).map((a) => a.name);
    expect(names).not.toContain("Watchdog");
    expect(names).toContain("DiskSpaceLow");
    const active = (body.alerts ?? []).find((a) => a.host === "gda-aicenter")!;
    const suppressed = (body.alerts ?? []).find((a) => a.host === "sumopod")!;
    expect(active.state).toBe("active");
    expect(suppressed.state).toBe("suppressed");
    expect(body.estate?.alertsActive).toBe(1);
    expect(body.estate?.alertsSuppressed).toBe(1);
  });

  it("legacy §20.1 fields are derived from the gda-aicenter row, for the one-release expand phase", async () => {
    const r = await app.inject({ method: "GET", url: "/api/admin/observability", headers: asUser(admin) });
    const body = r.json() as EstateObservabilitySnapshot;
    const gda = (body.hosts ?? []).find((h) => h.key === "gda-aicenter")!;
    expect(body.host).toEqual(gda.host);
    expect(body.targets).toEqual(gda.targets);
    expect(body.datastores).toEqual(gda.datastores);
  });

  it("PROMETHEUS_URL unset -> available:false, hosts/estate null, but Alertmanager still independently reachable", async () => {
    config.observability.prometheusUrl = "";
    const r = await app.inject({ method: "GET", url: "/api/admin/observability", headers: asUser(admin) });
    const body = r.json() as EstateObservabilitySnapshot;
    expect(body.available).toBe(false);
    expect(body.hosts).toBeNull();
    expect(body.estate).toBeNull();
    expect(body.reason).toContain("PROMETHEUS_URL");
    // Alertmanager is a SEPARATE upstream — an operator should still see current alerts.
    expect(body.alerts).not.toBeNull();
    config.observability.prometheusUrl = promBaseUrl;
  });

  it("ALERTMANAGER_URL unreachable -> alerts:null with a reason, but hosts/estate unaffected", async () => {
    config.observability.alertmanagerUrl = "http://127.0.0.1:1/unreachable";
    const r = await app.inject({ method: "GET", url: "/api/admin/observability", headers: asUser(admin) });
    const body = r.json() as EstateObservabilitySnapshot;
    expect(body.available).toBe(true);
    expect(body.hosts).not.toBeNull();
    expect(body.alerts).toBeNull();
    expect(body.alertsNote).toBeTruthy();
    expect(body.estate?.alertsActive).toBeNull();
    expect(body.estate?.alertsSuppressed).toBeNull();
    config.observability.alertmanagerUrl = amBaseUrl;
  });
});
