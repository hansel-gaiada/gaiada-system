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
  let coC: string;
  let clientA: string;
  let clientB: string;
  let clientC: string;
  let staff: string;
  let manager: string;
  let outsider: string;
  let managerC: string;
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

    // MON-19 — the SSRF allowlist floor. `viceroybali.com` is VERIFIED for coA/clientA, so an http
    // monitor targeting it must be accepted; anything else must be refused (constraint 2).
    await pool.query(
      `INSERT INTO search_properties (tenant_id, client_id, domain, site_url, verified_at)
       VALUES ($1,$2,'viceroybali.com','https://viceroybali.com', now())`, [coA, clientA]);

    // MON-19 cross-tenant write fixture — a SECOND company with the module enabled (unlike coB,
    // which deliberately lacks it and only proves the module gate). This is what lets the
    // cross-tenant write test prove the RLS wall specifically, rather than merely re-proving the
    // 404-when-module-off case already covered above.
    coC = await createCompany("Other Monitored Agency", ["monitoring"]);
    clientC = await createClient(coC, "Someone Else Entirely");
    managerC = await createUser("mon-mgr@c.test");
    await addMembership(coC, managerC);
    await grantRole(managerC, mgrRole, "company", coC);

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

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  // MON-19 — monitor create / update / delete.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("MON-19 — monitor write surface", () => {
    it("rejects an unknown kind with 400, not a silent accept", async () => {
      const res = await app.inject({
        method: "POST", url: `/api/${coA}/monitoring/monitors`, headers: asUser(staff),
        payload: { name: "bogus kind", kind: "not-a-kind", clientId: clientA, target: "https://viceroybali.com" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects a known kind with no registered driver — 'available:false' must not be silently accepted", async () => {
      // 'tcp' is a real KNOWN_KINDS member (registry.ts) but this suite never registers a driver for
      // it — exactly the "not built yet" state the UI's kind picker renders disabled.
      const res = await app.inject({
        method: "POST", url: `/api/${coA}/monitoring/monitors`, headers: asUser(staff),
        payload: { name: "tcp attempt", kind: "tcp", clientId: clientA, target: "viceroybali.com:443" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/no monitor driver/i);
    });

    it("refuses a target whose host is not a VERIFIED property — the SSRF floor at write time", async () => {
      const res = await app.inject({
        method: "POST", url: `/api/${coA}/monitoring/monitors`, headers: asUser(staff),
        payload: { name: "ssrf attempt", kind: "http", clientId: clientA, target: "https://evil.example/" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/not a verified property/i);
    });

    it("refuses even a private/metadata-looking host the same way — never a special-cased 500", async () => {
      const res = await app.inject({
        method: "POST", url: `/api/${coA}/monitoring/monitors`, headers: asUser(staff),
        payload: { name: "metadata attempt", kind: "http", clientId: clientA, target: "http://169.254.169.254/" },
      });
      expect(res.statusCode).toBe(400);
    });

    let createdMonitorId: string;

    it("creates an http monitor for a verified target, and the write is readable back through the same scope", async () => {
      const res = await app.inject({
        method: "POST", url: `/api/${coA}/monitoring/monitors`, headers: asUser(staff),
        payload: {
          name: "viceroybali.com — homepage", kind: "http", clientId: clientA,
          target: "https://viceroybali.com/", intervalSec: 45, severity: "ticket",
        },
      });
      expect(res.statusCode).toBeLessThan(300);
      createdMonitorId = res.json().id;
      expect(createdMonitorId).toBeTruthy();

      const got = await app.inject({
        method: "GET", url: `/api/${coA}/monitoring/monitors/${createdMonitorId}`, headers: asUser(staff),
      });
      expect(got.statusCode).toBe(200);
      const body = got.json() as { kind: string; intervalSec: number; config: unknown };
      expect(body.kind).toBe("http");
      expect(body.intervalSec).toBe(45);
      // The detail read path redacts config regardless of who created it.
      expect(body.config).toBeNull();
    });

    it("creates a keyword monitor carrying the body_contains assertion inside its driver config", async () => {
      const res = await app.inject({
        method: "POST", url: `/api/${coA}/monitoring/monitors`, headers: asUser(staff),
        payload: {
          name: "viceroybali.com — content check", kind: "keyword", clientId: clientA,
          target: "https://viceroybali.com/", assertions: [{ type: "body_contains", expr: "Book a table" }],
        },
      });
      expect(res.statusCode).toBeLessThan(300);
      const row = await adminPool().query<{ config: { expect?: string } }>(
        `SELECT config FROM monitors WHERE id = $1`, [res.json().id]);
      expect(row.rows[0].config.expect).toBe("Book a table");
    });

    it("a keyword monitor with no assertion is refused by the driver's OWN validate(), not silently accepted", async () => {
      const res = await app.inject({
        method: "POST", url: `/api/${coA}/monitoring/monitors`, headers: asUser(staff),
        payload: { name: "content check, no assertion", kind: "keyword", clientId: clientA, target: "https://viceroybali.com/" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("creates a heartbeat monitor, issuing a one-time plaintext token that is never stored in clear", async () => {
      const res = await app.inject({
        method: "POST", url: `/api/${coA}/monitoring/monitors`, headers: asUser(staff),
        payload: { name: "nightly export job", kind: "heartbeat", clientId: clientA },
      });
      expect(res.statusCode).toBeLessThan(300);
      const body = res.json() as { id: string; heartbeatToken: string };
      expect(body.heartbeatToken).toBeTruthy();

      const row = await adminPool().query<{ token_hash: string }>(
        `SELECT token_hash FROM monitor_heartbeats WHERE monitor_id = $1`, [body.id]);
      expect(row.rows[0].token_hash).not.toBe(body.heartbeatToken);
      expect(row.rows[0].token_hash).toBe(createHash("sha256").update(body.heartbeatToken).digest("hex"));

      // The minted token actually works against the real (unauthenticated) ingest endpoint.
      const ping = await app.inject({ method: "POST", url: `/api/monitoring/heartbeat/${body.heartbeatToken}` });
      expect(ping.statusCode).toBeLessThan(300);
    });

    it("clientId must belong to this tenant", async () => {
      const res = await app.inject({
        method: "POST", url: `/api/${coA}/monitoring/monitors`, headers: asUser(staff),
        payload: { name: "wrong client", kind: "http", clientId: clientB, target: "https://viceroybali.com/" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("updates name, interval and severity, re-validating the target on every write", async () => {
      const res = await app.inject({
        method: "PATCH", url: `/api/${coA}/monitoring/monitors/${createdMonitorId}`, headers: asUser(staff),
        payload: { name: "viceroybali.com — homepage (renamed)", intervalSec: 90, severity: "page" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { name: string; intervalSec: number; severity: string };
      expect(body.name).toBe("viceroybali.com — homepage (renamed)");
      expect(body.intervalSec).toBe(90);
      expect(body.severity).toBe("page");
    });

    it("refuses to re-target a monitor onto an unverified host, even on update", async () => {
      const res = await app.inject({
        method: "PATCH", url: `/api/${coA}/monitoring/monitors/${createdMonitorId}`, headers: asUser(staff),
        payload: { target: "https://evil.example/" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("refuses to change kind after creation", async () => {
      const res = await app.inject({
        method: "PATCH", url: `/api/${coA}/monitoring/monitors/${createdMonitorId}`, headers: asUser(staff),
        payload: { kind: "keyword" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("company C (a DIFFERENT tenant with the module enabled) cannot update company A's monitor — RLS, not just Cerbos", async () => {
      // managerC is authorized to update MONITORS IN THEIR OWN TENANT (coC) — Cerbos's decision does
      // not depend on the target row. RLS is what must refuse this, exactly like the read suite's
      // cross-tenant assertion above, restated for a write.
      const res = await app.inject({
        method: "PATCH", url: `/api/${coC}/monitoring/monitors/${createdMonitorId}`, headers: asUser(managerC),
        payload: { name: "hijacked" },
      });
      expect(res.statusCode).toBe(404);
      const row = await adminPool().query(`SELECT name FROM monitors WHERE id = $1`, [createdMonitorId]);
      expect(row.rows[0].name).not.toBe("hijacked");
    });

    it("company C cannot delete company A's monitor either", async () => {
      const res = await app.inject({
        method: "DELETE", url: `/api/${coC}/monitoring/monitors/${createdMonitorId}`, headers: asUser(managerC),
      });
      expect(res.statusCode).toBe(404);
      const row = await adminPool().query(`SELECT deleted_at FROM monitors WHERE id = $1`, [createdMonitorId]);
      expect(row.rows[0].deleted_at).toBeNull();
    });

    it("monitoring_staff cannot delete — delete is manager-tier (destroys history)", async () => {
      const res = await app.inject({
        method: "DELETE", url: `/api/${coA}/monitoring/monitors/${createdMonitorId}`, headers: asUser(staff),
      });
      expect(res.statusCode).toBe(403);
    });

    it("a manager CAN delete — soft delete: deleted_at is set, the row and its result history survive", async () => {
      const res = await app.inject({
        method: "DELETE", url: `/api/${coA}/monitoring/monitors/${createdMonitorId}`, headers: asUser(manager),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { id: string; deletedAt: string };
      expect(body.deletedAt).toBeTruthy();

      // Gone from the active board...
      const got = await app.inject({
        method: "GET", url: `/api/${coA}/monitoring/monitors/${createdMonitorId}`, headers: asUser(staff),
      });
      expect(got.statusCode).toBe(404);

      // ...but the row itself, and its history, still physically exist — this is SOFT delete.
      const row = await adminPool().query(
        `SELECT deleted_at, enabled FROM monitors WHERE id = $1`, [createdMonitorId]);
      expect(row.rows[0].deleted_at).not.toBeNull();
      expect(row.rows[0].enabled).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  // MON-20 — incident acknowledge: an accountability record, not an edit, not a close.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("MON-20 — incident acknowledge", () => {
    it("staff can acknowledge an open incident, recording who and when", async () => {
      const openIncident = await adminPool().query<{ id: string }>(
        `SELECT id FROM monitor_incidents WHERE monitor_id = $1 AND closed_at IS NULL LIMIT 1`, [monitorA]);
      const incidentId = openIncident.rows[0].id;

      const res = await app.inject({
        method: "POST", url: `/api/${coA}/monitoring/incidents/${incidentId}/ack`, headers: asUser(staff),
      });
      expect(res.statusCode).toBeLessThan(300);
      const body = res.json() as { acknowledgedAt: string; acknowledgedBy: string };
      expect(body.acknowledgedAt).toBeTruthy();
      expect(body.acknowledgedBy).toBe(staff);

      // Not an edit and not a close: severity/cause/closed_at are all untouched by acknowledging.
      const row = await adminPool().query(
        `SELECT closed_at, severity, cause FROM monitor_incidents WHERE id = $1`, [incidentId]);
      expect(row.rows[0].closed_at).toBeNull();
      expect(row.rows[0].severity).toBe("page");
      expect(row.rows[0].cause).toBe("connect: refused");
    });

    it("re-acknowledging by someone else does NOT reassign the claim — first person wins", async () => {
      const openIncident = await adminPool().query<{ id: string }>(
        `SELECT id FROM monitor_incidents WHERE monitor_id = $1 AND closed_at IS NULL LIMIT 1`, [monitorA]);
      const incidentId = openIncident.rows[0].id;

      const res = await app.inject({
        method: "POST", url: `/api/${coA}/monitoring/incidents/${incidentId}/ack`, headers: asUser(manager),
      });
      expect(res.statusCode).toBeLessThan(300);
      const body = res.json() as { acknowledgedBy: string };
      // Still the ORIGINAL claimant (staff), not manager — an accountability record is not
      // overwritable by whoever happens to click it next.
      expect(body.acknowledgedBy).toBe(staff);
    });

    it("company C cannot acknowledge company A's incident — 404, RLS-invisible", async () => {
      const openIncident = await adminPool().query<{ id: string }>(
        `SELECT id FROM monitor_incidents WHERE monitor_id = $1 AND closed_at IS NULL LIMIT 1`, [monitorA]);
      const incidentId = openIncident.rows[0].id;

      const res = await app.inject({
        method: "POST", url: `/api/${coC}/monitoring/incidents/${incidentId}/ack`, headers: asUser(managerC),
      });
      expect(res.statusCode).toBe(404);
    });

    it("an unknown incident id is 404", async () => {
      const res = await app.inject({
        method: "POST", url: `/api/${coA}/monitoring/incidents/00000000-0000-0000-0000-000000000000/ack`,
        headers: asUser(staff),
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  // Channel / route / maintenance management — the missing middle that lets a tenant fill
  // monitor_channels/monitor_routes without hand-SQL, so runner.ts:293-345 has somewhere to fan an
  // incident out to.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("results by window", () => {
    it("returns results within the requested window, defaulting to 24h", async () => {
      const res = await app.inject({
        method: "GET", url: `/api/${coA}/monitoring/monitors/${monitorA}/results`, headers: asUser(staff),
      });
      expect(res.statusCode).toBe(200);
      const rows = res.json() as { checkedAt: string; status: string }[];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0].status).toBe("down");
    });

    it("accepts 7d and 30d explicitly", async () => {
      for (const window of ["7d", "30d"]) {
        const res = await app.inject({
          method: "GET", url: `/api/${coA}/monitoring/monitors/${monitorA}/results?window=${window}`,
          headers: asUser(staff),
        });
        expect(res.statusCode).toBe(200);
      }
    });

    it("an unrecognised window is a 400, not a silent fallback", async () => {
      const res = await app.inject({
        method: "GET", url: `/api/${coA}/monitoring/monitors/${monitorA}/results?window=1y`,
        headers: asUser(staff),
      });
      expect(res.statusCode).toBe(400);
    });

    it("an unknown monitor id is 404", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/${coA}/monitoring/monitors/00000000-0000-0000-0000-000000000000/results`,
        headers: asUser(staff),
      });
      expect(res.statusCode).toBe(404);
    });

    it("company C cannot read company A's monitor results — RLS, not just Cerbos", async () => {
      const res = await app.inject({
        method: "GET", url: `/api/${coC}/monitoring/monitors/${monitorA}/results`, headers: asUser(managerC),
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("channels — the delivery targets runner.ts fans incidents out to", () => {
    let channelId: string;

    it("monitoring_staff cannot create a channel — manage is manager-tier", async () => {
      const res = await app.inject({
        method: "POST", url: `/api/${coA}/monitoring/channels`, headers: asUser(staff),
        payload: { kind: "email", name: "ops pager", destination: "ops@viceroybali.com" },
      });
      expect(res.statusCode).toBe(403);
    });

    it("rejects an unknown channel kind with 400", async () => {
      const res = await app.inject({
        method: "POST", url: `/api/${coA}/monitoring/channels`, headers: asUser(manager),
        payload: { kind: "carrier-pigeon", name: "bad kind" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("an email channel requires a plausible destination", async () => {
      const noDest = await app.inject({
        method: "POST", url: `/api/${coA}/monitoring/channels`, headers: asUser(manager),
        payload: { kind: "email", name: "no destination" },
      });
      expect(noDest.statusCode).toBe(400);

      const badDest = await app.inject({
        method: "POST", url: `/api/${coA}/monitoring/channels`, headers: asUser(manager),
        payload: { kind: "email", name: "bad destination", destination: "not-an-email" },
      });
      expect(badDest.statusCode).toBe(400);
    });

    it("a manager creates an email channel, and staff can read it back", async () => {
      const res = await app.inject({
        method: "POST", url: `/api/${coA}/monitoring/channels`, headers: asUser(manager),
        payload: { kind: "email", name: "ops pager", destination: "ops@viceroybali.com" },
      });
      expect(res.statusCode).toBeLessThan(300);
      channelId = res.json().id;
      expect(channelId).toBeTruthy();

      const list = await app.inject({
        method: "GET", url: `/api/${coA}/monitoring/channels`, headers: asUser(staff),
      });
      expect(list.statusCode).toBe(200);
      const rows = list.json() as { id: string; kind: string; destination: string | null; enabled: boolean }[];
      const row = rows.find((r) => r.id === channelId);
      expect(row?.kind).toBe("email");
      expect(row?.destination).toBe("ops@viceroybali.com");
      expect(row?.enabled).toBe(true);
    });

    it("a non-email channel can be created even with no wired driver — 'absent, not silently inert'", async () => {
      const res = await app.inject({
        method: "POST", url: `/api/${coA}/monitoring/channels`, headers: asUser(manager),
        payload: { kind: "webhook", name: "n8n hook", destination: "https://n8n.example/webhook/abc…" },
      });
      expect(res.statusCode).toBeLessThan(300);
    });

    it("staff cannot update a channel", async () => {
      const res = await app.inject({
        method: "PATCH", url: `/api/${coA}/monitoring/channels/${channelId}`, headers: asUser(staff),
        payload: { name: "renamed" },
      });
      expect(res.statusCode).toBe(403);
    });

    it("a manager can update name/destination/enabled", async () => {
      const res = await app.inject({
        method: "PATCH", url: `/api/${coA}/monitoring/channels/${channelId}`, headers: asUser(manager),
        payload: { name: "ops pager (renamed)", enabled: false },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { name: string; enabled: boolean };
      expect(body.name).toBe("ops pager (renamed)");
      expect(body.enabled).toBe(false);

      // Put it back enabled for the routes/test-send suites below.
      const reEnable = await app.inject({
        method: "PATCH", url: `/api/${coA}/monitoring/channels/${channelId}`, headers: asUser(manager),
        payload: { enabled: true },
      });
      expect(reEnable.statusCode).toBe(200);
    });

    it("company C cannot update company A's channel — RLS", async () => {
      const res = await app.inject({
        method: "PATCH", url: `/api/${coC}/monitoring/channels/${channelId}`, headers: asUser(managerC),
        payload: { name: "hijacked" },
      });
      expect(res.statusCode).toBe(404);
    });

    describe("test-send — a REAL notification through enqueueMail(\"monitoring.alert\")", () => {
      const savedMailEnabled = config.mail.enabled;
      beforeAll(() => { config.mail.enabled = true; });
      afterAll(() => { config.mail.enabled = savedMailEnabled; });

      it("sends through the exact template path runner.ts's notifyIncidents uses", async () => {
        const before = await adminPool().query<{ n: string }>(
          `SELECT count(*)::text AS n FROM mail_log WHERE template_key = 'monitoring.alert' AND tenant_id = $1`,
          [coA],
        );
        const res = await app.inject({
          method: "POST", url: `/api/${coA}/monitoring/channels/${channelId}/test`, headers: asUser(manager),
        });
        // NestJS's default success code for @Post is 201, not 200 — same convention every other
        // POST assertion in this file already follows (createMonitor et al. use toBeLessThan(300)).
        expect(res.statusCode).toBeLessThan(300);
        expect(res.json()).toEqual({ ok: true });

        const after = await adminPool().query<{ n: string }>(
          `SELECT count(*)::text AS n FROM mail_log WHERE template_key = 'monitoring.alert' AND tenant_id = $1`,
          [coA],
        );
        expect(Number(after.rows[0].n)).toBe(Number(before.rows[0].n) + 1);

        // Never a leak of the destination into anything the test can observe beyond the row that
        // legitimately carries it (mail_log.to_email) — the HTTP response carries only {ok:true}.
        const row = await adminPool().query<{ to_email: string }>(
          `SELECT to_email FROM mail_log WHERE template_key = 'monitoring.alert' AND tenant_id = $1
            ORDER BY id DESC LIMIT 1`,
          [coA],
        );
        expect(row.rows[0].to_email).toBe("ops@viceroybali.com");
      });

      it("staff cannot trigger a test-send — manage is manager-tier", async () => {
        const res = await app.inject({
          method: "POST", url: `/api/${coA}/monitoring/channels/${channelId}/test`, headers: asUser(staff),
        });
        expect(res.statusCode).toBe(403);
      });

      it("refuses to test a channel kind with no wired driver, rather than reporting a fake ok", async () => {
        const webhook = await adminPool().query<{ id: string }>(
          `SELECT id FROM monitor_channels WHERE tenant_id = $1 AND kind = 'webhook' LIMIT 1`, [coA],
        );
        const res = await app.inject({
          method: "POST", url: `/api/${coA}/monitoring/channels/${webhook.rows[0].id}/test`, headers: asUser(manager),
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toMatch(/no notification driver/i);
      });
    });

    it("a manager can delete (soft) a channel, and it disappears from the active list", async () => {
      const disposable = await app.inject({
        method: "POST", url: `/api/${coA}/monitoring/channels`, headers: asUser(manager),
        payload: { kind: "email", name: "disposable channel", destination: "throwaway@viceroybali.com" },
      });
      const disposableId = disposable.json().id;

      const del = await app.inject({
        method: "DELETE", url: `/api/${coA}/monitoring/channels/${disposableId}`, headers: asUser(manager),
      });
      expect(del.statusCode).toBe(200);
      expect(del.json().deletedAt).toBeTruthy();

      const list = await app.inject({
        method: "GET", url: `/api/${coA}/monitoring/channels`, headers: asUser(staff),
      });
      expect((list.json() as { id: string }[]).map((r) => r.id)).not.toContain(disposableId);
    });
  });

  describe("routes — a channel's own routing table", () => {
    let channelId: string;
    let routeId: string;

    beforeAll(async () => {
      const res = await app.inject({
        method: "POST", url: `/api/${coA}/monitoring/channels`, headers: asUser(manager),
        payload: { kind: "email", name: "routes-suite channel", destination: "routes-suite@viceroybali.com" },
      });
      channelId = res.json().id;
    });

    it("an unknown channelId is a 400, not a silently accepted orphan route", async () => {
      const res = await app.inject({
        method: "POST", url: `/api/${coA}/monitoring/routes`, headers: asUser(manager),
        payload: { channelId: "00000000-0000-0000-0000-000000000000" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects an invalid matchSeverity with 400", async () => {
      const res = await app.inject({
        method: "POST", url: `/api/${coA}/monitoring/routes`, headers: asUser(manager),
        payload: { channelId, matchSeverity: "urgent" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("a manager creates a severity-filtered route, and staff can read it", async () => {
      const res = await app.inject({
        method: "POST", url: `/api/${coA}/monitoring/routes`, headers: asUser(manager),
        payload: { channelId, matchSeverity: "page" },
      });
      expect(res.statusCode).toBeLessThan(300);
      routeId = res.json().id;

      const list = await app.inject({
        method: "GET", url: `/api/${coA}/monitoring/routes`, headers: asUser(staff),
      });
      expect(list.statusCode).toBe(200);
      const rows = list.json() as { id: string; channelId: string; matchSeverity: string | null }[];
      const row = rows.find((r) => r.id === routeId);
      expect(row?.channelId).toBe(channelId);
      expect(row?.matchSeverity).toBe("page");
    });

    it("staff cannot create a route", async () => {
      const res = await app.inject({
        method: "POST", url: `/api/${coA}/monitoring/routes`, headers: asUser(staff),
        payload: { channelId },
      });
      expect(res.statusCode).toBe(403);
    });

    it("a manager updates the match filter", async () => {
      const res = await app.inject({
        method: "PATCH", url: `/api/${coA}/monitoring/routes/${routeId}`, headers: asUser(manager),
        payload: { matchSeverity: "ticket", matchKind: "http" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { matchSeverity: string | null; matchKind: string | null };
      expect(body.matchSeverity).toBe("ticket");
      expect(body.matchKind).toBe("http");
    });

    it("company C cannot delete company A's route — RLS", async () => {
      const res = await app.inject({
        method: "DELETE", url: `/api/${coC}/monitoring/routes/${routeId}`, headers: asUser(managerC),
      });
      expect(res.statusCode).toBe(404);
    });

    it("a manager deletes the route, and it is gone (hard delete — no deleted_at column)", async () => {
      const res = await app.inject({
        method: "DELETE", url: `/api/${coA}/monitoring/routes/${routeId}`, headers: asUser(manager),
      });
      expect(res.statusCode).toBe(200);

      const row = await adminPool().query(`SELECT id FROM monitor_routes WHERE id = $1`, [routeId]);
      expect(row.rows[0]).toBeUndefined();
    });
  });

  describe("maintenance — the one write that can make monitoring lie (K7)", () => {
    it("monitoring_staff cannot schedule a window — create is manager-tier", async () => {
      const res = await app.inject({
        method: "POST", url: `/api/${coA}/monitoring/maintenance`, headers: asUser(staff),
        payload: { scope: "all", startsAt: "2026-09-10T00:00:00Z", endsAt: "2026-09-10T02:00:00Z" },
      });
      expect(res.statusCode).toBe(403);
    });

    it("rejects an inverted window with 400, not a constraint-violation 500", async () => {
      const res = await app.inject({
        method: "POST", url: `/api/${coA}/monitoring/maintenance`, headers: asUser(manager),
        payload: { scope: "all", startsAt: "2026-09-10T02:00:00Z", endsAt: "2026-09-10T00:00:00Z" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects a malformed scope string with 400", async () => {
      const res = await app.inject({
        method: "POST", url: `/api/${coA}/monitoring/maintenance`, headers: asUser(manager),
        payload: { scope: "everything", startsAt: "2026-09-10T00:00:00Z", endsAt: "2026-09-10T02:00:00Z" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects a scope naming a monitor outside this tenant", async () => {
      const res = await app.inject({
        method: "POST", url: `/api/${coA}/monitoring/maintenance`, headers: asUser(manager),
        payload: { scope: `monitor:${monitorB}`, startsAt: "2026-09-10T00:00:00Z", endsAt: "2026-09-10T02:00:00Z" },
      });
      expect(res.statusCode).toBe(400);
    });

    let windowId: string;

    it("a manager schedules a monitor-scoped window, and it round-trips through GET", async () => {
      const res = await app.inject({
        method: "POST", url: `/api/${coA}/monitoring/maintenance`, headers: asUser(manager),
        payload: {
          scope: `monitor:${monitorA}`, startsAt: "2026-09-10T00:00:00Z", endsAt: "2026-09-10T02:00:00Z",
          reason: "planned upgrade",
        },
      });
      expect(res.statusCode).toBeLessThan(300);
      windowId = res.json().id;
      expect(windowId).toBeTruthy();

      const list = await app.inject({
        method: "GET", url: `/api/${coA}/monitoring/maintenance`, headers: asUser(staff),
      });
      const rows = list.json() as { id: string; scope: string; reason: string | null }[];
      const row = rows.find((r) => r.id === windowId);
      expect(row?.scope).toBe(`monitor:${monitorA}`);
      expect(row?.reason).toBe("planned upgrade");
    });

    it("staff cannot cancel a window — delete is manager-tier", async () => {
      const res = await app.inject({
        method: "DELETE", url: `/api/${coA}/monitoring/maintenance/${windowId}`, headers: asUser(staff),
      });
      expect(res.statusCode).toBe(403);
    });

    it("company C cannot cancel company A's window — RLS", async () => {
      const res = await app.inject({
        method: "DELETE", url: `/api/${coC}/monitoring/maintenance/${windowId}`, headers: asUser(managerC),
      });
      expect(res.statusCode).toBe(404);
    });

    it("a manager cancels the window early, and it is gone", async () => {
      const res = await app.inject({
        method: "DELETE", url: `/api/${coA}/monitoring/maintenance/${windowId}`, headers: asUser(manager),
      });
      expect(res.statusCode).toBe(200);

      const row = await adminPool().query(`SELECT id FROM monitor_maintenance WHERE id = $1`, [windowId]);
      expect(row.rows[0]).toBeUndefined();
    });
  });
});
