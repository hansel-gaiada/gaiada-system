// CH — runSweep()'s incident fan-out (notifyIncidents, runner.ts:293-385) against REAL RLS, proving
// `monitor_channels.last_delivery_at`/`last_delivery_ok`/`failure_count` are ACTUALLY written now.
//
// Before this ticket the columns existed (0116) and were already SELECTed by the controller, but
// NOTHING wrote them — every channel read "unused" forever, even seconds after a real send. This
// file exists because that defect could not have been caught by a pure test: `runner.test.ts` never
// touches a database, and the controller's own `channels/:id/test` suite only proved the OTHER
// writer (see monitoring.controller.test.ts's "test-send" describe block for that half).
//
// A heartbeat monitor is used deliberately, same reason runner-sweep.db.test.ts uses it: its probe
// is a pure function of (lastSeenAt, graceSec, now) with NO network involved, so a monitor can be
// forced "down" (and, on a later sweep, back "up") by writing `monitor_heartbeats.last_seen_at`
// directly — hermetic, no egress, no timeouts, no flakes.
//
// ⚠ Needs DATABASE_URL_TEST. Skips silently without it.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runSweep } from "./runner";
import { resetDrivers, registerDriver } from "./drivers/registry";
import { heartbeatDriver } from "./drivers/heartbeat";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createClient } from "../../testing/fixtures";
import { newId } from "../../db";
import { config } from "../../config";

describe.skipIf(!TEST_URL)("CH · notifyIncidents writes monitor_channels health columns", () => {
  let tenantId: string;
  let clientId: string;
  let okMonitorId: string;
  let okChannelId: string;
  let failMonitorId: string;
  let failChannelId: string;
  const savedMailEnabled = config.mail.enabled;

  beforeAll(async () => {
    await initTestDb();
    resetDrivers();
    registerDriver(heartbeatDriver);
    config.mail.enabled = true;

    tenantId = await createCompany("Notify Delivery Co", ["monitoring"]);
    clientId = await createClient(tenantId, "Notify Delivery Client");

    const pool = adminPool();

    // Two independent monitor/channel/route triples, kept apart by `severity` so each event's
    // catch-all-except-severity route matches exactly ONE channel — otherwise a single catch-all
    // route would fan BOTH events out to BOTH channels and the success/failure assertions below
    // would contaminate each other.
    // ⚠ `monitor_heartbeats.grace_sec` is SELECTED by runner.ts's DUE_SELECT (as `hb_grace_sec`) but
    // never actually passed to the driver — `ctx.heartbeat` only carries `{lastSeenAt, now}`
    // (runner.ts around the `heartbeat:` ctx literal), and the grace period `evaluateHeartbeat`
    // receives comes from `driver.validate(row.config)`, i.e. `monitors.config.graceSec` (defaulting
    // to 300s when unset). That column looks load-bearing and is not — a real, PRE-EXISTING latent
    // defect unrelated to this ticket's delivery-tracking columns, out of scope to fix here. The
    // first version of this fixture set `monitor_heartbeats.grace_sec = 600` believing it controlled
    // the grace period, which left the ACTUAL grace at the 300s default — exactly equal to the
    // "recovery" test's 5-minute clock jump, so a few milliseconds of real test overhead pushed
    // `silentMs` just past `graceMs` and the monitor read `down` instead of `up`. Fixed by setting
    // the column the runner actually reads.
    const mk = await pool.query<{ id: string }>(
      `INSERT INTO monitors (tenant_id, client_id, name, kind, status, severity, interval_sec, config, last_checked_at)
       VALUES ($1,$2,'ok-path','heartbeat','unknown','ticket',60,'{"graceSec":600}'::jsonb,NULL) RETURNING id`,
      [tenantId, clientId],
    );
    okMonitorId = mk.rows[0].id;
    // Overdue by construction — `last_seen_at` far older than the grace period — so the very first
    // sweep observes `down` and opens an incident (no open incident exists yet). Grace is 10 MINUTES
    // (not the 60s minimum) specifically so the "recovery" test below can jump the clock 5 minutes
    // ahead of a freshly-touched `last_seen_at` and land back INSIDE grace — a small grace would
    // still read `down` at that offset and the recovery assertion would prove nothing.
    await pool.query(
      `INSERT INTO monitor_heartbeats (tenant_id, client_id, monitor_id, token_hash, grace_sec, last_seen_at)
       VALUES ($1,$2,$3,'ok-path-hash',600, now() - interval '1 hour')`,
      [tenantId, clientId, okMonitorId],
    );

    const fk = await pool.query<{ id: string }>(
      `INSERT INTO monitors (tenant_id, client_id, name, kind, status, severity, interval_sec, last_checked_at)
       VALUES ($1,$2,'fail-path','heartbeat','unknown','page',60,NULL) RETURNING id`,
      [tenantId, clientId],
    );
    failMonitorId = fk.rows[0].id;
    await pool.query(
      `INSERT INTO monitor_heartbeats (tenant_id, client_id, monitor_id, token_hash, grace_sec, last_seen_at)
       VALUES ($1,$2,$3,'fail-path-hash',60, now() - interval '1 hour')`,
      [tenantId, clientId, failMonitorId],
    );

    okChannelId = newId();
    await pool.query(
      `INSERT INTO monitor_channels (id, tenant_id, kind, name, destination, enabled)
       VALUES ($1,$2,'email','ok channel','ops-ok@notifydelivery.test', true)`,
      [okChannelId, tenantId],
    );
    await pool.query(
      `INSERT INTO monitor_routes (id, tenant_id, channel_id, match_severity, enabled)
       VALUES ($1,$2,$3,'ticket', true)`,
      [newId(), tenantId, okChannelId],
    );

    failChannelId = newId();
    await pool.query(
      `INSERT INTO monitor_channels (id, tenant_id, kind, name, destination, enabled)
       VALUES ($1,$2,'email','fail channel','ops-fail@notifydelivery.test', true)`,
      [failChannelId, tenantId],
    );
    await pool.query(
      `INSERT INTO monitor_routes (id, tenant_id, channel_id, match_severity, enabled)
       VALUES ($1,$2,$3,'page', true)`,
      [newId(), tenantId, failChannelId],
    );
    // The fail-channel's destination is under an active GLOBAL suppression (prior hard bounce) —
    // `enqueueMail()` still writes a `mail_log` row (`status: 'suppressed'`) but queue.ts's own
    // comment says the sender worker deliberately never reaches it, so it must be recorded as a
    // FAILURE here, not a success.
    await pool.query(
      `INSERT INTO mail_suppressions (id, email, stream, reason) VALUES ($1, 'ops-fail@notifydelivery.test', 'notify', 'manual')`,
      [newId()],
    );
  }, 120_000);

  afterAll(async () => {
    config.mail.enabled = savedMailEnabled;
    await teardownTestDb();
  });

  it("a successful enqueue marks the channel healthy — last_delivery_at set, ok=true, failure_count=0", async () => {
    await runSweep(new Date());

    const { rows } = await adminPool().query<{
      last_delivery_at: Date | null;
      last_delivery_ok: boolean | null;
      failure_count: number;
    }>(
      `SELECT last_delivery_at, last_delivery_ok, failure_count FROM monitor_channels WHERE id = $1`,
      [okChannelId],
    );
    expect(rows[0].last_delivery_at).not.toBeNull();
    expect(rows[0].last_delivery_ok).toBe(true);
    expect(rows[0].failure_count).toBe(0);

    // And the incident this whole fan-out exists to report on actually opened.
    const inc = await adminPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM monitor_incidents WHERE monitor_id = $1 AND closed_at IS NULL`,
      [okMonitorId],
    );
    expect(Number(inc.rows[0].n)).toBe(1);
  });

  it("a suppressed recipient marks the channel failing — ok=false, failure_count incremented, never a fake success", async () => {
    // Same sweep call as the previous test drove both monitors down at once (they were both due,
    // both overdue) — re-assert here rather than re-run, since a second runSweep() would find the
    // fail-path monitor still `down` with an already-open incident and correctly NOT re-notify
    // (decideTransition never re-opens an already-open incident), which would make a second call
    // look like nothing happened rather than proving anything.
    const { rows } = await adminPool().query<{
      last_delivery_at: Date | null;
      last_delivery_ok: boolean | null;
      failure_count: number;
    }>(
      `SELECT last_delivery_at, last_delivery_ok, failure_count FROM monitor_channels WHERE id = $1`,
      [failChannelId],
    );
    expect(rows[0].last_delivery_at).not.toBeNull();
    expect(rows[0].last_delivery_ok).toBe(false);
    expect(rows[0].failure_count).toBe(1);

    // The mail_log row DOES exist (enqueueMail still writes it) — proving the failure is about
    // "will never deliver", not "was never attempted".
    const log = await adminPool().query<{ status: string }>(
      `SELECT status FROM mail_log WHERE to_email = 'ops-fail@notifydelivery.test' AND tenant_id = $1
        ORDER BY queued_at DESC LIMIT 1`,
      [tenantId],
    );
    expect(log.rows[0]?.status).toBe("suppressed");
  });

  it("recovery (up) closes the incident and records ANOTHER successful attempt, resetting failure_count to 0", async () => {
    // Bring the ok-path monitor back within grace, then advance the clock past its 60s interval so
    // the next sweep re-evaluates it (isDue() compares against last_checked_at, which the first
    // sweep set).
    await adminPool().query(
      `UPDATE monitor_heartbeats SET last_seen_at = now() WHERE monitor_id = $1`,
      [okMonitorId],
    );
    const later = new Date(Date.now() + 5 * 60 * 1000);
    await runSweep(later);

    const inc = await adminPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM monitor_incidents WHERE monitor_id = $1 AND closed_at IS NULL`,
      [okMonitorId],
    );
    expect(Number(inc.rows[0].n)).toBe(0);

    const { rows } = await adminPool().query<{ last_delivery_ok: boolean | null; failure_count: number }>(
      `SELECT last_delivery_ok, failure_count FROM monitor_channels WHERE id = $1`,
      [okChannelId],
    );
    expect(rows[0].last_delivery_ok).toBe(true);
    expect(rows[0].failure_count).toBe(0);
  });
});
