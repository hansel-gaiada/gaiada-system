import { Card, HairlineTable, StatusBadge } from "@/components/ui";
import { EmptyNote } from "./EmptyNote";
import { formatDateTime } from "@/lib/format";
import {
  ageSeconds,
  diskProjectionNote,
  fmt,
  formatAge,
  freshnessTier,
  levelLabel,
  utilLevel,
  type HostRow,
} from "@/lib/observability";
import "./observability.css";

// MON-10 — the selected host's full breakdown, below the dense table. This is where the original
// single-host page's panels (resource pressure / datastores / alerts) now live, plus two additions
// the table can't fit: the disk trend and the estate-wide per-container-metrics limitation, which
// must render EVERY time (never silently dropped) because cAdvisor's per-container discovery is
// broken estate-wide today (MON-09n) — see the card's own comment below.

export function ObservabilityDrilldown({ row, now }: { row: HostRow; now: number }) {
  const age = ageSeconds(row.collectedAt, now);
  const fresh = freshnessTier(age);
  const h = row.host;

  const cpu = utilLevel(h?.cpuBusyPct.value ?? null);
  const mem = utilLevel(h?.memUsedPct.value ?? null);
  const disk = utilLevel(h?.diskUsedPct.value ?? null);
  const diskNote = h ? diskProjectionNote(h.diskFreeGb, h.diskFreeGb24h) : null;

  const pgDown = (row.datastores?.postgres ?? []).filter((d) => !d.up);
  const redisDown = (row.datastores?.redis ?? []).filter((d) => !d.up);

  return (
    <div>
      <div className="obs-drill__head">
        <span className="obs-drill__label">{row.label}</span>
        {row.environment ? (
          <span className="obs-env">{row.environment}</span>
        ) : (
          <span className="obs-env obs-env--unset">not tagged</span>
        )}
        <StatusBadge label={levelLabel(row.tier)} />
      </div>
      <p className="obs-drill__meta">
        Snapshot generated {formatAge(age)} ({fresh}) — {formatDateTime(row.collectedAt)}.{" "}
        {fresh !== "fresh" && (
          <strong style={{ color: "var(--status-warning-fg)" }}>
            This reading is older than it looks calm about — treat every figure below as that much
            out of date.
          </strong>
        )}
      </p>

      {!row.available ? (
        <EmptyNote>
          <strong>Cannot read this host&apos;s metrics.</strong> {row.reason}
          <br />
          Full dashboards: <code>{row.grafanaHint}</code>
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
                ["Load (1m)", fmt(h?.load1), ""],
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
            {(row.datastores?.postgres.length ?? 0) + (row.datastores?.redis.length ?? 0) === 0 ? (
              <EmptyNote>
                No datastore metrics at all — the exporters are not reporting. That is a blind spot,
                not a clean bill of health.
              </EmptyNote>
            ) : (
              <>
                <HairlineTable
                  columns={[{ label: "Datastore" }, { label: "Instance" }, { label: "State" }]}
                  rows={[
                    ...(row.datastores?.postgres ?? []).map((d, i) => [
                      "Postgres", d.instance, <StatusBadge key={`p${i}`} label={d.up ? "active" : "critical"} />,
                    ]),
                    ...(row.datastores?.redis ?? []).map((d, i) => [
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
            hint="The always-on Watchdog heartbeat is excluded — showing it would put a permanent red on a healthy host."
          >
            {(row.alerts ?? []).length === 0 ? (
              <EmptyNote>Nothing firing.</EmptyNote>
            ) : (
              <HairlineTable
                columns={[{ label: "Alert" }, { label: "Severity" }]}
                rows={(row.alerts ?? []).map((a, i) => [
                  a.name,
                  <StatusBadge key={`a${i}`} label={a.severity === "page" ? "critical" : "at risk"} />,
                ])}
              />
            )}
          </Card>

          {/* KNOWN-UNAVAILABLE, ESTATE-WIDE, TODAY — not a per-request live read. cAdvisor's
              per-container discovery is broken on every box in this estate: the Docker factory
              registers and docker.sock is readable, but no series carries a `name` label, so
              `count(container_last_seen{name!=""})` is 0 (MON-09n, docs/blueprints/monitoring-
              program.md §2.8). This card is a standing fact, cited rather than fetched, and is
              shown unconditionally so the gap reads as "known and reasoned about", never as a
              panel that was simply never built. */}
          <Card title="Per-container metrics">
            <p className="obs-limitation">
              <span className="obs-limitation__head">
                <span className="obs-dot obs-dot--unknown" aria-hidden="true" />
                Not measured — known estate-wide limitation
              </span>
              cAdvisor&apos;s per-container discovery is broken on every host in this estate: the
              containerd snapshotter breaks its RW-layer lookup, so no series carries a container{" "}
              <code>name</code> label and per-container CPU/memory cannot be computed
              (<code>count(container_last_seen{"{"}name!=&quot;&quot;{"}"}</code>) is 0
              — see MON-09n). This is not this host&apos;s reading; it is true everywhere until the
              cAdvisor fault is fixed. Host-level CPU/memory above are unaffected.
            </p>
          </Card>
        </div>
      )}

      <p style={{ marginTop: 20, fontSize: 13, opacity: 0.7 }}>
        This is a summary. Dashboards, log search and traces live in Grafana:{" "}
        <code>{row.grafanaHint}</code>. Client website monitoring is a separate surface under
        Business → Monitoring.
      </p>
    </div>
  );
}
