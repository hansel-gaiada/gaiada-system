// MON-12 — the runner: the loop that actually checks things. Everything before this was capable of
// monitoring; this is what makes it happen.
//
// ── THE PURE/IMPURE SPLIT IS DELIBERATE ─────────────────────────────────────────────────────────
// Every decision (is this due, is it suppressed, did the state transition, what is the uptime) is a
// pure function at the top of this file, tested without a database. The DB work is a thin shell
// underneath. This is the same split `lib/reports.ts` documents in platform-ui, and it exists because
// the decisions are where the bugs that matter live — and a suite that needs DATABASE_URL_TEST SKIPS
// SILENTLY, which for scheduling logic would mean "green" while nothing ran.
//
// ── TWO THINGS THE SCHEMA MADE LOAD-BEARING ─────────────────────────────────────────────────────
// 1. `monitor_results` is PARTITIONED. A missing partition makes the INSERT fail outright — the right
//    failure direction (loud, not lossy), but it means the roll-forward below is not housekeeping: it
//    is a precondition for the runner working at all next month.
// 2. There is a UNIQUE index allowing ONE open incident per monitor. The transition logic here must
//    therefore be idempotent — a second consecutive `down` must NOT try to open a second incident.
import type { PoolClient } from "pg";
import { withGlobal } from "../../db";
import { getDriver, hasDriver, parseKind, type MonitorStatus, type ProbeCtx, type ProbeResult } from "./drivers/registry";
import type { HeartbeatProbeCtx } from "./drivers/heartbeat";

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// PURE DECISIONS
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export interface DueInput {
  intervalSec: number;
  lastCheckedAt: Date | null;
  enabled: boolean;
  now: Date;
}

/**
 * A monitor never checked is due immediately — otherwise a monitor created at 09:00 with a 24h
 * interval shows `unknown` until tomorrow, and the operator concludes monitoring is broken.
 * A disabled monitor is never due: `enabled: false` means "stop checking", not "check and hide".
 */
export function isDue(i: DueInput): boolean {
  if (!i.enabled) return false;
  if (i.lastCheckedAt === null) return true;
  return i.now.getTime() - i.lastCheckedAt.getTime() >= i.intervalSec * 1000;
}

export interface MaintenanceWindowLite {
  startsAt: Date;
  endsAt: Date;
  monitorId: string | null;
}

/**
 * `monitorId: null` is a tenant-wide window. Suppression is checked at RESULT time, not at probe
 * time: we still probe and still record the observation, because throwing away data during
 * maintenance would leave a hole in the history that later reads as an outage of unknown length.
 * What suppression changes is the STATUS and whether an incident opens.
 */
export function inMaintenance(windows: readonly MaintenanceWindowLite[], monitorId: string, now: Date): boolean {
  const t = now.getTime();
  return windows.some(
    (w) =>
      (w.monitorId === null || w.monitorId === monitorId) &&
      w.startsAt.getTime() <= t &&
      w.endsAt.getTime() > t,
  );
}

export interface TransitionInput {
  previous: MonitorStatus;
  observed: MonitorStatus;
  hasOpenIncident: boolean;
  suppressed: boolean;
}

export interface Transition {
  /** What to store on `monitors.status`. */
  status: MonitorStatus;
  openIncident: boolean;
  closeIncident: boolean;
}

/**
 * The state machine, and the only place that decides whether a human gets woken.
 *
 * Rules, each with a reason:
 *  * SUPPRESSED => status becomes `maintenance` and NO incident opens. The observation is still
 *    recorded (see inMaintenance) so the history is honest about what happened.
 *  * A failing observation opens an incident ONLY if one is not already open. The partial unique
 *    index enforces this in the database too, but relying on a constraint violation as control flow
 *    would mean every subsequent probe of a down monitor throws.
 *  * Recovery closes the incident. `up` is the only recovery: `unknown` does NOT close one, because
 *    "we stopped being able to check" is not "it got better" — closing on unknown would silently
 *    resolve an outage the moment the checker itself broke.
 */
export function decideTransition(i: TransitionInput): Transition {
  if (i.suppressed) {
    return { status: "maintenance", openIncident: false, closeIncident: false };
  }
  const failing = i.observed === "down" || i.observed === "degraded";
  if (failing) {
    return { status: i.observed, openIncident: !i.hasOpenIncident, closeIncident: false };
  }
  if (i.observed === "up") {
    return { status: "up", openIncident: false, closeIncident: i.hasOpenIncident };
  }
  // `unknown`: record it, change nothing about incidents.
  return { status: "unknown", openIncident: false, closeIncident: false };
}

/**
 * Uptime as a ratio of counted checks. Returns null for an empty window rather than 1 or 0: with no
 * observations we do not know, and both 100% and 0% would be a fabricated claim about a period we
 * never measured. `maintenance` results are EXCLUDED from both numerator and denominator — counting
 * them as up would flatter the figure, counting them as down would punish the client for scheduled
 * work, and the honest answer is that the window was not being measured.
 */
export function uptimeRatio(results: readonly { status: MonitorStatus }[]): number | null {
  const counted = results.filter((r) => r.status !== "maintenance" && r.status !== "unknown");
  if (counted.length === 0) return null;
  const up = counted.filter((r) => r.status === "up").length;
  return up / counted.length;
}

/** Partition names the roll-forward uses. Monthly so the job is trivially idempotent. */
export function partitionSpecs(now: Date, monthsAhead = 3): { name: string; from: string; to: string }[] {
  const out: { name: string; from: string; to: string }[] = [];
  for (let i = 0; i <= monthsAhead; i++) {
    const s = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
    const e = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i + 1, 1));
    const yyyymm = `${s.getUTCFullYear()}${String(s.getUTCMonth() + 1).padStart(2, "0")}`;
    out.push({ name: `monitor_results_${yyyymm}`, from: s.toISOString().slice(0, 10), to: e.toISOString().slice(0, 10) });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE SHELL
// ═══════════════════════════════════════════════════════════════════════════════════════════════

interface DueRow {
  id: string;
  tenant_id: string;
  client_id: string;
  property_id: string | null;
  kind: string;
  config: Record<string, unknown>;
  target: string | null;
  interval_sec: number;
  status: MonitorStatus;
  last_checked_at: Date | null;
  severity: string;
  hb_last_seen_at: Date | null;
  hb_grace_sec: number | null;
  open_incident_id: string | null;
  /** Hostnames from VERIFIED properties only — see the query. */
  allowlist: string[];
}

/**
 * Idempotent. Runs before every sweep rather than on a timer of its own: a partition missing at the
 * moment of insert is a hard failure, and tying its creation to the thing that needs it removes the
 * possibility of the two schedules drifting apart.
 */
export async function ensureResultPartitions(c: PoolClient, now = new Date()): Promise<void> {
  for (const p of partitionSpecs(now)) {
    await c.query(
      `CREATE TABLE IF NOT EXISTS ${p.name} PARTITION OF monitor_results FOR VALUES FROM ($1) TO ($2)`,
      [p.from, p.to],
    );
  }
}

/**
 * ⚠ THE ALLOWLIST IS THE SECURITY BOUNDARY OF THIS FILE.
 *
 * It is built ONLY from `search_properties` rows with `verified_at IS NOT NULL`, joined on the
 * monitor's own tenant AND client. An unverified property contributes nothing, so a tenant cannot
 * make us probe a host merely by typing it: someone had to pass the verification checkpoint first.
 * Feeding the guard a list derived from the monitor's own `target` would make the guard validate
 * attacker-supplied input against itself, which is not a guard at all.
 */
const DUE_SELECT = `
  SELECT m.id, m.tenant_id, m.client_id, m.property_id, m.kind, m.config, m.target,
         m.interval_sec, m.status, m.last_checked_at, m.severity,
         hb.last_seen_at AS hb_last_seen_at, hb.grace_sec AS hb_grace_sec,
         (SELECT i.id FROM monitor_incidents i
           WHERE i.monitor_id = m.id AND i.closed_at IS NULL LIMIT 1) AS open_incident_id,
         COALESCE((
           SELECT array_agg(DISTINCT p.domain)
             FROM search_properties p
            WHERE p.tenant_id = m.tenant_id
              AND p.client_id = m.client_id
              AND p.verified_at IS NOT NULL
              AND p.deleted_at IS NULL
         ), ARRAY[]::text[]) AS allowlist
    FROM monitors m
    LEFT JOIN monitor_heartbeats hb ON hb.monitor_id = m.id
   WHERE m.deleted_at IS NULL AND m.enabled = true`;

export interface SweepResult {
  considered: number;
  probed: number;
  skippedNoDriver: number;
  incidentsOpened: number;
  incidentsClosed: number;
}

/**
 * One sweep. `withGlobal` with an explicit justification: this is a platform-wide background job with
 * no request principal, and it must see every tenant's monitors. It compensates by scoping every
 * WRITE to the monitor's own tenant_id/client_id, taken from the row it just read — never from
 * anything a caller supplied.
 */
export async function runSweep(now = new Date(), timeoutMs = 10_000): Promise<SweepResult> {
  const out: SweepResult = { considered: 0, probed: 0, skippedNoDriver: 0, incidentsOpened: 0, incidentsClosed: 0 };

  await withGlobal(async (c) => {
    await ensureResultPartitions(c, now);

    const due = await c.query<DueRow>(DUE_SELECT);
    const windows = await c.query<{ starts_at: Date; ends_at: Date; monitor_id: string | null }>(
      `SELECT starts_at, ends_at, monitor_id FROM monitor_maintenance WHERE ends_at > now() AND starts_at <= now()`,
    );
    const wins: MaintenanceWindowLite[] = windows.rows.map((w) => ({
      startsAt: w.starts_at,
      endsAt: w.ends_at,
      monitorId: w.monitor_id,
    }));

    for (const row of due.rows) {
      out.considered += 1;
      if (!isDue({ intervalSec: row.interval_sec, lastCheckedAt: row.last_checked_at, enabled: true, now })) continue;

      const kind = parseKind(row.kind);
      // No default: an unrecognised or driverless kind is COUNTED and skipped, never silently
      // treated as healthy. The board keeps showing its last known state and the counter is what
      // makes the gap visible in logs/metrics.
      if (kind === null || !hasDriver(kind)) {
        out.skippedNoDriver += 1;
        continue;
      }

      const audit: ProbeCtx["audit"] = () => {
        /* MON-12b: persist egress decisions. Deliberately a no-op rather than a console line — a
           half-wired audit sink that logs somewhere nobody reads is worse than an obvious gap. */
      };
      const ctx: HeartbeatProbeCtx = {
        allowlistHosts: row.allowlist,
        timeoutMs,
        audit,
        heartbeat:
          kind === "heartbeat"
            ? { lastSeenAt: row.hb_last_seen_at, now }
            : undefined,
      };

      let observed: ProbeResult;
      try {
        const driver = getDriver(kind);
        observed = await driver.probe(driver.validate(row.config), ctx);
      } catch (e) {
        // A driver that throws is a DOWN observation with the reason attached, not a skipped check:
        // "the probe could not complete" is information about the target, and swallowing it would
        // leave the monitor looking un-run.
        observed = { status: "down", latencyMs: null, detail: (e as Error).message };
      }
      out.probed += 1;

      const suppressed = inMaintenance(wins, row.id, now);
      const t = decideTransition({
        previous: row.status,
        observed: observed.status,
        hasOpenIncident: row.open_incident_id !== null,
        suppressed,
      });

      // The observation is recorded as OBSERVED, not as the suppressed status: the history must say
      // what was actually seen, or a maintenance window erases the evidence of a real outage.
      await c.query(
        `INSERT INTO monitor_results (tenant_id, client_id, monitor_id, checked_at, status, latency_ms, detail)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [row.tenant_id, row.client_id, row.id, now, observed.status, observed.latencyMs, observed.detail],
      );

      await c.query(
        `UPDATE monitors SET status = $2, last_checked_at = $3, last_latency_ms = $4, updated_at = now()
          WHERE id = $1 AND tenant_id = $5`,
        [row.id, t.status, now, observed.latencyMs, row.tenant_id],
      );

      if (t.openIncident) {
        // ON CONFLICT DO NOTHING against the partial unique index: two runners racing must not turn a
        // duplicate into a thrown error that aborts the whole sweep.
        const ins = await c.query(
          `INSERT INTO monitor_incidents (tenant_id, client_id, monitor_id, opened_at, cause, severity)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT DO NOTHING RETURNING id`,
          [row.tenant_id, row.client_id, row.id, now, observed.detail, row.severity],
        );
        if (ins.rows.length) out.incidentsOpened += 1;
      }
      if (t.closeIncident) {
        const upd = await c.query(
          `UPDATE monitor_incidents SET closed_at = $2
            WHERE monitor_id = $1 AND closed_at IS NULL RETURNING id`,
          [row.id, now],
        );
        out.incidentsClosed += upd.rows.length;
      }
    }
  });

  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// MON-12c — THE LOOP
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Chained `setTimeout`, never `setInterval` — the next tick is scheduled only after the current one
 * finishes, so a slow sweep cannot stack overlapping runs. Same shape as the search pull scheduler.
 *
 * ⚠ DARK BY DEFAULT, and that is a safety property rather than caution. This loop DIALS CLIENT
 * WEBSITES. A deployment that starts probing third-party hosts merely because it booted is not a
 * default anyone chose; someone has to turn it on. The gate is `config.monitoring.runnerEnabled`.
 *
 * The interval only controls how often due-ness is re-ASKED. Whether a monitor is actually probed is
 * decided per monitor by `isDue()` against its own `interval_sec`, never by this value — so setting a
 * 60s tick does not mean every monitor is checked every 60 seconds.
 */
export function startMonitoringRunnerLoop(intervalMs: number): { stop: () => void } {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async () => {
    if (stopped) return;
    try {
      const r = await runSweep();
      // A tick where nothing was due is SILENT by design: at a 60s cadence across every monitor this
      // would otherwise bury the log in "considered 40, probed 0". Anything that actually happened,
      // or any driver gap, is surfaced.
      if (r.probed > 0 || r.incidentsOpened > 0 || r.incidentsClosed > 0 || r.skippedNoDriver > 0) {
        // eslint-disable-next-line no-console
        console.log("[MONITORING] sweep:", r);
      }
    } catch (e) {
      // Never let a failed sweep kill the loop: monitoring that stops because one probe threw is
      // strictly worse than monitoring that logs and continues — and a dead loop is invisible, which
      // is the failure this whole module exists to prevent.
      // eslint-disable-next-line no-console
      console.error("[MONITORING] sweep failed:", (e as Error).message);
    } finally {
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }
  };

  timer = setTimeout(tick, intervalMs);
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
