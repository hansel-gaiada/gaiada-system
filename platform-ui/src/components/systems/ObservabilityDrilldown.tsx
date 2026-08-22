import { Card, HairlineTable, StatusBadge } from "@/components/ui";
import { EmptyNote } from "./EmptyNote";
import { formatDateTime } from "@/lib/format";
import {
  diskProjectionNote,
  fmt,
  formatAge,
  FRESHNESS_LABEL,
  hostAlarmState,
  levelLabel,
  liveSampleAgeSeconds,
  utilLevel,
  type HostRow,
} from "@/lib/observability";
import "./observability.css";

// MON-10 / MSO-06 — the selected host's full breakdown, below the dense table. Now sourced from a
// real per-host `HostSnapshot` (contract §20.1a) rather than the single synthesized "this box" row:
// `host`/`targets`/`datastores` are `null` when the host is not currently live (`freshness.state`
// is `dark`/`never`), which is a DIFFERENT fact from `available:false` (that was "we can't reach
// Prometheus at all"; this is "this one host's instant vectors are empty past staleness").

export function ObservabilityDrilldown({
  row,
  collectedAt,
  now,
  grafanaHint,
}: {
  row: HostRow;
  collectedAt: string;
  now: number;
  grafanaHint: string;
}) {
  const age = liveSampleAgeSeconds(row.freshness, collectedAt, now);
  const fresh = row.freshness.state;
  const isLive = fresh === "fresh" || fresh === "stale";
  const alarm = hostAlarmState(row);
  const h = row.host;

  const cpu = utilLevel(h?.cpuBusyPct.value ?? null);
  const mem = utilLevel(h?.memUsedPct.value ?? null);
  const disk = utilLevel(h?.diskUsedPct.value ?? null);
  const diskNote = h ? diskProjectionNote(h.diskFreeGb, h.diskFreeGb24h) : null;
  const loadPerCore = h && h.load1.value !== null && h.cores.value ? h.load1.value / h.cores.value : null;

  const pgDown = (row.datastores?.postgres ?? []).filter((d) => !d.up);
  const redisDown = (row.datastores?.redis ?? []).filter((d) => !d.up);

  return (
    <div>
      <div className="obs-drill__head">
        <span className="obs-drill__label">{row.label}</span>
        {row.role && <span className="obs-role">{row.role}</span>}
        {row.registered ? (
          <span className="obs-env-wrap">
            <span className="obs-env">{row.env}</span>
            {row.envDrift && <span className="obs-env-drift">env drift</span>}
          </span>
        ) : (
          <span className="obs-env obs-env--unregistered">unregistered</span>
        )}
        {row.status && <StatusBadge label={row.status} />}
        <StatusBadge label={levelLabel(row.tier)} />
      </div>

      <p className="obs-drill__meta">
        Freshness: <strong className={`obs-fresh obs-fresh--${fresh}`}>{FRESHNESS_LABEL[fresh]}</strong> — last sample{" "}
        {formatAge(age)}
        {isLive && ` (as of ${formatDateTime(collectedAt)})`}.{" "}
        {!isLive && (
          <strong style={{ color: "var(--status-critical-fg)" }}>
            No usable reading right now — every figure below is historical or absent, not current.
          </strong>
        )}
        {isLive && fresh === "stale" && (
          <strong style={{ color: "var(--status-warning-fg)" }}>
            This reading is older than it looks calm about — treat every figure below as that much
            out of date.
          </strong>
        )}
      </p>

      {!row.registered && (
        <div style={{ marginBottom: 16 }}>
          <EmptyNote>
            This host has no matching <code>infra_hosts</code> row — it is sending series with a{" "}
            <code>host</code> label the inventory does not recognize. Either register it (if it is
            ours) or investigate why an unknown source is remote-writing into this estate.
          </EmptyNote>
        </div>
      )}

      {row.registered && alarm === "expected-pending" && (
        <div style={{ marginBottom: 16 }}>
          <EmptyNote>
            Onboarding — this host is provisioned in the inventory but has not sent a sample yet.
            Expected-pending, not an incident.
          </EmptyNote>
        </div>
      )}

      {row.registered && alarm === "stopped-reporting" && (
        <div style={{ marginBottom: 16 }}>
          <EmptyNote>
            This host is marked <strong>active</strong> in the inventory but has gone dark. That
            combination — expected to report, currently silent — is exactly what the inventory merge
            exists to surface; a live-series-only view would have dropped this host from the board
            entirely instead of flagging it.
          </EmptyNote>
        </div>
      )}

      {row.status === "decommissioned" && (
        <div style={{ marginBottom: 16 }}>
          <EmptyNote>
            Decommissioned — still shown while its series age out of the freshness lookback, then it
            will drop off the board on its own.
          </EmptyNote>
        </div>
      )}

      {!isLive ? (
        <EmptyNote>
          No live metrics for this host — its instant vectors are empty past Prometheus&apos;s own
          staleness window. Full dashboards (if the box has ever reported): <code>{grafanaHint}</code>
        </EmptyNote>
      ) : (
        <div className="obs-drill__grid">
          <Card title="Resource pressure" hint="Tiers match the alert thresholds, so the console and the pager agree.">
            <HairlineTable
              columns={[{ label: "Resource" }, { label: "Value", align: "right" }, { label: "State" }]}
              rows={[
                ["CPU", fmt(h?.cpuBusyPct, "%"), <StatusBadge key="c" label={levelLabel(cpu)} />],
                ["Memory", fmt(h?.memUsedPct, "%"), <StatusBadge key="m" label={levelLabel(mem)} />],
                ["Disk", fmt(h?.diskUsedPct, "%"), <StatusBadge key="d" label={levelLabel(disk)} />],
                ["Cores", fmt(h?.cores), ""],
                ["Load (1m)", loadPerCore !== null ? `${fmt(h?.load1)} (${loadPerCore.toFixed(2)}/core)` : fmt(h?.load1), ""],
                ["Uptime", fmt(h?.uptimeDays, "d"), ""],
              ]}
            />
            {diskNote && (
              <p style={{ marginTop: 10, fontSize: 13 }}>
                <StatusBadge label={diskNote.startsWith("projected") ? "critical" : "at risk"} />{" "}
                Disk {diskNote}.
              </p>
            )}
          </Card>

          <Card
            title="Scrape targets"
            hint="A target being up means the exporter answered. It does NOT mean the thing it measures is healthy."
          >
            {!row.targets ? (
              <EmptyNote>No scrape-target summary reported — blind spot, not a clean bill of health.</EmptyNote>
            ) : (
              <>
                <p style={{ margin: "0 0 8px", fontSize: 13 }}>
                  <strong>{row.targets.up}</strong> up / <strong>{row.targets.up + row.targets.down}</strong> total
                </p>
                {row.targets.down > 0 && (
                  <EmptyNote>
                    Down: {row.targets.downJobs.join(", ")}. Metrics from{" "}
                    {row.targets.down === 1 ? "it" : "them"} are missing, so anything computed from those
                    series is incomplete rather than good.
                  </EmptyNote>
                )}
              </>
            )}
          </Card>

          <Card title="Datastores" hint="Reported by the exporters, per instance.">
            {!row.datastores ? (
              <EmptyNote>
                This host ships no Postgres/Redis exporters — nothing to measure here, distinct from
                a measured-and-down instance.
              </EmptyNote>
            ) : (row.datastores.postgres.length + row.datastores.redis.length === 0) ? (
              <EmptyNote>
                No datastore metrics at all — the exporters are not reporting. That is a blind spot,
                not a clean bill of health.
              </EmptyNote>
            ) : (
              <>
                <HairlineTable
                  columns={[{ label: "Datastore" }, { label: "Instance" }, { label: "State" }]}
                  rows={[
                    ...row.datastores.postgres.map((d, i) => [
                      "Postgres", d.instance, <StatusBadge key={`p${i}`} label={d.up ? "active" : "critical"} />,
                    ]),
                    ...row.datastores.redis.map((d, i) => [
                      "Redis", d.instance, <StatusBadge key={`r${i}`} label={d.up ? "active" : "critical"} />,
                    ]),
                  ]}
                />
                {(pgDown.length > 0 || redisDown.length > 0) && (
                  <p className="sys-empty-note" style={{ marginTop: 10 }}>
                    Check the exporter&apos;s DSN before concluding the datastore is down — a wrong
                    host or password reports identically to a real outage.
                  </p>
                )}
              </>
            )}
          </Card>

          <Card
            title="Firing alerts"
            hint="From Alertmanager, independently of Prometheus — includes silence/inhibition state. The always-on Watchdog heartbeat is excluded."
          >
            {row.alerts.length === 0 ? (
              <EmptyNote>Nothing firing or suppressed for this host.</EmptyNote>
            ) : (
              <HairlineTable
                columns={[{ label: "Alert" }, { label: "State" }, { label: "Severity" }]}
                rows={row.alerts.map((a, i) => [
                  a.name,
                  // "suspended" (idle/champagne family) on purpose — a SILENCED alert must read as
                  // calm/muted, not as another shade of critical-red, or the console teaches
                  // operators the exact wrong lesson about what a silence means.
                  <StatusBadge key={`s${i}`} label={a.state === "suppressed" ? "suspended" : "active"} />,
                  <StatusBadge key={`a${i}`} label={a.severity === "page" ? "critical" : "at risk"} />,
                ])}
              />
            )}
          </Card>
        </div>
      )}

      {/* Always rendered, live or not: the estate-wide MON-09n limitation. Sourced from the row's
          OWN `containersRunning` Reading rather than hardcoded prose, so this card stops describing
          a fixed limitation on its own the day the backend starts sending a real value (contract
          §20.1a note 11 — revisit when MON-09n closes) instead of needing a second edit here. */}
      <div style={{ marginTop: 16 }}>
        <Card title="Per-container metrics">
          {row.containersRunning.value !== null ? (
            <p style={{ margin: 0, fontSize: 13 }}>
              <strong>{row.containersRunning.value}</strong> containers running.
            </p>
          ) : (
            <p className="obs-limitation">
              <span className="obs-limitation__head">
                <span className="obs-dot obs-dot--unknown" aria-hidden="true" />
                Not measured — known estate-wide limitation
              </span>
              {/* The backend's own `note` string carries no trailing punctuation — join defensively
                  rather than assume one, so this never reads as one run-on sentence. */}
              {(row.containersRunning.note ?? "No reason given").replace(/[.\s]*$/, "")}. Host-level
              CPU/memory above are unaffected.
            </p>
          )}
        </Card>
      </div>

      <p style={{ marginTop: 20, fontSize: 13, opacity: 0.7 }}>
        This is a summary. Dashboards, log search and traces live in Grafana:{" "}
        <code>{grafanaHint}</code>. Client website monitoring is a separate surface under
        Business → Monitoring.
      </p>
    </div>
  );
}
