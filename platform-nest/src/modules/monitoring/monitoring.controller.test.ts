// MON-12/13 — the monitoring HTTP surface against a REAL database with REAL RLS and REAL Cerbos.
//
// Why this file matters more than its size suggests: every other monitoring suite is pure. These are
// the only assertions that exercise the third wall (`app_module_allowed`), the tenant predicate, and
// the Cerbos decisions together — which is exactly where a handler can look correct and return
// nothing, or worse, return another tenant's rows.
//
// ⚠ `describe.skipIf(!TEST_URL)` means this suite SKIPS SILENTLY without DATABASE_URL_TEST. Check the
// skip count before believing a green run: "0 failed" with everything skipped is the estate's most
// reliable way to feel safe while proving nothing.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { resetModules, registerModule } from "../registry";
import { buildApp } from "../../main";
import { monitoringModule } from "./index";
import { resetDrivers, registerDriver } from "./drivers/registry";
import { heartbeatDriver } from "./drivers/heartbeat";
import { httpDriver, keywordDriver } from "./drivers/http";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient } from "../../testing/fixtures";
import { createHash } from "node:crypto";

describe.skipIf(!TEST_URL)("monitoring module — live RLS + Cerbos", () => {
  let app: NestFastifyApplication;
  let coA: string;
  let coB: string;
  let clientA: string;
  let clientB: string;
  let staff: string;
  let manager: string;
  let outsider: string;
  let monitorA: string;
  let monitorB: string;
  let hbToken: string;
  const svc = { authorization: "Bearer svc-token" };
  const asUser = (id: string) => ({ ...svc, "x-user-id": id });


  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetDrivers();
    registerModule(monitoringModule);
    registerDriver(httpDriver);
    registerDriver(keywordDriver);
    registerDriver(heartbeatDriver);

    // Company A has the module; company B deliberately does NOT — that is the module-gate assertion.
    coA = await createCompany("Monitored Agency", ["monitoring"]);
    coB = await createCompany("Unmonitored Co");
    clientA = await createClient(coA, "Viceroy Bali");
    clientB = await createClient(coB, "Someone Else");

    staff = await createUser("mon-staff@a.test");
    manager = await createUser("mon-mgr@a.test");
    outsider = await createUser("outsider@b.test");
    await addMembership(coA, staff);
    await addMembership(coA, manager);
    await addMembership(coB, outsider);

    const staffRole = await createRole("monitoring_staff");
    const mgrRole = await createRole("monitoring_manager");
    await grantRole(staff, staffRole, "company", coA);
    await grantRole(manager, mgrRole, "company", coA);

    // Seeded directly: the write API is MON-19, so the read paths are what is under test here.
    const pool = adminPool();
    const a = await pool.query(
      `INSERT INTO monitors (tenant_id, client_id, name, kind, target, status, severity, interval_sec, last_checked_at)
       VALUES ($1,$2,'viceroybali.com','http','https://viceroybali.com','down','page',60, now())
       RETURNING id`, [coA, clientA]);
    monitorA = a.rows[0].id;
    const b = await pool.query(
      `INSERT INTO monitors (tenant_id, client_id, name, kind, target, status, severity, interval_sec)
       VALUES ($1,$2,'other-tenant.com','http','https://other.com','up','ticket',60) RETURNING id`,
      [coB, clientB]);
    monitorB = b.rows[0].id;
    await pool.query(
      `INSERT INTO monitor_incidents (tenant_id, client_id, monitor_id, cause, severity)
       VALUES ($1,$2,$3,'connect: refused','page')`, [coA, clientA, monitorA]);
    await pool.query(
      `INSERT INTO monitor_results (tenant_id, client_id, monitor_id, status, latency_ms)
       VALUES ($1,$2,$3,'down',NULL)`, [coA, clientA, monitorA]);

    // Heartbeat: the token is stored ONLY as a hash, so the test must hash it the same way.
    hbToken = "probe-token-abc123";
    const hbMonitor = await pool.query(
      `INSERT INTO monitors (tenant_id, client_id, name, kind, status, severity, interval_sec)
       VALUES ($1,$2,'nightly sweep','heartbeat','down','page',86400) RETURNING id`, [coA, clientA]);
    await pool.query(
      `INSERT INTO monitor_heartbeats (tenant_id, client_id, monitor_id, token_hash, grace_sec)
       VALUES ($1,$2,$3,$4,300)`,
      [coA, clientA, hbMonitor.rows[0].id, createHash("sha256").update(hbToken).digest("hex")]);
    await pool.query(
      `INSERT INTO monitor_incidents (tenant_id, client_id, monitor_id, cause, severity)
       VALUES ($1,$2,$3,'no heartbeat','page')`, [coA, clientA, hbMonitor.rows[0].id]);

    app = await buildApp();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  it("staff can read the board, and sees ONLY their own tenant's monitors", async () => {
    const res = await app.inject({ method: "GET", url: `/api/${coA}/monitoring/monitors`, headers: asUser(staff) });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as { id: string; name: string; clientName: string | null }[];
    const names = rows.map((r) => r.name);
    expect(names).toContain("viceroybali.com");
    // The cross-tenant assertion. RLS is the authority; this proves it rather than trusting it.
    expect(names).not.toContain("other-tenant.com");
    expect(rows.find((r) => r.name === "viceroybali.com")?.clientName).toBe("Viceroy Bali");
  });

  it("uptime distinguishes 'measured 0%' from 'never measured' (MON-12d)", async () => {
    // The distinction the whole figure rests on. Both rows below would be `0` under a naive
    // aggregate, and one of them would then be a fabricated claim of a total outage.
    const res = await app.inject({ method: "GET", url: `/api/${coA}/monitoring/monitors`, headers: asUser(staff) });
    const rows = res.json() as { name: string; uptime24h: number | null; uptime30d: number | null }[];

    // Has exactly one result row, status 'down' -> genuinely 0% over the window. A real measurement.
    const measured = rows.find((r) => r.name === "viceroybali.com");
    expect(measured?.uptime24h).toBe(0);

    // Has NO result rows at all -> null, which the UI prints as "—". Never 0, never 100%.
    const unmeasured = rows.find((r) => r.name === "nightly sweep");
    expect(unmeasured?.uptime24h).toBeNull();
    expect(unmeasured?.uptime30d).toBeNull();
  });

  it("a tenant WITHOUT the module gets 404, not an empty green summary", async () => {
    // The distinction the UI depends on: 404 => "backend not connected", which it says out loud.
    // A zeroed 200 would render as a healthy all-clear, which is the Nexus failure exactly.
    const res = await app.inject({ method: "GET", url: `/api/${coB}/monitoring/summary`, headers: asUser(outsider) });
    expect(res.statusCode).toBe(404);
  });

  it("summary counts only this tenant and reports lastSweepAt honestly", async () => {
    const res = await app.inject({ method: "GET", url: `/api/${coA}/monitoring/summary`, headers: asUser(staff) });
    expect(res.statusCode).toBe(200);
    const s = res.json() as { total: number; down: number; openIncidents: number; lastSweepAt: string | null };
    expect(s.total).toBe(2); // the http monitor + the heartbeat monitor, NOT company B's
    expect(s.down).toBe(2);
    expect(s.openIncidents).toBe(2);
    expect(s.lastSweepAt).not.toBeNull(); // a result row exists, so this must be a real timestamp
  });

  it("detail returns results and incidents, and REDACTS config", async () => {
    const res = await app.inject({ method: "GET", url: `/api/${coA}/monitoring/monitors/${monitorA}`, headers: asUser(staff) });
    expect(res.statusCode).toBe(200);
    const d = res.json() as { results: unknown[]; incidents: unknown[]; config: unknown };
    expect(d.results.length).toBeGreaterThan(0);
    expect(d.incidents.length).toBeGreaterThan(0);
    // config can hold secret REFERENCES and monitoring.read is a broad grant.
    expect(d.config).toBeNull();
  });

  it("another tenant's monitor is a 404 by id, not a leak", async () => {
    const res = await app.inject({ method: "GET", url: `/api/${coA}/monitoring/monitors/${monitorB}`, headers: asUser(staff) });
    expect(res.statusCode).toBe(404);
  });

  it("an unknown kind filter is a 400, not a silent empty list", async () => {
    // [] would look like "no monitors of that type" and hide the typo.
    const res = await app.inject({
      method: "GET", url: `/api/${coA}/monitoring/monitors?kind=htttp`, headers: asUser(staff),
    });
    expect(res.statusCode).toBe(400);
  });

  it("kinds comes from the driver registry, marking unavailable rather than hiding", async () => {
    const res = await app.inject({ method: "GET", url: `/api/${coA}/monitoring/kinds`, headers: asUser(staff) });
    const kinds = res.json() as { kind: string; available: boolean }[];
    expect(kinds.find((k) => k.kind === "http")?.available).toBe(true);
    // Registered nothing for steam, so it must be present-but-unavailable, never omitted.
    expect(kinds.find((k) => k.kind === "steam")?.available).toBe(false);
  });

  it("an outsider cannot read company A even by naming its tenant id", async () => {
    const res = await app.inject({ method: "GET", url: `/api/${coA}/monitoring/monitors`, headers: asUser(outsider) });
    expect([403, 404]).toContain(res.statusCode);
  });

  describe("heartbeat ingest — unauthenticated by design", () => {
    it("accepts a valid token with NO session, records liveness and CLOSES the incident", async () => {
      const before = await adminPool().query(
        `SELECT count(*)::int AS n FROM monitor_incidents WHERE tenant_id=$1 AND closed_at IS NULL`, [coA]);
      const res = await app.inject({ method: "POST", url: `/api/monitoring/heartbeat/${hbToken}` });
      expect(res.statusCode).toBeLessThan(300);
      const after = await adminPool().query(
        `SELECT count(*)::int AS n FROM monitor_incidents WHERE tenant_id=$1 AND closed_at IS NULL`, [coA]);
      // The ping IS the recovery signal, so it must resolve the open incident by itself.
      expect(after.rows[0].n).toBe(before.rows[0].n - 1);
      const m = await adminPool().query(
        `SELECT status FROM monitors WHERE kind='heartbeat' AND tenant_id=$1`, [coA]);
      expect(m.rows[0].status).toBe("up");
    });

    it("answers the SAME for a bad token — never an enumeration oracle", async () => {
      const good = await app.inject({ method: "POST", url: `/api/monitoring/heartbeat/${hbToken}` });
      const bad = await app.inject({ method: "POST", url: `/api/monitoring/heartbeat/definitely-not-a-token` });
      // A 404 on a bad token would let an attacker enumerate valid ones.
      expect(bad.statusCode).toBe(good.statusCode);
    });
  });
});
